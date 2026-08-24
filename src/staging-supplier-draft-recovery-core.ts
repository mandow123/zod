import type { StagingSupplierDraft, StagingSupplierDraftPayload } from './staging-supplier-drafts-api';

export type PendingStagingSupplierDraft = Readonly<{
  operation: 'create' | 'update';
  clientDraftId: string;
  draftId: string | null;
  expectedVersion: number | null;
  payload: StagingSupplierDraftPayload;
  signature: string;
  idempotencyKey: string;
  principalFingerprint: string;
}>;

export function assertStagingSupplierDraftPrincipal(
  pending: PendingStagingSupplierDraft,
  principalFingerprint: string,
) {
  if (!/^[a-f0-9]{64}$/u.test(principalFingerprint)
    || pending.principalFingerprint !== principalFingerprint) {
    throw new Error('待确认测试资源草稿属于其他测试账号，已禁止读取、重放或覆盖。');
  }
  return pending;
}

export async function replayPendingStagingSupplierDraft(
  pending: PendingStagingSupplierDraft,
  principalFingerprint: string,
  replay: (pending: PendingStagingSupplierDraft) => Promise<StagingSupplierDraft>,
  clearConfirmed: (idempotencyKey: string) => Promise<void>,
) {
  assertStagingSupplierDraftPrincipal(pending, principalFingerprint);
  const confirmed = await replay(pending);
  await clearConfirmed(pending.idempotencyKey);
  return confirmed;
}
