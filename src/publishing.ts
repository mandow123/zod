import { apiRequest } from './api-client';
import type { ResourceKind } from './api';
import type { ResourceDeliveryReadiness } from './resource-delivery-readiness';
export type SupplierProfile = Readonly<{
  id: string;
  legalName: string;
  creditCode: string;
  contactName: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'suspended';
  rejectionReason: string | null;
}>;

export type ComputeDemand = Readonly<{
  id: string;
  kind: ResourceKind;
  title: string;
  productHint: string;
  region: string;
  quantity: string;
  capacityUnit: string;
  desiredStartAt: string;
  deadlineAt: string;
  description: string;
  status: 'open' | 'matched' | 'cancelled' | 'expired' | 'closed';
  createdAt: string;
  updatedAt: string;
}>;

export type ComputeResource = Readonly<{
  id: string;
  supplierId: string;
  kind: ResourceKind;
  productCode: string;
  region: string;
  specifications: Record<string, unknown>;
  capacityTotal: string;
  capacityUnit: string;
  status: 'draft' | 'pending_verification' | 'verified' | 'rejected' | 'suspended' | 'retired';
  verification: null | Readonly<{
    status: 'pending' | 'running' | 'passed' | 'failed';
    requestedAt: string;
    completedAt: string | null;
    failureReason: string | null;
  }>;
  deliveryReadiness?: ResourceDeliveryReadiness;
}>;

export type OfferAudit = Readonly<{
  id: string;
  kind: 'resource' | 'price';
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'expired' | 'cancelled';
  decisionReason: string | null;
  evidenceSummary: string | null;
  returnStep: 'service' | 'terms' | 'price' | null;
  validUntil: string | null;
  decidedAt: string | null;
}>;

export type OfferTemplate = Readonly<{
  id: string;
  resourceId: string;
  version: number;
  submissionVersion: number;
  title: string;
  serviceMode: 'dedicated' | 'shared' | 'slice' | 'node' | 'reserved';
  nativeUnit: string;
  minimumQuantity: string;
  sla: Record<string, unknown>;
  deliveryTerms: Record<string, unknown>;
  acceptanceTerms: Record<string, unknown>;
  refundTerms: Record<string, unknown>;
  cleanupTerms: Record<string, unknown>;
  suggestedPriceCny: string;
  priceComponents: Record<string, unknown>;
  priceEvidence: unknown[];
  status: 'draft' | 'under_review' | 'changes_requested' | 'approved' | 'rejected' | 'suspended' | 'expired';
  approvedReferenceCny: string | null;
  approvedUnitCredits: string | null;
  conversion: string | null;
  auditValidUntil: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  audits: { resource: OfferAudit | null; price: OfferAudit | null };
}>;

export type CreditListing = Readonly<{
  id: string;
  offerId: string;
  resourceId: string;
  capacityTotal: string;
  capacityReserved: string;
  capacitySold: string;
  capacityAvailable: string;
  capacityUnit: string;
  minimumQuantity: string;
  unitCredits: string;
  referenceCny: string;
  conversion: '1 KAI卡时 = ¥1.002';
  status: 'active' | 'paused' | 'sold_out' | 'expired' | 'withdrawn' | 'suspended';
  sellingStage: 'scheduled' | 'scheduled_paused' | 'selling' | 'paused' | 'sold_out' | 'expired' | 'withdrawn' | 'suspended';
  startsAt: string;
  expiresAt: string;
  auditValidUntil: string;
  createdAt: string;
  audits: { resource: true; price: true };
  selloutEstimate: Readonly<{
    kind: 'gross_before_fee';
    grossCredits: string;
    basis: 'remaining_capacity';
    remainingCapacity: string;
    asOf: string;
    disclosure: '按当前剩余容量全部售完测算，未扣服务费';
  }>;
}>;

export type ListingWindowAvailability = Readonly<{
  status: 'available' | 'window_conflict';
  resourceId: string;
  capacityTotal: string;
  capacityUnit: string;
  minimumQuantity: string;
  auditValidUntil: string;
  requestedStartsAt: string;
  requestedExpiresAt: string;
  blockingStartsAt: string | null;
  blockingExpiresAt: string | null;
  nextAvailableAt: string | null;
}>;

export type OfferWizardStep = 'service' | 'terms' | 'price' | 'review';
export type OfferWizardPayload = Readonly<{
  title?: string;
  serviceMode?: OfferTemplate['serviceMode'];
  nativeUnit?: string;
  minimumQuantity?: string;
  sla?: Record<string, unknown>;
  deliveryTerms?: Record<string, unknown>;
  acceptanceTerms?: Record<string, unknown>;
  refundTerms?: Record<string, unknown>;
  cleanupTerms?: Record<string, unknown>;
  suggestedPriceCny?: string;
  priceComponents?: Record<string, unknown>;
  priceEvidence?: Array<Readonly<{
    type: 'contract' | 'invoice' | 'market_quote' | 'cost_breakdown';
    source: string;
    summary: string;
    digest?: string;
  }>>;
}>;

