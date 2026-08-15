export const KAI_CREDIT_MICROS = 1_000_000n;
export const KAI_CREDIT_PLATFORM_ACCOUNTS = Object.freeze({
  issuance: '00000000-0000-4000-8000-000000000101',
  clearing: '00000000-0000-4000-8000-000000000102',
  revenue: '00000000-0000-4000-8000-000000000103',
});

export type SubjectCreditAccountKind = 'available' | 'reserved' | 'supplier_receivable';

export type CreditAccountBalance = Readonly<{
  accountId: string;
  kind: SubjectCreditAccountKind;
  amountMicros: bigint;
}>;

export function formatCreditAmount(value: bigint) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const whole = absolute / KAI_CREDIT_MICROS;
  const fraction = (absolute % KAI_CREDIT_MICROS).toString().padStart(6, '0');
  return `${sign}${whole}.${fraction}`;
}

