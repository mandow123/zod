export function compactDecimal(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return value;
  return normalized.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
}

/** The only formatter for user-visible KAI credit amounts. Ledger/API values stay at 6 decimals. */
export function creditAmount(value: string, grouped = false) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return value;
  const [whole, rawFraction = ''] = normalized.split('.');
  const fraction = rawFraction.padEnd(3, '0');
  let cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1n;
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

/** Integer-yuan recharge preview converted to card-hours without binary floating point. */
export function cnyYuanToCreditEstimate(yuan: number) {
  if (!Number.isSafeInteger(yuan) || yuan < 0) return null;
  const micros = (BigInt(yuan) * 1_000n * 1_000_000n + 501n) / 1_002n;
  return creditAmount(`${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, '0')}`);
}
