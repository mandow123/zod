import { formatCreditCentMicros, quantizeCreditMicros } from '../credits/precision.js';

export type CreditOrderStatus =
  | 'reserved' | 'confirmed' | 'provisioning' | 'ready' | 'in_service' | 'acceptance_pending' | 'accepted'
  | 'cancelled' | 'expired' | 'release_pending' | 'refund_pending' | 'refunded' | 'disputed' | 'closed';

export type CreditOrderRecord = Readonly<{
  id: string;
  orderNumber: string;
  buyerSubjectId: string;
  supplierSubjectId: string;
  createdByUserId: string;
  listingId: string;
  status: CreditOrderStatus;
  quantity: string;
  capacityUnit: string;
  unitCreditMicros: bigint;
  totalCreditMicros: bigint;
  listingSnapshot: Record<string, unknown>;
  reservationExpiresAt: Date;
  confirmedAt: Date | null;
  confirmedByUserId: string | null;
  deliveryStartedAt: Date | null;
  deliveryReadyAt: Date | null;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export function parseCreditOrderQuantity(value: string) {
  const normalized = value.trim().replace(/^0+(?=\d)/u, '');
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/u.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const scaled = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (scaled <= 0n) return null;
  return { normalized: `${whole}.${fraction.padEnd(6, '0')}`, scaled };
}

export function totalCreditMicros(quantityScaled: bigint, unitCreditMicros: bigint) {
  if (quantityScaled <= 0n || unitCreditMicros <= 0n) throw new Error('positive quantity and unit credits are required');
  const exactMicrosRoundedUp = (quantityScaled * unitCreditMicros + 999_999n) / 1_000_000n;
  return quantizeCreditMicros(exactMicrosRoundedUp, 'ceil');
}

export function formatCreditMicros(value: bigint) {
  return formatCreditCentMicros(value);
}

export const SUPPLIER_SETTLEMENT_HOLD_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