export type OfferWizardDraft = Readonly<{
  id: string;
  resourceId: string;
  resource: { name: string; kind: string; capacityUnit: string };
  version: number;
  currentStep: OfferWizardStep;
  payload: OfferWizardPayload;
  status: 'active' | 'submitted';
  convertedOfferId: string | null;
  createdAt: string;
  updatedAt: string;
  pricePreview: null | Readonly<{
    referenceCny: string;
    unitCredits: string;
    conversion: '1 KAI卡时 = ¥1.002';
    auditStatus: 'pending_price_audit';
  }>;
}>;

export type OfferRevisionDraft = OfferWizardDraft & Readonly<{
  offerId: string;
  sourceOfferVersion: number;
  convertedOfferId: null;
  reviewFeedback: Array<Readonly<{
    kind: 'resource' | 'price';
    status: 'changes_requested' | 'rejected';
    reason: string | null;
    summary: string | null;
    returnStep: 'service' | 'terms' | 'price';
  }>>;
}>;

export async function listSupplierOffers() {
  const response = await apiRequest<{ ok: true; offers: OfferTemplate[] }>('/mobile/v1/provider/offers', {
    auth: 'required', retry: true,
  });
  return response.offers;
}

export async function getSupplierOffer(offerId: string) {
  const response = await apiRequest<{ ok: true; offer: OfferTemplate }>(
    `/mobile/v1/provider/offers/${encodeURIComponent(offerId)}`,
    { auth: 'required', retry: true },
  );
  return response.offer;
}

export async function listSupplierListings() {
  const response = await apiRequest<{ ok: true; listings: CreditListing[] }>('/mobile/v1/provider/listings', {
    auth: 'required', retry: true,
  });
  return response.listings;
}

export async function checkListingWindow(offerId: string, input: Readonly<
  { startMode: 'immediate'; durationDays: number }
  | { startMode: 'scheduled'; startsAt: string; expiresAt: string }
>) {
  const query = new URLSearchParams(input.startMode === 'immediate'
    ? { offerId, startMode: input.startMode, durationDays: String(input.durationDays) }
    : { offerId, startMode: input.startMode, startsAt: input.startsAt, expiresAt: input.expiresAt }).toString();
  const response = await apiRequest<{ ok: true; availability: ListingWindowAvailability }>(
    `/mobile/v1/provider/listings/availability?${query}`, { auth: 'required', retry: true },
  );
  return response.availability;
}

export async function resubmitExpiredOffer(offerId: string, expectedVersion: number) {
  const response = await apiRequest<{ ok: true; replayed: boolean; offer: OfferTemplate }>(
    `/mobile/v1/provider/offers/${encodeURIComponent(offerId)}/reaudit`,
    { method: 'POST', auth: 'required', retry: true, body: { expectedVersion } },
  );
  return response;
}

export async function publishCreditListing(input: Readonly<{ offerId: string; capacityTotal: string } & (
  | { startMode: 'immediate'; durationDays: number }
  | { startMode: 'scheduled'; startsAt: string; expiresAt: string }
)>, requestId: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; listing: CreditListing }>('/mobile/v1/provider/listings', {
    method: 'POST', auth: 'required', retry: true, body: input, headers: { 'idempotency-key': requestId },
  });
  return response;
}

export async function setCreditListingStatus(listingId: string, status: 'active' | 'paused' | 'withdrawn') {
  const response = await apiRequest<{ ok: true; replayed: boolean; listing: CreditListing }>(
    `/mobile/v1/provider/listings/${encodeURIComponent(listingId)}/status`,
    { method: 'PUT', auth: 'required', retry: true, body: { status } },
  );
  return response.listing;
}

export async function listOfferDrafts() {
  const response = await apiRequest<{ ok: true; drafts: OfferWizardDraft[] }>('/mobile/v1/provider/offer-drafts', {
    auth: 'required', retry: true,
  });
  return response.drafts;
}

export async function getOfferDraft(draftId: string) {
  const response = await apiRequest<{ ok: true; draft: OfferWizardDraft }>(`/mobile/v1/provider/offer-drafts/${encodeURIComponent(draftId)}`, {
    auth: 'required', retry: true,
  });
  return response.draft;
}

export async function createOfferDraft(resourceId: string, requestId: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; draft: OfferWizardDraft }>('/mobile/v1/provider/offer-drafts', {
    method: 'POST', auth: 'required', retry: true, body: { resourceId }, headers: { 'idempotency-key': requestId },
  });
  return response.draft;
}

export async function saveOfferDraft(draftId: string, input: Readonly<{
  expectedVersion: number; currentStep: OfferWizardStep; payload: OfferWizardPayload;
}>) {
  const response = await apiRequest<{ ok: true; draft: OfferWizardDraft }>(`/mobile/v1/provider/offer-drafts/${encodeURIComponent(draftId)}`, {
    method: 'PUT', auth: 'required', retry: false, body: input,
  });
  return response.draft;
}

export async function abandonOfferDraft(draftId: string, expectedVersion: number) {
  const response = await apiRequest<{ ok: true; draftId: string }>(
    `/mobile/v1/provider/offer-drafts/${encodeURIComponent(draftId)}`,
    { method: 'DELETE', auth: 'required', retry: false, body: { expectedVersion } },
  );
  return response.draftId;
}

