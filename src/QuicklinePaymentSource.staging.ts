import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { QuicklinePayment, QuicklinePaymentSource } from './QuicklinePaymentSource';
import {
  createStagingTopup, loadStagingBalance, loadStagingTopup, loadStagingTopups, type StagingTopup,
} from './staging-sandbox-api';
import { loadStagingPrincipalFingerprint } from './staging-principal';
import {
  assertStagingTopupPrincipal, replayPendingStagingTopup, type PendingStagingTopup,
} from './staging-topup-recovery-core';

const PENDING_KEY = 'kai.zod.staging.pending-quickline.v1';
const secureOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

function paymentFromServer(topup: StagingTopup): QuicklinePayment {
  return {
    id: topup.id, paymentAmount: topup.paymentAmount, creditAmount: topup.creditAmount,
    status: topup.status, allowedActions: topup.allowedActions,
    createdAt: topup.createdAt, updatedAt: topup.updatedAt,
  };
}

function validPending(value: unknown): value is PendingStagingTopup {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingStagingTopup>;
  return typeof pending.amount === 'string' && /^\d+\.\d{2}$/u.test(pending.amount)
    && typeof pending.idempotencyKey === 'string' && pending.idempotencyKey.length >= 16
    && pending.idempotencyKey.length <= 120
    && typeof pending.principalFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(pending.principalFingerprint);
}

export async function loadPendingStagingTopup() {
  const raw = await SecureStore.getItemAsync(PENDING_KEY, secureOptions);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('待确认支付记录无法读取，请联系客服。'); }
  if (!validPending(parsed)) throw new Error('待确认支付记录格式异常，请联系客服。');
  return assertStagingTopupPrincipal(parsed, await loadStagingPrincipalFingerprint());
}

async function pendingPayment(amount: string) {
  const existing = await loadPendingStagingTopup();
  if (existing) {
    if (existing.amount !== amount) {
      throw new Error('上一笔支付结果仍待确认，不能重复创建支付单。');
    }
    return existing;
  }
  const pending: PendingStagingTopup = {
    amount, idempotencyKey: `staging-topup:${Crypto.randomUUID()}`,
    principalFingerprint: await loadStagingPrincipalFingerprint(),
  };
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(pending), secureOptions);
  return pending;
}

async function clearConfirmedPayment(idempotencyKey: string) {
  const existing = await loadPendingStagingTopup();
  if (!existing) return;
  if (existing.idempotencyKey !== idempotencyKey) {
    throw new Error('待确认支付已变化，已停止清理以避免重复支付。');
  }
  await SecureStore.deleteItemAsync(PENDING_KEY, secureOptions);
}

async function replayPayment(pending: PendingStagingTopup) {
  const topup = await replayPendingStagingTopup(
    pending,
    await loadStagingPrincipalFingerprint(),
    (request) => createStagingTopup(request.amount, request.idempotencyKey),
    clearConfirmedPayment,
  );
  return paymentFromServer(topup);
}

const stagingSource: QuicklinePaymentSource = {
  source: 'staging',
  list: async () => (await loadStagingTopups()).map(paymentFromServer),
  load: async (id) => paymentFromServer(await loadStagingTopup(id)),
  create: async (amount) => {
    const pending = await pendingPayment(amount);
    return replayPayment(pending);
  },
  recover: async () => {
    const pending = await loadPendingStagingTopup();
    return pending ? replayPayment(pending) : null;
  },
  balance: async () => {
    const value = await loadStagingBalance();
    return { available: value.available, reserved: value.reserved };
  },
};

export function useQuicklinePaymentSource(): QuicklinePaymentSource {
  return stagingSource;
}
