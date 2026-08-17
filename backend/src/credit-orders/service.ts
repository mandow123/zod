import { randomBytes, randomUUID } from 'node:crypto';
import { decryptPii, encryptPii, secretHash } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { SubjectAccess } from '../subjects/types.js';
import type { CreditOrderListSide, CreditOrderStore } from './store.js';
import {
  formatCreditMicros, parseCreditOrderQuantity, SUPPLIER_SETTLEMENT_HOLD_MILLISECONDS, type CreditOrderRecord,
} from './types.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import { parseCreditCentMicros } from '../credits/precision.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;
type FulfillmentStarter = Readonly<{ onOrderConfirmed(orderId: string): Promise<unknown> }>;

export class CreditOrderService {
  private readonly auditPepper: string;
  private readonly piiKey: string;
  private readonly nodeAcceleratorCountFallback: number;
  private readonly computeFulfillmentAvailable: boolean;

  constructor(
    private readonly store: CreditOrderStore,
    private readonly subjects: SubjectAccess,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly fulfillment?: FulfillmentStarter,
  ) {
    if (!config.AUDIT_PEPPER) throw new Error('AUDIT_PEPPER is required.');
    if (!config.PII_ENCRYPTION_KEY) throw new Error('PII_ENCRYPTION_KEY is required.');
    this.auditPepper = config.AUDIT_PEPPER;
    this.piiKey = config.PII_ENCRYPTION_KEY;
    this.nodeAcceleratorCountFallback = config.COMPUTE_NODE_ACCELERATOR_COUNT ?? 8;
    this.computeFulfillmentAvailable = config.readiness.capabilities.computeFulfillment.available;
  }

