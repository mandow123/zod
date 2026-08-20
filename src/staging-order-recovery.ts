import * as SecureStore from 'expo-secure-store';
import { assertStagingOrderPrincipal, type PendingStagingOrder } from './staging-order-recovery-core';
import { loadStagingPrincipalFingerprint } from './staging-principal';

const PENDING_ORDER_KEY = 'kai.zod.staging.pending-order.v1';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

function validPending(value: unknown): value is PendingStagingOrder {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingStagingOrder>;
  return typeof pending.signature === 'string' && pending.signature.length >= 5 && pending.signature.length <= 300
    && typeof pending.listingId === 'string' && pending.listingId.length >= 1 && pending.listingId.length <= 160
    && typeof pending.quantity === 'string' && /^\d+\.\d{2}$/u.test(pending.quantity)
    && typeof pending.idempotencyKey === 'string' && pending.idempotencyKey.length >= 16
    && pending.idempotencyKey.length <= 120
    && typeof pending.principalFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(pending.principalFingerprint);
}

export async function loadPendingStagingOrder() {
  const raw = await SecureStore.getItemAsync(PENDING_ORDER_KEY, options);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('待确认订单记录无法读取，请保持当前测试身份并联系客服。'); }
  if (!validPending(parsed)) throw new Error('待确认订单记录格式异常，请保持当前测试身份并联系客服。');
  return assertStagingOrderPrincipal(parsed, await loadStagingPrincipalFingerprint());
}

export async function savePendingStagingOrder(input: Omit<PendingStagingOrder, 'principalFingerprint'>) {
  const pending: PendingStagingOrder = {
    ...input, principalFingerprint: await loadStagingPrincipalFingerprint(),
  };
  if (!validPending(pending)) throw new Error('待确认订单参数无效。');
  const existing = await loadPendingStagingOrder();
  if (existing && existing.signature !== pending.signature) {
    throw new Error('上一笔测试订单结果仍待确认，请先重新查询，不能发起另一笔预留。');
  }
  if (existing) return existing;
  await SecureStore.setItemAsync(PENDING_ORDER_KEY, JSON.stringify(pending), options);
  return pending;
}

export async function clearConfirmedStagingOrder(idempotencyKey: string) {
  const existing = await loadPendingStagingOrder();
  if (!existing) return;
  if (existing.idempotencyKey !== idempotencyKey) {
    throw new Error('待确认订单已变化，已停止清理以避免重复预留。');
  }
  await SecureStore.deleteItemAsync(PENDING_ORDER_KEY, options);
}
