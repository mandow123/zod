export const TOPUP_MIN_CENTS = 100;
export const TOPUP_MAX_CENTS = 10_000_000;

export type TopupAmountValidation = Readonly<{
  amountCents: number | null;
  error: string | null;
}>;

/** Parses a checkout-only CNY amount without using binary floating-point arithmetic. */
export function parseTopupAmount(value: string): TopupAmountValidation {
  const normalized = value.trim();
  if (!normalized) return { amountCents: null, error: null };
  if (!/^\d+(?:\.\d{0,2})?$/u.test(normalized)) {
    return { amountCents: null, error: '实付金额最多保留两位小数。' };
  }
  const [whole, fraction = ''] = normalized.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents < BigInt(TOPUP_MIN_CENTS) || cents > BigInt(TOPUP_MAX_CENTS)) {
    return { amountCents: null, error: '充值金额需为 1.00 至 100000.00 元。' };
  }
  return { amountCents: Number(cents), error: null };
}

/** Mirrors backend creditMicrosForTopup: divide by 1.002, then floor to one card-hour cent. */
export function estimateTopupCardHourCents(amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents < TOPUP_MIN_CENTS || amountCents > TOPUP_MAX_CENTS) return null;
  return Math.floor(amountCents * 1000 / 1002);
}

export function centsText(cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0) return '—';
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function topupQuote(value: string) {
  const parsed = parseTopupAmount(value);
  if (parsed.amountCents === null) return { ...parsed, cardHourCents: null, cardHours: null };
  const cardHourCents = estimateTopupCardHourCents(parsed.amountCents);
  return { ...parsed, cardHourCents, cardHours: cardHourCents === null ? null : centsText(cardHourCents) };
}
