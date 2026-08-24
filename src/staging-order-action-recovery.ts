import * as SecureStore from 'expo-secure-store';
import { assertStagingOrderActionPrincipal, type PendingStagingOrderAction } from './staging-order-action-recovery-core';
import { loadStagingPrincipalFingerprint } from './staging-principal';

const PENDING_ACTION_KEY = 'kai.zod.staging.pending-order-action.v1';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;
const actions = new Set(['cancel', 'request_stop', 'accept', 'open_dispute']);
const categories = new Set(['access', 'metering', 'disconnect', 'other']);

function validPending(value: unknown): value is PendingStagingOrderAction {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingStagingOrderAction>;
  const disputeValid = pending.action !== 'open_dispute'
    ? pending.dispute === null
    : Boolean(pending.dispute && categories.has(pending.dispute.category)
      && pending.dispute.description.trim().length >= 20 && pending.dispute.description.trim().length <= 500);
  return typeof pending.signature === 'string' && pending.signature.length >= 5 && pending.signature.length <= 360
    && typeof pending.action === 'string' && actions.has(pending.action)
    && typeof pending.orderId === 'string' && pending.orderId.length >= 1 && pending.orderId.length <= 160
    && Number.isInteger(pending.expectedVersion) && Number(pending.expectedVersion) >= 1
    && typeof pending.idempotencyKey === 'string' && pending.idempotencyKey.length >= 16
    && pending.idempotencyKey.length <= 120
    && typeof pending.principalFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(pending.principalFingerprint)
    && disputeValid;
}

export async function loadPendingStagingOrderAction() {
  const raw = await SecureStore.getItemAsync(PENDING_ACTION_KEY, options);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('待确认履约操作无法读取，请保持当前测试身份并联系客服。'); }
  if (!validPending(parsed)) throw new Error('待确认履约操作格式异常，请保持当前测试身份并联系客服。');
  return assertStagingOrderActionPrincipal(parsed, await loadStagingPrincipalFingerprint());
}

export async function savePendingStagingOrderAction(
  input: Omit<PendingStagingOrderAction, 'principalFingerprint'>,
) {
  const pending: PendingStagingOrderAction = {
    ...input, principalFingerprint: await loadStagingPrincipalFingerprint(),
  };
  if (!validPending(pending)) throw new Error('待确认履约操作参数无效。');
  const existing = await loadPendingStagingOrderAction();
  if (existing && existing.signature !== pending.signature) {
    throw new Error('上一项测试履约操作仍待确认，请先重新查询，不能发起另一项操作。');
  }
  if (existing) return existing;
  await SecureStore.setItemAsync(PENDING_ACTION_KEY, JSON.stringify(pending), options);
  return pending;
}

export async function clearConfirmedStagingOrderAction(idempotencyKey: string) {
  const existing = await loadPendingStagingOrderAction();
  if (!existing) return;
  if (existing.idempotencyKey !== idempotencyKey) {
    throw new Error('待确认履约操作已变化，已停止清理以避免重复执行。');
  }
  await SecureStore.deleteItemAsync(PENDING_ACTION_KEY, options);
}