  async create(principal: AccountPrincipal, input: Readonly<{
    listingId: string; quantity: string; idempotencyKey: string;
  }>, context: RequestContext) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(input.idempotencyKey)) {
      throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '下单请求缺少有效的幂等标识。');
    }
    const quantity = parseCreditOrderQuantity(input.quantity);
    if (!quantity) throw new AppError('ORDER_QUANTITY_INVALID', 400, '请输入有效的购买数量，最多保留六位小数。');
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    const payloadDigest = secretHash(JSON.stringify({
      subjectId: subject.subjectId, listingId: input.listingId, quantity: quantity.normalized,
    }), this.auditPepper);
    const now = this.now();
    const orderId = randomUUID();
    const result = await this.store.createReservation({
      id: orderId,
      orderNumber: `KC${now.toISOString().slice(0, 10).replaceAll('-', '')}${randomBytes(6).toString('hex').toUpperCase()}`,
      buyerSubjectId: subject.subjectId, userId: principal.userId, listingId: input.listingId,
      quantity: quantity.normalized, quantityScaled: quantity.scaled, clientRequestId: input.idempotencyKey,
      payloadDigest, expiresAt: new Date(now.getTime() + 30 * 60_000), now, requestId: context.requestId,
      ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      computeFulfillmentAvailable: this.computeFulfillmentAvailable, autoConfirmCompute: true,
      nodeAcceleratorCountFallback: this.nodeAcceleratorCountFallback,
    });
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的订单内容。');
    if (result.status === 'commerce_unavailable') throw new AppError('COMPUTE_FULFILLMENT_UNAVAILABLE', 503,
      '节点接入或算力交付服务尚未准备好，当前不能购买。');
    if (result.status === 'listing_unavailable') throw new AppError('LISTING_CAPACITY_UNAVAILABLE', 409, '当前可售数量不足，或该资源已停止接单。');
    if (result.status === 'insufficient_credits') throw new AppError('KAI_CREDIT_INSUFFICIENT', 409, '可用卡时不足，请先充值或减少购买数量。');
    if (result.status === 'self_purchase') throw new AppError('SELF_PURCHASE_NOT_ALLOWED', 409, '不能购买当前交易主体自己上架的资源。');
    if (result.status !== 'created' && result.status !== 'replayed') throw new Error('KAI_CREDIT_ORDER_RESULT_INVALID');
    let responseOrder = result.order;
    if (result.order.status === 'confirmed' && this.fulfillment) {
      try {
        await this.fulfillment.onOrderConfirmed(result.order.id);
        responseOrder = await this.store.getForSubject(subject.subjectId, result.order.id) ?? result.order;
      } catch {
        // The purchase is already committed. Return it as confirmed and let the durable worker retry or refund it.
        const latest = await this.store.getForSubject(subject.subjectId, result.order.id);
        if (latest?.status === 'refunded') responseOrder = latest;
      }
    }
    return { replayed: result.status === 'replayed', order: this.serialize(responseOrder, subject.subjectId, subject.permissions) };
  }

  async get(principal: AccountPrincipal, orderId: string) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const order = await this.store.getForSubject(subject.subjectId, orderId);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    return this.serialize(order, subject.subjectId, subject.permissions);
  }

  async list(principal: AccountPrincipal, input: Readonly<{ limit?: number; side?: CreditOrderListSide; cursor?: string }> = {}) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const side = input.side ?? 'all';
    const cursor = input.cursor ? this.decodeOrderCursor(input.cursor) : null;
    const records = await this.store.listForSubject(subject.subjectId, limit + 1, side, cursor);
    const page = records.slice(0, limit);
    const serialized = await Promise.all(page.map(async (order) => {
      const serializedOrder = this.serialize(order, subject.subjectId, subject.permissions);
      if (serializedOrder.side !== 'provider' || order.status !== 'accepted'
        || !subject.permissions.includes('provider.refund.approve')) return serializedOrder;
      const aftercare = await this.store.postAcceptanceRefundForSubject(subject.subjectId, order.id);
      return aftercare?.status === 'pending'
        ? { ...serializedOrder, requiresAttention: true }
        : serializedOrder;
    }));
    const last = page.at(-1);
    return {
      orders: serialized,
      nextCursor: records.length > limit && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }), 'utf8').toString('base64url')
        : null,
    };
  }

  private decodeOrderCursor(value: string) {
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
      const createdAt = typeof decoded.createdAt === 'string' ? new Date(decoded.createdAt) : null;
      if (!createdAt || !Number.isFinite(createdAt.getTime())
        || typeof decoded.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(decoded.id)) {
        throw new Error('invalid order cursor');
      }
      return { createdAt, id: decoded.id };
    } catch {
      throw new AppError('PAGINATION_CURSOR_INVALID', 400, '订单分页位置无效，请重新打开订单列表。');
    }
  }

  async confirm(principal: AccountPrincipal, orderId: string, idempotencyKey: string, context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'provider.order.manage');
    const payloadDigest = secretHash(JSON.stringify({ action: 'confirm', subjectId: subject.subjectId, orderId }), this.auditPepper);
    const result = await this.store.confirm({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper), now: this.now(),
    });
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的接单操作。');
    if (result.status === 'not_found') throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    if (result.status === 'expired') throw new AppError('ORDER_RESERVATION_EXPIRED', 409, '订单预留已到期，卡时和数量已经退回。');
    if (result.status === 'invalid_state') throw new AppError('ORDER_NOT_CONFIRMABLE', 409, '订单当前不能确认。');
    if (result.status !== 'confirmed' && result.status !== 'replayed') throw new Error('KAI_CREDIT_ORDER_CONFIRM_RESULT_INVALID');
    if (result.order.status === 'confirmed') await this.fulfillment?.onOrderConfirmed(orderId);
    return { replayed: result.status === 'replayed', order: this.serialize(result.order, subject.subjectId, subject.permissions) };
  }

  async cancel(principal: AccountPrincipal, orderId: string, idempotencyKey: string, context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    const payloadDigest = secretHash(JSON.stringify({ action: 'cancel', subjectId: subject.subjectId, orderId }), this.auditPepper);
    const result = await this.store.cancel({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper), now: this.now(),
    });
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的取消操作。');
    if (result.status === 'not_found') throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    if (result.status === 'expired') throw new AppError('ORDER_RESERVATION_EXPIRED', 409, '订单预留已到期，卡时和数量已经退回。');
    if (result.status === 'invalid_state') throw new AppError('ORDER_NOT_CANCELLABLE', 409, '提供方确认后不能直接取消；如需变更，请联系提供方或平台。');
    if (result.status !== 'cancelled' && result.status !== 'replayed') throw new Error('KAI_CREDIT_ORDER_CANCEL_RESULT_INVALID');
    return { replayed: result.status === 'replayed', order: this.serialize(result.order, subject.subjectId, subject.permissions) };
  }

  async startDelivery(principal: AccountPrincipal, orderId: string, idempotencyKey: string, context: RequestContext) {
    return this.providerAction(principal, orderId, idempotencyKey, 'start_delivery', context);
  }

  async deliveryReady(principal: AccountPrincipal, orderId: string, deliveryDetails: Record<string, unknown>,
    idempotencyKey: string, context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'provider.order.manage');
    const canonical = JSON.stringify(stableValue(normalizeDeliveryDetails(deliveryDetails)));
    if (canonical.length < 2 || Buffer.byteLength(canonical, 'utf8') > 16_384) {
      throw new AppError('DELIVERY_DETAILS_INVALID', 400, '交付信息不能为空，且不能超过 16 KB。');
    }
    const deliveryPayloadDigest = secretHash(canonical, this.auditPepper);
    const payloadDigest = secretHash(JSON.stringify({
      action: 'delivery_ready', subjectId: subject.subjectId, orderId, deliveryPayloadDigest,
    }), this.auditPepper);
    const result = await this.store.markDeliveryReady({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, deliveryPayloadCiphertext: encryptPii(canonical, this.piiKey), deliveryPayloadDigest,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper), now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions,
      'DELIVERY_NOT_READY', '订单尚未进入交付阶段，不能提交交付结果。');
  }

  async delivery(principal: AccountPrincipal, orderId: string) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const result = await this.store.deliveryForSubject(subject.subjectId, orderId);
    if (!result) throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    const attempts = result.attempts.map((attempt) => {
      let details: Record<string, unknown> | null = null;
      if (attempt.deliveryPayloadCiphertext) {
        try { details = JSON.parse(decryptPii(attempt.deliveryPayloadCiphertext, this.piiKey)) as Record<string, unknown>; }
        catch { throw new AppError('DELIVERY_DETAILS_UNAVAILABLE', 503, '交付信息暂时无法读取，请联系平台支持。'); }
      }
      return {
        id: attempt.id, attemptNumber: attempt.attemptNumber, status: attempt.status,
        details, digest: attempt.deliveryPayloadDigest, startedAt: attempt.startedAt.toISOString(),
        readyAt: attempt.readyAt?.toISOString() ?? null,
      };
    });
    const latest = attempts.at(-1) ?? null;
    return {
      order: this.serialize(result.order, subject.subjectId, subject.permissions),
      delivery: latest?.details ? { details: latest.details, digest: latest.digest,
        attemptNumber: latest.attemptNumber, status: latest.status } : null,
      attempts,
    };
  }

  async startRework(principal: AccountPrincipal, orderId: string, idempotencyKey: string, context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'provider.order.manage');
    const payloadDigest = secretHash(JSON.stringify({
      action: 'start_rework', subjectId: subject.subjectId, orderId,
    }), this.auditPepper);
    const result = await this.store.startRework({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions,
      'DELIVERY_REWORK_NOT_STARTABLE', '这笔交付不能重新提交。');
  }

  async accept(principal: AccountPrincipal, orderId: string, evidenceDigest: string | undefined,
    idempotencyKey: string, context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    if (evidenceDigest && !/^sha256:[a-f0-9]{64}$/u.test(evidenceDigest)) {
      throw new AppError('DELIVERY_EVIDENCE_INVALID', 400, '验收证据摘要格式不正确。');
    }
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    const payloadDigest = secretHash(JSON.stringify({
      action: 'accept', subjectId: subject.subjectId, orderId, evidenceDigest: evidenceDigest ?? null,
    }), this.auditPepper);
    const result = await this.store.accept({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, evidenceDigest: evidenceDigest ?? null, requestId: context.requestId,
      ipHash: secretHash(context.ip || 'unknown', this.auditPepper), now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions,
      'DELIVERY_NOT_ACCEPTABLE', '交付尚未提交，当前不能验收。');
  }

  async reportDeliveryIssue(principal: AccountPrincipal, orderId: string, input: Readonly<{
    requestedResolution: 'rework' | 'refund'; description: string;
  }>, idempotencyKey: string, context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const description = input.description.trim();
    if (description.length < 5 || description.length > 2_000) {
      throw new AppError('DELIVERY_ISSUE_DESCRIPTION_INVALID', 400, '请用 5 到 2000 个字说明交付问题。');
    }
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    const canonical = JSON.stringify({ requestedResolution: input.requestedResolution, description });
    const descriptionDigest = secretHash(description, this.auditPepper);
    const payloadDigest = secretHash(JSON.stringify({
      action: 'report_delivery_issue', subjectId: subject.subjectId, orderId,
      requestedResolution: input.requestedResolution, descriptionDigest,
    }), this.auditPepper);
    const result = await this.store.reportDeliveryIssue({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, requestedResolution: input.requestedResolution,
      descriptionCiphertext: encryptPii(canonical, this.piiKey), descriptionDigest,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper), now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions,
      'DELIVERY_ISSUE_NOT_REPORTABLE', '当前订单不能提交交付问题。');
  }

  async deliveryIssue(principal: AccountPrincipal, orderId: string) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const result = await this.store.deliveryIssueForSubject(subject.subjectId, orderId);
    if (!result) throw new AppError('DELIVERY_ISSUE_NOT_FOUND', 404, '这笔订单没有交付问题记录。');
    let decoded: { requestedResolution?: unknown; description?: unknown };
    try { decoded = JSON.parse(decryptPii(result.descriptionCiphertext, this.piiKey)) as typeof decoded; }
    catch { throw new AppError('DELIVERY_ISSUE_UNAVAILABLE', 503, '问题说明暂时无法读取，请联系平台支持。'); }
    if (decoded.requestedResolution !== result.requestedResolution || typeof decoded.description !== 'string') {
      throw new AppError('DELIVERY_ISSUE_UNAVAILABLE', 503, '问题说明暂时无法读取，请联系平台支持。');
    }
    return {
      order: this.serialize(result.order, subject.subjectId, subject.permissions),
      issue: {
        status: result.status, requestedResolution: result.requestedResolution,
        description: decoded.description, digest: result.descriptionDigest, openedAt: result.openedAt.toISOString(),
        actions: this.deliveryIssueActions(result.order, subject.subjectId, subject.permissions,
          result.status, result.requestedResolution),
      },
    };
  }

  async approveMutualRefund(principal: AccountPrincipal, orderId: string, idempotencyKey: string,
    context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'provider.order.manage');
    const payloadDigest = secretHash(JSON.stringify({
      action: 'approve_refund', subjectId: subject.subjectId, orderId,
    }), this.auditPepper);
    const result = await this.store.approveMutualRefund({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions,
      'MUTUAL_REFUND_NOT_APPROVABLE', '这笔订单不能直接同意退款。');
  }

  async mutualRefund(principal: AccountPrincipal, orderId: string) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const result = await this.store.mutualRefundForSubject(subject.subjectId, orderId);
    if (!result) throw new AppError('MUTUAL_REFUND_NOT_FOUND', 404, '这笔订单没有已完成的协商退款。');
    return {
      order: this.serialize(result.order, subject.subjectId, subject.permissions),
      refund: {
        status: result.status, creditAmount: formatCreditMicros(result.creditMicros),
        approvedAt: result.approvedAt.toISOString(),
      },
    };
  }

  async escalateDispute(principal: AccountPrincipal, orderId: string, idempotencyKey: string,
    context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'orders.dispute.manage');
    const payloadDigest = secretHash(JSON.stringify({
      action: 'escalate_dispute', subjectId: subject.subjectId, orderId,
    }), this.auditPepper);
    const result = await this.store.escalateDispute({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions, 'DISPUTE_NOT_ESCALATABLE',
      '这笔退款申请当前不能提交平台处理。');
  }

  async disputeAdjudication(principal: AccountPrincipal, orderId: string) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const result = await this.store.disputeAdjudicationForSubject(subject.subjectId, orderId);
    if (!result) throw new AppError('DISPUTE_ADJUDICATION_NOT_FOUND', 404, '这笔订单没有平台处理记录。');
    return {
      order: this.serialize(result.order, subject.subjectId, subject.permissions),
      adjudication: {
        status: result.status, escalatedBySide: result.escalatedBySide,
        escalatedAt: result.escalatedAt.toISOString(), outcome: result.outcome,
        reason: result.reasonCiphertext ? this.decryptDecisionReason(result.reasonCiphertext) : null,
        reasonDigest: result.reasonDigest,
        creditAmount: result.creditMicros === null ? null : formatCreditMicros(result.creditMicros),
        decidedAt: result.decidedAt?.toISOString() ?? null,
      },
    };
  }

  async pendingDisputeAdjudications(principal: AccountPrincipal, limit = 50) {
    this.requireOperator(principal);
    const records = await this.store.listPendingDisputeAdjudications(limit);
    return records.map((record) => {
      let decoded: { requestedResolution?: unknown; description?: unknown };
      try { decoded = JSON.parse(decryptPii(record.descriptionCiphertext, this.piiKey)) as typeof decoded; }
      catch { throw new AppError('DELIVERY_ISSUE_UNAVAILABLE', 503, '问题说明暂时无法读取。'); }
      if (decoded.requestedResolution !== 'refund' || typeof decoded.description !== 'string') {
        throw new AppError('DELIVERY_ISSUE_UNAVAILABLE', 503, '问题说明暂时无法读取。');
      }
      let deliveryDetails: Record<string, unknown>;
      try { deliveryDetails = JSON.parse(decryptPii(record.deliveryPayloadCiphertext, this.piiKey)) as Record<string, unknown>; }
      catch { throw new AppError('DELIVERY_DETAILS_UNAVAILABLE', 503, '交付信息暂时无法读取。'); }
      return {
        order: this.serializeForOperator(record.order), deliveryIssueId: record.deliveryIssueId,
        escalatedBySide: record.escalatedBySide, escalatedAt: record.escalatedAt.toISOString(),
        requestedResolution: record.requestedResolution, description: decoded.description,
        descriptionDigest: record.descriptionDigest,
        delivery: {
          attemptNumber: record.deliveryAttemptNumber, details: deliveryDetails,
          digest: record.deliveryPayloadDigest,
        },
      };
    });
  }

  async decideDispute(principal: AccountPrincipal, orderId: string, input: Readonly<{
    outcome: 'full_refund' | 'resume_acceptance'; reason: string;
  }>, idempotencyKey: string, context: RequestContext) {
    this.requireOperator(principal);
    this.assertIdempotencyKey(idempotencyKey);
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 2_000) {
      throw new AppError('DISPUTE_DECISION_REASON_INVALID', 400, '请用 10 到 2000 个字说明处理依据。');
    }
    const reasonDigest = secretHash(reason, this.auditPepper);
    const decisionDigest = secretHash(JSON.stringify({ orderId, outcome: input.outcome, reasonDigest }), this.auditPepper);
    const payloadDigest = secretHash(JSON.stringify({
      action: 'decide_dispute', operatorId: principal.userId, orderId, outcome: input.outcome, reasonDigest,
    }), this.auditPepper);
    const result = await this.store.decideDispute({
      operatorId: principal.userId, orderId, clientRequestId: idempotencyKey, payloadDigest,
      outcome: input.outcome, reasonCiphertext: encryptPii(JSON.stringify({ reason }), this.piiKey),
      reasonDigest, decisionDigest, requestId: context.requestId,
      ipHash: secretHash(context.ip || 'unknown', this.auditPepper), now: this.now(),
    });
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409,
      '同一请求标识对应了不同的裁定内容。');
    if (result.status === 'not_found') throw new AppError('DISPUTE_ADJUDICATION_NOT_FOUND', 404,
      '待处理争议不存在。');
    if (result.status === 'invalid_state') throw new AppError('DISPUTE_NOT_DECIDABLE', 409,
      '这笔争议已经处理，或当前不能裁定。');
    if (!('order' in result)) throw new Error('KAI_CREDIT_DISPUTE_DECISION_RESULT_INVALID');
    return {
      replayed: result.status === 'replayed', decisionId: result.decisionId, outcome: result.outcome,
      order: this.serializeForOperator(result.order),
    };
  }

  async settleSupplier(principal: AccountPrincipal, orderId: string, idempotencyKey: string,
    context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'provider.order.manage');
    const payloadDigest = secretHash(JSON.stringify({
      action: 'settle', subjectId: subject.subjectId, orderId,
    }), this.auditPepper);
    const result = await this.store.settleSupplier({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      now: this.now(),
    });
    if (result.status === 'not_due') throw new AppError('SUPPLIER_SETTLEMENT_NOT_DUE', 409,
      '这笔订单还在结算期内。', { availableAt: result.availableAt.toISOString() });
    return this.actionResult(result, subject.subjectId, subject.permissions, 'SUPPLIER_SETTLEMENT_NOT_AVAILABLE',
      '这笔订单当前不能结算。');
  }

  async supplierSettlement(principal: AccountPrincipal, orderId: string) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const result = await this.store.supplierSettlementForSubject(subject.subjectId, orderId);
    if (!result) throw new AppError('SUPPLIER_SETTLEMENT_NOT_FOUND', 404, '这笔订单还没有结算记录。');
    return {
      order: this.serialize(result.order, subject.subjectId, subject.permissions),
      settlement: {
        status: result.status, creditAmount: formatCreditMicros(result.creditMicros),
        triggeredBy: result.triggeredBy, acceptedAt: result.acceptedAt.toISOString(),
        availableAt: result.availableAt.toISOString(), settledAt: result.settledAt.toISOString(),
      },
    };
  }

  async requestPostAcceptanceRefund(principal: AccountPrincipal, orderId: string, descriptionInput: string,
    creditAmountInput: string, idempotencyKey: string, context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const description = descriptionInput.trim();
    if (description.length < 10 || description.length > 2_000) {
      throw new AppError('AFTERCARE_DESCRIPTION_INVALID', 400, '请用 10 到 2000 个字说明售后退款原因。');
    }
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    const order = await this.store.getForSubject(subject.subjectId, orderId);
    if (!order || order.buyerSubjectId !== subject.subjectId) {
      throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    }
    if (isComputeOrder(order)) {
      throw new AppError('COMPUTE_AFTERCARE_WINDOW_CLOSED', 409,
        '算力订单请在停止后的 24 小时计量验收期内提交异议；完成验收后不再开放通用交付售后入口。');
    }
    const creditMicros = parseCreditCentMicros(creditAmountInput);
    if (!creditMicros || creditMicros > order.totalCreditMicros) {
      throw new AppError('AFTERCARE_CREDIT_AMOUNT_INVALID', 400,
        `补偿卡时必须大于 0，且不能超过本单 ${formatCreditDisplayMicros(order.totalCreditMicros)} 卡时。`);
    }
    const descriptionDigest = secretHash(description, this.auditPepper);
    const payloadDigest = secretHash(JSON.stringify({
      action: 'request_post_acceptance_refund', subjectId: subject.subjectId, orderId, descriptionDigest,
      creditMicros: creditMicros.toString(),
    }), this.auditPepper);
    const result = await this.store.requestPostAcceptanceRefund({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, descriptionCiphertext: encryptPii(JSON.stringify({ description }), this.piiKey),
      descriptionDigest, creditMicros, requestId: context.requestId,
      ipHash: secretHash(context.ip || 'unknown', this.auditPepper), now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions, 'AFTERCARE_REFUND_NOT_REQUESTABLE',
      '这笔订单已超过售后申请期，或当前不能申请退款。');
  }

  async approvePostAcceptanceRefund(principal: AccountPrincipal, orderId: string, idempotencyKey: string,
    context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'provider.refund.approve');
    const payloadDigest = secretHash(JSON.stringify({
      action: 'approve_post_acceptance_refund', subjectId: subject.subjectId, orderId,
    }), this.auditPepper);
    const result = await this.store.approvePostAcceptanceRefund({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions, 'AFTERCARE_REFUND_NOT_APPROVABLE',
      '这笔订单没有待处理的售后退款申请。');
  }

  async contestPostAcceptanceRefund(principal: AccountPrincipal, orderId: string, responseInput: string,
    idempotencyKey: string, context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const response = responseInput.trim();
    if (response.length < 10 || response.length > 2_000) {
      throw new AppError('AFTERCARE_RESPONSE_INVALID', 400, '请用 10 到 2000 个字说明不同意退款的依据。');
    }
    const subject = await this.subjects.current(principal.userId, 'provider.refund.approve');
    const responseDigest = secretHash(response, this.auditPepper);
    const payloadDigest = secretHash(JSON.stringify({
      action: 'contest_post_acceptance_refund', subjectId: subject.subjectId, orderId, responseDigest,
    }), this.auditPepper);
    const result = await this.store.contestPostAcceptanceRefund({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, responseCiphertext: encryptPii(JSON.stringify({ response }), this.piiKey), responseDigest,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper), now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions, 'AFTERCARE_REFUND_NOT_CONTESTABLE',
      '这笔售后申请当前不能提交平台处理。');
  }

  async escalatePostAcceptanceRefund(principal: AccountPrincipal, orderId: string, idempotencyKey: string,
    context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    const payloadDigest = secretHash(JSON.stringify({
      action: 'escalate_post_acceptance_refund', subjectId: subject.subjectId, orderId,
    }), this.auditPepper);
    const result = await this.store.escalatePostAcceptanceRefund({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions, 'AFTERCARE_REFUND_NOT_ESCALATABLE',
      '提交后满 24 小时仍未处理，才可交平台处理。');
  }

  async pendingPostAcceptanceRefundAdjudications(principal: AccountPrincipal, limit = 50) {
    this.requireOperator(principal);
    const records = await this.store.listPendingPostAcceptanceRefundAdjudications(limit);
    return records.map((record) => ({
      order: this.serializeForOperator(record.order), refundId: record.refundId,
      escalatedBySide: record.escalatedBySide, escalatedAt: record.escalatedAt.toISOString(),
      description: this.decryptAftercareField(record.descriptionCiphertext, 'description'),
      descriptionDigest: record.descriptionDigest, creditAmount: formatCreditMicros(record.creditMicros),
      providerResponse: record.providerResponseCiphertext
        ? this.decryptAftercareField(record.providerResponseCiphertext, 'response') : null,
      providerResponseDigest: record.providerResponseDigest,
      delivery: {
        attemptNumber: record.deliveryAttemptNumber,
        details: this.decryptDeliveryDetails(record.deliveryPayloadCiphertext),
        digest: record.deliveryPayloadDigest,
      },
    }));
  }

  async decidePostAcceptanceRefund(principal: AccountPrincipal, orderId: string, input: Readonly<{
    outcome: 'approve_refund' | 'reject_refund'; reason: string;
  }>, idempotencyKey: string, context: RequestContext) {
    this.requireOperator(principal);
    this.assertIdempotencyKey(idempotencyKey);
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 2_000) {
      throw new AppError('AFTERCARE_DECISION_REASON_INVALID', 400, '请用 10 到 2000 个字说明处理依据。');
    }
    const reasonDigest = secretHash(reason, this.auditPepper);
    const decisionDigest = secretHash(JSON.stringify({ orderId, outcome: input.outcome, reasonDigest }), this.auditPepper);
    const payloadDigest = secretHash(JSON.stringify({
      action: 'decide_post_acceptance_refund', operatorId: principal.userId,
      orderId, outcome: input.outcome, reasonDigest,
    }), this.auditPepper);
    const result = await this.store.decidePostAcceptanceRefund({
      operatorId: principal.userId, orderId, clientRequestId: idempotencyKey, payloadDigest,
      outcome: input.outcome, reasonCiphertext: encryptPii(JSON.stringify({ reason }), this.piiKey),
      reasonDigest, decisionDigest, requestId: context.requestId,
      ipHash: secretHash(context.ip || 'unknown', this.auditPepper), now: this.now(),
    });
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409,
      '同一请求标识对应了不同的处理结果。');
    if (result.status === 'not_found') throw new AppError('AFTERCARE_ADJUDICATION_NOT_FOUND', 404,
      '待处理售后申请不存在。');
    if (result.status === 'invalid_state') throw new AppError('AFTERCARE_REFUND_NOT_DECIDABLE', 409,
      '这笔售后申请已经处理，或当前不能裁定。');
    if (!('order' in result)) throw new Error('KAI_CREDIT_AFTERCARE_DECISION_RESULT_INVALID');
    return {
      replayed: result.status === 'replayed', decisionId: result.decisionId, outcome: result.outcome,
      order: this.serializeForOperator(result.order),
    };
  }

  async postAcceptanceRefund(principal: AccountPrincipal, orderId: string) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const result = await this.store.postAcceptanceRefundForSubject(subject.subjectId, orderId);
    if (!result) throw new AppError('AFTERCARE_REFUND_NOT_FOUND', 404, '这笔订单没有售后退款记录。');
    const description = this.decryptAftercareField(result.descriptionCiphertext, 'description');
    const providerResponse = result.providerResponseCiphertext
      ? this.decryptAftercareField(result.providerResponseCiphertext, 'response') : null;
    const decisionReason = result.decisionReasonCiphertext
      ? this.decryptAftercareField(result.decisionReasonCiphertext, 'reason') : null;
    const side = result.order.buyerSubjectId === subject.subjectId ? 'buyer' : 'provider';
    const escalationAvailableAt = new Date(result.requestedAt.getTime() + 24 * 60 * 60 * 1_000);
    const now = this.now();
    const actions = result.status === 'pending'
      ? (side === 'provider' && subject.permissions.includes('provider.refund.approve')
        ? ['approve_refund', 'contest_refund']
        : (side === 'buyer' && subject.permissions.includes('orders.buy') && now >= escalationAvailableAt
          ? ['escalate_refund'] : [])) : [];
    return {
      order: this.serialize(result.order, subject.subjectId, subject.permissions),
      aftercareRefund: {
        status: result.status, description, descriptionDigest: result.descriptionDigest,
        creditAmount: formatCreditMicros(result.creditMicros), requestedAt: result.requestedAt.toISOString(),
        escalationAvailableAt: escalationAvailableAt.toISOString(), escalatedBySide: result.escalatedBySide,
        escalatedAt: result.escalatedAt?.toISOString() ?? null,
        providerResponse, providerResponseDigest: result.providerResponseDigest,
        outcome: result.outcome, decisionReason, decisionReasonDigest: result.decisionReasonDigest,
        decidedAt: result.decidedAt?.toISOString() ?? null,
        resolvedAt: result.resolvedAt?.toISOString() ?? null, actions,
      },
    };
  }

  private async providerAction(principal: AccountPrincipal, orderId: string, idempotencyKey: string,
    action: 'start_delivery', context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'provider.order.manage');
    const payloadDigest = secretHash(JSON.stringify({ action, subjectId: subject.subjectId, orderId }), this.auditPepper);
    const result = await this.store.startDelivery({
      subjectId: subject.subjectId, userId: principal.userId, orderId, clientRequestId: idempotencyKey,
      payloadDigest, requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper), now: this.now(),
    });
    return this.actionResult(result, subject.subjectId, subject.permissions,
      'DELIVERY_NOT_STARTABLE', '订单尚未确认，当前不能开始交付。');
  }

  private actionResult(result: Awaited<ReturnType<CreditOrderStore['startDelivery']>>, subjectId: string,
    permissions: readonly string[], invalidCode: string, invalidMessage: string) {
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的订单操作。');
    if (result.status === 'not_found') throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    if (result.status === 'expired') throw new AppError('ORDER_RESERVATION_EXPIRED', 409, '订单预留已到期。');
    if (result.status === 'invalid_state') throw new AppError(invalidCode, 409, invalidMessage);
    if (!('order' in result)) throw new Error('KAI_CREDIT_ORDER_ACTION_RESULT_INVALID');
    return { replayed: result.status === 'replayed', order: this.serialize(result.order, subjectId, permissions) };
  }

  private assertIdempotencyKey(value: string) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(value)) throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '请求缺少有效的幂等标识。');
  }

  private requireOperator(principal: AccountPrincipal) {
    if (principal.role !== 'operator' && principal.role !== 'admin') {
      throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要平台运营权限。');
    }
  }

  private decryptDecisionReason(ciphertext: string) {
    try {
      const decoded = JSON.parse(decryptPii(ciphertext, this.piiKey)) as { reason?: unknown };
      if (typeof decoded.reason !== 'string') throw new Error('INVALID_REASON');
      return decoded.reason;
    } catch {
      throw new AppError('DISPUTE_DECISION_UNAVAILABLE', 503, '处理结果暂时无法读取，请联系平台支持。');
    }
  }

  private decryptAftercareField(ciphertext: string, field: 'description' | 'response' | 'reason') {
    try {
      const decoded = JSON.parse(decryptPii(ciphertext, this.piiKey)) as Record<string, unknown>;
      if (typeof decoded[field] !== 'string') throw new Error('INVALID_AFTERCARE_FIELD');
      return decoded[field];
    } catch {
      throw new AppError('AFTERCARE_REFUND_UNAVAILABLE', 503, '售后记录暂时无法读取，请联系平台支持。');
    }
  }

  private decryptDeliveryDetails(ciphertext: string) {
    try { return JSON.parse(decryptPii(ciphertext, this.piiKey)) as Record<string, unknown>; }
    catch { throw new AppError('DELIVERY_DETAILS_UNAVAILABLE', 503, '交付信息暂时无法读取。'); }
  }

  private serializeForOperator(order: CreditOrderRecord) {
    const snapshot = order.listingSnapshot;
    return {
      id: order.id, orderNumber: order.orderNumber, status: order.status, listingId: order.listingId,
      buyerSubjectId: order.buyerSubjectId, supplierSubjectId: order.supplierSubjectId,
      title: typeof snapshot.title === 'string' ? snapshot.title : '算力订单',
      productCode: typeof snapshot.productCode === 'string' ? snapshot.productCode : null,
      region: typeof snapshot.region === 'string' ? snapshot.region : null,
      quantity: order.quantity, capacityUnit: order.capacityUnit,
      unitCredits: formatCreditMicros(order.unitCreditMicros), totalCredits: formatCreditMicros(order.totalCreditMicros),
      deliveryReadyAt: order.deliveryReadyAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString(),
    };
  }

  private serialize(order: CreditOrderRecord, subjectId: string, permissions: readonly string[]) {
    const snapshot = order.listingSnapshot;
    const side = order.buyerSubjectId === subjectId ? 'buyer' as const : 'provider' as const;
    return {
      id: order.id, orderNumber: order.orderNumber, status: order.status,
      side,
      listingId: order.listingId,
      title: typeof snapshot.title === 'string' ? snapshot.title : '算力订单',
      productCode: typeof snapshot.productCode === 'string' ? snapshot.productCode : null,
      region: typeof snapshot.region === 'string' ? snapshot.region : null,
      quantity: order.quantity, capacityUnit: order.capacityUnit,
      unitCredits: formatCreditMicros(order.unitCreditMicros), totalCredits: formatCreditMicros(order.totalCreditMicros),
      reservationExpiresAt: order.reservationExpiresAt.toISOString(),
      confirmedAt: order.confirmedAt?.toISOString() ?? null,
      deliveryStartedAt: order.deliveryStartedAt?.toISOString() ?? null,
      deliveryReadyAt: order.deliveryReadyAt?.toISOString() ?? null,
      acceptedAt: order.acceptedAt?.toISOString() ?? null,
      settlementAvailableAt: order.acceptedAt
        ? new Date(order.acceptedAt.getTime() + SUPPLIER_SETTLEMENT_HOLD_MILLISECONDS).toISOString()
        : null,
      actions: this.orderActions(order, side, permissions),
      aftercarePolicy: isComputeOrder(order)
        ? { model: 'metering_issue_before_acceptance', issueWindowHours: 24, postAcceptanceRefundAvailable: false }
        : { model: 'delivery_aftercare', issueWindowHours: null, postAcceptanceRefundAvailable: true },
      requiresAttention: side === 'provider' && order.status === 'disputed',
      createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString(),
    };
  }

  private orderActions(order: CreditOrderRecord, side: 'buyer' | 'provider', permissions: readonly string[]) {
    const status = order.status;
    const compute = isComputeOrder(order);
    if (side === 'buyer' && permissions.includes('orders.buy')) {
      if (!compute && status === 'reserved') return ['cancel_order'] as const;
      if (!compute && status === 'acceptance_pending') return ['accept_delivery', 'report_delivery_issue'] as const;
    }
    if (side === 'provider' && permissions.includes('provider.order.manage')) {
      if (!compute && status === 'reserved') return ['confirm_order'] as const;
      if (!compute && status === 'confirmed') return ['start_delivery'] as const;
      if (!compute && status === 'provisioning') return ['submit_delivery'] as const;
    }
    return [] as const;
  }

  private deliveryIssueActions(order: CreditOrderRecord, subjectId: string, permissions: readonly string[],
    status: string, requestedResolution: 'rework' | 'refund') {
    if (order.status !== 'disputed' || status !== 'open') return [] as const;
    const side = order.buyerSubjectId === subjectId ? 'buyer' : 'provider';
    if (requestedResolution === 'rework' && side === 'provider'
      && permissions.includes('provider.order.manage')) return ['start_rework'] as const;
    if (requestedResolution === 'refund') {
      const actions: Array<'approve_refund' | 'escalate_dispute'> = [];
      if (side === 'provider' && permissions.includes('provider.order.manage')) actions.push('approve_refund');
      if (permissions.includes('orders.dispute.manage')) actions.push('escalate_dispute');
      return actions;
    }
    return [] as const;
  }
}

