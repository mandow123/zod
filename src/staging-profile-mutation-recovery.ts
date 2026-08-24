import * as SecureStore from 'expo-secure-store';
import { assertStagingProfileMutationPrincipal, type StagingProfileMutation } from './staging-profile-mutation-recovery-core';
import { loadStagingPrincipalFingerprint } from './staging-principal';

const KEY = 'kai.zod.staging.pending-profile-mutation.v1';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;
const operations = new Set(['create_ssh_key', 'rename_ssh_key', 'revoke_ssh_key', 'submit_manual_delivery']);

function valid(value: unknown): value is StagingProfileMutation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StagingProfileMutation>;
  return typeof item.operation === 'string' && operations.has(item.operation)
    && typeof item.signature === 'string' && /^[a-f0-9]{64}$/u.test(item.signature)
    && typeof item.idempotencyKey === 'string' && item.idempotencyKey.length >= 16 && item.idempotencyKey.length <= 120
    && typeof item.principalFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(item.principalFingerprint)
    && Boolean(item.payload && typeof item.payload === 'object');
}
export async function loadPendingStagingProfileMutation() {
  const raw = await SecureStore.getItemAsync(KEY, options); if (!raw) return null;
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error('待确认的安全操作无法读取，请保持当前测试身份并联系客服。'); }
  if (!valid(parsed)) throw new Error('待确认的安全操作格式异常，请保持当前测试身份并联系客服。');
  return assertStagingProfileMutationPrincipal(parsed, await loadStagingPrincipalFingerprint());
}
export async function savePendingStagingProfileMutation(input: Omit<StagingProfileMutation, 'principalFingerprint'>) {
  const pending: StagingProfileMutation = {
    ...input, principalFingerprint: await loadStagingPrincipalFingerprint(),
  };
  if (!valid(pending)) throw new Error('待确认的安全操作参数无效。');
  const existing = await loadPendingStagingProfileMutation();
  if (existing && existing.signature !== pending.signature) throw new Error('上一项安全操作结果仍待确认，不能覆盖未知结果。');
  if (existing) return existing;
  await SecureStore.setItemAsync(KEY, JSON.stringify(pending), options); return pending;
}
export async function clearConfirmedStagingProfileMutation(idempotencyKey: string) {
  const existing = await loadPendingStagingProfileMutation(); if (!existing) return;
  if (existing.idempotencyKey !== idempotencyKey) throw new Error('待确认安全操作已变化，已停止清理。');
  await SecureStore.deleteItemAsync(KEY, options);
}
