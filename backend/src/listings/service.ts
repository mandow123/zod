import { randomUUID } from 'node:crypto';
import type { AccountStore } from '../account/store.js';
import type { AccountPrincipal } from '../account/types.js';
import { secretHash } from '../account/crypto.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { ListingAuditStore } from './store.js';
import {
  creditMicrosFromCnyMicros, formatCnyMicros, formatCreditMicros, KAI_CNY_MICROS_PER_CREDIT,
  parseCnyMicros, type AuditKind, type CreditListing, type OfferAudit, type OfferRevisionDraft, type OfferTemplate, type OfferWizardDraft,
  type OfferWizardPayload, type OfferWizardStep, type PublicCreditListing, type ServiceMode,
} from './types.js';
import type { SubjectAccess } from '../subjects/types.js';

type Context = Readonly<{ requestId: string; ip: string }>;
type OfferInput = Readonly<{
  resourceId: string;
  title: string;
  serviceMode: ServiceMode;
  nativeUnit: string;
  minimumQuantity: string;
  sla: Record<string, unknown>;
  deliveryTerms: Record<string, unknown>;
  acceptanceTerms: Record<string, unknown>;
  refundTerms: Record<string, unknown>;
  cleanupTerms: Record<string, unknown>;
  suggestedPriceCnyMicros: string;
  priceComponents: Record<string, unknown>;
  priceEvidence: unknown[];
}>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveMicros(value: string, code: string, message: string) {
  if (!/^\d{1,18}$/u.test(value)) throw new AppError(code, 400, message);
  const result = BigInt(value);
  if (result <= 0n) throw new AppError(code, 400, message);
  return result;
}

function decimalQuantity(value: string) {
  const normalized = value.trim().replace(/^0+(?=\d)/u, '');
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(normalized) || Number(normalized) <= 0) {
    throw new AppError('LISTING_QUANTITY_INVALID', 400, '数量必须大于零且最多保留六位小数。');
  }
  return normalized;
}

function publicObject(value: Record<string, unknown>) {
  const encoded = JSON.stringify(value);
  if (encoded.length > 20_000) throw new AppError('OFFER_FIELD_TOO_LARGE', 400, '商品方案内容过长，请精简后重试。');
  const forbidden = /password|secret|token|credential|private.?key|ssh.?key|endpoint|ip.?address/iu;
  const walk = (current: unknown): boolean => {
    if (Array.isArray(current)) return current.every(walk);
    if (!current || typeof current !== 'object') return true;
    return Object.entries(current).every(([key, nested]) => !forbidden.test(key) && walk(nested));
  };
  if (!walk(value)) throw new AppError('OFFER_SENSITIVE_DATA_FORBIDDEN', 400, '公开商品方案不能包含密码、密钥、地址或访问凭证。');
  return value;
}

function evidenceList(value: unknown[]) {
  const encoded = JSON.stringify(value);
  if (value.length < 1 || value.length > 20 || encoded.length > 40_000) {
    throw new AppError('PRICE_EVIDENCE_INVALID', 400, '请提交 1 至 20 条可核验价格依据。');
  }
  return value;
}

function wizardEvidenceList(value: unknown[]) {
  evidenceList(value);
  const allowed = new Set(['contract', 'invoice', 'market_quote', 'cost_breakdown']);
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AppError('PRICE_EVIDENCE_INVALID', 400, '每条价格依据都要包含类型、来源和说明。');
    }
    const record = item as Record<string, unknown>;
    if (typeof record.type !== 'string' || !allowed.has(record.type)
      || typeof record.source !== 'string' || record.source.trim().length < 2 || record.source.length > 120
      || typeof record.summary !== 'string' || record.summary.trim().length < 4 || record.summary.length > 1_000
      || (record.digest !== undefined && (typeof record.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(record.digest)))) {
      throw new AppError('PRICE_EVIDENCE_INVALID', 400, '价格依据的类型、来源、说明或摘要格式不正确。');
    }
    publicObject(record);
  }
  return value;
}

function draftEvidenceList(value: unknown[]) {
  if (value.length > 20 || JSON.stringify(value).length > 40_000) {
    throw new AppError('PRICE_EVIDENCE_INVALID', 400, '价格依据最多 20 条。');
  }
  const allowed = new Set(['contract', 'invoice', 'market_quote', 'cost_breakdown']);
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AppError('PRICE_EVIDENCE_INVALID', 400, '核价凭证草稿格式不正确。');
    }
    const record = item as Record<string, unknown>;
    if (typeof record.type !== 'string' || !allowed.has(record.type)
      || typeof record.source !== 'string' || record.source.length > 120
      || typeof record.summary !== 'string' || record.summary.length > 1_000
      || (record.digest !== undefined && (typeof record.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(record.digest)))) {
      throw new AppError('PRICE_EVIDENCE_INVALID', 400, '核价凭证草稿格式不正确。');
    }
    publicObject(record);
  }
  return value;
}

function optionalText(value: string | undefined, maximum: number) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length > maximum) throw new AppError('OFFER_FIELD_TOO_LARGE', 400, '商品方案内容过长，请精简后重试。');
  return normalized;
}

export class ListingAuditService {
  private readonly auditPepper: string;
  private readonly computeFulfillmentAvailable: boolean;

