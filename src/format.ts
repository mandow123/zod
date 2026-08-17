export function compactDecimal(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return value;
  return normalized.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
}

/** The only formatter for user-visible KAI card-hour amounts. Public values always use two decimals. */
export function creditAmount(value: string, grouped = false) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return '—';
  const [whole, rawFraction = ''] = normalized.split('.');
  if (rawFraction.slice(2).replace(/0/gu, '') !== '') return '—';
  const cents = BigInt(whole) * 100n + BigInt(rawFraction.slice(0, 2).padEnd(2, '0'));
  const wholeText = (cents / 100n).toString();
  const displayedWhole = grouped ? wholeText.replace(/\B(?=(\d{3})+(?!\d))/gu, ',') : wholeText;
  return `${displayedWhole}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export function creditUnitPrice(value: string) {
  return creditAmount(value);
}

export function cnyPrice(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return value;
  const [whole, fraction = ''] = normalized.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

function decimalMicros(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/u.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/** 1 KAI card-hour = CNY 1.002, rounded to the nearest fen using integer arithmetic. */
export function creditToCnyEstimate(value: string) {
  const micros = decimalMicros(value);
  if (micros === null) return null;
  const denominator = 10_000_000n;
  const cents = (micros * 1_002n + denominator / 2n) / denominator;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/**
 * Integer-yuan recharge preview using the same contract as the backend:
 * CNY / 1.002, then floor once to the 0.01 card-hour settlement unit.
 */
export function cnyYuanToCreditEstimate(yuan: number) {
  if (!Number.isSafeInteger(yuan) || yuan < 0) return null;
  const creditCents = BigInt(yuan) * 100_000n / 1_002n;
  return `${creditCents / 100n}.${(creditCents % 100n).toString().padStart(2, '0')}`;
}
