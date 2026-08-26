import { createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import {
  computeDataPayloadDigest,
  recordComputeJourneyEventInTransaction as writeComputeJourneyEventInTransaction,
  type ComputeDataFlywheelStore,
} from './store.js';
import type {
  CaptureComputeRankingInput,
  ComputeJourneyEventName,
  ComputeTrainingDatasetRow,
  JsonValue,
  RecordComputeJourneyEventInput,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/u;
const POSITIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const FORBIDDEN_KEY_FRAGMENTS = [
  'email', 'phone', 'mobile', 'contact', 'address', 'token', 'secret', 'password', 'cookie',
  'authorization', 'description', 'prompt', 'message', 'notes', 'freetext', 'displayname',
  'username', 'fullname', 'legalname',
] as const;
const MAX_EXPORT_ROWS = 50_000;
const PARSED_REQUIREMENT_KEYS = new Set([
  'gpuModel', 'gpuCount', 'region', 'durationHours', 'quantity', 'budgetMaxMicros', 'currency',
  'useCase', 'taskType', 'workload', 'modelFamily', 'modelSizeBillions', 'datasetRows',
  'fineTuningMethod', 'estimatedVramGiBPerGpu', 'deadlineHours', 'precision',
  'minimumReliabilityPercent', 'minimumSlaAvailabilityPercent', 'environment', 'network',
  'storageGiB', 'allowSubstitutes', 'desiredStartAt', 'deadlineAt',
]);

const reasonRequired = new Set<ComputeJourneyEventName>([
  'failed', 'reservation_failed', 'provisioning_failed', 'sla_violated',
]);

function requireDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AppError('COMPUTE_DATA_INVALID', 400, `${field} 必须是有效时间。`);
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new AppError('COMPUTE_DATA_INVALID', 400, `${field} 必须是 UUID。`);
}

function requireSafeText(value: string, field: string, maximum = 200): void {
  if (value.length < 1 || value.length > maximum || !SAFE_TEXT.test(value)) {
    throw new AppError('COMPUTE_DATA_INVALID', 400, `${field} 格式无效。`);
  }
}

function requireMoney(value: string | undefined, field: string): void {
  if (value !== undefined && !NON_NEGATIVE_INTEGER.test(value)) {
    throw new AppError('COMPUTE_DATA_INVALID', 400, `${field} 必须是非负整数。`);
  }
}

function rejectSensitiveKeys(value: JsonValue, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    if (normalized === 'name' || normalized === 'ip' || normalized === 'clientip'
      || normalized === 'sourceip' || normalized === 'remoteip'
      || FORBIDDEN_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
      throw new AppError('COMPUTE_DATA_SENSITIVE_FIELD', 400, `数据采集禁止敏感字段：${path}.${key}`);
    }
    rejectSensitiveKeys(child, `${path}.${key}`);
  }
}

