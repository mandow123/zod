import { formatCreditCentMicros } from './precision.js';

/** Human-readable KAI credit value. */
export function formatCreditDisplayMicros(value: bigint) {
  return formatCreditCentMicros(value);
}
