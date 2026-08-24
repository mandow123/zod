import * as SecureStore from 'expo-secure-store';
import { assertStagingSupplierDraftPrincipal, type PendingStagingSupplierDraft } from './staging-supplier-draft-recovery-core';
import { loadStagingPrincipalFingerprint } from './staging-principal';

const PENDING_DRAFT_KEY = 'kai.zod.staging.pending-supplier-draft.v1';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

function validPending(value: unknown): value is PendingStagingSupplierDraft {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingStagingSupplierDraft>;
  const versionValid = pending.operation === 'create'
    ? pending.draftId === null && pending.expectedVersion === null
    : typeof pending.draftId === 'string' && pending.draftId.length > 0
      && Number.isInteger(pending.expectedVersion) && Number(pending.expectedVersion) >= 1;
  return (pending.operation === 'create' || pending.operation === 'update')
    && typeof pending.clientDraftId === 'string' && pending.clientDraftId.length >= 8 && pending.clientDraftId.length <= 160
    && versionValid && Boolean(pending.payload && typeof pending.payload === 'object')
    && typeof pending.signature === 'string' && /^[a-f0-9]{64}$/u.test(pending.signature)
    && typeof pending.idempotencyKey === 'string' && pending.idempotencyKey.length >= 16
    && pending.idempotencyKey.length <= 120
    && typeof pending.principalFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(pending.principalFingerprint);
}

export async function loadPendingStagingSupplierDraft() {
  const raw = await SecureStore.getItemAsync(PENDING_DRAFT_KEY, options);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('待确认的测试资源草稿无法读取，请保持当前供应身份并联系客服。');
  }
  if (!validPending(parsed)) throw new Error('待确认的测试资源草稿格式异常，请保持当前供应身份并联系客服。');
  return assertStagingSupplierDraftPrincipal(parsed, await loadStagingPrincipalFingerprint());
}

export async function savePendingStagingSupplierDraft(input: Omit<PendingStagingSupplierDraft, 'principalFingerprint'>) {
  const pending: PendingStagingSupplierDraft = {
    ...input, principalFingerprint: await loadStagingPrincipalFingerprint(),
  };
  if (!validPending(pending)) throw new Error('待确认的测试资源草稿参数无效。');
  const existing = await loadPendingStagingSupplierDraft();
  if (existing && existing.signature !== pending.signature) {
    throw new Error('上一份草稿保存结果仍待确认，请联网重试，不能覆盖未知结果。');
  }
  if (existing) return existing;
  await SecureStore.setItemAsync(PENDING_DRAFT_KEY, JSON.stringify(pending), options);
  return pending;
}

export async function clearConfirmedStagingSupplierDraft(idempotencyKey: string) {
  const existing = await loadPendingStagingSupplierDraft();
  if (!existing) return;
  if (existing.idempotencyKey !== idempotencyKey) {
    throw new Error('待确认草稿请求已变化，已停止清理以避免重复保存。');
  }
  await SecureStore.deleteItemAsync(PENDING_DRAFT_KEY, options);
}
