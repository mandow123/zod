import { formatCreditCentMicros, parseCreditCentMicros, quantizeCreditMicros } from '../credits/precision.js';

export const KAI_CNY_MICROS_PER_CREDIT = 1_002_000n;

export type OfferStatus = 'draft' | 'under_review' | 'changes_requested' | 'approved' | 'rejected' | 'suspended' | 'expired';
export type AuditKind = 'resource' | 'price';
export type AuditStatus = 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'expired' | 'cancelled';
export type ServiceMode = 'dedicated' | 'shared' | 'slice' | 'node' | 'reserved';
export type OfferWizardStep = 'service' | 'terms' | 'price' | 'review';

export type OfferWizardPayload = Readonly<{
  title?: string | undefined;
  serviceMode?: ServiceMode | undefined;
  nativeUnit?: string | undefined;
  minimumQuantity?: string | undefined;
  sla?: Record<string, unknown> | undefined;
  deliveryTerms?: Record<string, unknown> | undefined;
  acceptanceTerms?: Record<string, unknown> | undefined;
  refundTerms?: Record<string, unknown> | undefined;
  cleanupTerms?: Record<string, unknown> | undefined;
  suggestedUnitCredits?: string | undefined;
  priceComponents?: Record<string, unknown> | undefined;
  priceEvidence?: unknown[] | undefined;
}>;

export type OfferWizardDraft = Readonly<{
  id: string;
  supplierId: string;
  resourceId: string;
  resourceName: string;
  resourceKind: string;
  capacityUnit: string;
  version: number;
  currentStep: OfferWizardStep;
  payload: OfferWizardPayload;
  status: 'active' | 'submitted' | 'abandoned';
  convertedOfferId: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type OfferTemplate = Readonly<{
  id: string;
  supplierId: string;
  resourceId: string;
  version: number;
  submissionVersion: number;
  title: string;
  serviceMode: ServiceMode;
  nativeUnit: string;
  minimumQuantity: string;
  sla: Record<string, unknown>;
  deliveryTerms: Record<string, unknown>;
  acceptanceTerms: Record<string, unknown>;
  refundTerms: Record<string, unknown>;
  cleanupTerms: Record<string, unknown>;
  suggestedUnitCreditMicros: bigint;
  suggestedPriceCnyMicros: bigint;
  priceComponents: Record<string, unknown>;
  priceEvidence: unknown[];
  status: OfferStatus;
  approvedReferenceCnyMicros: bigint | null;
  approvedUnitCreditMicros: bigint | null;
  conversionCnyMicrosPerCredit: bigint | null;
  auditValidUntil: Date | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type OfferAudit = Readonly<{
  id: string;
  offerId: string;
  submissionVersion: number;
  kind: AuditKind;
  status: AuditStatus;
  reviewerId: string | null;
  decisionReason: string | null;
  evidenceSummary: string | null;
  evidenceDigest: string | null;
  decisionDigest: string | null;
  approvedReferenceCnyMicros: bigint | null;
  conversionCnyMicrosPerCredit: bigint | null;
  approvedUnitCreditMicros: bigint | null;
  validUntil: Date | null;
  createdAt: Date;
  decidedAt: Date | null;
  returnStep: 'service' | 'terms' | 'price' | null;
}>;

export type OfferRevisionDraft = Readonly<{
  id: string;
  offerId: string;
  supplierId: string;
  resourceId: string;
  resourceName: string;
  resourceKind: string;
  capacityUnit: string;
  sourceOfferVersion: number;
  version: number;
  currentStep: OfferWizardStep;
  payload: OfferWizardPayload;
  status: 'active' | 'submitted';
  submittedSubmissionVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type CreditListing = Readonly<{
  id: string;
  offerId: string;
  resourceId: string;
  supplierId: string;
  capacityTotal: string;
  capacityReserved: string;
  capacitySold: string;
  capacityUnit: string;
  minimumQuantity: string;
  unitCreditMicros: bigint;
  referenceCnyMicros: bigint;
  conversionCnyMicrosPerCredit: bigint;
  status: 'active' | 'paused' | 'sold_out' | 'expired' | 'withdrawn' | 'suspended';
  startsAt: Date;
  expiresAt: Date;
  auditValidUntil: Date;
  createdAt: Date;
}>;

export type PublicCreditListing = CreditListing & Readonly<{
  supplierSubjectId: string;
  title: string;
  serviceMode: ServiceMode;
  productCode: string;
  kind: 'gpu' | 'token_capacity' | 'token_usage' | 'rack' | 'storage' | 'apple_silicon';
  region: string;
  specifications: Record<string, unknown>;
  sla: Record<string, unknown>;
  capacityAvailable: string;
}>;

export function creditMicrosFromCnyMicros(cnyMicros: bigint, rate = KAI_CNY_MICROS_PER_CREDIT) {
  if (cnyMicros <= 0n || rate <= 0n) throw new Error('positive price and conversion rate are required');
  return quantizeCreditMicros((cnyMicros * 1_000_000n + rate / 2n) / rate, 'half_up');
}

export function cnyMicrosFromCreditMicros(creditMicros: bigint, rate = KAI_CNY_MICROS_PER_CREDIT) {
  if (creditMicros <= 0n || rate <= 0n) throw new Error('positive price and conversion rate are required');
  return (creditMicros * rate + 500_000n) / 1_000_000n;
}

export function parseCreditMicros(value: string) {
  return parseCreditCentMicros(value);
}

export function formatCreditMicros(value: bigint) {
  return formatCreditCentMicros(value);
}

export function formatCnyMicros(value: bigint) {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

export function parseCnyMicros(value: string) {
  const normalized = value.trim().replace(/^0+(?=\d)/u, '');
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return micros > 0n ? micros : null;
}