export async function submitOfferDraft(draftId: string, expectedVersion: number, requestId: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; offer: OfferTemplate }>(`/mobile/v1/provider/offer-drafts/${encodeURIComponent(draftId)}/submit`, {
    method: 'POST', auth: 'required', retry: true, body: { expectedVersion }, headers: { 'idempotency-key': requestId },
  });
  return response.offer;
}

export async function createOfferRevision(offerId: string, requestId: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; draft: OfferRevisionDraft }>(
    `/mobile/v1/provider/offers/${encodeURIComponent(offerId)}/revision`, {
      method: 'POST', auth: 'required', retry: true, headers: { 'idempotency-key': requestId },
    },
  );
  return response.draft;
}

export async function getOfferRevision(offerId: string) {
  const response = await apiRequest<{ ok: true; draft: OfferRevisionDraft }>(
    `/mobile/v1/provider/offers/${encodeURIComponent(offerId)}/revision`, { auth: 'required', retry: true },
  );
  return response.draft;
}

export async function saveOfferRevision(offerId: string, input: Readonly<{
  expectedVersion: number; currentStep: OfferWizardStep; payload: OfferWizardPayload;
}>) {
  const response = await apiRequest<{ ok: true; draft: OfferRevisionDraft }>(
    `/mobile/v1/provider/offers/${encodeURIComponent(offerId)}/revision`, {
      method: 'PUT', auth: 'required', retry: false, body: input,
    },
  );
  return response.draft;
}

export async function submitOfferRevision(offerId: string, expectedVersion: number, requestId: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; offer: OfferTemplate }>(
    `/mobile/v1/provider/offers/${encodeURIComponent(offerId)}/revision/submit`, {
      method: 'POST', auth: 'required', retry: true, body: { expectedVersion }, headers: { 'idempotency-key': requestId },
    },
  );
  return response.offer;
}

export function previewKaiCredits(cny: string) {
  const normalized = cny.trim().replace(/^0+(?=\d)/u, '');
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const cnyMicros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (cnyMicros <= 0n) return null;
  const creditMicros = (cnyMicros * 1_000_000n + 1_002_000n - 1n) / 1_002_000n;
  return `${creditMicros / 1_000_000n}.${(creditMicros % 1_000_000n).toString().padStart(6, '0')}`;
}

export async function createDemand(input: Readonly<{
  kind: ResourceKind;
  title: string;
  productHint: string;
  region: string;
  quantity: string;
  capacityUnit: string;
  desiredStartAt: string;
  deadlineAt: string;
  description: string;
}>) {
  const response = await apiRequest<{ ok: true; demand: ComputeDemand }>('/mobile/v1/demands', {
    method: 'POST', auth: 'required', retry: false, body: input,
  });
  return response.demand;
}

export async function listDemands() {
  const response = await apiRequest<{ ok: true; demands: ComputeDemand[] }>('/mobile/v1/demands', {
    auth: 'required', retry: true,
  });
  return response.demands;
}

export async function cancelDemand(demandId: string) {
  const response = await apiRequest<{ ok: true; demand: ComputeDemand }>(`/mobile/v1/demands/${encodeURIComponent(demandId)}/cancel`, {
    method: 'POST', auth: 'required', retry: false,
  });
  return response.demand;
}

export async function loadSupplierWorkspace() {
  const [profile, resources] = await Promise.all([
    getSupplierProfile(),
    apiRequest<{ ok: true; resources: ComputeResource[] }>('/mobile/v1/provider/resources', { auth: 'required', retry: true }),
  ]);
  return { profile, resources: resources.resources };
}

export async function getSupplierProfile() {
  const response = await apiRequest<{ ok: true; profile: SupplierProfile | null }>(
    '/mobile/v1/provider/profile', { auth: 'required', retry: true },
  );
  return response.profile;
}

export async function submitSupplier(input: Readonly<{ legalName: string; creditCode: string; contactName: string }>) {
  const response = await apiRequest<{ ok: true; profile: SupplierProfile }>('/mobile/v1/provider/profile', {
    method: 'POST', auth: 'required', retry: false, body: input,
  });
  return response.profile;
}

export async function createResource(input: Readonly<{
  kind: ResourceKind;
  productCode: string;
  region: string;
  specifications: Record<string, unknown>;
  capacityTotal: string;
  capacityUnit: string;
  assetReference: string;
  assetIdentityKind: 'hardware_serial' | 'cloud_resource_id' | 'internal_asset_id';
}>, requestId: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; recovered: boolean; resource: ComputeResource }>('/mobile/v1/provider/resources', {
    method: 'POST', auth: 'required', retry: true, body: input, headers: { 'idempotency-key': requestId },
  });
  return response;
}

export async function resubmitResource(resourceId: string, requestId: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; resource: ComputeResource }>(
    `/mobile/v1/provider/resources/${encodeURIComponent(resourceId)}/resubmit`, {
      method: 'POST', auth: 'required', retry: true, headers: { 'idempotency-key': requestId },
    },
  );
  return response;
}