function validateRanking(input: CaptureComputeRankingInput): void {
  requireUuid(input.request.id, 'request.id');
  if (input.request.buyerSubjectId !== undefined) requireUuid(input.request.buyerSubjectId, 'buyerSubjectId');
  requireUuid(input.ranking.id, 'ranking.id');
  requireSafeText(input.request.sourceEntityType, 'sourceEntityType', 80);
  requireSafeText(input.request.sourceEntityId, 'sourceEntityId');
  requireSafeText(input.request.requirementVersion, 'requirementVersion', 80);
  requireSafeText(input.request.source, 'request.source', 80);
  requireSafeText(input.request.sourceVersion, 'request.sourceVersion', 80);
  requireSafeText(input.ranking.sourceEventId, 'ranking.sourceEventId');
  requireSafeText(input.ranking.algorithmVersion, 'algorithmVersion', 120);
  requireSafeText(input.ranking.policyVersion, 'policyVersion', 120);
  requireSafeText(input.ranking.source, 'ranking.source', 80);
  requireSafeText(input.ranking.sourceVersion, 'ranking.sourceVersion', 80);
  requireDate(input.request.occurredAt, 'request.occurredAt');
  requireDate(input.ranking.occurredAt, 'ranking.occurredAt');
  if (input.ranking.occurredAt < input.request.occurredAt) {
    throw new AppError('COMPUTE_DATA_INVALID_TIMESTAMP', 409, '排序时间不能早于需求时间。');
  }
  if (input.candidates.length > 10_000) {
    throw new AppError('COMPUTE_DATA_INVALID', 400, '候选数量超过 V1 上限。');
  }
  rejectSensitiveKeys(input.request.requirement);
  rejectSensitiveKeys(input.request.parsedRequirement);
  rejectSensitiveKeys(input.ranking.context);
  const parsed = input.request.parsedRequirement;
  const unknownRequirementKeys = Object.keys(parsed).filter((key) => !PARSED_REQUIREMENT_KEYS.has(key));
  if (unknownRequirementKeys.length > 0) {
    throw new AppError('COMPUTE_DATA_INVALID_REQUIREMENT', 400,
      `解析后的需求包含 V1 未定义字段：${unknownRequirementKeys.sort().join(',')}`);
  }
  if (typeof parsed.gpuModel !== 'string' || parsed.gpuModel.trim().length < 1
    || typeof parsed.gpuCount !== 'number' || !Number.isSafeInteger(parsed.gpuCount) || parsed.gpuCount < 1
    || typeof parsed.region !== 'string' || parsed.region.trim().length < 1) {
    throw new AppError('COMPUTE_DATA_INVALID_GPU', 400, '解析后的需求必须包含 gpuModel、gpuCount 和 region。');
  }
  const keys = new Set<string>();
  const ranks = new Set<number>();
  for (const candidate of input.candidates) {
    requireSafeText(candidate.candidateKey, 'candidateKey');
    for (const [field, value] of [['resourceId', candidate.resourceId], ['supplierId', candidate.supplierId],
      ['listingId', candidate.listingId]] as const) if (value !== undefined) requireUuid(value, field);
    if (keys.has(candidate.candidateKey) || ranks.has(candidate.rankPosition)) {
      throw new AppError('COMPUTE_DATA_DUPLICATE_CANDIDATE', 409, '候选 ID 或排名位置重复。');
    }
    keys.add(candidate.candidateKey); ranks.add(candidate.rankPosition);
    if (!Number.isSafeInteger(candidate.rankPosition) || candidate.rankPosition < 1
      || candidate.rankPosition > input.candidates.length) {
      throw new AppError('COMPUTE_DATA_INVALID', 400, '候选排名位置无效。');
    }
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(candidate.score)) {
      throw new AppError('COMPUTE_DATA_INVALID', 400, '候选分数格式无效。');
    }
    requireMoney(candidate.listedPriceMicros, 'listedPriceMicros');
    requireMoney(candidate.quotedPriceMicros, 'quotedPriceMicros');
    if (candidate.quantity !== undefined && (!POSITIVE_DECIMAL.test(candidate.quantity)
      || Number(candidate.quantity) <= 0)) throw new AppError('COMPUTE_DATA_INVALID', 400, 'quantity 必须为正数。');
    if (candidate.durationSeconds !== undefined && !/^[1-9]\d*$/u.test(candidate.durationSeconds)) {
      throw new AppError('COMPUTE_DATA_INVALID', 400, 'durationSeconds 必须为正整数。');
    }
    if (!candidate.eligible && candidate.rejectionReasons.length === 0) {
      throw new AppError('COMPUTE_DATA_INVALID', 400, '不合格候选必须记录拒绝原因。');
    }
    requireDate(candidate.capturedAt, 'candidate.capturedAt');
    if (candidate.capturedAt < input.ranking.occurredAt) {
      throw new AppError('COMPUTE_DATA_INVALID_TIMESTAMP', 409, '候选快照时间不能早于排序时间。');
    }
    if (candidate.priceObservedAt) requireDate(candidate.priceObservedAt, 'candidate.priceObservedAt');
    if (candidate.inventoryObservedAt) requireDate(candidate.inventoryObservedAt, 'candidate.inventoryObservedAt');
    rejectSensitiveKeys(candidate.featureSnapshot);
    rejectSensitiveKeys(candidate.componentScores);
    rejectSensitiveKeys(candidate.availabilitySnapshot);
    rejectSensitiveKeys(candidate.slaSnapshot);
    if (typeof candidate.featureSnapshot.gpuModel !== 'string'
      || candidate.featureSnapshot.gpuModel.trim().length < 1) {
      throw new AppError('COMPUTE_DATA_INVALID_GPU', 400, '候选特征必须包含 gpuModel。');
    }
    if (Object.keys(candidate.componentScores).length < 1
      || Object.values(candidate.componentScores).some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new AppError('COMPUTE_DATA_INVALID', 400, 'componentScores 必须是非空数值对象。');
    }
  }
}