  constructor(
    private readonly store: ListingAuditStore,
    private readonly accounts: AccountStore,
    config: RuntimeConfig,
    private readonly subjects: SubjectAccess,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
    this.computeFulfillmentAvailable = config.readiness.capabilities.computeFulfillment.available;
  }

  async createOffer(principal: AccountPrincipal, input: OfferInput, clientRequestId: string, context: Context) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    this.assertRequestId(clientRequestId);
    const normalized = this.offerInput(input);
    const payloadDigest = this.digest(normalized);
    const result = await this.store.createOffer({
      id: randomUUID(), subjectId: subject.subjectId, userId: principal.userId, clientRequestId, payloadDigest, ...normalized,
    });
    if (!result) throw new AppError('RESOURCE_NOT_OFFERABLE', 409, '资源必须已验真、属于当前供应方且计量单位一致。');
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的商品方案。');
    if (result.status === 'created') await this.audit(principal, 'OFFER_DRAFT_CREATED', result.offer.id, context, { resourceId: input.resourceId });
    return { replayed: result.status === 'replayed', offer: this.serializeOffer(result.offer, []) };
  }

  async createWizardDraft(principal: AccountPrincipal, resourceId: string, clientRequestId: string, context: Context) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    this.assertRequestId(clientRequestId);
    const result = await this.store.createWizardDraft({
      id: randomUUID(), subjectId: subject.subjectId, userId: principal.userId, resourceId, clientRequestId,
      payloadDigest: this.digest({ resourceId }),
    });
    if (!result) throw new AppError('RESOURCE_NOT_OFFERABLE', 409, '只能为当前供应主体已验真的资源创建上架方案。');
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的上架草稿。');
    if (result.status === 'listing_active') throw new AppError('RESOURCE_LISTING_ALREADY_ACTIVE', 409, '这项资源已有挂牌，请从上架进度管理当前挂牌。');
    if (result.status === 'created') await this.audit(principal, 'OFFER_WIZARD_CREATED', result.draft.id, context, { resourceId }, 'OFFER_WIZARD_DRAFT');
    return { replayed: result.status === 'replayed', draft: this.serializeWizardDraft(result.draft) };
  }

  async wizardDrafts(principal: AccountPrincipal) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    return (await this.store.listWizardDrafts(subject.subjectId)).map((draft) => this.serializeWizardDraft(draft));
  }

  async wizardDraft(principal: AccountPrincipal, draftId: string) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    const draft = await this.store.getWizardDraft(subject.subjectId, draftId);
    if (!draft) throw new AppError('OFFER_DRAFT_NOT_FOUND', 404, '上架草稿不存在。');
    return this.serializeWizardDraft(draft);
  }

  async saveWizardDraft(principal: AccountPrincipal, draftId: string, input: Readonly<{
    expectedVersion: number; currentStep: OfferWizardStep; payload: OfferWizardPayload;
  }>) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    const payload = this.normalizeWizardPayload(input.payload);
    const draft = await this.store.updateWizardDraft({
      subjectId: subject.subjectId, draftId, expectedVersion: input.expectedVersion,
      currentStep: input.currentStep, payload,
    });
    if (!draft) throw new AppError('OFFER_DRAFT_EDIT_CONFLICT', 409, '该草稿已在其他设备更新或已提交，请刷新后确认。');
    return this.serializeWizardDraft(draft);
  }

  async abandonWizardDraft(principal: AccountPrincipal, draftId: string, expectedVersion: number, context: Context) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    const result = await this.store.abandonWizardDraft({
      subjectId: subject.subjectId, userId: principal.userId, draftId, expectedVersion,
    });
    if (result === 'not_found') throw new AppError('OFFER_DRAFT_NOT_FOUND', 404, '上架草稿不存在。');
    if (result === 'conflict') throw new AppError('OFFER_DRAFT_ABANDON_CONFLICT', 409, '草稿已在其他设备更新或已经提交，请刷新后确认。');
    await this.audit(principal, 'OFFER_WIZARD_ABANDONED', draftId, context, { expectedVersion }, 'OFFER_WIZARD_DRAFT');
    return { draftId };
  }

  async submitWizardDraft(principal: AccountPrincipal, draftId: string, expectedVersion: number, clientRequestId: string, context: Context) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    this.assertRequestId(clientRequestId);
    const draft = await this.store.getWizardDraft(subject.subjectId, draftId);
    if (!draft) throw new AppError('OFFER_DRAFT_NOT_FOUND', 404, '上架草稿不存在。');
    const normalized = this.wizardOfferInput(draft);
    const submitPayloadDigest = this.digest(normalized);
    const result = await this.store.submitWizardDraft({
      subjectId: subject.subjectId, userId: principal.userId, draftId, expectedVersion,
      submitRequestId: clientRequestId, submitPayloadDigest, ...normalized,
    });
    if (!('offer' in result)) {
      if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一提交标识已用于其他上架方案。');
      throw new AppError('OFFER_DRAFT_SUBMIT_CONFLICT', 409, '草稿已变化，或资源与供应主体不再满足上架条件。');
    }
    if (result.status === 'created') await this.audit(principal, 'OFFER_SUBMITTED', result.offer.id, context, {
      draftId, submissionVersion: result.offer.submissionVersion,
    });
    return { replayed: result.status === 'replayed', offer: this.serializeOffer(result.offer, result.audits) };
  }

  async createOfferRevision(principal: AccountPrincipal, offerId: string, clientRequestId: string, context: Context) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    this.assertRequestId(clientRequestId);
    const result = await this.store.createOfferRevision({
      id: randomUUID(), subjectId: subject.subjectId, userId: principal.userId, offerId, clientRequestId,
    });
    if (!result) throw new AppError('OFFER_REVISION_NOT_ALLOWED', 409, '这份方案当前不需要修改，或资源已不能上架。');
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识已用于另一份方案。');
    const item = await this.store.getSupplierOffer(subject.subjectId, offerId);
    if (!item) throw new AppError('OFFER_NOT_FOUND', 404, '上架方案不存在。');
    if (result.status === 'created') {
      await this.audit(principal, 'OFFER_REVISION_CREATED', result.draft.id, context, { offerId }, 'OFFER_REVISION_DRAFT');
    }
    return { replayed: result.status === 'replayed', draft: this.serializeRevisionDraft(result.draft, item.audits) };
  }

  async offerRevision(principal: AccountPrincipal, offerId: string) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    const [draft, item] = await Promise.all([
      this.store.getOfferRevision(subject.subjectId, offerId),
      this.store.getSupplierOffer(subject.subjectId, offerId),
    ]);
    if (!draft || !item) throw new AppError('OFFER_REVISION_NOT_FOUND', 404, '没有找到待修改的上架方案。');
    return this.serializeRevisionDraft(draft, item.audits);
  }

  async saveOfferRevision(principal: AccountPrincipal, offerId: string, input: Readonly<{
    expectedVersion: number; currentStep: OfferWizardStep; payload: OfferWizardPayload;
  }>) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    const draft = await this.store.updateOfferRevision({
      subjectId: subject.subjectId, offerId, expectedVersion: input.expectedVersion,
      currentStep: input.currentStep, payload: this.normalizeWizardPayload(input.payload),
    });
    if (!draft) throw new AppError('OFFER_REVISION_EDIT_CONFLICT', 409, '方案已在其他设备更新，或审核状态已经变化。');
    const item = await this.store.getSupplierOffer(subject.subjectId, offerId);
    if (!item) throw new AppError('OFFER_NOT_FOUND', 404, '上架方案不存在。');
    return this.serializeRevisionDraft(draft, item.audits);
  }

  async submitOfferRevision(principal: AccountPrincipal, offerId: string, expectedVersion: number, clientRequestId: string, context: Context) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    this.assertRequestId(clientRequestId);
    const draft = await this.store.getOfferRevision(subject.subjectId, offerId);
    if (!draft) throw new AppError('OFFER_REVISION_NOT_FOUND', 404, '没有找到待修改的上架方案。');
    const normalized = this.wizardOfferInput(draft);
    const submitPayloadDigest = this.digest(normalized);
    const result = await this.store.submitOfferRevision({
      subjectId: subject.subjectId, userId: principal.userId, offerId, expectedVersion,
      submitRequestId: clientRequestId, submitPayloadDigest, ...normalized,
    });
    if (!('offer' in result)) {
      if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一提交标识已用于其他修改内容。');
      throw new AppError('OFFER_REVISION_SUBMIT_CONFLICT', 409, '方案已变化，或资源与供应主体不再满足上架条件。');
    }
    if (result.status === 'created') {
      await this.audit(principal, 'OFFER_REVISION_SUBMITTED', result.offer.id, context, {
        revisionId: draft.id, submissionVersion: result.offer.submissionVersion,
      });
    }
    return { replayed: result.status === 'replayed', offer: this.serializeOffer(result.offer, result.audits) };
  }

  async updateOffer(principal: AccountPrincipal, offerId: string, expectedVersion: number, input: OfferInput, context: Context) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    const normalized = this.offerInput(input);
    const offer = await this.store.updateOffer({ subjectId: subject.subjectId, userId: principal.userId, offerId, expectedVersion, ...normalized });
    if (!offer) throw new AppError('OFFER_EDIT_CONFLICT', 409, '草稿已变化或当前状态不能编辑，请刷新后继续。');
    await this.audit(principal, 'OFFER_DRAFT_UPDATED', offer.id, context, { version: offer.version });
    return this.serializeOffer(offer, []);
  }

  async submitOffer(principal: AccountPrincipal, offerId: string, expectedVersion: number, context: Context) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    const result = await this.store.submitOffer(subject.subjectId, principal.userId, offerId, expectedVersion);
    if (!result) throw new AppError('OFFER_NOT_SUBMITTABLE', 409, '草稿已变化、资源状态异常或当前不能提交审核。');
    if (result.status === 'created') {
      await this.audit(principal, 'OFFER_SUBMITTED', result.offer.id, context, { submissionVersion: result.offer.submissionVersion });
    }
    return { replayed: result.status === 'replayed', offer: this.serializeOffer(result.offer, result.audits) };
  }

  async resubmitExpiredOffer(principal: AccountPrincipal, offerId: string, expectedVersion: number, context: Context) {
    const subject = await this.subjects.current(principal.userId, 'provider.offer.manage');
    const current = await this.store.getSupplierOffer(subject.subjectId, offerId);
    if (!current) throw new AppError('OFFER_NOT_FOUND', 404, '上架方案不存在。');
    if (current.offer.status === 'under_review' && current.offer.version === expectedVersion + 1) {
      const replay = await this.store.submitOffer(subject.subjectId, principal.userId, offerId, expectedVersion);
      if (replay?.status === 'replayed') return { replayed: true, offer: this.serializeOffer(replay.offer, replay.audits) };
    }
    if (current.offer.status !== 'expired') {
      throw new AppError('OFFER_REAUDIT_NOT_ALLOWED', 409, '只有审核已到期的方案可以重新提交审核。');
    }
    const result = await this.store.submitOffer(subject.subjectId, principal.userId, offerId, expectedVersion);
    if (!result) throw new AppError('OFFER_REAUDIT_CONFLICT', 409, '方案状态已变化，请刷新后重试。');
    if (result.status === 'created') {
      await this.audit(principal, 'OFFER_RESUBMITTED', result.offer.id, context, { submissionVersion: result.offer.submissionVersion });
    }
    return { replayed: result.status === 'replayed', offer: this.serializeOffer(result.offer, result.audits) };
  }

  async supplierOffers(principal: AccountPrincipal) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    return Promise.all((await this.store.listSupplierOffers(subject.subjectId)).map((item) => this.serializeOffer(item.offer, item.audits)));
  }

  async supplierOffer(principal: AccountPrincipal, offerId: string) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    const item = await this.store.getSupplierOffer(subject.subjectId, offerId);
    if (!item) throw new AppError('OFFER_NOT_FOUND', 404, '上架方案不存在。');
    return this.serializeOffer(item.offer, item.audits);
  }

  async decideAudit(principal: AccountPrincipal, input: Readonly<{
    offerId: string; kind: AuditKind; decision: 'approve' | 'changes_requested' | 'reject';
    decisionReason: string; evidenceSummary: string; evidenceDigest: string;
    validUntil?: string; approvedReferenceCnyMicros?: string; returnStep?: 'service' | 'terms' | 'price';
  }>, context: Context) {
    this.assertReviewer(principal, input.kind);
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.evidenceDigest)) {
      throw new AppError('AUDIT_EVIDENCE_INVALID', 400, '审核证据摘要格式不正确。');
    }
    const approved = input.decision === 'approve';
    if (!approved && !input.returnStep) {
      throw new AppError('AUDIT_RETURN_STEP_REQUIRED', 400, '要求修改或不通过时，必须指出用户需要返回的步骤。');
    }
    if (!approved && input.kind === 'price' && input.returnStep !== 'price') {
      throw new AppError('AUDIT_RETURN_STEP_INVALID', 400, '价格审核意见必须返回价格步骤。');
    }
    if (!approved && input.kind === 'resource' && !['service', 'terms'].includes(input.returnStep!)) {
      throw new AppError('AUDIT_RETURN_STEP_INVALID', 400, '资源审核意见必须返回服务或条款步骤。');
    }
    let validUntil: Date | undefined;
    let approvedReferenceCnyMicros: bigint | undefined;
    let approvedUnitCreditMicros: bigint | undefined;
    if (approved) {
      if (!input.validUntil) throw new AppError('AUDIT_VALIDITY_REQUIRED', 400, '审核通过必须填写有效期。');
      validUntil = new Date(input.validUntil);
      const maximumDays = input.kind === 'resource' ? 90 : 30;
      if (!Number.isFinite(validUntil.getTime()) || validUntil <= this.now()
        || validUntil.getTime() > this.now().getTime() + maximumDays * 86_400_000) {
        throw new AppError('AUDIT_VALIDITY_INVALID', 400, `${input.kind === 'resource' ? '资源' : '价格'}审核有效期不能超过 ${maximumDays} 天。`);
      }
      if (input.kind === 'price') {
        approvedReferenceCnyMicros = positiveMicros(
          input.approvedReferenceCnyMicros ?? '', 'AUDITED_PRICE_INVALID', '价格审核必须填写大于零的人民币 micros。',
        );
        approvedUnitCreditMicros = creditMicrosFromCnyMicros(approvedReferenceCnyMicros);
      }
    }
    const decisionDigest = this.digest({ ...input, reviewerId: principal.userId, validUntil: validUntil?.toISOString() ?? null });
    const result = await this.store.decideAudit({
      reviewerId: principal.userId, offerId: input.offerId, kind: input.kind, approved,
      changesRequested: input.decision === 'changes_requested', decisionReason: input.decisionReason.trim(),
      evidenceSummary: input.evidenceSummary.trim(), evidenceDigest: input.evidenceDigest, decisionDigest,
      ...(input.returnStep ? { returnStep: input.returnStep } : {}),
      ...(validUntil ? { validUntil } : {}),
      ...(approvedReferenceCnyMicros ? {
        approvedReferenceCnyMicros, conversionCnyMicrosPerCredit: KAI_CNY_MICROS_PER_CREDIT,
        approvedUnitCreditMicros: approvedUnitCreditMicros!,
      } : {}),
    });
    if (result === 'four_eyes_violation') throw new AppError('AUDIT_FOUR_EYES_REQUIRED', 409, '资源审核与价格审核必须由不同审核员完成。');
    if (result === 'self_review_violation') throw new AppError('AUDIT_SELF_REVIEW_FORBIDDEN', 409, '审核员不能审核自己所属供应主体的资源。');
    if (!result) throw new AppError('AUDIT_DECISION_CONFLICT', 409, '审核已处理或方案状态已变化，请刷新队列。');
    await this.audit(principal, `OFFER_${input.kind.toUpperCase()}_${input.decision.toUpperCase()}`, input.offerId, context, { decisionDigest });
    return this.serializeOffer(result.offer, result.audits);
  }

  async publish(principal: AccountPrincipal, input: Readonly<{ offerId: string; capacityTotal: string } & (
    | { startMode: 'immediate'; durationDays: number }
    | { startMode: 'scheduled'; startsAt: string; expiresAt: string }
  )>, clientRequestId: string, context: Context) {
    if (!this.computeFulfillmentAvailable) throw new AppError('COMPUTE_FULFILLMENT_UNAVAILABLE', 503,
      '节点接入或算力交付服务尚未准备好，当前不能发布挂牌。');
    const subject = await this.subjects.current(principal.userId, 'provider.listing.manage');
    this.assertRequestId(clientRequestId);
    const now = this.now();
    const requestedStartsAt = input.startMode === 'immediate' ? now : new Date(input.startsAt);
    const expiresAt = input.startMode === 'immediate'
      ? new Date(now.getTime() + input.durationDays * 86_400_000)
      : new Date(input.expiresAt);
    if (!Number.isFinite(requestedStartsAt.getTime()) || !Number.isFinite(expiresAt.getTime())
      || requestedStartsAt.getTime() < now.getTime() - 60_000 || expiresAt <= requestedStartsAt
      || expiresAt.getTime() - requestedStartsAt.getTime() > 366 * 86_400_000) {
      throw new AppError('LISTING_WINDOW_INVALID', 400, '可售时段无效，请重新选择开始时间和持续天数。');
    }
    const startsAt = requestedStartsAt < now ? now : requestedStartsAt;
    const capacityTotal = decimalQuantity(input.capacityTotal);
    const normalized = input.startMode === 'immediate'
      ? { offerId: input.offerId, capacityTotal, startMode: input.startMode, durationDays: input.durationDays }
      : { offerId: input.offerId, capacityTotal, startMode: input.startMode, startsAt: startsAt.toISOString(), expiresAt: expiresAt.toISOString() };
    const result = await this.store.publishListing({
      id: randomUUID(), subjectId: subject.subjectId, userId: principal.userId, clientRequestId, payloadDigest: this.digest(normalized),
      offerId: input.offerId, capacityTotal, startsAt, expiresAt,
    });
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的挂牌。');
    if (result.status === 'not_approved') throw new AppError('OFFER_APPROVAL_REQUIRED', 409, '商品方案必须完成双审核且资源与主体仍有效。');
    if (result.status === 'resource_not_ready') throw new AppError('RESOURCE_DELIVERY_NOT_READY', 409, '节点接入并保持在线后才能挂牌。');
    if (result.status === 'audit_expired') throw new AppError('OFFER_AUDIT_EXPIRED', 409, '上架时段超过审核有效期，请先重新审核。');
    if (result.status === 'minimum_not_met') throw new AppError('LISTING_BELOW_MINIMUM', 409, '可售数量不能低于该方案的最小起售量。');
    if (result.status === 'capacity_unavailable') throw new AppError('LISTING_CAPACITY_INVALID', 409, '挂牌容量超过资源核验容量。');
    if (result.status === 'window_conflict') throw new AppError('LISTING_WINDOW_CONFLICT', 409, '同一资源在该时段已有挂牌，请调整时段。');
    if (result.status === 'created') await this.audit(principal, 'CREDIT_LISTING_PUBLISHED', result.listing.id, context, { offerId: input.offerId }, 'CREDIT_LISTING');
    return { replayed: result.status === 'replayed', listing: this.serializeListing(result.listing) };
  }

  async listingWindowAvailability(principal: AccountPrincipal, input: Readonly<{ offerId: string } & (
    | { startMode: 'immediate'; durationDays: number }
    | { startMode: 'scheduled'; startsAt: string; expiresAt: string }
  )>) {
    const subject = await this.subjects.current(principal.userId, 'provider.listing.manage');
    const now = this.now();
    const startsAt = input.startMode === 'immediate' ? now : new Date(input.startsAt);
    const expiresAt = input.startMode === 'immediate'
      ? new Date(now.getTime() + input.durationDays * 86_400_000)
      : new Date(input.expiresAt);
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(expiresAt.getTime())
      || startsAt.getTime() < now.getTime() - 60_000 || expiresAt <= startsAt
      || expiresAt.getTime() - startsAt.getTime() > 366 * 86_400_000) {
      throw new AppError('LISTING_WINDOW_INVALID', 400, '可售时段无效，请重新选择开始时间和持续天数。');
    }
    const result = await this.store.listingWindowAvailability({
      subjectId: subject.subjectId, offerId: input.offerId, startsAt, expiresAt,
    });
    if (result.status === 'not_approved') throw new AppError('OFFER_APPROVAL_REQUIRED', 409, '商品方案必须完成双审核且资源与主体仍有效。');
    if (result.status === 'resource_not_ready') throw new AppError('RESOURCE_DELIVERY_NOT_READY', 409, '节点接入并保持在线后才能挂牌。');
    if (result.status === 'audit_expired') throw new AppError('OFFER_AUDIT_EXPIRED', 409, '上架时段超过审核有效期，请先重新审核。');
    return {
      status: result.status, resourceId: result.resourceId, capacityTotal: result.capacityTotal,
      capacityUnit: result.capacityUnit, minimumQuantity: result.minimumQuantity,
      auditValidUntil: result.auditValidUntil.toISOString(), requestedStartsAt: result.requestedStartsAt.toISOString(),
      requestedExpiresAt: result.requestedExpiresAt.toISOString(),
      blockingStartsAt: result.blockingStartsAt?.toISOString() ?? null,
      blockingExpiresAt: result.blockingExpiresAt?.toISOString() ?? null,
      nextAvailableAt: result.nextAvailableAt?.toISOString() ?? null,
    };
  }

  async publicListings(limit = 20, principal?: AccountPrincipal) {
    if (!this.computeFulfillmentAvailable) return [];
    const subject = principal ? await this.subjects.current(principal.userId, 'orders.read') : null;
    return (await this.store.listPublicListings(Math.min(Math.max(limit, 1), 50)))
      .map((listing) => this.serializePublicListing(listing, subject?.subjectId));
  }

  async supplierListings(principal: AccountPrincipal) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    return (await this.store.listSupplierListings(subject.subjectId)).map((listing) => this.serializeListing(listing));
  }

  async setListingStatus(principal: AccountPrincipal, listingId: string, targetStatus: 'active' | 'paused' | 'withdrawn', context: Context) {
    if (targetStatus === 'active' && !this.computeFulfillmentAvailable) {
      throw new AppError('COMPUTE_FULFILLMENT_UNAVAILABLE', 503, '节点接入或算力交付服务尚未准备好，当前不能恢复挂牌。');
    }
    const subject = await this.subjects.current(principal.userId, 'provider.listing.manage');
    const result = await this.store.setListingStatus({ subjectId: subject.subjectId, listingId, targetStatus });
    if (result.status === 'updated' || result.status === 'replayed') {
      if (result.status === 'updated') {
        await this.audit(principal, `CREDIT_LISTING_${targetStatus.toUpperCase()}`, listingId, context, { targetStatus }, 'CREDIT_LISTING');
      }
      return { replayed: result.status === 'replayed', listing: this.serializeListing(result.listing) };
    }
    if (result.status === 'not_found') throw new AppError('LISTING_NOT_FOUND', 404, '挂牌不存在或不属于当前交易主体。');
    if (result.status === 'expired') throw new AppError('LISTING_EXPIRED', 409, '该挂牌已到期，如需继续售卖请重新上架。');
    if (result.status === 'reserved_capacity') throw new AppError('LISTING_HAS_RESERVATIONS', 409, '当前还有已预留容量，请先完成或释放后再结束挂牌。');
    if (result.status === 'approval_invalid') throw new AppError('LISTING_APPROVAL_INVALID', 409, '资源或审核状态已变化，当前不能恢复销售。');
    if (result.status === 'capacity_unavailable') throw new AppError('LISTING_CAPACITY_UNAVAILABLE', 409, '可售余量低于最低起售量，当前不能恢复销售。');
    if (result.status === 'resource_not_ready') throw new AppError('RESOURCE_DELIVERY_NOT_READY', 409, '节点恢复在线后才能继续销售。');
    if (result.status === 'invalid_transition') throw new AppError('LISTING_STATUS_CONFLICT', 409, '挂牌状态已变化，请刷新后重试。');
    throw new AppError('LISTING_STATUS_CONFLICT', 409, '挂牌状态已变化，请刷新后重试。');
  }

  private offerInput(input: OfferInput) {
    if (input.serviceMode !== 'dedicated' || input.nativeUnit.trim() !== 'GPU时') {
      throw new AppError('COMPUTE_PRODUCT_CONTRACT_UNSUPPORTED', 400, '当前只支持一单一张、按 GPU时计量的整卡独享方案。');
    }
    const suggestedPriceCnyMicros = positiveMicros(
      input.suggestedPriceCnyMicros, 'SUGGESTED_PRICE_INVALID', '建议价格必须使用大于零的人民币 micros。',
    );
    return {
      resourceId: input.resourceId, title: input.title.trim(), serviceMode: input.serviceMode,
      nativeUnit: input.nativeUnit.trim(), minimumQuantity: decimalQuantity(input.minimumQuantity),
      sla: publicObject(input.sla), deliveryTerms: publicObject(input.deliveryTerms),
      acceptanceTerms: publicObject(input.acceptanceTerms), refundTerms: publicObject(input.refundTerms),
      cleanupTerms: publicObject(input.cleanupTerms), suggestedPriceCnyMicros,
      priceComponents: publicObject(input.priceComponents), priceEvidence: evidenceList(input.priceEvidence),
    };
  }

  private normalizeWizardPayload(input: OfferWizardPayload): OfferWizardPayload {
    const suggestedPriceCny = optionalText(input.suggestedPriceCny, 32);
    if (suggestedPriceCny && !parseCnyMicros(suggestedPriceCny)) {
      throw new AppError('SUGGESTED_PRICE_INVALID', 400, '人民币依据必须大于零且最多保留六位小数。');
    }
    if (input.minimumQuantity?.trim() && !/^(?:0|[1-9]\d{0,11})(?:\.\d{0,6})?$/u.test(input.minimumQuantity.trim())) {
      throw new AppError('LISTING_QUANTITY_INVALID', 400, '数量最多保留六位小数。');
    }
    return {
      ...(input.title === undefined ? {} : { title: optionalText(input.title, 120) }),
      ...(input.serviceMode === undefined ? {} : { serviceMode: input.serviceMode }),
      ...(input.nativeUnit === undefined ? {} : { nativeUnit: optionalText(input.nativeUnit, 40) }),
      ...(input.minimumQuantity === undefined ? {} : { minimumQuantity: optionalText(input.minimumQuantity, 40) }),
      ...(input.sla === undefined ? {} : { sla: publicObject(input.sla) }),
      ...(input.deliveryTerms === undefined ? {} : { deliveryTerms: publicObject(input.deliveryTerms) }),
      ...(input.acceptanceTerms === undefined ? {} : { acceptanceTerms: publicObject(input.acceptanceTerms) }),
      ...(input.refundTerms === undefined ? {} : { refundTerms: publicObject(input.refundTerms) }),
      ...(input.cleanupTerms === undefined ? {} : { cleanupTerms: publicObject(input.cleanupTerms) }),
      ...(suggestedPriceCny === undefined ? {} : { suggestedPriceCny }),
      ...(input.priceComponents === undefined ? {} : { priceComponents: publicObject(input.priceComponents) }),
      ...(input.priceEvidence === undefined ? {} : { priceEvidence: draftEvidenceList(input.priceEvidence) }),
    };
  }

  private wizardOfferInput(draft: Pick<OfferWizardDraft | OfferRevisionDraft, 'resourceId' | 'capacityUnit' | 'payload'>) {
    const payload = draft.payload;
    const suggestedPriceCnyMicros = parseCnyMicros(payload.suggestedPriceCny ?? '');
    if (!suggestedPriceCnyMicros) throw new AppError('OFFER_DRAFT_INCOMPLETE', 400, '请完成价格依据后再提交审核。');
    const requiredRecord = (value: Record<string, unknown> | undefined, message: string) => {
      if (!value || Object.keys(value).length === 0) throw new AppError('OFFER_DRAFT_INCOMPLETE', 400, message);
      return value;
    };
    const value = this.offerInput({
      resourceId: draft.resourceId,
      title: payload.title ?? '',
      serviceMode: payload.serviceMode ?? 'dedicated',
      nativeUnit: payload.nativeUnit ?? draft.capacityUnit,
      minimumQuantity: payload.minimumQuantity ?? '',
      sla: requiredRecord(payload.sla, '请填写服务保障后再提交审核。'),
      deliveryTerms: requiredRecord(payload.deliveryTerms, '请填写交付方式后再提交审核。'),
      acceptanceTerms: requiredRecord(payload.acceptanceTerms, '请填写验收规则后再提交审核。'),
      refundTerms: requiredRecord(payload.refundTerms, '请填写退款规则后再提交审核。'),
      cleanupTerms: requiredRecord(payload.cleanupTerms, '请填写数据清理规则后再提交审核。'),
      suggestedPriceCnyMicros: suggestedPriceCnyMicros.toString(),
      priceComponents: requiredRecord(payload.priceComponents, '请填写价格构成后再提交审核。'),
      priceEvidence: wizardEvidenceList(payload.priceEvidence ?? []),
    });
    if (value.title.length < 2 || value.nativeUnit.length < 1) {
      throw new AppError('OFFER_DRAFT_INCOMPLETE', 400, '请完成服务名称与计量单位后再提交审核。');
    }
    return value;
  }

  private serializeWizardDraft(draft: OfferWizardDraft) {
    const cnyMicros = draft.payload.suggestedPriceCny ? parseCnyMicros(draft.payload.suggestedPriceCny) : null;
    return {
      id: draft.id, resourceId: draft.resourceId,
      resource: { name: draft.resourceName, kind: draft.resourceKind, capacityUnit: draft.capacityUnit },
      version: draft.version, currentStep: draft.currentStep, payload: draft.payload, status: draft.status,
      convertedOfferId: draft.convertedOfferId, createdAt: draft.createdAt.toISOString(), updatedAt: draft.updatedAt.toISOString(),
      pricePreview: cnyMicros ? {
        referenceCny: formatCnyMicros(cnyMicros), unitCredits: formatCreditMicros(creditMicrosFromCnyMicros(cnyMicros)),
        conversion: '1 KAI卡时 = ¥1.002', auditStatus: 'pending_price_audit',
      } : null,
    };
  }

  private serializeRevisionDraft(draft: OfferRevisionDraft, audits: OfferAudit[]) {
    const base = this.serializeWizardDraft({ ...draft, convertedOfferId: null } as OfferWizardDraft);
    return {
      ...base, offerId: draft.offerId, sourceOfferVersion: draft.sourceOfferVersion,
      reviewFeedback: audits.filter((item) => ['changes_requested', 'rejected'].includes(item.status)).map((item) => ({
        kind: item.kind, status: item.status, reason: item.decisionReason,
        summary: item.evidenceSummary, returnStep: item.returnStep ?? (item.kind === 'price' ? 'price' : 'service'),
      })),
    };
  }

  private serializeOffer(offer: OfferTemplate, audits: OfferAudit[]) {
    const audit = (kind: AuditKind) => audits.find((item) => item.kind === kind);
    const serializeAudit = (item: OfferAudit | undefined) => item ? {
      id: item.id, kind: item.kind,
      status: item.status === 'approved' && item.validUntil && item.validUntil <= this.now() ? 'expired' : item.status,
      decisionReason: item.decisionReason,
      evidenceSummary: item.evidenceSummary, evidenceDigest: item.evidenceDigest,
      returnStep: item.returnStep,
      validUntil: item.validUntil?.toISOString() ?? null, decidedAt: item.decidedAt?.toISOString() ?? null,
    } : null;
    return {
      id: offer.id, resourceId: offer.resourceId, version: offer.version, submissionVersion: offer.submissionVersion,
      title: offer.title, serviceMode: offer.serviceMode, nativeUnit: offer.nativeUnit,
      minimumQuantity: offer.minimumQuantity, sla: offer.sla, deliveryTerms: offer.deliveryTerms,
      acceptanceTerms: offer.acceptanceTerms, refundTerms: offer.refundTerms, cleanupTerms: offer.cleanupTerms,
      suggestedPriceCny: formatCnyMicros(offer.suggestedPriceCnyMicros), priceComponents: offer.priceComponents,
      priceEvidence: offer.priceEvidence, status: offer.status,
      approvedReferenceCny: offer.approvedReferenceCnyMicros ? formatCnyMicros(offer.approvedReferenceCnyMicros) : null,
      approvedUnitCredits: offer.approvedUnitCreditMicros ? formatCreditMicros(offer.approvedUnitCreditMicros) : null,
      conversion: offer.conversionCnyMicrosPerCredit ? '1 KAI卡时 = ¥1.002' : null,
      auditValidUntil: offer.auditValidUntil?.toISOString() ?? null,
      submittedAt: offer.submittedAt?.toISOString() ?? null, approvedAt: offer.approvedAt?.toISOString() ?? null,
      createdAt: offer.createdAt.toISOString(), updatedAt: offer.updatedAt.toISOString(),
      audits: { resource: serializeAudit(audit('resource')), price: serializeAudit(audit('price')) },
    };
  }

  private serializeListing(listing: CreditListing) {
    const now = this.now();
    const sellingStage = listing.status === 'active'
      ? listing.startsAt > now ? 'scheduled' : listing.expiresAt <= now ? 'expired' : 'selling'
      : listing.status === 'paused' && listing.startsAt > now ? 'scheduled_paused'
        : listing.status === 'sold_out' ? 'sold_out' : listing.status;
    const capacityAvailable = remainingQuantity(listing.capacityTotal, listing.capacityReserved, listing.capacitySold);
    return {
      id: listing.id, offerId: listing.offerId, resourceId: listing.resourceId, capacityTotal: listing.capacityTotal,
      capacityReserved: listing.capacityReserved, capacitySold: listing.capacitySold,
      capacityAvailable,
      capacityUnit: listing.capacityUnit, minimumQuantity: listing.minimumQuantity,
      unitCredits: formatCreditMicros(listing.unitCreditMicros), referenceCny: formatCnyMicros(listing.referenceCnyMicros),
      conversion: '1 KAI卡时 = ¥1.002', status: listing.status, sellingStage, startsAt: listing.startsAt.toISOString(),
      expiresAt: listing.expiresAt.toISOString(), auditValidUntil: listing.auditValidUntil.toISOString(),
      createdAt: listing.createdAt.toISOString(), audits: { resource: true, price: true },
      selloutEstimate: {
        kind: 'gross_before_fee' as const,
        grossCredits: grossCreditsForQuantity(capacityAvailable, listing.unitCreditMicros),
        basis: 'remaining_capacity' as const,
        remainingCapacity: capacityAvailable,
        asOf: now.toISOString(),
        disclosure: '按当前剩余容量全部售完测算，未扣服务费',
      },
    };
  }

  private serializePublicListing(listing: PublicCreditListing, currentSubjectId?: string) {
    const { supplierSubjectId, ...publicListing } = listing;
    return {
      ...this.serializeListing(publicListing), title: listing.title, serviceMode: listing.serviceMode,
      productCode: listing.productCode, kind: listing.kind, region: listing.region,
      specifications: listing.specifications, sla: listing.sla, capacityAvailable: listing.capacityAvailable,
      ownedByCurrentSubject: currentSubjectId !== undefined && supplierSubjectId === currentSubjectId,
    };
  }

  private assertReviewer(principal: AccountPrincipal, _kind: AuditKind) {
    if (!['operator', 'admin'].includes(principal.role)) throw new AppError('AUDITOR_REQUIRED', 403, '该操作需要审核权限。');
  }

  private assertRequestId(value: string) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(value)) throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '请求缺少有效的幂等标识。');
  }

  private digest(value: unknown) {
    return secretHash(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item), this.auditPepper);
  }

  private audit(principal: AccountPrincipal, action: string, entityId: string, context: Context, metadata: Record<string, unknown>, entityType = 'OFFER_TEMPLATE') {
    return this.accounts.recordAudit({
      actorId: principal.userId, actorKind: ['operator', 'admin'].includes(principal.role) ? 'operator' : 'user',
      action, entityType, entityId,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      payloadDigest: this.digest(metadata), metadata,
    });
  }
}

function remainingQuantity(total: string, reserved: string, sold: string) {
  const scaled = (value: string) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  };
  const value = scaled(total) - scaled(reserved) - scaled(sold);
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
}

function grossCreditsForQuantity(quantity: string, unitCreditMicros: bigint) {
  const [whole = '0', fraction = ''] = quantity.split('.');
  const quantityMicros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  const grossMicros = (quantityMicros * unitCreditMicros + 999_999n) / 1_000_000n;
  return formatCreditMicros(grossMicros);
}
