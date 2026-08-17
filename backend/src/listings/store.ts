import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Database } from '../database.js';
import type {
  AuditKind, CreditListing, OfferAudit, OfferRevisionDraft, OfferStatus, OfferTemplate, OfferWizardDraft, OfferWizardPayload, PublicCreditListing,
  OfferWizardStep, ServiceMode,
} from './types.js';
import { formatCreditMicros } from './types.js';

type OfferRow = QueryResultRow & {
  id: string; supplier_id: string; resource_id: string; version: number; submission_version: number;
  title: string; service_mode: ServiceMode; native_unit: string; minimum_quantity: string;
  sla: Record<string, unknown>; delivery_terms: Record<string, unknown>; acceptance_terms: Record<string, unknown>;
  refund_terms: Record<string, unknown>; cleanup_terms: Record<string, unknown>; suggested_unit_credit_micros: string;
  suggested_price_cny_micros: string;
  price_components: Record<string, unknown>; price_evidence: unknown[]; status: OfferStatus;
  approved_reference_cny_micros: string | null; approved_unit_credit_micros: string | null;
  conversion_cny_micros_per_credit: string | null; audit_valid_until: Date | null; submitted_at: Date | null;
  approved_at: Date | null; created_at: Date; updated_at: Date;
};

type AuditRow = QueryResultRow & {
  id: string; offer_id: string; submission_version: number; kind: AuditKind; status: OfferAudit['status'];
  reviewer_id: string | null; decision_reason: string | null; evidence_summary: string | null;
  evidence_digest: string | null; decision_digest: string | null; approved_reference_cny_micros: string | null;
  conversion_cny_micros_per_credit: string | null; approved_unit_credit_micros: string | null;
  valid_until: Date | null; return_step: OfferAudit['returnStep']; created_at: Date; decided_at: Date | null;
};

type ListingRow = QueryResultRow & {
  id: string; offer_id: string; resource_id: string; supplier_id: string; capacity_total: string;
  capacity_reserved: string; capacity_sold: string;
  capacity_unit: string; minimum_quantity: string; unit_credit_micros: string; reference_cny_micros: string;
  conversion_cny_micros_per_credit: string; status: CreditListing['status']; starts_at: Date; expires_at: Date;
  audit_valid_until: Date; created_at: Date;
};

type PublicListingRow = ListingRow & {
  supplier_subject_id: string;
  title: string; service_mode: ServiceMode; product_code: string; kind: PublicCreditListing['kind']; region: string;
  specifications: Record<string, unknown>; sla: Record<string, unknown>; capacity_available: string;
};

type WizardDraftRow = QueryResultRow & {
  id: string; supplier_id: string; resource_id: string; product_code: string; kind: string; capacity_unit: string;
  version: number; current_step: OfferWizardStep; payload: OfferWizardPayload; status: 'active' | 'submitted' | 'abandoned';
  converted_offer_id: string | null; created_at: Date; updated_at: Date;
};

type RevisionDraftRow = QueryResultRow & {
  id: string; offer_id: string; supplier_id: string; resource_id: string; product_code: string; kind: string;
  capacity_unit: string; source_offer_version: number; version: number; current_step: OfferWizardStep;
  payload: OfferWizardPayload; status: 'active' | 'submitted'; submit_request_id: string | null;
  submit_payload_digest: string | null; submitted_submission_version: number | null; created_at: Date; updated_at: Date;
};

const offerColumns = `id, supplier_id, resource_id, version, submission_version, title, service_mode, native_unit,
  minimum_quantity::text, sla, delivery_terms, acceptance_terms, refund_terms, cleanup_terms,
  suggested_unit_credit_micros::text, suggested_price_cny_micros::text, price_components, price_evidence, status,
  approved_reference_cny_micros::text, approved_unit_credit_micros::text,
  conversion_cny_micros_per_credit::text, audit_valid_until, submitted_at, approved_at, created_at, updated_at`;
const auditColumns = `id, offer_id, submission_version, kind, status, reviewer_id, decision_reason,
  evidence_summary, evidence_digest, decision_digest, approved_reference_cny_micros::text,
  conversion_cny_micros_per_credit::text, approved_unit_credit_micros::text, valid_until, return_step, created_at, decided_at`;
const listingColumns = `id, offer_id, resource_id, supplier_id, capacity_total::text, capacity_reserved::text,
  capacity_sold::text, capacity_unit,
  minimum_quantity::text, unit_credit_micros::text, reference_cny_micros::text,
  conversion_cny_micros_per_credit::text, status, starts_at, expires_at,
  (audit_snapshot->>'validUntil')::timestamptz AS audit_valid_until, created_at`;
const joinedListingColumns = `l.id, l.offer_id, l.resource_id, l.supplier_id, l.capacity_total::text,
  l.capacity_reserved::text, l.capacity_sold::text, l.capacity_unit,
  l.minimum_quantity::text, l.unit_credit_micros::text, l.reference_cny_micros::text,
  l.conversion_cny_micros_per_credit::text, l.status, l.starts_at, l.expires_at,
  (l.audit_snapshot->>'validUntil')::timestamptz AS audit_valid_until, l.created_at`;
const publicListingColumns = `${joinedListingColumns}, s.subject_id AS supplier_subject_id,
  o.title, o.service_mode, o.sla, r.product_code, r.kind,
  r.region, r.specifications,
  GREATEST(l.capacity_total - l.capacity_reserved - l.capacity_sold, 0)::text AS capacity_available`;

