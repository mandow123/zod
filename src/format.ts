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