export function validateComputeJourneyEvent(input: RecordComputeJourneyEventInput): void {
  requireUuid(input.id, 'event.id');
  requireUuid(input.requestId, 'requestId');
  requireUuid(input.rankingRunId, 'rankingRunId');
  requireSafeText(input.candidateKey, 'candidateKey');
  requireSafeText(input.sourceEventId, 'sourceEventId');
  requireSafeText(input.source, 'source', 80);
  requireSafeText(input.sourceVersion, 'sourceVersion', 80);
  for (const [field, value] of [['quoteId', input.quoteId], ['reservationId', input.reservationId],
    ['orderId', input.orderId], ['fulfillmentId', input.fulfillmentId],
    ['settlementId', input.settlementId], ['refundId', input.refundId]] as const) {
    if (value !== undefined) requireSafeText(value, field);
  }
  if (input.currency !== undefined && !/^[A-Z]{3,12}$/u.test(input.currency)) {
    throw new AppError('COMPUTE_DATA_INVALID', 400, 'currency 格式无效。');
  }
  if (input.reasonCode !== undefined) requireSafeText(input.reasonCode, 'reasonCode', 120);
  if (input.traceId !== undefined) requireSafeText(input.traceId, 'traceId', 160);
  requireDate(input.occurredAt, 'occurredAt');
  requireMoney(input.acceptedPriceMicros, 'acceptedPriceMicros');
  requireMoney(input.finalCostMicros, 'finalCostMicros');
  requireMoney(input.latencyMs, 'latencyMs');
  if (reasonRequired.has(input.eventName) && !input.reasonCode) {
    throw new AppError('COMPUTE_DATA_REASON_REQUIRED', 400, '失败或违约事件必须提供 reasonCode。');
  }
  if (input.eventName === 'quote_accepted' && input.acceptedPriceMicros === undefined) {
    throw new AppError('COMPUTE_DATA_PRICE_REQUIRED', 400, '报价接受事件必须记录接受价格。');
  }
  if (input.eventName === 'settlement_completed' && input.finalCostMicros === undefined) {
    throw new AppError('COMPUTE_DATA_COST_REQUIRED', 400, '结算事件必须记录最终费用。');
  }
  const requiredEntity = input.eventName.startsWith('quote_') ? ['quoteId', input.quoteId]
    : input.eventName.startsWith('reservation_') ? ['reservationId', input.reservationId]
      : input.eventName.startsWith('provisioning_') || input.eventName.startsWith('fulfillment_')
        || input.eventName === 'telemetry_observed' || input.eventName === 'sla_violated'
        ? ['fulfillmentId', input.fulfillmentId]
        : input.eventName === 'settlement_completed' ? ['settlementId', input.settlementId]
          : input.eventName === 'refund_requested' || input.eventName === 'refunded'
            ? ['refundId', input.refundId] : null;
  if (requiredEntity && !requiredEntity[1]) {
    throw new AppError('COMPUTE_DATA_ENTITY_ID_REQUIRED', 400, `${requiredEntity[0]} 是该事件的必填字段。`);
  }
  rejectSensitiveKeys(input.payload);
}

function assertEventWriteResult(result: Awaited<ReturnType<typeof writeComputeJourneyEventInTransaction>>): void {
  if (result.status === 'conflict') {
    throw new AppError('COMPUTE_DATA_IDEMPOTENCY_CONFLICT', 409, '同一数据事件标识不能对应不同内容。');
  }
  if (result.status === 'missing_parent') {
    throw new AppError('COMPUTE_DATA_PARENT_MISSING', 409, '事件引用的需求、排序或候选不存在。');
  }
  if (result.status === 'invalid_transition') {
    throw new AppError('COMPUTE_DATA_INVALID_TRANSITION', 409, '事件缺少必要的前置状态。');
  }
}

