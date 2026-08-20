export type StagingProfileMutation = Readonly<{
  operation: 'create_ssh_key' | 'rename_ssh_key' | 'revoke_ssh_key' | 'submit_manual_delivery';
  signature: string; idempotencyKey: string; principalFingerprint: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export function assertStagingProfileMutationPrincipal(pending: StagingProfileMutation, principalFingerprint: string) {
  if (!/^[a-f0-9]{64}$/u.test(principalFingerprint)
    || pending.principalFingerprint !== principalFingerprint) {
    throw new Error('待确认安全操作属于其他测试账号，已禁止读取、重放或覆盖。');
  }
  return pending;
}

export async function replayStagingProfileMutation<T>(pending: StagingProfileMutation, principalFingerprint: string,
  replay: (pending: StagingProfileMutation) => Promise<T>, clearConfirmed: (key: string) => Promise<void>) {
  assertStagingProfileMutationPrincipal(pending, principalFingerprint);
  const result = await replay(pending);
  await clearConfirmed(pending.idempotencyKey);
  return result;
}
