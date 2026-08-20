export type StagingOrderMutationAction = 'cancel' | 'request_stop' | 'accept' | 'open_dispute';

export type PendingStagingOrderAction = Readonly<{
  signature: string;
  action: StagingOrderMutationAction;
  orderId: string;
  expectedVersion: number;
  idempotencyKey: string;
  principalFingerprint: string;
  dispute: null | Readonly<{
    category: 'access' | 'metering' | 'disconnect' | 'other';
    description: string;
  }>;
}>;

export function assertStagingOrderActionPrincipal(
  pending: PendingStagingOrderAction,
  principalFingerprint: string,
) {
  if (!/^[a-f0-9]{64}$/u.test(principalFingerprint)
    || pending.principalFingerprint !== principalFingerprint) {
    throw new Error('待确认履约操作属于其他测试账号，已禁止读取、重放或覆盖。');
  }
  return pending;
}

export async function replayPendingStagingOrderAction<T>(
  pending: PendingStagingOrderAction,
  principalFingerprint: string,
  replay: (pending: PendingStagingOrderAction) => Promise<T>,
  clearConfirmed: (idempotencyKey: string) => Promise<void>,
) {
  assertStagingOrderActionPrincipal(pending, principalFingerprint);
  const confirmed = await replay(pending);
  await clearConfirmed(pending.idempotencyKey);
  return confirmed;
}
