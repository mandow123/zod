export type PendingStagingOrder = Readonly<{
  signature: string;
  listingId: string;
  quantity: string;
  idempotencyKey: string;
  principalFingerprint: string;
}>;

export function assertStagingOrderPrincipal(pending: PendingStagingOrder, principalFingerprint: string) {
  if (!/^[a-f0-9]{64}$/u.test(principalFingerprint)
    || pending.principalFingerprint !== principalFingerprint) {
    throw new Error('待确认订单属于其他测试账号，已禁止读取、重放或覆盖。');
  }
  return pending;
}

export async function replayPendingStagingOrder<T>(
  pending: PendingStagingOrder,
  principalFingerprint: string,
  replay: (pending: PendingStagingOrder) => Promise<T>,
  clearConfirmed: (idempotencyKey: string) => Promise<void>,
) {
  assertStagingOrderPrincipal(pending, principalFingerprint);
  const confirmed = await replay(pending);
  await clearConfirmed(pending.idempotencyKey);
  return confirmed;
}