export async function recordComputeJourneyEventInTransaction(
  client: PoolClient, input: RecordComputeJourneyEventInput,
) {
  validateComputeJourneyEvent(input);
  const result = await writeComputeJourneyEventInTransaction(client, input, computeDataPayloadDigest(input));
  assertEventWriteResult(result);
  return { replayed: result.status === 'replayed', eventId: input.id };
}

function anonymous(key: string, domain: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return `hmac-sha256:v1:${createHmac('sha256', key).update(`${domain}\0${String(value)}`).digest('hex')}`;
}

function anonymizeRow(row: ComputeTrainingDatasetRow, key: string) {
  const result: Record<string, unknown> = { ...row, dataset_version: 'compute-training-v1' };
  for (const field of ['request_id', 'ranking_run_id', 'candidate_key', 'resource_id', 'supplier_id', 'listing_id']) {
    result[field.replace(/_id$/u, '_anon_id').replace('candidate_key', 'candidate_anon_id')] = anonymous(key, field, row[field]);
    delete result[field];
  }
  return result;
}

export class ComputeDataFlywheelService {
  constructor(private readonly store: ComputeDataFlywheelStore) {}

  async captureRanking(input: CaptureComputeRankingInput) {
    validateRanking(input);
    const requestDigest = computeDataPayloadDigest(input.request);
    const rankingDigest = computeDataPayloadDigest({ requestId: input.request.id, ranking: input.ranking, candidates: input.candidates });
    const result = await this.store.captureRanking(input, requestDigest, rankingDigest);
    if (result.status === 'conflict') {
      throw new AppError('COMPUTE_DATA_IDEMPOTENCY_CONFLICT', 409, '同一数据事件标识不能对应不同内容。');
    }
    if (result.status !== 'created' && result.status !== 'replayed') {
      throw new AppError('COMPUTE_DATA_PARENT_MISSING', 409, '数据链父实体不存在。');
    }
    return { replayed: result.status === 'replayed', requestId: input.request.id, rankingRunId: input.ranking.id,
      candidateCount: input.candidates.length };
  }

  async recordEvent(input: RecordComputeJourneyEventInput) {
    validateComputeJourneyEvent(input);
    const result = await this.store.recordEvent(input, computeDataPayloadDigest(input));
    assertEventWriteResult(result);
    return { replayed: result.status === 'replayed', eventId: input.id };
  }

  qualityIssues(limit = 1_000) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new AppError('COMPUTE_DATA_INVALID', 400, '数据质量检查数量无效。');
    }
    return this.store.qualityIssues(limit);
  }

  async exportDataset(input: Readonly<{ from: Date; to: Date; limit?: number; anonymizationKey: string }>) {
    requireDate(input.from, 'from'); requireDate(input.to, 'to');
    if (input.to <= input.from) throw new AppError('COMPUTE_DATA_INVALID', 400, '导出结束时间必须晚于开始时间。');
    if (input.anonymizationKey.length < 32) {
      throw new AppError('COMPUTE_DATA_EXPORT_KEY_INVALID', 500, '匿名化密钥必须至少 32 个字符。');
    }
    const limit = input.limit ?? MAX_EXPORT_ROWS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPORT_ROWS) {
      throw new AppError('COMPUTE_DATA_INVALID', 400, '导出数量必须在 1 到 50000 之间。');
    }
    const exported = await this.store.exportDataset(input.from, input.to, limit);
    return {
      datasetVersion: 'compute-training-v1',
      asOf: new Date().toISOString(),
      hasMore: exported.hasMore,
      rows: exported.rows.map((row) => anonymizeRow(row, input.anonymizationKey)),
    };
  }

  trace(requestId: string) {
    requireUuid(requestId, 'requestId');
    return this.store.trace(requestId);
  }
}
