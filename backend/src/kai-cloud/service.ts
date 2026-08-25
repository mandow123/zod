import { createHash } from 'node:crypto';
import type { AccountPrincipal } from '../account/types.js';
import { AppError } from '../errors.js';
import type { SubjectAccess } from '../subjects/types.js';
import { KaiCloudError } from './client.js';
import type { KaiCloudVerificationStore, StoredKaiCloudVerification } from './store.js';
import type { KaiCloudPublicApi, KaiCloudVerification } from './types.js';
import type { KaiCloudWebhookVerifier } from './webhook.js';

export interface KaiCloudAuditRecorder { record(input: Readonly<{ actorUserId: string | null; action: string;
  entityType: string; entityId: string; requestId: string; ip: string; details: Record<string, unknown> }>): Promise<void>; }
export type KaiCloudRequestContext = Readonly<{ requestId: string; ip: string }>;

export class KaiCloudVerificationService {
  constructor(private readonly store: KaiCloudVerificationStore, private readonly subjects: SubjectAccess,
    private readonly api: KaiCloudPublicApi, private readonly webhook: KaiCloudWebhookVerifier | null,
    private readonly audit: KaiCloudAuditRecorder, private readonly now: () => Date = () => new Date()) {}

  async get(principal: AccountPrincipal, assetId: string) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    await this.requireAsset(subject.subjectId, assetId);
    const stored = await this.store.find(subject.subjectId, assetId);
    if (!stored) return { available: this.api.available, status: 'not_started' as const, syncState: 'current' as const,
      failure: null, updatedAt: null };
    if (!this.api.available || stored.status === 'revoked') {
      return this.present(stored, this.api.available ? 'current' : 'unavailable');
    }
    try {
      const current = await this.api.getVerification(stored.upstreamVerificationId);
      if (current.version <= stored.upstreamVersion) return current.version === stored.upstreamVersion
        ? this.present(stored, 'current')
        : { ...this.present(stored, 'stale'), blocker: 'KAI_CLOUD_VERSION_REGRESSION' };
      const saved = await this.store.save({ id: stored.id, subjectId: stored.subjectId, assetId: stored.assetId,
        startIdempotencyKey: stored.startIdempotencyKey, requestPayloadDigest: stored.requestPayloadDigest,
        verification: current, source: 'api', now: this.now() });
      return this.present(saved, 'current');
    } catch (reason) {
      const error = this.providerError(reason);
      return { ...this.present(stored, 'stale'), blocker: error.code };
    }
  }

  async start(principal: AccountPrincipal, assetId: string, idempotencyKey: string, context: KaiCloudRequestContext) {
    this.validIdempotency(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    const asset = await this.requireAsset(subject.subjectId, assetId);
    if (!this.api.available) throw new AppError('KAI_CLOUD_PUBLIC_API_UNAVAILABLE', 503, 'KAI Cloud 在线验证尚未配置。');
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify({ subjectId: subject.subjectId,
      assetId, resourceId: asset.resourceId, productCode: asset.productCode, region: asset.region,
      specifications: asset.specifications })).digest('hex')}`;
    const existing = await this.store.find(subject.subjectId, assetId);
    if (existing?.startIdempotencyKey === idempotencyKey) {
      if (existing.requestPayloadDigest !== payloadDigest) throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一幂等标识对应了不同资源。');
      return { replayed: true, verification: this.present(existing, 'current') };
    }
    if (existing && ['pending','running','passed'].includes(existing.status)) {
      throw new AppError('KAI_CLOUD_VERIFICATION_ACTIVE', 409, '这项资源已有进行中的在线验证。');
    }
    let upstream: KaiCloudVerification;
    try {
      upstream = await this.api.createVerification({ organizationReference: subject.subjectId,
        resourceReference: asset.resourceId, productCode: asset.productCode, region: asset.region,
        specifications: asset.specifications, idempotencyKey });
    } catch (reason) { throw this.toAppError(reason); }
    const saved = await this.store.save({ subjectId: subject.subjectId, assetId, startIdempotencyKey: idempotencyKey,
      requestPayloadDigest: payloadDigest, verification: upstream, source: 'api', now: this.now() });
    await this.audit.record({ actorUserId: principal.userId, action: 'KAI_CLOUD_VERIFICATION_STARTED',
      entityType: 'COMPUTE_ASSET', entityId: assetId, requestId: context.requestId, ip: context.ip,
      details: { upstreamStatus: saved.status } });
    return { replayed: false, verification: this.present(saved, 'current') };
  }

  async revoke(principal: AccountPrincipal, assetId: string, idempotencyKey: string, context: KaiCloudRequestContext) {
    this.validIdempotency(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    await this.requireAsset(subject.subjectId, assetId);
    const existing = await this.store.find(subject.subjectId, assetId);
    if (!existing) throw new AppError('KAI_CLOUD_VERIFICATION_NOT_FOUND', 404, '这项资源还没有在线验证记录。');
    if (existing.status === 'revoked') return { replayed: true, verification: this.present(existing, 'current') };
    if (!this.api.available) throw new AppError('KAI_CLOUD_PUBLIC_API_UNAVAILABLE', 503, 'KAI Cloud 在线验证暂时不可用。');
    let upstream: KaiCloudVerification;
    try { upstream = await this.api.revokeVerification(existing.upstreamVerificationId, idempotencyKey); }
    catch (reason) { throw this.toAppError(reason); }
    if (upstream.status !== 'revoked') throw new AppError('KAI_CLOUD_INVALID_RESPONSE', 502, 'KAI Cloud 未确认撤销结果。');
    const saved = await this.store.save({ id: existing.id, subjectId: existing.subjectId, assetId,
      startIdempotencyKey: existing.startIdempotencyKey, requestPayloadDigest: existing.requestPayloadDigest,
      verification: upstream, source: 'revoke', now: this.now() });
    await this.audit.record({ actorUserId: principal.userId, action: 'KAI_CLOUD_VERIFICATION_REVOKED',
      entityType: 'COMPUTE_ASSET', entityId: assetId, requestId: context.requestId, ip: context.ip, details: {} });
    return { replayed: false, verification: this.present(saved, 'current') };
  }

  async acceptWebhook(input: Readonly<{ deliveryId: string | undefined; timestamp: string | undefined;
    signature: string | undefined; rawBody: string }>) {
    const verified = this.webhook?.verify(input);
    if (!verified) throw new AppError('KAI_CLOUD_WEBHOOK_INVALID', 401, 'Webhook 签名无效。');
    let payload: unknown; try { payload = JSON.parse(input.rawBody); } catch { throw new AppError('VALIDATION_ERROR', 400, 'Webhook 正文不是有效 JSON。'); }
    const event = parseEvent(payload);
    const result = await this.store.applyWebhook({ deliveryId: verified.deliveryId, eventType: event.type,
      payloadDigest: verified.payloadDigest, verification: event.verification, now: this.now() });
    if (result === 'delivery_conflict') throw new AppError('KAI_CLOUD_WEBHOOK_REPLAY_CONFLICT', 409, 'Webhook 投递标识发生冲突。');
    return { accepted: true, replayed: result === 'replayed', matched: result !== 'not_found' };
  }

  private async requireAsset(subjectId: string, assetId: string) {
    const asset = await this.store.asset(subjectId, assetId);
    if (!asset) throw new AppError('PROVIDER_ASSET_NOT_FOUND', 404, '没有找到这项资产。');
    return asset;
  }
  private validIdempotency(value: string) {
    if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(value)) throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '缺少有效的幂等标识。');
  }
  private present(value: StoredKaiCloudVerification, syncState: 'current' | 'stale' | 'unavailable') {
    return { available: this.api.available, status: value.status, syncState, failure: value.failure,
      updatedAt: value.upstreamUpdatedAt.toISOString() };
  }
  private providerError(reason: unknown) { return reason instanceof KaiCloudError ? reason
    : new KaiCloudError('KAI_CLOUD_UNAVAILABLE', true, false, 'KAI Cloud request failed.'); }
  private toAppError(reason: unknown) {
    const error = this.providerError(reason);
    const status = error.code === 'KAI_CLOUD_UNAUTHORIZED' ? 503 : error.code === 'KAI_CLOUD_NOT_FOUND' ? 404
      : error.code === 'KAI_CLOUD_CONFLICT' ? 409 : error.code === 'KAI_CLOUD_RATE_LIMITED' ? 429
        : error.code === 'KAI_CLOUD_INVALID_RESPONSE' ? 502 : 503;
    const message = error.code === 'KAI_CLOUD_RATE_LIMITED' ? '在线验证请求过多，请稍后重试。'
      : error.code === 'KAI_CLOUD_CONFLICT' ? 'KAI Cloud 验证状态发生冲突，请刷新后重试。'
        : 'KAI Cloud 在线验证暂时不可用。';
    return new AppError(error.code, status, message, { outcomeUnknown: error.outcomeUnknown });
  }
}

function parseEvent(value: unknown): Readonly<{ type: 'resource.verification.updated'; verification: KaiCloudVerification }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('VALIDATION_ERROR', 400, 'Webhook 格式无效。');
  const event = value as Record<string, unknown>;
  if (!safeEventId(event.id) || event.version !== 1 || typeof event.occurredAt !== 'string'
    || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new AppError('VALIDATION_ERROR', 400, 'Webhook 事件信封无效。');
  }
  if (event.type !== 'resource.verification.updated' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
    throw new AppError('KAI_CLOUD_WEBHOOK_EVENT_UNSUPPORTED', 400, 'Webhook 事件类型不受支持。');
  }
  const verification = (event.data as Record<string, unknown>).verification;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) throw new AppError('VALIDATION_ERROR', 400, 'Webhook 验证记录无效。');
  const record = verification as Record<string, unknown>; const statuses = ['pending','running','passed','failed','revoked'];
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/u.test(record.id)
    || !Number.isSafeInteger(record.version) || Number(record.version) < 1
    || typeof record.status !== 'string' || !statuses.includes(record.status)
    || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new AppError('VALIDATION_ERROR', 400, 'Webhook 验证记录无效。');
  }
  let failure: KaiCloudVerification['failure'] = null;
  if (record.failure !== null && record.failure !== undefined) {
    if (!record.failure || typeof record.failure !== 'object' || Array.isArray(record.failure)) throw new AppError('VALIDATION_ERROR', 400, 'Webhook 失败信息无效。');
    const detail = record.failure as Record<string, unknown>;
    if (typeof detail.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,79}$/u.test(detail.code)
      || typeof detail.message !== 'string' || detail.message.length < 1 || detail.message.length > 240) {
      throw new AppError('VALIDATION_ERROR', 400, 'Webhook 失败信息无效。');
    }
    failure = { code: detail.code, message: detail.message };
  }
  return { type: event.type, verification: { id: record.id, version: Number(record.version), status: record.status as KaiCloudVerification['status'],
    updatedAt: record.updatedAt, failure } };
}

function safeEventId(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u.test(value); }
