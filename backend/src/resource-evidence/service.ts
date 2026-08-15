import { randomUUID } from 'node:crypto';
import { secretHash } from '../account/crypto.js';
import type { AccountStore } from '../account/store.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { PrivateObjectStore } from '../storage/object-store.js';
import type { SubjectAccess } from '../subjects/types.js';
import type { ResourceEvidenceStore } from './store.js';
import type { ResourceEvidenceCategory, ResourceEvidenceChecklist, ResourceEvidenceRecord } from './types.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

const extensions = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['application/pdf', 'pdf'],
]);

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export class ResourceEvidenceService {
  private readonly auditPepper: string;

  constructor(
    private readonly store: ResourceEvidenceStore,
    private readonly accounts: AccountStore,
    private readonly subjects: SubjectAccess,
    private readonly objects: PrivateObjectStore | null,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
  }

  async checklist(principal: AccountPrincipal, resourceId: string) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    const checklist = await this.store.checklist(subject.subjectId, resourceId);
    if (!checklist) throw new AppError('RESOURCE_NOT_FOUND', 404, '没有找到这项资源。');
    return this.serializeChecklist(checklist);
  }

  async createUpload(
    principal: AccountPrincipal,
    input: {
      resourceId: string; category: ResourceEvidenceCategory; fileName: string; mimeType: string;
      sizeBytes: number; sha256Digest: string; clientRequestId: string;
    },
    context: RequestContext,
  ) {
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    const objects = this.requireObjects();
    this.assertRequestId(input.clientRequestId);
    const extension = extensions.get(input.mimeType);
    if (!extension) throw new AppError('RESOURCE_EVIDENCE_TYPE_UNSUPPORTED', 400, '材料仅支持 JPG、PNG 和 PDF。');
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 20 * 1024 * 1024) {
      throw new AppError('RESOURCE_EVIDENCE_SIZE_INVALID', 400, '单份材料不能超过 20MB。');
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.sha256Digest)) {
      throw new AppError('RESOURCE_EVIDENCE_DIGEST_INVALID', 400, '材料文件摘要格式无效。');
    }
    const originalName = input.fileName.normalize('NFKC').replace(/^.*[\\/]/u, '').trim();
    const fileName = originalName.length > 0 && originalName.length <= 120
      ? originalName.replace(/[\r\n]/gu, '_') : `资源材料.${extension}`;
    const evidenceId = randomUUID();
    const objectKey = `quarantine/resources/${input.resourceId}/${evidenceId}.${extension}`;
    const payloadDigest = this.digest({
      resourceId: input.resourceId, category: input.category, fileName, mimeType: input.mimeType,
      sizeBytes: input.sizeBytes, sha256Digest: input.sha256Digest,
    });
    const result = await this.store.create({
      id: evidenceId, subjectId: subject.subjectId, userId: principal.userId, resourceId: input.resourceId,
      category: input.category, objectKey, fileName,
      mimeType: input.mimeType as ResourceEvidenceRecord['mimeType'], sizeBytes: input.sizeBytes,
      sha256Digest: input.sha256Digest, retentionUntil: new Date(this.now().getTime() + 3 * 365 * 24 * 60 * 60_000),
      clientRequestId: input.clientRequestId, payloadDigest,
    });
    if (result.status === 'not_found') throw new AppError('RESOURCE_NOT_FOUND', 404, '没有找到这项资源。');
    if (result.status === 'invalid_state') throw new AppError('RESOURCE_EVIDENCE_STATE_INVALID', 409, '这项资源已送审，当前不能再更换材料。');
    if (result.status === 'limit_reached') throw new AppError('RESOURCE_EVIDENCE_LIMIT_REACHED', 409, '待处理材料较多，请先删除未通过的文件再上传。');
    if (result.status === 'idempotency_conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的材料。');
    if (!('evidence' in result)) throw new Error('unhandled resource evidence result');
    const upload = result.evidence.status === 'pending_upload' ? await objects.createUploadGrant({
      objectKey: result.evidence.objectKey, mimeType: result.evidence.mimeType, sizeBytes: result.evidence.sizeBytes,
      sha256Hex: result.evidence.sha256Digest.slice(7), expiresAt: new Date(this.now().getTime() + 10 * 60_000),
    }) : null;
    if (result.status === 'created') await this.audit(principal, 'RESOURCE_EVIDENCE_UPLOAD_CREATED', result.evidence.id, context, {
      resourceId: input.resourceId, category: input.category, sizeBytes: input.sizeBytes,
    });
    return {
      replayed: result.status === 'replayed', evidence: this.serializeEvidence(result.evidence),
      upload: upload ? { ...upload, expiresAt: upload.expiresAt.toISOString() } : null,
    };
  }

  async renewUpload(principal: AccountPrincipal, resourceId: string, evidenceId: string, sha256Digest: string) {
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    const evidence = await this.store.get(subject.subjectId, resourceId, evidenceId);
    if (!evidence) throw new AppError('RESOURCE_EVIDENCE_NOT_FOUND', 404, '没有找到这份材料。');
    if (evidence.status !== 'pending_upload') throw new AppError('RESOURCE_EVIDENCE_UPLOAD_COMPLETED', 409, '材料已上传或正在检查。');
    if (evidence.sha256Digest !== sha256Digest) {
      throw new AppError('RESOURCE_EVIDENCE_FILE_CHANGED', 409, '这不是上次未完成的文件，将重新上传。');
    }
    const upload = await this.requireObjects().createUploadGrant({
      objectKey: evidence.objectKey, mimeType: evidence.mimeType, sizeBytes: evidence.sizeBytes,
      sha256Hex: evidence.sha256Digest.slice(7), expiresAt: new Date(this.now().getTime() + 10 * 60_000),
    });
    return { ...upload, expiresAt: upload.expiresAt.toISOString() };
  }

  async completeUpload(principal: AccountPrincipal, resourceId: string, evidenceId: string, context: RequestContext) {
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    const evidence = await this.store.get(subject.subjectId, resourceId, evidenceId);
    if (!evidence) throw new AppError('RESOURCE_EVIDENCE_NOT_FOUND', 404, '没有找到这份材料。');
    if (evidence.status === 'pending_scan' || evidence.status === 'verified') return this.serializeEvidence(evidence);
    if (evidence.status !== 'pending_upload') throw new AppError('RESOURCE_EVIDENCE_UPLOAD_STATE_INVALID', 409, '这份材料当前不能完成上传。');
    const object = await this.requireObjects().head(evidence.objectKey);
    const expectedHex = evidence.sha256Digest.slice(7);
    const expectedBase64 = Buffer.from(expectedHex, 'hex').toString('base64');
    if (object.sizeBytes !== evidence.sizeBytes || object.mimeType !== evidence.mimeType
      || object.metadataSha256 !== expectedHex || (object.sha256Base64 !== null && object.sha256Base64 !== expectedBase64)) {
      throw new AppError('RESOURCE_EVIDENCE_OBJECT_MISMATCH', 409, '上传文件与登记的信息不一致，请重新上传。');
    }
    const updated = await this.store.uploaded(evidence.id, this.now());
    if (!updated) throw new AppError('RESOURCE_EVIDENCE_UPLOAD_STATE_INVALID', 409, '材料状态已变化，请刷新后重试。');
    await this.audit(principal, 'RESOURCE_EVIDENCE_UPLOADED', evidence.id, context, { resourceId, category: evidence.category });
    return this.serializeEvidence(updated);
  }

  async discard(principal: AccountPrincipal, resourceId: string, evidenceId: string, context: RequestContext) {
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    const evidence = await this.store.discard(subject.subjectId, resourceId, evidenceId);
    if (!evidence) throw new AppError('RESOURCE_EVIDENCE_NOT_DISCARDABLE', 409, '材料正在检查、已经通过或不属于当前主体。');
    await this.objects?.delete(evidence.objectKey).catch(() => undefined);
    await this.audit(principal, 'RESOURCE_EVIDENCE_DISCARDED', evidence.id, context, { resourceId, category: evidence.category });
    return this.serializeEvidence(evidence);
  }

  async submit(
    principal: AccountPrincipal, resourceId: string, clientRequestId: string, context: RequestContext,
  ) {
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    this.assertRequestId(clientRequestId);
    const payloadDigest = this.digest({ resourceId, action: 'submit_resource_materials' });
    const result = await this.store.submit({
      id: randomUUID(), subjectId: subject.subjectId, userId: principal.userId, resourceId,
      clientRequestId, payloadDigest, now: this.now(),
    });
    if (result.status === 'not_found') throw new AppError('RESOURCE_NOT_FOUND', 404, '没有找到这项资源。');
    if (result.status === 'invalid_state') throw new AppError('RESOURCE_EVIDENCE_SUBMIT_STATE_INVALID', 409, '资源已经送审，或当前不能提交材料。');
    if (result.status === 'materials_incomplete') throw new AppError('RESOURCE_EVIDENCE_INCOMPLETE', 409, '三类材料全部通过安全检查后才能送审。');
    if (result.status === 'idempotency_conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了另一项资源。');
    if (!('runId' in result)) throw new Error('unhandled resource evidence submission result');
    if (result.status === 'created') await this.audit(principal, 'RESOURCE_EVIDENCE_SUBMITTED', resourceId, context, { runId: result.runId });
    return { replayed: result.status === 'replayed', runId: result.runId, submittedAt: result.submittedAt.toISOString() };
  }

  async operatorBundle(principal: AccountPrincipal, resourceId: string) {
    this.assertOperator(principal);
    const bundle = await this.store.reviewBundle(resourceId);
    if (!bundle) throw new AppError('RESOURCE_EVIDENCE_SUBMISSION_NOT_FOUND', 404, '这项资源还没有可审核的材料包。');
    return {
      resourceId: bundle.resourceId, verificationRunId: bundle.runId, status: bundle.runStatus,
      submittedAt: bundle.submittedAt.toISOString(),
      materials: bundle.materials.map((material) => this.serializeEvidence(material)),
    };
  }

  async operatorDownload(
    principal: AccountPrincipal, resourceId: string, evidenceId: string, context: RequestContext,
  ) {
    this.assertOperator(principal);
    const evidence = await this.store.submittedEvidence(resourceId, evidenceId);
    if (!evidence) throw new AppError('RESOURCE_EVIDENCE_NOT_FOUND', 404, '没有找到本轮送审材料。');
    const expiresAt = new Date(this.now().getTime() + 5 * 60_000);
    const url = await this.requireObjects().createDownloadUrl(evidence.objectKey, evidence.fileName, expiresAt);
    await this.audit(principal, 'RESOURCE_EVIDENCE_VIEWED', evidence.id, context, {
      resourceId, category: evidence.category,
    });
    return { url, expiresAt: expiresAt.toISOString(), fileName: evidence.fileName };
  }

  private requireObjects() {
    if (!this.objects) throw new AppError('OBJECT_STORAGE_UNAVAILABLE', 503, '材料存储服务暂时不可用。');
    return this.objects;
  }

  private assertRequestId(value: string) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(value)) throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '请求缺少有效的幂等标识。');
  }

  private assertOperator(principal: AccountPrincipal) {
    if (principal.role !== 'operator' && principal.role !== 'admin') {
      throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要运营审核权限。');
    }
  }

  private serializeEvidence(evidence: ResourceEvidenceRecord) {
    return {
      id: evidence.id, category: evidence.category, fileName: evidence.fileName, mimeType: evidence.mimeType,
      sizeBytes: evidence.sizeBytes, status: evidence.status,
      result: evidence.status === 'verified' ? 'clean' : evidence.status === 'rejected' ? 'replace_file'
        : evidence.status === 'scan_failed' ? 'checking_delayed' : null,
      createdAt: evidence.createdAt.toISOString(), uploadedAt: evidence.uploadedAt?.toISOString() ?? null,
      verifiedAt: evidence.verifiedAt?.toISOString() ?? null,
    };
  }

  private serializeChecklist(checklist: ResourceEvidenceChecklist) {
    return {
      resourceId: checklist.resourceId, resourceStatus: checklist.resourceStatus,
      review: {
        ...checklist.review, requestedAt: checklist.review.requestedAt?.toISOString() ?? null,
        submittedAt: checklist.review.submittedAt?.toISOString() ?? null,
      },
      categories: Object.fromEntries(Object.entries(checklist.categories).map(([key, value]) => [key, {
        state: value.state, reviewDecision: value.reviewDecision,
        evidence: value.evidence ? this.serializeEvidence(value.evidence) : null,
      }])),
      readyToSubmit: checklist.readyToSubmit,
    };
  }

  private digest(value: unknown) { return secretHash(JSON.stringify(value), this.auditPepper); }

  private audit(
    principal: AccountPrincipal, action: string, entityId: string, context: RequestContext, metadata: Record<string, unknown>,
  ) {
    return this.accounts.recordAudit({
      actorId: principal.userId, actorKind: principal.role === 'operator' || principal.role === 'admin' ? 'operator' : 'user',
      action, entityType: 'RESOURCE_EVIDENCE', entityId,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      payloadDigest: this.digest(metadata), metadata,
    });
  }
}
