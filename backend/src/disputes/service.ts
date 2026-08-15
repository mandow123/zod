import { randomUUID } from 'node:crypto';
import { secretHash } from '../account/crypto.js';
import type { AccountStore } from '../account/store.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { PrivateObjectStore } from '../storage/object-store.js';
import type { DisputeStore } from './store.js';
import type { DisputeCategory, DisputeRecord, EvidenceRecord } from './types.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

const evidenceTypes = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['application/pdf', 'pdf'],
  ['text/plain', 'txt'], ['application/json', 'json'],
]);

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export class DisputeService {
  private readonly auditPepper: string;

  constructor(
    private readonly store: DisputeStore,
    private readonly accountStore: AccountStore,
    private readonly objects: PrivateObjectStore | null,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
  }

  async open(
    principal: AccountPrincipal, input: { orderId: string; category: DisputeCategory; reason: string; idempotencyKey: string }, context: RequestContext,
  ) {
    const reason = input.reason.trim();
    if (reason.length < 8 || reason.length > 2_000) throw new AppError('DISPUTE_REASON_INVALID', 400, '请填写 8 至 2000 个字符的争议说明。');
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(input.idempotencyKey)) throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '争议请求缺少有效的幂等标识。');
    const payloadDigest = secretHash(JSON.stringify({ orderId: input.orderId, category: input.category, reason }), this.auditPepper);
    const result = await this.store.open({
      id: randomUUID(), userId: principal.userId, orderId: input.orderId, category: input.category, reason,
      evidenceDeadline: new Date(this.now().getTime() + 72 * 60 * 60_000), idempotencyKey: input.idempotencyKey, payloadDigest,
    });
    if (result.status === 'idempotency_conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一幂等标识对应了不同的争议内容。');
    if (result.status === 'order_not_found') throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在或不属于当前账户。');
    if (result.status === 'order_not_disputable') throw new AppError('ORDER_NOT_DISPUTABLE', 409, '订单当前不能发起争议。');
    if (result.status === 'active_dispute_exists') throw new AppError('DISPUTE_ALREADY_ACTIVE', 409, '该订单已有争议正在处理中。');
    if (result.status === 'created') await this.audit(principal, 'DISPUTE_OPENED', 'DISPUTE', result.dispute.id, context, { orderId: input.orderId, category: input.category });
    return { replayed: result.status === 'replayed', dispute: this.serialize(result.dispute, principal) };
  }

  async list(principal: AccountPrincipal) {
    return (await this.store.list(principal.userId, this.isOperator(principal))).map((dispute) => this.serialize(dispute, principal));
  }

  async detail(principal: AccountPrincipal, disputeId: string) {
    const dispute = await this.store.get(principal.userId, disputeId, this.isOperator(principal));
    if (!dispute) throw new AppError('DISPUTE_NOT_FOUND', 404, '争议记录不存在。');
    const evidence = await this.store.listEvidence(principal.userId, disputeId, this.isOperator(principal));
    return { ...this.serialize(dispute, principal), evidence: (evidence ?? []).map((item) => this.serializeEvidence(item)) };
  }

  async createEvidenceUpload(
    principal: AccountPrincipal,
    input: { disputeId: string; mimeType: string; sizeBytes: number; sha256Digest: string },
    context: RequestContext,
  ) {
    const objects = this.requireObjects();
    const extension = evidenceTypes.get(input.mimeType);
    if (!extension) throw new AppError('EVIDENCE_TYPE_UNSUPPORTED', 400, '仅支持 JPG、PNG、PDF、TXT 和 JSON 证据。');
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 20 * 1024 * 1024) {
      throw new AppError('EVIDENCE_SIZE_INVALID', 400, '单个证据文件大小不能超过 20MB。');
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.sha256Digest)) throw new AppError('EVIDENCE_DIGEST_INVALID', 400, '证据文件摘要格式无效。');
    const evidenceId = randomUUID();
    const objectKey = `quarantine/disputes/${input.disputeId}/${evidenceId}.${extension}`;
    const evidence = await this.store.createEvidence({
      id: evidenceId, disputeId: input.disputeId, userId: principal.userId, operator: this.isOperator(principal),
      objectKey, fileName: `证据-${evidenceId.slice(0, 8)}.${extension}`,
      mimeType: input.mimeType, sizeBytes: input.sizeBytes, sha256Digest: input.sha256Digest,
      retentionUntil: new Date(this.now().getTime() + 3 * 365 * 24 * 60 * 60_000),
      now: this.now(),
    });
    if (!evidence) throw new AppError('EVIDENCE_UPLOAD_NOT_ALLOWED', 409, '当前争议不能继续添加证据，或证据数量已达上限。');
    const upload = await objects.createUploadGrant({
      objectKey, mimeType: evidence.mimeType, sizeBytes: evidence.sizeBytes,
      sha256Hex: evidence.sha256Digest.slice(7), expiresAt: new Date(this.now().getTime() + 10 * 60_000),
    });
    await this.audit(principal, 'EVIDENCE_UPLOAD_CREATED', 'DISPUTE_EVIDENCE', evidence.id, context, { disputeId: input.disputeId, sizeBytes: input.sizeBytes });
    return { evidence: this.serializeEvidence(evidence), upload: { ...upload, expiresAt: upload.expiresAt.toISOString() } };
  }

  async renewEvidenceUpload(principal: AccountPrincipal, disputeId: string, evidenceId: string) {
    const objects = this.requireObjects();
    const evidence = await this.store.getEvidence(principal.userId, disputeId, evidenceId, this.isOperator(principal));
    if (!evidence) throw new AppError('EVIDENCE_NOT_FOUND', 404, '证据记录不存在。');
    if (evidence.status !== 'pending_upload') throw new AppError('EVIDENCE_UPLOAD_ALREADY_COMPLETED', 409, '该证据已完成上传或进入审核。');
    const upload = await objects.createUploadGrant({
      objectKey: evidence.objectKey, mimeType: evidence.mimeType, sizeBytes: evidence.sizeBytes,
      sha256Hex: evidence.sha256Digest.slice(7), expiresAt: new Date(this.now().getTime() + 10 * 60_000),
    });
    return { ...upload, expiresAt: upload.expiresAt.toISOString() };
  }

  async completeEvidenceUpload(
    principal: AccountPrincipal, disputeId: string, evidenceId: string, context: RequestContext,
  ) {
    const objects = this.requireObjects();
    const evidence = await this.store.getEvidence(principal.userId, disputeId, evidenceId, this.isOperator(principal));
    if (!evidence) throw new AppError('EVIDENCE_NOT_FOUND', 404, '证据记录不存在。');
    if (evidence.status === 'pending_scan' || evidence.status === 'verified') return this.serializeEvidence(evidence);
    if (evidence.status !== 'pending_upload') throw new AppError('EVIDENCE_UPLOAD_STATE_INVALID', 409, '该证据当前不能完成上传。');
    const object = await objects.head(evidence.objectKey);
    const expectedHex = evidence.sha256Digest.slice(7);
    const expectedBase64 = Buffer.from(expectedHex, 'hex').toString('base64');
    if (object.sizeBytes !== evidence.sizeBytes || object.mimeType !== evidence.mimeType
      || object.metadataSha256 !== expectedHex || (object.sha256Base64 !== null && object.sha256Base64 !== expectedBase64)) {
      throw new AppError('EVIDENCE_OBJECT_MISMATCH', 409, '上传文件与登记的大小、类型或摘要不一致，请重新上传。');
    }
    const updated = await this.store.markEvidenceUploaded(evidence.id, this.now());
    if (!updated) throw new AppError('EVIDENCE_UPLOAD_STATE_INVALID', 409, '证据状态已变化，请刷新后重试。');
    await this.audit(principal, 'EVIDENCE_UPLOADED', 'DISPUTE_EVIDENCE', evidence.id, context, { disputeId });
    return this.serializeEvidence(updated);
  }

  async discardEvidence(
    principal: AccountPrincipal, disputeId: string, evidenceId: string, context: RequestContext,
  ) {
    const evidence = await this.store.discardEvidence(principal.userId, disputeId, evidenceId);
    if (!evidence) throw new AppError('EVIDENCE_NOT_DISCARDABLE', 409, '该证据正在安全检查、已通过核验，或不属于当前账户。');
    await this.objects?.delete(evidence.objectKey).catch(() => undefined);
    await this.audit(principal, 'EVIDENCE_DISCARDED', 'DISPUTE_EVIDENCE', evidence.id, context, { disputeId });
    return this.serializeEvidence(evidence);
  }

  async evidenceDownload(principal: AccountPrincipal, disputeId: string, evidenceId: string) {
    const evidence = await this.store.getEvidence(principal.userId, disputeId, evidenceId, this.isOperator(principal));
    if (!evidence) throw new AppError('EVIDENCE_NOT_FOUND', 404, '证据记录不存在。');
    if (evidence.status !== 'verified') throw new AppError('EVIDENCE_NOT_VERIFIED', 409, '证据尚未通过安全检查，暂不能下载。');
    const expiresAt = new Date(this.now().getTime() + 5 * 60_000);
    return {
      url: await this.requireObjects().createDownloadUrl(evidence.objectKey, evidence.fileName, expiresAt),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async close(principal: AccountPrincipal, disputeId: string, context: RequestContext) {
    const dispute = await this.store.close(principal.userId, disputeId);
    if (!dispute) throw new AppError('DISPUTE_NOT_CLOSABLE', 409, '争议已进入审核或不属于当前账户，无法关闭。');
    await this.audit(principal, 'DISPUTE_CLOSED', 'DISPUTE', dispute.id, context, { orderId: dispute.orderId });
    return this.serialize(dispute, principal);
  }

  async completeEvidenceSubmission(principal: AccountPrincipal, disputeId: string, context: RequestContext) {
    const dispute = await this.store.completeEvidenceSubmission(principal.userId, disputeId, this.now());
    if (!dispute) throw new AppError('DISPUTE_NOT_FOUND', 404, '争议记录不存在或当前不能提交证据。');
    await this.audit(principal, 'EVIDENCE_SUBMISSION_COMPLETED', 'DISPUTE', dispute.id, context, {});
    return this.serialize(dispute, principal);
  }

  async resolve(
    principal: AccountPrincipal,
    input: { disputeId: string; outcome: 'buyer' | 'supplier'; resolution: string; refundAmountCents?: number },
    context: RequestContext,
  ) {
    if (!this.isOperator(principal)) throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要运营审核权限。');
    const resolution = input.resolution.trim();
    if (resolution.length < 8 || resolution.length > 2_000) throw new AppError('DISPUTE_RESOLUTION_INVALID', 400, '请填写 8 至 2000 个字符的裁定说明。');
    const payloadDigest = secretHash(JSON.stringify({ outcome: input.outcome, resolution, amount: input.refundAmountCents ?? null }), this.auditPepper);
    const result = await this.store.resolve({
      disputeId: input.disputeId, operatorId: principal.userId, outcome: input.outcome,
      resolution, refundId: randomUUID(), payloadDigest, now: this.now(),
      ...(input.refundAmountCents === undefined ? {} : { refundAmountCents: input.refundAmountCents }),
    });
    if (result.status === 'invalid_state') throw new AppError('DISPUTE_RESOLUTION_STATE_INVALID', 409, '争议当前状态不能执行裁定。');
    if (result.status === 'evidence_pending') throw new AppError('DISPUTE_EVIDENCE_PENDING', 409, '仍有证据正在上传或安全检查，请完成后再裁定。');
    if (result.status === 'evidence_window_open') throw new AppError('DISPUTE_EVIDENCE_WINDOW_OPEN', 409, '证据提交期尚未结束，需双方完成提交或等待截止时间。');
    if (result.status === 'refund_unavailable') throw new AppError('DISPUTE_REFUND_UNAVAILABLE', 409, '争议订单没有可执行退款的成功付款。');
    if (result.status === 'refund_amount_invalid') throw new AppError('DISPUTE_REFUND_AMOUNT_INVALID', 400, '裁定退款金额超过可退余额。');
    await this.audit(principal, 'DISPUTE_RESOLVED', 'DISPUTE', result.dispute.id, context, { outcome: input.outcome, refundId: result.dispute.resolutionRefundId });
    return this.serialize(result.dispute, principal);
  }

  private requireObjects() {
    if (!this.objects) throw new AppError('OBJECT_STORAGE_UNAVAILABLE', 503, '证据存储服务暂时不可用。');
    return this.objects;
  }

  private isOperator(principal: AccountPrincipal) {
    return principal.role === 'operator' || principal.role === 'admin';
  }

  private serialize(dispute: DisputeRecord, principal: AccountPrincipal) {
    return {
      id: dispute.id, orderId: dispute.orderId, orderNumber: dispute.orderNumber,
      openedByCurrentUser: dispute.openedBy === principal.userId,
      canClose: dispute.openedBy === principal.userId && ['open', 'evidence_pending'].includes(dispute.status),
      category: dispute.category, reason: dispute.reason, status: dispute.status,
      resolution: dispute.resolution, resolutionRefundId: dispute.resolutionRefundId,
      evidenceDeadline: dispute.evidenceDeadline.toISOString(),
      buyerEvidenceCompleted: Boolean(dispute.buyerEvidenceCompletedAt),
      supplierEvidenceCompleted: Boolean(dispute.supplierEvidenceCompletedAt),
      createdAt: dispute.createdAt.toISOString(), updatedAt: dispute.updatedAt.toISOString(),
    };
  }

  private serializeEvidence(evidence: EvidenceRecord) {
    return {
      id: evidence.id, fileName: evidence.fileName, mimeType: evidence.mimeType, sizeBytes: evidence.sizeBytes,
      sha256Digest: evidence.sha256Digest, status: evidence.status,
      scanResult: evidence.status === 'verified' ? 'clean' : evidence.status === 'rejected' ? 'rejected' : evidence.status === 'scan_failed' ? 'scanner_unavailable' : null,
      createdAt: evidence.createdAt.toISOString(), uploadedAt: evidence.uploadedAt?.toISOString() ?? null,
      verifiedAt: evidence.verifiedAt?.toISOString() ?? null,
    };
  }

  private async audit(
    principal: AccountPrincipal, action: string, entityType: string, entityId: string,
    context: RequestContext, metadata: Record<string, unknown>,
  ) {
    await this.accountStore.recordAudit({
      actorId: principal.userId, actorKind: 'user', action, entityType, entityId,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      payloadDigest: secretHash(JSON.stringify(metadata), this.auditPepper), metadata,
    });
  }
}
