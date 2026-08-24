import type { QixiangCheckoutCiphertext } from '../payment/qixiang-checkout-crypto.js';

export type QixiangTopupStatus =
  | 'created' | 'pending' | 'verifying' | 'succeeded' | 'failed' | 'expired' | 'manual_review';

export type QixiangTopupRecord = Readonly<{
  id: string;
  subjectId: string;
  createdByUserId: string;
  clientRequestId: string;
  payloadDigest: string;
  providerReference: string;
  providerPaymentId: string | null;
  providerTransactionId: string | null;
  status: QixiangTopupStatus;
  version: number;
  amountCents: number;
  cardHourCents: number;
  creditMicros: bigint;
  checkout: QixiangCheckoutCiphertext | null;
  checkoutExpiresAt: Date;
  entitlementExpiresAt: Date | null;
  succeededAt: Date | null;
  lastCheckedAt: Date | null;
  nextReconcileAt: Date;
  reconciliationAttempts: number;
  reconciliationDeadLetteredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type QixiangCursor = Readonly<{ createdAt: Date; id: string }>;

export type QixiangCreatePreparation =
  | Readonly<{ status: 'created' | 'replayed'; topup: QixiangTopupRecord }>
  | Readonly<{ status: 'conflict' }>;

export type QixiangMutationResult =
  | Readonly<{ status: 'updated' | 'replayed'; topup: QixiangTopupRecord }>
  | Readonly<{ status: 'conflict' | 'not_found' | 'version_conflict' }>;

export type QixiangQueryAttempt = Readonly<{
  attemptId: string;
  claimedAt: Date;
  topup: QixiangTopupRecord;
}>;

export type QixiangQueryProcessingResult =
  | Readonly<{ status: 'pending' | 'verifying' | 'expired' | 'succeeded' | 'manual_review' | 'duplicate'; topup: QixiangTopupRecord }>
  | Readonly<{ status: 'stale' }>;