function mapOffer(row: OfferRow): OfferTemplate {
  return {
    id: row.id, supplierId: row.supplier_id, resourceId: row.resource_id, version: row.version,
    submissionVersion: row.submission_version, title: row.title, serviceMode: row.service_mode,
    nativeUnit: row.native_unit, minimumQuantity: row.minimum_quantity, sla: row.sla,
    deliveryTerms: row.delivery_terms, acceptanceTerms: row.acceptance_terms, refundTerms: row.refund_terms,
    cleanupTerms: row.cleanup_terms, suggestedUnitCreditMicros: BigInt(row.suggested_unit_credit_micros),
    suggestedPriceCnyMicros: BigInt(row.suggested_price_cny_micros),
    priceComponents: row.price_components, priceEvidence: row.price_evidence, status: row.status,
    approvedReferenceCnyMicros: row.approved_reference_cny_micros === null ? null : BigInt(row.approved_reference_cny_micros),
    approvedUnitCreditMicros: row.approved_unit_credit_micros === null ? null : BigInt(row.approved_unit_credit_micros),
    conversionCnyMicrosPerCredit: row.conversion_cny_micros_per_credit === null ? null : BigInt(row.conversion_cny_micros_per_credit),
    auditValidUntil: row.audit_valid_until ? new Date(row.audit_valid_until) : null,
    submittedAt: row.submitted_at ? new Date(row.submitted_at) : null,
    approvedAt: row.approved_at ? new Date(row.approved_at) : null,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

function mapAudit(row: AuditRow): OfferAudit {
  return {
    id: row.id, offerId: row.offer_id, submissionVersion: row.submission_version, kind: row.kind,
    status: row.status, reviewerId: row.reviewer_id, decisionReason: row.decision_reason,
    evidenceSummary: row.evidence_summary, evidenceDigest: row.evidence_digest, decisionDigest: row.decision_digest,
    approvedReferenceCnyMicros: row.approved_reference_cny_micros === null ? null : BigInt(row.approved_reference_cny_micros),
    conversionCnyMicrosPerCredit: row.conversion_cny_micros_per_credit === null ? null : BigInt(row.conversion_cny_micros_per_credit),
    approvedUnitCreditMicros: row.approved_unit_credit_micros === null ? null : BigInt(row.approved_unit_credit_micros),
    validUntil: row.valid_until ? new Date(row.valid_until) : null, returnStep: row.return_step, createdAt: new Date(row.created_at),
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
  };
}

function mapListing(row: ListingRow): CreditListing {
  return {
    id: row.id, offerId: row.offer_id, resourceId: row.resource_id, supplierId: row.supplier_id,
    capacityTotal: row.capacity_total, capacityUnit: row.capacity_unit, minimumQuantity: row.minimum_quantity,
    capacityReserved: row.capacity_reserved, capacitySold: row.capacity_sold,
    unitCreditMicros: BigInt(row.unit_credit_micros), referenceCnyMicros: BigInt(row.reference_cny_micros),
    conversionCnyMicrosPerCredit: BigInt(row.conversion_cny_micros_per_credit), status: row.status,
    startsAt: new Date(row.starts_at), expiresAt: new Date(row.expires_at),
    auditValidUntil: new Date(row.audit_valid_until), createdAt: new Date(row.created_at),
  };
}

function mapPublicListing(row: PublicListingRow): PublicCreditListing {
  return {
    ...mapListing(row), supplierSubjectId: row.supplier_subject_id,
    title: row.title, serviceMode: row.service_mode, productCode: row.product_code,
    kind: row.kind, region: row.region, specifications: row.specifications, sla: row.sla,
    capacityAvailable: row.capacity_available,
  };
}

function mapWizardDraft(row: WizardDraftRow): OfferWizardDraft {
  return {
    id: row.id, supplierId: row.supplier_id, resourceId: row.resource_id, resourceName: row.product_code,
    resourceKind: row.kind, capacityUnit: row.capacity_unit, version: row.version, currentStep: row.current_step,
    payload: row.payload, status: row.status, convertedOfferId: row.converted_offer_id,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

const wizardDraftColumns = `d.id, d.supplier_id, d.resource_id, r.product_code, r.kind, r.capacity_unit,
  d.version, d.current_step, d.payload, d.status, d.converted_offer_id, d.created_at, d.updated_at`;
const revisionDraftColumns = `d.id, d.offer_id, d.supplier_id, d.resource_id, r.product_code, r.kind, r.capacity_unit,
  d.source_offer_version, d.version, d.current_step, d.payload, d.status, d.submit_request_id,
  d.submit_payload_digest, d.submitted_submission_version, d.created_at, d.updated_at`;

function mapRevisionDraft(row: RevisionDraftRow): OfferRevisionDraft {
  return {
    id: row.id, offerId: row.offer_id, supplierId: row.supplier_id, resourceId: row.resource_id,
    resourceName: row.product_code, resourceKind: row.kind, capacityUnit: row.capacity_unit,
    sourceOfferVersion: row.source_offer_version, version: row.version, currentStep: row.current_step,
    payload: row.payload, status: row.status, submittedSubmissionVersion: row.submitted_submission_version,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

function publicPriceComponents(value: Record<string, unknown>) {
  const { authoritativeUnitCreditMicros: _legacyInternalPrice, ...publicValue } = value;
  return publicValue;
}

export type CreateOfferResult = Readonly<{ status: 'created' | 'replayed'; offer: OfferTemplate }> | Readonly<{ status: 'conflict' }>;
export type CreateWizardDraftResult = Readonly<{ status: 'created' | 'replayed'; draft: OfferWizardDraft }>
  | Readonly<{ status: 'conflict' }>
  | Readonly<{ status: 'listing_active' }>;
export type SubmitWizardDraftResult = Readonly<{ status: 'created' | 'replayed'; offer: OfferTemplate; audits: OfferAudit[] }>
  | Readonly<{ status: 'conflict' | 'not_submittable' }>;
export type AbandonWizardDraftResult = 'abandoned' | 'not_found' | 'conflict';
export type SubmitOfferResult = Readonly<{
  status: 'created' | 'replayed'; offer: OfferTemplate; audits: OfferAudit[];
}>;
export type SubmitOfferRevisionResult = SubmitOfferResult | Readonly<{ status: 'conflict' | 'not_submittable' }>;
export type CreateOfferRevisionResult = Readonly<{ status: 'created' | 'replayed'; draft: OfferRevisionDraft }>
  | Readonly<{ status: 'conflict' }>;
export type PublishListingResult = Readonly<{ status: 'created' | 'replayed'; listing: CreditListing }>
  | Readonly<{ status: 'conflict' }>
  | Readonly<{ status: 'not_approved' }>
  | Readonly<{ status: 'resource_not_ready' }>
  | Readonly<{ status: 'audit_expired' }>
  | Readonly<{ status: 'minimum_not_met' }>
  | Readonly<{ status: 'capacity_unavailable' }>
  | Readonly<{ status: 'window_conflict' }>;
export type ListingWindowAvailabilityResult = Readonly<{
  status: 'available' | 'window_conflict';
  resourceId: string;
  capacityTotal: string;
  capacityUnit: string;
  minimumQuantity: string;
  auditValidUntil: Date;
  requestedStartsAt: Date;
  requestedExpiresAt: Date;
  blockingStartsAt: Date | null;
  blockingExpiresAt: Date | null;
  nextAvailableAt: Date | null;
}> | Readonly<{ status: 'not_approved' }> | Readonly<{ status: 'resource_not_ready' }> | Readonly<{ status: 'audit_expired' }>;
export type SetListingStatusResult = Readonly<{ status: 'updated' | 'replayed'; listing: CreditListing }>
  | Readonly<{ status: 'not_found' | 'invalid_transition' | 'expired' | 'reserved_capacity' | 'approval_invalid' | 'resource_not_ready' | 'capacity_unavailable' }>;

export interface ListingAuditStore {
  synchronizeExpirations(subjectId: string): Promise<void>;
  createOfferRevision(input: Readonly<{
    id: string; subjectId: string; userId: string; offerId: string; clientRequestId: string;
  }>): Promise<CreateOfferRevisionResult | null>;
  getOfferRevision(subjectId: string, offerId: string): Promise<OfferRevisionDraft | null>;
  updateOfferRevision(input: Readonly<{
    subjectId: string; offerId: string; expectedVersion: number; currentStep: OfferWizardStep; payload: OfferWizardPayload;
  }>): Promise<OfferRevisionDraft | null>;
  submitOfferRevision(input: Readonly<{
    subjectId: string; userId: string; offerId: string; expectedVersion: number; submitRequestId: string;
    submitPayloadDigest: string; title: string; serviceMode: ServiceMode; nativeUnit: string; minimumQuantity: string;
    sla: Record<string, unknown>; deliveryTerms: Record<string, unknown>; acceptanceTerms: Record<string, unknown>;
    refundTerms: Record<string, unknown>; cleanupTerms: Record<string, unknown>; suggestedUnitCreditMicros: bigint;
    suggestedPriceCnyMicros: bigint;
    priceComponents: Record<string, unknown>; priceEvidence: unknown[];
  }>): Promise<SubmitOfferRevisionResult>;
  createWizardDraft(input: Readonly<{
    id: string; subjectId: string; userId: string; resourceId: string; clientRequestId: string; payloadDigest: string;
  }>): Promise<CreateWizardDraftResult | null>;
  listWizardDrafts(subjectId: string): Promise<OfferWizardDraft[]>;
  getWizardDraft(subjectId: string, draftId: string): Promise<OfferWizardDraft | null>;
  updateWizardDraft(input: Readonly<{
    subjectId: string; draftId: string; expectedVersion: number; currentStep: OfferWizardStep; payload: OfferWizardPayload;
  }>): Promise<OfferWizardDraft | null>;
  abandonWizardDraft(input: Readonly<{
    subjectId: string; userId: string; draftId: string; expectedVersion: number;
  }>): Promise<AbandonWizardDraftResult>;
  submitWizardDraft(input: Readonly<{
    subjectId: string; userId: string; draftId: string; expectedVersion: number; submitRequestId: string;
    submitPayloadDigest: string; title: string; serviceMode: ServiceMode; nativeUnit: string; minimumQuantity: string;
    sla: Record<string, unknown>; deliveryTerms: Record<string, unknown>; acceptanceTerms: Record<string, unknown>;
    refundTerms: Record<string, unknown>; cleanupTerms: Record<string, unknown>; suggestedUnitCreditMicros: bigint;
    suggestedPriceCnyMicros: bigint;
    priceComponents: Record<string, unknown>; priceEvidence: unknown[];
  }>): Promise<SubmitWizardDraftResult>;
  createOffer(input: Readonly<{
    id: string; subjectId: string; userId: string; resourceId: string; clientRequestId: string; payloadDigest: string;
    title: string; serviceMode: ServiceMode; nativeUnit: string; minimumQuantity: string;
    sla: Record<string, unknown>; deliveryTerms: Record<string, unknown>; acceptanceTerms: Record<string, unknown>;
    refundTerms: Record<string, unknown>; cleanupTerms: Record<string, unknown>; suggestedUnitCreditMicros: bigint;
    suggestedPriceCnyMicros: bigint;
    priceComponents: Record<string, unknown>; priceEvidence: unknown[];
  }>): Promise<CreateOfferResult | null>;
  updateOffer(input: Readonly<{
    subjectId: string; userId: string; offerId: string; expectedVersion: number; title: string; serviceMode: ServiceMode; nativeUnit: string; minimumQuantity: string;
    sla: Record<string, unknown>; deliveryTerms: Record<string, unknown>; acceptanceTerms: Record<string, unknown>;
    refundTerms: Record<string, unknown>; cleanupTerms: Record<string, unknown>; suggestedUnitCreditMicros: bigint;
    suggestedPriceCnyMicros: bigint;
    priceComponents: Record<string, unknown>; priceEvidence: unknown[];
  }>): Promise<OfferTemplate | null>;
  submitOffer(subjectId: string, userId: string, offerId: string, expectedVersion: number): Promise<SubmitOfferResult | null>;
  listSupplierOffers(subjectId: string): Promise<Array<{ offer: OfferTemplate; audits: OfferAudit[] }>>;
  getSupplierOffer(subjectId: string, offerId: string): Promise<{ offer: OfferTemplate; audits: OfferAudit[] } | null>;
  decideAudit(input: Readonly<{
    reviewerId: string; offerId: string; kind: AuditKind; approved: boolean; changesRequested: boolean;
    decisionReason: string; evidenceSummary: string; evidenceDigest: string; decisionDigest: string;
    validUntil?: Date; approvedReferenceCnyMicros?: bigint; conversionCnyMicrosPerCredit?: bigint;
    approvedUnitCreditMicros?: bigint;
    returnStep?: 'service' | 'terms' | 'price';
  }>): Promise<{ offer: OfferTemplate; audits: OfferAudit[] } | null | 'four_eyes_violation' | 'self_review_violation'>;
  publishListing(input: Readonly<{
    id: string; subjectId: string; userId: string; offerId: string; clientRequestId: string; payloadDigest: string;
    capacityTotal: string; startsAt: Date; expiresAt: Date;
  }>): Promise<PublishListingResult>;
  listingWindowAvailability(input: Readonly<{
    subjectId: string; offerId: string; startsAt: Date; expiresAt: Date;
  }>): Promise<ListingWindowAvailabilityResult>;
  listSupplierListings(subjectId: string): Promise<CreditListing[]>;
  listPublicListings(limit: number): Promise<PublicCreditListing[]>;
  setListingStatus(input: Readonly<{
    subjectId: string; listingId: string; targetStatus: 'active' | 'paused' | 'withdrawn';
  }>): Promise<SetListingStatusResult>;
}

export class PostgresListingAuditStore implements ListingAuditStore {
  constructor(private readonly database: Database) {}

  async synchronizeExpirations(subjectId: string) {
    await this.database.transaction(async (client) => {
      await this.expireApprovedOffers(client, subjectId);
      await client.query(
        `UPDATE credit_market_listings l SET status = 'expired'
         FROM supplier_profiles s WHERE s.id = l.supplier_id AND s.subject_id = $1
           AND l.status IN ('active', 'paused', 'sold_out') AND l.expires_at <= now()`, [subjectId],
      );
    });
  }

  async createOfferRevision(input: Parameters<ListingAuditStore['createOfferRevision']>[0]): Promise<CreateOfferRevisionResult | null> {
    return this.database.transaction(async (client) => {
      const replay = await client.query<RevisionDraftRow>(
        `SELECT ${revisionDraftColumns} FROM offer_revision_drafts d
         JOIN compute_resources r ON r.id = d.resource_id JOIN supplier_profiles s ON s.id = d.supplier_id
         WHERE s.subject_id = $1 AND d.client_request_id = $2 FOR UPDATE OF d`,
        [input.subjectId, input.clientRequestId],
      );
      if (replay.rows[0]) return replay.rows[0].offer_id === input.offerId
        ? { status: 'replayed', draft: mapRevisionDraft(replay.rows[0]) }
        : { status: 'conflict' };

      const current = await client.query<OfferRow & {
        resource_name: string; resource_kind: string; capacity_unit: string; resource_status: string; supplier_status: string;
      }>(
        `SELECT o.${offerColumns.replaceAll(', ', ', o.')}, r.product_code AS resource_name,
          r.kind AS resource_kind, r.capacity_unit, r.status AS resource_status, s.status AS supplier_status
         FROM offer_templates o JOIN compute_resources r ON r.id = o.resource_id
         JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE o.id = $1 AND s.subject_id = $2 FOR UPDATE OF o`, [input.offerId, input.subjectId],
      );
      const offer = current.rows[0];
      if (!offer || !['changes_requested', 'rejected'].includes(offer.status)
        || offer.resource_status !== 'verified' || offer.supplier_status !== 'approved') return null;

      const active = await client.query<RevisionDraftRow>(
        `SELECT ${revisionDraftColumns} FROM offer_revision_drafts d JOIN compute_resources r ON r.id = d.resource_id
         WHERE d.offer_id = $1 AND d.status = 'active' FOR UPDATE OF d`, [offer.id],
      );
      if (active.rows[0]) return { status: 'replayed', draft: mapRevisionDraft(active.rows[0]) };

      const audits = await this.audits(client, offer.id, offer.submission_version);
      const feedback = audits.find((audit) => ['changes_requested', 'rejected'].includes(audit.status));
      const currentStep: OfferWizardStep = feedback?.returnStep
        ?? (feedback?.kind === 'price' ? 'price' : 'service');
      const payload: OfferWizardPayload = {
        title: offer.title, serviceMode: offer.service_mode, nativeUnit: offer.native_unit,
        minimumQuantity: offer.minimum_quantity, sla: offer.sla, deliveryTerms: offer.delivery_terms,
        acceptanceTerms: offer.acceptance_terms, refundTerms: offer.refund_terms, cleanupTerms: offer.cleanup_terms,
        suggestedUnitCredits: formatCreditMicros(BigInt(offer.suggested_unit_credit_micros)),
        priceComponents: publicPriceComponents(offer.price_components), priceEvidence: offer.price_evidence,
      };
      await client.query(
        `INSERT INTO offer_revision_drafts(id, offer_id, supplier_id, resource_id, created_by,
          client_request_id, source_offer_version, current_step, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [input.id, offer.id, offer.supplier_id, offer.resource_id, input.userId, input.clientRequestId,
          offer.version, currentStep, JSON.stringify(payload)],
      );
      const created = await client.query<RevisionDraftRow>(
        `SELECT ${revisionDraftColumns} FROM offer_revision_drafts d JOIN compute_resources r ON r.id = d.resource_id
         WHERE d.id = $1`, [input.id],
      );
      return { status: 'created', draft: mapRevisionDraft(created.rows[0]!) };
    });
  }

  async getOfferRevision(subjectId: string, offerId: string) {
    const result = await this.database.query<RevisionDraftRow>(
      `SELECT ${revisionDraftColumns} FROM offer_revision_drafts d JOIN compute_resources r ON r.id = d.resource_id
       JOIN supplier_profiles s ON s.id = d.supplier_id
       WHERE s.subject_id = $1 AND d.offer_id = $2
       ORDER BY CASE WHEN d.status = 'active' THEN 0 ELSE 1 END, d.updated_at DESC LIMIT 1`, [subjectId, offerId],
    );
    return result.rows[0] ? mapRevisionDraft(result.rows[0]) : null;
  }

  async updateOfferRevision(input: Parameters<ListingAuditStore['updateOfferRevision']>[0]) {
    const result = await this.database.query<RevisionDraftRow>(
      `UPDATE offer_revision_drafts d SET current_step = $3, payload = $4::jsonb, version = d.version + 1
       FROM supplier_profiles s, compute_resources r, offer_templates o
       WHERE d.offer_id = $1 AND s.subject_id = $2 AND s.id = d.supplier_id AND r.id = d.resource_id
         AND o.id = d.offer_id AND d.status = 'active' AND d.version = $5
         AND o.version = d.source_offer_version AND o.status IN ('changes_requested', 'rejected')
         AND s.status = 'approved' AND r.status = 'verified'
       RETURNING d.id, d.offer_id, d.supplier_id, d.resource_id, r.product_code, r.kind, r.capacity_unit,
         d.source_offer_version, d.version, d.current_step, d.payload, d.status, d.submit_request_id,
         d.submit_payload_digest, d.submitted_submission_version, d.created_at, d.updated_at`,
      [input.offerId, input.subjectId, input.currentStep, JSON.stringify(input.payload), input.expectedVersion],
    );
    return result.rows[0] ? mapRevisionDraft(result.rows[0]) : null;
  }

  async submitOfferRevision(input: Parameters<ListingAuditStore['submitOfferRevision']>[0]): Promise<SubmitOfferRevisionResult> {
    return this.database.transaction(async (client) => {
      const current = await client.query<RevisionDraftRow & {
        offer_version: number; offer_status: OfferStatus; offer_submission_version: number;
        resource_status: string; supplier_status: string;
      }>(
        `SELECT ${revisionDraftColumns}, o.version AS offer_version, o.status AS offer_status,
          o.submission_version AS offer_submission_version, r.status AS resource_status, s.status AS supplier_status
         FROM offer_revision_drafts d JOIN offer_templates o ON o.id = d.offer_id
         JOIN compute_resources r ON r.id = d.resource_id JOIN supplier_profiles s ON s.id = d.supplier_id
         WHERE d.offer_id = $1 AND s.subject_id = $2
         ORDER BY CASE WHEN d.status = 'active' THEN 0 ELSE 1 END, d.updated_at DESC LIMIT 1
         FOR UPDATE OF d, o`, [input.offerId, input.subjectId],
      );
      const draft = current.rows[0];
      if (!draft) return { status: 'not_submittable' };
      if (draft.status === 'submitted') {
        if (draft.submit_request_id !== input.submitRequestId || draft.submit_payload_digest !== input.submitPayloadDigest
          || !draft.submitted_submission_version) return { status: 'conflict' };
        const offer = await client.query<OfferRow>(`SELECT ${offerColumns} FROM offer_templates WHERE id = $1`, [input.offerId]);
        if (!offer.rows[0]) return { status: 'not_submittable' };
        return { status: 'replayed', offer: mapOffer(offer.rows[0]),
          audits: await this.audits(client, input.offerId, draft.submitted_submission_version) };
      }
      if (draft.version !== input.expectedVersion || draft.offer_version !== draft.source_offer_version
        || !['changes_requested', 'rejected'].includes(draft.offer_status)
        || draft.resource_status !== 'verified' || draft.supplier_status !== 'approved'
        || draft.capacity_unit !== input.nativeUnit) return { status: 'not_submittable' };

      const submissionVersion = draft.offer_submission_version + 1;
      const updated = await client.query<OfferRow>(
        `UPDATE offer_templates SET title = $2, service_mode = $3, native_unit = $4, minimum_quantity = $5,
          sla = $6::jsonb, delivery_terms = $7::jsonb, acceptance_terms = $8::jsonb, refund_terms = $9::jsonb,
          cleanup_terms = $10::jsonb, suggested_unit_credit_micros = $11, suggested_price_cny_micros = $12,
          price_components = $13::jsonb, price_evidence = $14::jsonb, submission_version = $15,
          status = 'under_review', submitted_at = now(),
          approved_reference_cny_micros = NULL, approved_unit_credit_micros = NULL,
          conversion_cny_micros_per_credit = NULL, audit_valid_until = NULL, approved_at = NULL, version = version + 1
         WHERE id = $1 RETURNING ${offerColumns}`,
        [input.offerId, input.title, input.serviceMode, input.nativeUnit, input.minimumQuantity,
          JSON.stringify(input.sla), JSON.stringify(input.deliveryTerms), JSON.stringify(input.acceptanceTerms),
          JSON.stringify(input.refundTerms), JSON.stringify(input.cleanupTerms), input.suggestedUnitCreditMicros.toString(),
          input.suggestedPriceCnyMicros.toString(), JSON.stringify(input.priceComponents),
          JSON.stringify(input.priceEvidence), submissionVersion],
      );
      await client.query(
        `INSERT INTO offer_audit_versions(id, offer_id, submission_version, kind, status)
         VALUES ($1, $2, $3, 'resource', 'pending'), ($4, $2, $3, 'price', 'pending')`,
        [randomUUID(), input.offerId, submissionVersion, randomUUID()],
      );
      await client.query(
        `UPDATE offer_revision_drafts SET status = 'submitted', submit_request_id = $2,
          submit_payload_digest = $3, submitted_submission_version = $4, submitted_at = now(), version = version + 1
         WHERE id = $1`, [draft.id, input.submitRequestId, input.submitPayloadDigest, submissionVersion],
      );
      return { status: 'created', offer: mapOffer(updated.rows[0]!), audits: await this.audits(client, input.offerId, submissionVersion) };
    });
  }

  async createWizardDraft(input: Parameters<ListingAuditStore['createWizardDraft']>[0]) {
    return this.database.transaction(async (client) => {
      const replay = await client.query<WizardDraftRow & { payload_digest: string }>(
        `SELECT ${wizardDraftColumns}, d.payload_digest FROM offer_wizard_drafts d
         JOIN compute_resources r ON r.id = d.resource_id JOIN supplier_profiles s ON s.id = d.supplier_id
         WHERE s.subject_id = $1 AND d.client_request_id = $2 FOR UPDATE OF d`, [input.subjectId, input.clientRequestId],
      );
      if (replay.rows[0]) return replay.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed' as const, draft: mapWizardDraft(replay.rows[0]) }
        : { status: 'conflict' as const };
      const resource = await client.query<{ supplier_id: string }>(
        `SELECT r.supplier_id FROM compute_resources r JOIN supplier_profiles s ON s.id = r.supplier_id
         WHERE r.id = $1 AND s.subject_id = $2 AND s.status = 'approved' AND r.status = 'verified' FOR UPDATE OF r`,
        [input.resourceId, input.subjectId],
      );
      if (!resource.rows[0]) return null;
      const activeListing = await client.query<{ id: string }>(
        `SELECT id FROM credit_market_listings
         WHERE supplier_id = $1 AND resource_id = $2 AND status IN ('active', 'paused', 'sold_out')
           AND expires_at > now()
         ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [resource.rows[0].supplier_id, input.resourceId],
      );
      if (activeListing.rows[0]) return { status: 'listing_active' as const };
      const active = await client.query<WizardDraftRow>(
        `SELECT ${wizardDraftColumns} FROM offer_wizard_drafts d JOIN compute_resources r ON r.id = d.resource_id
         WHERE d.supplier_id = $1 AND d.resource_id = $2 AND d.status = 'active'
         ORDER BY d.updated_at DESC LIMIT 1 FOR UPDATE OF d`,
        [resource.rows[0].supplier_id, input.resourceId],
      );
      if (active.rows[0]) return { status: 'replayed' as const, draft: mapWizardDraft(active.rows[0]) };
      const created = await client.query<WizardDraftRow>(
        `INSERT INTO offer_wizard_drafts(id, supplier_id, resource_id, created_by, client_request_id, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, supplier_id, resource_id, '' AS product_code,
           '' AS kind, '' AS capacity_unit, version, current_step, payload, status, converted_offer_id, created_at, updated_at`,
        [input.id, resource.rows[0].supplier_id, input.resourceId, input.userId, input.clientRequestId, input.payloadDigest],
      );
      const result = await client.query<WizardDraftRow>(
        `SELECT ${wizardDraftColumns} FROM offer_wizard_drafts d JOIN compute_resources r ON r.id = d.resource_id WHERE d.id = $1`,
        [created.rows[0]!.id],
      );
      return { status: 'created' as const, draft: mapWizardDraft(result.rows[0]!) };
    });
  }

  async listWizardDrafts(subjectId: string) {
    const result = await this.database.query<WizardDraftRow>(
      `SELECT ${wizardDraftColumns} FROM offer_wizard_drafts d JOIN compute_resources r ON r.id = d.resource_id
       JOIN supplier_profiles s ON s.id = d.supplier_id WHERE s.subject_id = $1 AND d.status = 'active'
       ORDER BY d.updated_at DESC LIMIT 50`, [subjectId],
    );
    return result.rows.map(mapWizardDraft);
  }

  async getWizardDraft(subjectId: string, draftId: string) {
    const result = await this.database.query<WizardDraftRow>(
      `SELECT ${wizardDraftColumns} FROM offer_wizard_drafts d JOIN compute_resources r ON r.id = d.resource_id
       JOIN supplier_profiles s ON s.id = d.supplier_id
       WHERE s.subject_id = $1 AND d.id = $2 AND d.status IN ('active', 'submitted')`, [subjectId, draftId],
    );
    return result.rows[0] ? mapWizardDraft(result.rows[0]) : null;
  }

  async updateWizardDraft(input: Parameters<ListingAuditStore['updateWizardDraft']>[0]) {
    const result = await this.database.query<WizardDraftRow>(
      `UPDATE offer_wizard_drafts d SET current_step = $3, payload = $4::jsonb, version = d.version + 1
       FROM supplier_profiles s, compute_resources r
       WHERE d.id = $1 AND s.subject_id = $2 AND s.id = d.supplier_id AND r.id = d.resource_id
         AND d.status = 'active' AND d.version = $5
       RETURNING d.id, d.supplier_id, d.resource_id, r.product_code, r.kind, r.capacity_unit,
         d.version, d.current_step, d.payload, d.status, d.converted_offer_id, d.created_at, d.updated_at`,
      [input.draftId, input.subjectId, input.currentStep, JSON.stringify(input.payload), input.expectedVersion],
    );
    return result.rows[0] ? mapWizardDraft(result.rows[0]) : null;
  }

  async abandonWizardDraft(input: Parameters<ListingAuditStore['abandonWizardDraft']>[0]) {
    return this.database.transaction(async (client) => {
      const current = await client.query<{ status: OfferWizardDraft['status']; version: number }>(
        `SELECT d.status, d.version FROM offer_wizard_drafts d
         JOIN supplier_profiles s ON s.id = d.supplier_id
         WHERE d.id = $1 AND s.subject_id = $2 FOR UPDATE OF d`,
        [input.draftId, input.subjectId],
      );
      if (!current.rows[0]) return 'not_found' as const;
      if (current.rows[0].status !== 'active' || current.rows[0].version !== input.expectedVersion) return 'conflict' as const;
      const result = await client.query(
        `UPDATE offer_wizard_drafts SET status = 'abandoned', abandoned_at = now(), abandoned_by = $3,
           version = version + 1 WHERE id = $1 AND supplier_id IN
           (SELECT id FROM supplier_profiles WHERE subject_id = $2) AND status = 'active' AND version = $4`,
        [input.draftId, input.subjectId, input.userId, input.expectedVersion],
      );
      return result.rowCount === 1 ? 'abandoned' as const : 'conflict' as const;
    });
  }

  async submitWizardDraft(input: Parameters<ListingAuditStore['submitWizardDraft']>[0]): Promise<SubmitWizardDraftResult> {
    return this.database.transaction(async (client) => {
      const current = await client.query<WizardDraftRow & {
        submit_request_id: string | null; submit_payload_digest: string | null; resource_status: string; supplier_status: string;
      }>(
        `SELECT ${wizardDraftColumns}, d.submit_request_id, d.submit_payload_digest,
           r.status AS resource_status, s.status AS supplier_status
         FROM offer_wizard_drafts d JOIN compute_resources r ON r.id = d.resource_id
         JOIN supplier_profiles s ON s.id = d.supplier_id
         WHERE d.id = $1 AND s.subject_id = $2 FOR UPDATE OF d`, [input.draftId, input.subjectId],
      );
      const draft = current.rows[0];
      if (!draft) return { status: 'not_submittable' };
      if (draft.status === 'submitted') {
        if (draft.submit_request_id !== input.submitRequestId || draft.submit_payload_digest !== input.submitPayloadDigest
          || !draft.converted_offer_id) return { status: 'conflict' };
        const offer = await client.query<OfferRow>(`SELECT ${offerColumns} FROM offer_templates WHERE id = $1`, [draft.converted_offer_id]);
        return { status: 'replayed', offer: mapOffer(offer.rows[0]!), audits: await this.audits(client, draft.converted_offer_id, 1) };
      }
      if (draft.version !== input.expectedVersion || draft.resource_status !== 'verified' || draft.supplier_status !== 'approved'
        || draft.capacity_unit !== input.nativeUnit) return { status: 'not_submittable' };
      const offerId = randomUUID();
      const created = await client.query<OfferRow>(
        `INSERT INTO offer_templates(id, supplier_id, resource_id, client_request_id, payload_digest, title,
          service_mode, native_unit, minimum_quantity, sla, delivery_terms, acceptance_terms, refund_terms,
          cleanup_terms, suggested_unit_credit_micros, suggested_price_cny_micros, price_components, price_evidence, version,
          submission_version, status, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb,
          $13::jsonb, $14::jsonb, $15, $16, $17::jsonb, $18::jsonb, 2, 1, 'under_review', now())
         RETURNING ${offerColumns}`,
        [offerId, draft.supplier_id, draft.resource_id, input.submitRequestId, input.submitPayloadDigest, input.title,
          input.serviceMode, input.nativeUnit, input.minimumQuantity, JSON.stringify(input.sla), JSON.stringify(input.deliveryTerms),
          JSON.stringify(input.acceptanceTerms), JSON.stringify(input.refundTerms), JSON.stringify(input.cleanupTerms),
          input.suggestedUnitCreditMicros.toString(), input.suggestedPriceCnyMicros.toString(),
          JSON.stringify(input.priceComponents), JSON.stringify(input.priceEvidence)],
      );
      await client.query(
        `INSERT INTO offer_audit_versions(id, offer_id, submission_version, kind, status)
         VALUES ($1, $2, 1, 'resource', 'pending'), ($3, $2, 1, 'price', 'pending')`,
        [randomUUID(), offerId, randomUUID()],
      );
      await client.query(
        `UPDATE offer_wizard_drafts SET status = 'submitted', submit_request_id = $2,
          submit_payload_digest = $3, converted_offer_id = $4, version = version + 1 WHERE id = $1`,
        [draft.id, input.submitRequestId, input.submitPayloadDigest, offerId],
      );
      return { status: 'created', offer: mapOffer(created.rows[0]!), audits: await this.audits(client, offerId, 1) };
    });
  }

  async createOffer(input: Parameters<ListingAuditStore['createOffer']>[0]) {
    return this.database.transaction(async (client) => {
      const replay = await client.query<OfferRow>(
        `SELECT o.${offerColumns.replaceAll(', ', ', o.')} FROM offer_templates o JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE s.subject_id = $1 AND o.client_request_id = $2 FOR UPDATE OF o`, [input.subjectId, input.clientRequestId],
      );
      if (replay.rows[0]) {
        const previous = await client.query<{ payload_digest: string }>('SELECT payload_digest FROM offer_templates WHERE id = $1', [replay.rows[0].id]);
        return previous.rows[0]?.payload_digest === input.payloadDigest
          ? { status: 'replayed' as const, offer: mapOffer(replay.rows[0]) }
          : { status: 'conflict' as const };
      }
      const resource = await client.query<{ supplier_id: string; capacity_unit: string }>(
        `SELECT r.supplier_id, r.capacity_unit FROM compute_resources r JOIN supplier_profiles s ON s.id = r.supplier_id
         WHERE r.id = $1 AND s.subject_id = $2 AND s.status = 'approved' AND r.status = 'verified' FOR UPDATE OF r`,
        [input.resourceId, input.subjectId],
      );
      const row = resource.rows[0];
      if (!row || row.capacity_unit !== input.nativeUnit) return null;
      const result = await client.query<OfferRow>(
        `INSERT INTO offer_templates(id, supplier_id, resource_id, client_request_id, payload_digest, title,
          service_mode, native_unit, minimum_quantity, sla, delivery_terms, acceptance_terms, refund_terms,
          cleanup_terms, suggested_unit_credit_micros, suggested_price_cny_micros, price_components, price_evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb,
          $13::jsonb, $14::jsonb, $15, $16, $17::jsonb, $18::jsonb) RETURNING ${offerColumns}`,
        [input.id, row.supplier_id, input.resourceId, input.clientRequestId, input.payloadDigest, input.title,
          input.serviceMode, input.nativeUnit, input.minimumQuantity, JSON.stringify(input.sla), JSON.stringify(input.deliveryTerms),
          JSON.stringify(input.acceptanceTerms), JSON.stringify(input.refundTerms), JSON.stringify(input.cleanupTerms),
          input.suggestedUnitCreditMicros.toString(), input.suggestedPriceCnyMicros.toString(),
          JSON.stringify(input.priceComponents), JSON.stringify(input.priceEvidence)],
      );
      return { status: 'created' as const, offer: mapOffer(result.rows[0]!) };
    });
  }

  async updateOffer(input: Parameters<ListingAuditStore['updateOffer']>[0]) {
    const result = await this.database.query<OfferRow>(
      `UPDATE offer_templates o SET title = $3, service_mode = $4, native_unit = $5, minimum_quantity = $6,
        sla = $7::jsonb, delivery_terms = $8::jsonb, acceptance_terms = $9::jsonb, refund_terms = $10::jsonb,
        cleanup_terms = $11::jsonb, suggested_unit_credit_micros = $12, suggested_price_cny_micros = $13,
        price_components = $14::jsonb, price_evidence = $15::jsonb, status = 'draft', approved_reference_cny_micros = NULL,
        approved_unit_credit_micros = NULL, conversion_cny_micros_per_credit = NULL,
        audit_valid_until = NULL, approved_at = NULL, version = o.version + 1
       FROM supplier_profiles s, compute_resources r
       WHERE o.id = $1 AND s.subject_id = $2 AND s.id = o.supplier_id AND r.id = o.resource_id
         AND o.status IN ('draft', 'changes_requested', 'rejected') AND o.version = $16 AND r.status = 'verified'
         AND r.capacity_unit = $5 RETURNING o.${offerColumns.replaceAll(', ', ', o.')}`,
      [input.offerId, input.subjectId, input.title, input.serviceMode, input.nativeUnit, input.minimumQuantity,
        JSON.stringify(input.sla), JSON.stringify(input.deliveryTerms), JSON.stringify(input.acceptanceTerms),
        JSON.stringify(input.refundTerms), JSON.stringify(input.cleanupTerms), input.suggestedUnitCreditMicros.toString(),
        input.suggestedPriceCnyMicros.toString(), JSON.stringify(input.priceComponents),
        JSON.stringify(input.priceEvidence), input.expectedVersion],
    );
    return result.rows[0] ? mapOffer(result.rows[0]) : null;
  }

  async submitOffer(subjectId: string, _userId: string, offerId: string, expectedVersion: number) {
    return this.database.transaction(async (client) => {
      await this.expireApprovedOffers(client, subjectId);
      const current = await client.query<OfferRow>(
        `SELECT o.${offerColumns.replaceAll(', ', ', o.')} FROM offer_templates o
         JOIN supplier_profiles s ON s.id = o.supplier_id JOIN compute_resources r ON r.id = o.resource_id
         WHERE o.id = $1 AND s.subject_id = $2 AND s.status = 'approved' AND r.status = 'verified' FOR UPDATE OF o`,
        [offerId, subjectId],
      );
      const offer = current.rows[0];
      if (!offer) return null;
      if (offer.status === 'under_review' && offer.version === expectedVersion + 1) {
        const audits = await this.audits(client, offerId, offer.submission_version);
        if (audits.length === 2 && audits.every((audit) => audit.status === 'pending')) {
          return { status: 'replayed' as const, offer: mapOffer(offer), audits };
        }
      }
      if (offer.version !== expectedVersion || !['draft', 'changes_requested', 'expired'].includes(offer.status)) return null;
      const submissionVersion = offer.submission_version + 1;
      const updated = await client.query<OfferRow>(
        `UPDATE offer_templates SET submission_version = $2, status = 'under_review', submitted_at = now(),
          approved_reference_cny_micros = NULL, approved_unit_credit_micros = NULL,
          conversion_cny_micros_per_credit = NULL, audit_valid_until = NULL, approved_at = NULL,
          version = version + 1
         WHERE id = $1 RETURNING ${offerColumns}`, [offerId, submissionVersion],
      );
      await client.query(
        `INSERT INTO offer_audit_versions(id, offer_id, submission_version, kind, status)
         VALUES ($1, $2, $3, 'resource', 'pending'), ($4, $2, $3, 'price', 'pending')`,
        [randomUUID(), offerId, submissionVersion, randomUUID()],
      );
      return { status: 'created' as const, offer: mapOffer(updated.rows[0]!), audits: await this.audits(client, offerId, submissionVersion) };
    });
  }

  async listSupplierOffers(subjectId: string) {
    return this.database.transaction(async (client) => {
      await this.expireApprovedOffers(client, subjectId);
      const result = await client.query<OfferRow>(
        `SELECT o.${offerColumns.replaceAll(', ', ', o.')} FROM offer_templates o JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE s.subject_id = $1 ORDER BY o.updated_at DESC LIMIT 100`, [subjectId],
      );
      const items: Array<{ offer: OfferTemplate; audits: OfferAudit[] }> = [];
      for (const row of result.rows) {
        items.push({ offer: mapOffer(row), audits: await this.audits(client, row.id, row.submission_version) });
      }
      return items;
    });
  }

  async getSupplierOffer(subjectId: string, offerId: string) {
    return this.database.transaction(async (client) => {
      await this.expireApprovedOffers(client, subjectId);
      const result = await client.query<OfferRow>(
        `SELECT o.${offerColumns.replaceAll(', ', ', o.')} FROM offer_templates o JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE o.id = $1 AND s.subject_id = $2`, [offerId, subjectId],
      );
      const row = result.rows[0];
      return row ? { offer: mapOffer(row), audits: await this.audits(client, row.id, row.submission_version) } : null;
    });
  }

  async decideAudit(input: Parameters<ListingAuditStore['decideAudit']>[0]) {
    return this.database.transaction(async (client) => {
      if (input.approved && !input.validUntil) return null;
      if (!input.approved && !input.returnStep) return null;
      if (!input.approved && input.kind === 'price' && input.returnStep !== 'price') return null;
      if (!input.approved && input.kind === 'resource' && !['service', 'terms'].includes(input.returnStep!)) return null;
      if (input.approved && input.kind === 'price' && (!input.approvedReferenceCnyMicros
        || !input.conversionCnyMicrosPerCredit || !input.approvedUnitCreditMicros)) return null;
      const current = await client.query<OfferRow & { supplier_subject_id: string }>(
        `SELECT o.${offerColumns.replaceAll(', ', ', o.')}, s.subject_id AS supplier_subject_id
         FROM offer_templates o JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE o.id = $1 FOR UPDATE OF o`, [input.offerId],
      );
      const offer = current.rows[0];
      if (!offer || offer.status !== 'under_review' || offer.submission_version < 1) return null;
      const member = await client.query(
        `SELECT 1 FROM subject_memberships WHERE subject_id = $1 AND user_id = $2 AND status = 'active'`,
        [offer.supplier_subject_id, input.reviewerId],
      );
      if (member.rows[0]) return 'self_review_violation';
      const audits = await this.audits(client, input.offerId, offer.submission_version, true);
      const target = audits.find((audit) => audit.kind === input.kind);
      const other = audits.find((audit) => audit.kind !== input.kind);
      if (!target || target.status !== 'pending') return null;
      if (other?.reviewerId === input.reviewerId) return 'four_eyes_violation';
      const status = input.changesRequested ? 'changes_requested' : input.approved ? 'approved' : 'rejected';
      const updatedAudit = await client.query<AuditRow>(
        `UPDATE offer_audit_versions SET status = $2, reviewer_id = $3, decision_reason = $4,
          evidence_summary = $5, evidence_digest = $6, decision_digest = $7,
          approved_reference_cny_micros = $8, conversion_cny_micros_per_credit = $9,
          approved_unit_credit_micros = $10, valid_until = $11, return_step = $12, decided_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING ${auditColumns}`,
        [target.id, status, input.reviewerId, input.decisionReason, input.evidenceSummary, input.evidenceDigest,
          input.decisionDigest, input.approvedReferenceCnyMicros?.toString() ?? null,
          input.conversionCnyMicrosPerCredit?.toString() ?? null, input.approvedUnitCreditMicros?.toString() ?? null,
          input.validUntil ?? null, input.approved ? null : input.returnStep],
      );
      if (!updatedAudit.rows[0]) return null;
      const nextAudits = audits.map((audit) => audit.id === target.id ? mapAudit(updatedAudit.rows[0]!) : audit);
      if (status === 'changes_requested' || status === 'rejected') {
        await client.query(
          `UPDATE offer_audit_versions SET status = 'cancelled' WHERE offer_id = $1 AND submission_version = $2
           AND kind <> $3 AND status = 'pending'`, [offer.id, offer.submission_version, input.kind],
        );
        const siblingIndex = nextAudits.findIndex((audit) => audit.kind !== input.kind && audit.status === 'pending');
        if (siblingIndex >= 0) nextAudits[siblingIndex] = { ...nextAudits[siblingIndex]!, status: 'cancelled' };
      }
      let nextStatus: OfferStatus = 'under_review';
      if (nextAudits.some((audit) => audit.status === 'changes_requested')) nextStatus = 'changes_requested';
      else if (nextAudits.some((audit) => audit.status === 'rejected')) nextStatus = 'rejected';
      else if (nextAudits.every((audit) => audit.status === 'approved')) nextStatus = 'approved';
      let updatedOffer: OfferRow;
      if (nextStatus === 'approved') {
        const resourceAudit = nextAudits.find((audit) => audit.kind === 'resource')!;
        const priceAudit = nextAudits.find((audit) => audit.kind === 'price')!;
        const validUntil = new Date(Math.min(resourceAudit.validUntil!.getTime(), priceAudit.validUntil!.getTime()));
        const result = await client.query<OfferRow>(
          `UPDATE offer_templates SET status = 'approved', approved_reference_cny_micros = $2,
            approved_unit_credit_micros = $3, conversion_cny_micros_per_credit = $4,
            audit_valid_until = $5, approved_at = now(), version = version + 1 WHERE id = $1 RETURNING ${offerColumns}`,
          [offer.id, priceAudit.approvedReferenceCnyMicros!.toString(), priceAudit.approvedUnitCreditMicros!.toString(),
            priceAudit.conversionCnyMicrosPerCredit!.toString(), validUntil],
        );
        updatedOffer = result.rows[0]!;
      } else {
        const result = await client.query<OfferRow>(
          `UPDATE offer_templates SET status = $2, version = version + 1 WHERE id = $1 RETURNING ${offerColumns}`,
          [offer.id, nextStatus],
        );
        updatedOffer = result.rows[0]!;
      }
      const recipients = await client.query<{ user_id: string }>(
        `SELECT m.user_id FROM supplier_profiles s JOIN subject_memberships m ON m.subject_id = s.subject_id
         WHERE s.id = $1 AND m.status = 'active' AND m.role IN ('owner', 'admin', 'provider_manager', 'provider_operator')`,
        [offer.supplier_id],
      );
      for (const recipient of recipients.rows) {
        const notificationId = randomUUID();
        const content = notificationContent(input.kind, status, input.decisionReason, nextStatus === 'approved');
        await client.query(
          `INSERT INTO notifications(id, user_id, category, title, body, data)
           VALUES ($1, $2, 'market', $3, $4, $5::jsonb)`,
          [notificationId, recipient.user_id, content.title, content.body,
            JSON.stringify({ route: 'provider_offer', offerId: offer.id, kind: input.kind, status,
              offerStatus: nextStatus,
              subjectId: offer.supplier_subject_id, returnStep: input.approved ? null : input.returnStep,
              submissionVersion: offer.submission_version })],
        );
        await client.query(
          `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
           VALUES ($1, 'notification.created', 'NOTIFICATION', $2, $3::jsonb)`,
          [randomUUID(), notificationId, JSON.stringify({ notificationId, userId: recipient.user_id })],
        );
      }
      return { offer: mapOffer(updatedOffer), audits: nextAudits };
    });
  }

  async publishListing(input: Parameters<ListingAuditStore['publishListing']>[0]): Promise<PublishListingResult> {
    return this.database.transaction(async (client) => {
      await this.expireApprovedOffers(client, input.subjectId);
      const replay = await client.query<ListingRow & { payload_digest: string }>(
        `SELECT ${joinedListingColumns}, l.payload_digest FROM credit_market_listings l JOIN supplier_profiles s ON s.id = l.supplier_id
         WHERE s.subject_id = $1 AND l.client_request_id = $2 FOR UPDATE OF l`, [input.subjectId, input.clientRequestId],
      );
      if (replay.rows[0]) return replay.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', listing: mapListing(replay.rows[0]) }
        : { status: 'conflict' };
      const current = await client.query<OfferRow & { capacity_total: string; resource_status: string;
        supplier_status: string; resource_kind: string; resource_capacity_unit: string }>(
        `SELECT o.${offerColumns.replaceAll(', ', ', o.')}, r.capacity_total::text, r.kind AS resource_kind,
          r.capacity_unit AS resource_capacity_unit, r.status AS resource_status,
          s.status AS supplier_status FROM offer_templates o JOIN compute_resources r ON r.id = o.resource_id
          JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE o.id = $1 AND s.subject_id = $2 FOR UPDATE OF o, r`, [input.offerId, input.subjectId],
      );
      const offerRow = current.rows[0];
      if (offerRow?.status === 'expired') return { status: 'audit_expired' };
      if (!offerRow || offerRow.status !== 'approved' || offerRow.resource_status !== 'verified' || offerRow.supplier_status !== 'approved') {
        return { status: 'not_approved' };
      }
      if (offerRow.resource_kind !== 'gpu' || offerRow.resource_capacity_unit !== 'GPU时'
        || offerRow.native_unit !== 'GPU时' || offerRow.service_mode !== 'dedicated') return { status: 'not_approved' };
      if (!await this.lockDeliveryReady(client, offerRow.resource_id)) return { status: 'resource_not_ready' };
      const now = new Date();
      if (!offerRow.audit_valid_until || new Date(offerRow.audit_valid_until) <= now || input.expiresAt > new Date(offerRow.audit_valid_until)) {
        return { status: 'audit_expired' };
      }
      if (scaledQuantity(input.capacityTotal) < scaledQuantity(offerRow.minimum_quantity)) return { status: 'minimum_not_met' };
      if (scaledQuantity(input.capacityTotal) > scaledQuantity(offerRow.capacity_total)) return { status: 'capacity_unavailable' };
      const overlap = await client.query(
        `SELECT 1 FROM credit_market_listings WHERE resource_id = $1 AND status IN ('active', 'paused', 'sold_out')
         AND starts_at < $3 AND expires_at > $2 LIMIT 1 FOR UPDATE`, [offerRow.resource_id, input.startsAt, input.expiresAt],
      );
      if (overlap.rows[0]) return { status: 'window_conflict' };
      const audits = await this.audits(client, input.offerId, offerRow.submission_version);
      const resourceAudit = audits.find((audit) => audit.kind === 'resource' && audit.status === 'approved');
      const priceAudit = audits.find((audit) => audit.kind === 'price' && audit.status === 'approved');
      if (!resourceAudit || !priceAudit) return { status: 'not_approved' };
      const snapshot = {
        offerVersion: offerRow.version, submissionVersion: offerRow.submission_version,
        resourceAuditId: resourceAudit.id, priceAuditId: priceAudit.id,
        validUntil: new Date(offerRow.audit_valid_until).toISOString(),
        conversionCnyMicrosPerCredit: offerRow.conversion_cny_micros_per_credit,
      };
      const result = await client.query<ListingRow>(
        `INSERT INTO credit_market_listings(id, offer_id, resource_id, supplier_id, client_request_id, payload_digest,
          resource_audit_id, price_audit_id, capacity_total, capacity_unit, minimum_quantity,
          unit_credit_micros, reference_cny_micros, conversion_cny_micros_per_credit,
          status, starts_at, expires_at, audit_snapshot, published_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          'active', $15, $16, $17::jsonb, $18) RETURNING ${listingColumns}`,
        [input.id, offerRow.id, offerRow.resource_id, offerRow.supplier_id, input.clientRequestId, input.payloadDigest,
          resourceAudit.id, priceAudit.id, input.capacityTotal, offerRow.native_unit, offerRow.minimum_quantity,
          offerRow.approved_unit_credit_micros, offerRow.approved_reference_cny_micros,
          offerRow.conversion_cny_micros_per_credit, input.startsAt, input.expiresAt, JSON.stringify(snapshot), input.userId],
      );
      return { status: 'created', listing: mapListing(result.rows[0]!) };
    });
  }

  async listingWindowAvailability(
    input: Parameters<ListingAuditStore['listingWindowAvailability']>[0],
  ): Promise<ListingWindowAvailabilityResult> {
    return this.database.transaction(async (client) => {
      await this.expireApprovedOffers(client, input.subjectId);
      const current = await client.query<OfferRow & {
        capacity_total: string; capacity_unit: string; resource_status: string; supplier_status: string;
      }>(
        `SELECT o.${offerColumns.replaceAll(', ', ', o.')}, r.capacity_total::text, r.capacity_unit,
          r.status AS resource_status, s.status AS supplier_status
         FROM offer_templates o JOIN compute_resources r ON r.id = o.resource_id
         JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE o.id = $1 AND s.subject_id = $2`, [input.offerId, input.subjectId],
      );
      const offer = current.rows[0];
      if (offer?.status === 'expired') return { status: 'audit_expired' };
      if (!offer || offer.status !== 'approved' || offer.resource_status !== 'verified' || offer.supplier_status !== 'approved') {
        return { status: 'not_approved' };
      }
      if (!await this.lockDeliveryReady(client, offer.resource_id)) return { status: 'resource_not_ready' };
      const now = new Date();
      const auditValidUntil = offer.audit_valid_until ? new Date(offer.audit_valid_until) : null;
      if (!auditValidUntil || auditValidUntil <= now || input.expiresAt > auditValidUntil) return { status: 'audit_expired' };

      const blockers = await client.query<QueryResultRow & { starts_at: Date; expires_at: Date }>(
        `SELECT starts_at, expires_at FROM credit_market_listings
         WHERE resource_id = $1 AND status IN ('active', 'paused', 'sold_out') AND expires_at > $2
         ORDER BY starts_at, expires_at`, [offer.resource_id, input.startsAt],
      );
      const requestedBlocker = blockers.rows.find((row) => new Date(row.starts_at) < input.expiresAt
        && new Date(row.expires_at) > input.startsAt) ?? null;
      if (!requestedBlocker) {
        return {
          status: 'available', resourceId: offer.resource_id, capacityTotal: offer.capacity_total,
          capacityUnit: offer.capacity_unit, minimumQuantity: offer.minimum_quantity, auditValidUntil,
          requestedStartsAt: input.startsAt, requestedExpiresAt: input.expiresAt,
          blockingStartsAt: null, blockingExpiresAt: null, nextAvailableAt: input.startsAt,
        };
      }

      const durationMs = input.expiresAt.getTime() - input.startsAt.getTime();
      let candidate = new Date(input.startsAt);
      for (const row of blockers.rows) {
        const startsAt = new Date(row.starts_at);
        const expiresAt = new Date(row.expires_at);
        const candidateExpiresAt = new Date(candidate.getTime() + durationMs);
        if (startsAt >= candidateExpiresAt) break;
        if (expiresAt > candidate) candidate = expiresAt;
      }
      return {
        status: 'window_conflict', resourceId: offer.resource_id, capacityTotal: offer.capacity_total,
        capacityUnit: offer.capacity_unit, minimumQuantity: offer.minimum_quantity, auditValidUntil,
        requestedStartsAt: input.startsAt, requestedExpiresAt: input.expiresAt,
        blockingStartsAt: new Date(requestedBlocker.starts_at), blockingExpiresAt: new Date(requestedBlocker.expires_at),
        nextAvailableAt: candidate.getTime() + durationMs <= auditValidUntil.getTime() ? candidate : null,
      };
    });
  }

  async listPublicListings(limit: number) {
    return this.database.transaction(async (client) => {
      await this.expireApprovedOffers(client, null);
      const result = await client.query<PublicListingRow>(
        `SELECT ${publicListingColumns} FROM credit_market_listings l JOIN offer_templates o ON o.id = l.offer_id
         JOIN compute_resources r ON r.id = l.resource_id JOIN supplier_profiles s ON s.id = l.supplier_id
         JOIN compute_resource_delivery_readiness dr ON dr.resource_id = r.id
         WHERE l.status = 'active' AND l.starts_at <= now() AND l.expires_at > now()
           AND o.status = 'approved' AND o.audit_valid_until > now() AND r.status = 'verified' AND s.status = 'approved'
           AND dr.status = 'ready'
           AND l.capacity_total - l.capacity_reserved - l.capacity_sold >= l.minimum_quantity
         ORDER BY l.created_at DESC LIMIT $1`, [limit],
      );
      return result.rows.map(mapPublicListing);
    });
  }

  async listSupplierListings(subjectId: string) {
    return this.database.transaction(async (client) => {
      await this.expireApprovedOffers(client, subjectId);
      await client.query(
        `UPDATE credit_market_listings l SET status = 'expired'
         FROM supplier_profiles s WHERE s.id = l.supplier_id AND s.subject_id = $1
           AND l.status IN ('active', 'paused', 'sold_out') AND l.expires_at <= now()`, [subjectId],
      );
      const result = await client.query<ListingRow>(
        `SELECT ${joinedListingColumns} FROM credit_market_listings l
         JOIN supplier_profiles s ON s.id = l.supplier_id
         WHERE s.subject_id = $1 ORDER BY l.created_at DESC LIMIT 100`, [subjectId],
      );
      return result.rows.map(mapListing);
    });
  }

  async setListingStatus(input: Parameters<ListingAuditStore['setListingStatus']>[0]): Promise<SetListingStatusResult> {
    return this.database.transaction(async (client) => {
      await this.expireApprovedOffers(client, input.subjectId);
      const current = await client.query<ListingRow & {
        offer_status: OfferStatus; offer_audit_valid_until: Date | null; resource_status: string; supplier_status: string;
      }>(
        `SELECT ${joinedListingColumns}, o.status AS offer_status, o.audit_valid_until AS offer_audit_valid_until,
          r.status AS resource_status, s.status AS supplier_status
         FROM credit_market_listings l JOIN offer_templates o ON o.id = l.offer_id
         JOIN compute_resources r ON r.id = l.resource_id JOIN supplier_profiles s ON s.id = l.supplier_id
         WHERE l.id = $1 AND s.subject_id = $2 FOR UPDATE OF l`, [input.listingId, input.subjectId],
      );
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      if (row.status === 'expired') return { status: 'expired' };
      if (['active', 'paused', 'sold_out'].includes(row.status) && new Date(row.expires_at) <= new Date()) {
        await client.query(`UPDATE credit_market_listings SET status = 'expired' WHERE id = $1`, [row.id]);
        return { status: 'expired' };
      }
      if (row.status === input.targetStatus) return { status: 'replayed', listing: mapListing(row) };

      if (input.targetStatus === 'paused' && row.status !== 'active') return { status: 'invalid_transition' };
      if (input.targetStatus === 'withdrawn') {
        if (!['active', 'paused', 'sold_out'].includes(row.status)) return { status: 'invalid_transition' };
        if (scaledQuantity(row.capacity_reserved) > 0n) return { status: 'reserved_capacity' };
      }
      if (input.targetStatus === 'active') {
        if (row.status !== 'paused') return { status: 'invalid_transition' };
        if (row.offer_status !== 'approved' || !row.offer_audit_valid_until
          || new Date(row.offer_audit_valid_until) <= new Date() || row.resource_status !== 'verified'
          || row.supplier_status !== 'approved') return { status: 'approval_invalid' };
        if (!await this.lockDeliveryReady(client, row.resource_id)) return { status: 'resource_not_ready' };
        const available = scaledQuantity(row.capacity_total) - scaledQuantity(row.capacity_reserved) - scaledQuantity(row.capacity_sold);
        if (available < scaledQuantity(row.minimum_quantity)) return { status: 'capacity_unavailable' };
      }

      const updated = await client.query<ListingRow>(
        `UPDATE credit_market_listings SET status = $2 WHERE id = $1 RETURNING ${listingColumns}`,
        [row.id, input.targetStatus],
      );
      return { status: 'updated', listing: mapListing(updated.rows[0]!) };
    });
  }

  private async lockDeliveryReady(client: PoolClient, resourceId: string) {
    const result = await client.query(
      `SELECT b.id FROM compute_resource_bindings b
       JOIN compute_nodes n ON n.id = b.node_id
       JOIN compute_resources r ON r.id = b.resource_id
       JOIN compute_resource_delivery_readiness dr ON dr.resource_id=r.id
       WHERE b.resource_id = $1 AND dr.status='ready' AND b.status='ready' AND n.status='ready'
       FOR UPDATE OF r, b, n`, [resourceId],
    );
    return Boolean(result.rows[0]);
  }

  private async audits(
    queryable: { query: <Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<{ rows: Row[] }> },
    offerId: string,
    submissionVersion: number,
    lock = false,
  ) {
    if (submissionVersion < 1) return [];
    const result = await queryable.query<AuditRow>(
      `SELECT ${auditColumns} FROM offer_audit_versions WHERE offer_id = $1 AND submission_version = $2
       ORDER BY kind${lock ? ' FOR UPDATE' : ''}`, [offerId, submissionVersion],
    );
    return result.rows.map(mapAudit);
  }

  private async expireApprovedOffers(client: PoolClient, subjectId: string | null) {
    const expired = await client.query<{ id: string; supplier_id: string; subject_id: string; title: string }>(
      `UPDATE offer_templates o SET status = 'expired', version = o.version + 1
       FROM supplier_profiles s
       WHERE s.id = o.supplier_id AND o.status = 'approved' AND o.audit_valid_until <= now()
         AND ($1::uuid IS NULL OR s.subject_id = $1)
       RETURNING o.id, o.supplier_id, s.subject_id, o.title`, [subjectId],
    );
    for (const offer of expired.rows) {
      await client.query(
        `UPDATE credit_market_listings SET status = 'expired'
         WHERE offer_id = $1 AND status IN ('active', 'paused', 'sold_out')`, [offer.id],
      );
      const recipients = await client.query<{ user_id: string }>(
        `SELECT m.user_id FROM supplier_profiles s JOIN subject_memberships m ON m.subject_id = s.subject_id
         WHERE s.id = $1 AND m.status = 'active' AND m.role IN ('owner', 'admin', 'provider_manager', 'provider_operator')`,
        [offer.supplier_id],
      );
      for (const recipient of recipients.rows) {
        const notificationId = randomUUID();
        await client.query(
          `INSERT INTO notifications(id, user_id, category, title, body, data)
           VALUES ($1, $2, 'market', '审核已到期，请重新提交', $3, $4::jsonb)`,
          [notificationId, recipient.user_id,
            `「${offer.title}」的资源或价格审核已到期。重新审核通过后，再选择容量和时段上架。`,
            JSON.stringify({ route: 'provider_offer', offerId: offer.id, subjectId: offer.subject_id, status: 'expired' })],
        );
        await client.query(
          `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
           VALUES ($1, 'notification.created', 'NOTIFICATION', $2, $3::jsonb)`,
          [randomUUID(), notificationId, JSON.stringify({ notificationId, userId: recipient.user_id })],
        );
      }
    }
  }
}

function scaledQuantity(quantity: string) {
  const [whole = '0', fraction = ''] = quantity.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function notificationContent(kind: AuditKind, status: OfferAudit['status'], reason: string, fullyApproved: boolean) {
  const subject = kind === 'resource' ? '资源审核' : '价格审核';
  if (fullyApproved) return { title: '双审已通过，可以上架', body: '资源与卡时价格均已确认。现在只需选择容量和可售时段即可发布。' };
  if (status === 'approved') return { title: `${subject}已通过`, body: kind === 'resource' ? '资源事实已确认，等待价格审核完成后即可选择时段上架。' : '卡时价格已确认；双审完成后可直接选择容量与时段上架。' };
  if (status === 'changes_requested') return { title: `${subject}需要补充材料`, body: reason };
  return { title: `${subject}未通过`, body: reason };
}
