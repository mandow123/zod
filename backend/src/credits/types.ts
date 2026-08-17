import { formatCreditCentMicros } from './precision.js';

export const KAI_CREDIT_MICROS = 1_000_000n;
export const KAI_CREDIT_PLATFORM_ACCOUNTS = Object.freeze({
  issuance: '00000000-0000-4000-8000-000000000101',
  clearing: '00000000-0000-4000-8000-000000000102',
  revenue: '00000000-0000-4000-8000-000000000103',
});

export type SubjectCreditAccountKind = 'available' | 'reserved' | 'supplier_receivable'
  | 'supplier_earnings_available' | 'payout_frozen';

export type CreditAccountBalance = Readonly<{
  accountId: string;
  kind: SubjectCreditAccountKind;
  amountMicros: bigint;
}>;

export function formatCreditAmount(value: bigint) {
  return formatCreditCentMicros(value);
}
