export type PendingStagingTopup = Readonly<{
  amount: string;
  idempotencyKey: string;
  principalFingerprint: string;
}>;

export function assertStagingTopupPrincipal(pending: PendingStagingTopup, principalFingerprint: string) {
  if (!/^[a-f0-9]{64}$/u.test(principalFingerprint)
    || pending.principalFingerprint !== principalFingerprint) {
    throw new Error('待确认支付属于其他测试账号，已禁止读取、重放或覆盖。');
  }
  return pending;
}

export async function replayPendingStagingTopup<T>(
  pending: PendingStagingTopup,
  principalFingerprint: string,
  replay: (pending: PendingStagingTopup) => Promise<T>,
  clearConfirmed: (idempotencyKey: string) => Promise<void>,
) {
  assertStagingTopupPrincipal(pending, principalFingerprint);
  const confirmed = await replay(pending);
  await clearConfirmed(pending.idempotencyKey);
  return confirmed;
}
