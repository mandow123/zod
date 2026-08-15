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
  const normalized = value.trim().replace(/^0+(?=\d)/u, '');
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return micros > 0n ? micros : null;
}
