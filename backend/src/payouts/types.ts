import { parseCreditCentMicros } from '../credits/precision.js';

export type CreditPayoutStatus =
  | 'submitted' | 'reviewing' | 'paying' | 'succeeded' | 'failed' | 'rejected' | 'cancelled';

export type CreditPayoutRecord = Readonly<{
  id: string;
  payoutNumber: string;
  subjectId: string;
  requestedByUserId: string;
  status: CreditPayoutStatus;
  creditMicros: bigint;
  conversionCnyMicrosPerCredit: bigint;
  cnyMicros: bigint;
  paymentAmountCents: bigint;
  payoutAccountId: string;
  freezeTransactionId: string;
  resolutionTransactionId: string | null;
  companyPaymentReference: string | null;
  companyPaymentFlowDigest: string | null;
  companyPaymentAmountCents: bigint | null;
  failureCode: string | null;
  resolutionReason: string | null;
  supplierEarningsBeforeMicros: bigint;
  supplierEarningsAfterMicros: bigint;
  frozenBeforeMicros: bigint;
  frozenAfterMicros: bigint;
  resolutionSupplierEarningsBeforeMicros: bigint | null;
  resolutionSupplierEarningsAfterMicros: bigint | null;
  resolutionFrozenBeforeMicros: bigint | null;
  resolutionFrozenAfterMicros: bigint | null;
  reviewedAt: Date | null;
  payingAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type CreditPayoutProfile = Readonly<{
  subjectId: string;
  status: 'pending_activation' | 'active' | 'suspended';
  legalEntityDigest: string | null;
  recipientReference: string | null;
  activatedAt: Date | null;
}>;

export function parseCreditMicros(value: string) {
  return parseCreditCentMicros(value);
}
