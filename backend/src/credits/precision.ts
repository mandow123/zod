export const KAI_CREDIT_CENT_MICROS = 10_000n;

export function isCreditCentAligned(value: bigint) {
  return value % KAI_CREDIT_CENT_MICROS === 0n;
}

export function quantizeCreditMicros(
  value: bigint,
  mode: 'floor' | 'ceil' | 'half_up' = 'half_up',
): bigint {
  if (value < 0n) return -quantizeCreditMicros(-value, mode === 'floor' ? 'ceil' : mode === 'ceil' ? 'floor' : mode);
  const remainder = value % KAI_CREDIT_CENT_MICROS;
  if (remainder === 0n) return value;
  const base = value - remainder;
  if (mode === 'floor') return base;
  if (mode === 'ceil') return base + KAI_CREDIT_CENT_MICROS;
  return remainder * 2n >= KAI_CREDIT_CENT_MICROS ? base + KAI_CREDIT_CENT_MICROS : base;
}

export function parseCreditCentMicros(value: string) {
  const normalized = value.trim().replace(/^0+(?=\d)/u, '');
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(2, '0')) * KAI_CREDIT_CENT_MICROS;
  return micros > 0n ? micros : null;
}

export function formatCreditCentMicros(value: bigint) {
  if (!isCreditCentAligned(value)) throw new Error('KAI_CREDIT_CENT_ALIGNMENT_REQUIRED');
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 1_000_000n}.${((absolute % 1_000_000n) / KAI_CREDIT_CENT_MICROS).toString().padStart(2, '0')}`;
}
