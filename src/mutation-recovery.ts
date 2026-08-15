import type { OfferTemplate, OfferRevisionDraft, OfferWizardDraft, CreditListing, SupplierProfile } from './publishing';
import type { ResourceEvidenceChecklist } from './resource-evidence';
import type { CloudPayOrder } from './api';

export function isAmbiguousMutationFailure(reason: unknown) {
  if (!reason || typeof reason !== 'object' || !('status' in reason)) return false;
  const status = (reason as { status?: unknown }).status;
  return status === 0 || status === 502 || status === 503 || status === 504;
}

export function resourceSubmissionAccepted(checklist: ResourceEvidenceChecklist) {
  return ['under_review', 'passed', 'failed'].includes(checklist.review.status);
}

export function supplierSubmissionAccepted(
  input: { legalName: string; creditCode: string; contactName: string },
  profile: SupplierProfile | null,
) {
  if (!profile || !['submitted', 'approved'].includes(profile.status)) return false;
  const creditCode = input.creditCode.trim().toUpperCase();
  const masked = `${creditCode.slice(0, 4)}**********${creditCode.slice(-4)}`;
  return profile.legalName === input.legalName.trim() && profile.contactName === input.contactName.trim()
    && (profile.creditCode === creditCode || profile.creditCode === masked);
}

export function resourceUploadAccepted(
  checklist: ResourceEvidenceChecklist,
  category: keyof ResourceEvidenceChecklist['categories'],
  fileName: string,
  sizeBytes: number | undefined,
) {
  const evidence = checklist.categories[category].evidence;
  return Boolean(evidence && evidence.fileName === fileName
    && (sizeBytes === undefined || evidence.sizeBytes === sizeBytes)
    && ['pending_scan', 'verified'].includes(evidence.status));
}

export function wizardSubmissionAccepted(draft: OfferWizardDraft) {
  return draft.status === 'submitted' && typeof draft.convertedOfferId === 'string' && draft.convertedOfferId.length > 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = stableValue((value as Record<string, unknown>)[key]);
    return result;
  }, {});
}

export function draftSaveAccepted(
  before: Pick<OfferWizardDraft, 'id' | 'version'>,
  desired: { step: string; payload: unknown },
  after: Pick<OfferWizardDraft, 'id' | 'version' | 'status' | 'currentStep' | 'payload'>,
) {
  return after.id === before.id && after.status === 'active' && after.version > before.version
    && after.currentStep === desired.step
    && JSON.stringify(stableValue(after.payload)) === JSON.stringify(stableValue(desired.payload));
}

export function revisionSubmissionAccepted(before: OfferRevisionDraft, offer: OfferTemplate) {
  return offer.id === before.offerId && offer.version > before.sourceOfferVersion
    && ['under_review', 'changes_requested', 'approved', 'rejected', 'expired'].includes(offer.status);
}

export function listingPublicationAccepted(offerId: string, listings: readonly CreditListing[]) {
  return listings.some((listing) => listing.offerId === offerId
    && ['active', 'paused', 'sold_out'].includes(listing.status));
}

export function listingStatusChangeAccepted(
  listingId: string,
  targetStatus: 'active' | 'paused' | 'withdrawn',
  listings: readonly CreditListing[],
) {
  return listings.find((listing) => listing.id === listingId && listing.status === targetStatus) ?? null;
}

export function draftAbandonAccepted(draftId: string, drafts: readonly OfferWizardDraft[]) {
  return !drafts.some((draft) => draft.id === draftId);
}

export function offerReauditAccepted(before: OfferTemplate, after: OfferTemplate) {
  return after.id === before.id && after.status === 'under_review'
    && after.version === before.version + 1
    && after.submissionVersion === before.submissionVersion + 1;
}

export function providerOrderActionAccepted(
  action: 'confirm' | 'start_delivery',
  before: CloudPayOrder,
  after: CloudPayOrder,
) {
  if (after.id !== before.id || before.side !== 'provider' || after.side !== 'provider') return false;
  if (action === 'confirm') {
    return before.status === 'reserved' && Boolean(after.confirmedAt)
      && !['reserved', 'cancelled', 'expired'].includes(after.status);
  }
  return before.status === 'confirmed' && Boolean(after.deliveryStartedAt)
    && !['reserved', 'confirmed', 'cancelled', 'expired'].includes(after.status);
}

export const unknownSubmissionMessage = '网络中断，暂时没能确认结果。已填写的内容不会丢失，请恢复网络后再次确认。';