function isComputeOrder(order: CreditOrderRecord) {
  const mode = order.listingSnapshot.fulfillmentMode;
  return mode === 'compute_sidecar_v1' || (order.capacityUnit === 'GPU时' && mode !== 'legacy_delivery');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableValue(nested)]));
}

function normalizeDeliveryDetails(value: Record<string, unknown>) {
  const allowed = new Set(['endpoint', 'instructions', 'username', 'temporaryPassword']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AppError('DELIVERY_DETAILS_INVALID', 400, '交付信息包含无法识别的字段。');
  }
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint.trim() : '';
  const instructions = typeof value.instructions === 'string' ? value.instructions.trim() : '';
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  const temporaryPassword = typeof value.temporaryPassword === 'string' ? value.temporaryPassword : '';
  if (endpoint.length < 3 || endpoint.length > 2_000 || instructions.length < 3 || instructions.length > 2_000
    || username.length > 2_000 || temporaryPassword.length > 2_000
    || (value.username !== undefined && !username)
    || (value.temporaryPassword !== undefined && !temporaryPassword)) {
    throw new AppError('DELIVERY_DETAILS_INVALID', 400, '请填写有效的访问地址和使用说明。');
  }
  return {
    endpoint, instructions,
    ...(username ? { username } : {}),
    ...(temporaryPassword ? { temporaryPassword } : {}),
  };
}
