const CREDIT_SCALE = 1_000_000n;
const CREDIT_CENT_SCALE = 10_000n;

export function parseCreditMicros(value: string) {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const micros = BigInt(whole) * CREDIT_SCALE + BigInt(fraction.padEnd(2, '0')) * CREDIT_CENT_SCALE;
  return micros > 0n ? micros : null;
}

export function remainingCreditAmount(total: string, deducted: string) {
  const totalMicros = parseCreditMicros(total);
  const deductedMicros = parseCreditMicros(deducted);
  if (totalMicros === null || deductedMicros === null) return total;
  if (deductedMicros >= totalMicros) return '0';
  const remaining = totalMicros - deductedMicros;
  return `${remaining / CREDIT_SCALE}.${((remaining % CREDIT_SCALE) / CREDIT_CENT_SCALE).toString().padStart(2, '0')}`;
}
