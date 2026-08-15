/** Human-readable KAI credit value. Persistence and API DTOs continue to use six decimals. */
export function formatCreditDisplayMicros(value: bigint) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const cents = (absolute + 5_000n) / 10_000n;
  const displayed = `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  return negative ? `-${displayed}` : displayed;
}
