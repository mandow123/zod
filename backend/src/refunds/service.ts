import { randomUUID } from 'node:crypto';
import type { AccountStore } from '../account/store.js';
import { secretHash } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { RefundStore } from './store.js';
import type { RefundRecord } from './types.js';
import type { RefundStatus } from './types.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export class RefundService {
  private readonly auditPepper: string;

  constructor(
    private readonly store: RefundStore,
    private readonly accountStore: AccountStore,
    config: RuntimeConfig,
  ) {
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
  }

  async request(
    principal: AccountPrincipal,
    input: { orderId: string; amountCents?: number; reason: string; idempotencyKey: string },
    context: RequestContext,
  ) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(input.idempotencyKey)) {
      throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '退款请求缺少有效的幂等标识。');
    }
    const reason = input.reason.trim();
    if (reason.length < 8 || reason.length > 1_000) throw new AppError('REFUND_REASON_INVALID', 400, '请填写 8 至 1000 个字符的退款原因。');
    const payloadDigest = secretHash(JSON.stringify({ orderId: input.orderId, amountCents: input.amountCents ?? null, reason }), this.auditPepper);
    const result = await this.store.request({
      id: randomUUID(), userId: principal.userId, orderId: input.orderId, reason,
      idempotencyKey: input.idempotencyKey, payloadDigest,
      ...(input.amountCents === undefined ? {} : { amountCents: input.amountCents }),
    });
    if (result.status === 'idempotency_conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一幂等标识对应了不同的退款内容。');
    if (result.status === 'order_not_found') throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    if (result.status === 'order_not_refundable') throw new AppError('ORDER_NOT_REFUNDABLE', 409, '订单当前不符合退款申请条件。');
    if (result.status === 'active_refund_exists') throw new AppError('REFUND_ALREADY_ACTIVE', 409, '该笔付款已有退款正在处理中。');
    if (result.status === 'amount_exceeds_available') throw new AppError('REFUND_AMOUNT_INVALID', 400, '退款金额超过当前可退金额。');
    if (result.status === 'created') {
      await this.audit(principal, 'REFUND_REQUESTED', result.refund.id, context, { orderId: input.orderId, amountCents: result.refund.amountCents });
    }
    return { replayed: result.status === 'replayed', refund: this.serialize(result.refund) };
  }

  async list(principal: AccountPrincipal) {
    return (await this.store.list(principal.userId)).map((refund) => this.serialize(refund));
  }

  async reviewQueue(principal: AccountPrincipal, status?: RefundStatus, limit = 50) {
    if (!this.isOperator(principal)) throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要运营审核权限。');
    return (await this.store.listForReview(status, Math.min(Math.max(limit, 1), 100))).map((refund) => this.serialize(refund));
  }

  async get(principal: AccountPrincipal, refundId: string) {
    const refund = await this.store.get(principal.userId, refundId, this.isOperator(principal));
    if (!refund) throw new AppError('REFUND_NOT_FOUND', 404, '退款记录不存在。');
    return this.serialize(refund);
  }

  async cancel(principal: AccountPrincipal, refundId: string, context: RequestContext) {
    const refund = await this.store.cancel(principal.userId, refundId);
    if (!refund) throw new AppError('REFUND_NOT_CANCELLABLE', 409, '退款已进入处理，当前不能撤销。');
    await this.audit(principal, 'REFUND_CANCELLED', refund.id, context, { orderId: refund.orderId });
    return this.serialize(refund);
  }

  async review(
    principal: AccountPrincipal, input: { refundId: string; approved: boolean; reason?: string }, context: RequestContext,
  ) {
    if (!this.isOperator(principal)) throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要运营审核权限。');
    if (!input.approved && (!input.reason?.trim() || input.reason.trim().length < 4)) {
      throw new AppError('REFUND_REVIEW_REASON_REQUIRED', 400, '拒绝退款时需要填写审核说明。');
    }
    const refund = await this.store.review({
      refundId: input.refundId, operatorId: principal.userId, approved: input.approved,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    });
    if (!refund) throw new AppError('REFUND_REVIEW_STATE_INVALID', 409, '退款当前状态不能执行审核。');
    await this.audit(principal, input.approved ? 'REFUND_APPROVED' : 'REFUND_REJECTED', refund.id, context, { orderId: refund.orderId });
    return this.serialize(refund);
  }

  private isOperator(principal: AccountPrincipal) {
    return principal.role === 'operator' || principal.role === 'admin';
  }

  private serialize(refund: RefundRecord) {
    return {
      id: refund.id, orderId: refund.orderId, orderNumber: refund.orderNumber,
      amountCents: refund.amountCents, amountCny: (refund.amountCents / 100).toFixed(2), currency: refund.currency,
      reason: refund.reason, reviewReason: refund.reviewReason, status: refund.status,
      providerRefundId: refund.providerRefundId, decidedAt: refund.decidedAt?.toISOString() ?? null,
      createdAt: refund.createdAt.toISOString(), updatedAt: refund.updatedAt.toISOString(),
    };
  }

  private async audit(
    principal: AccountPrincipal, action: string, refundId: string, context: RequestContext, metadata: Record<string, unknown>,
  ) {
    await this.accountStore.recordAudit({
      actorId: principal.userId, actorKind: 'user', action, entityType: 'REFUND', entityId: refundId,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      payloadDigest: secretHash(JSON.stringify(metadata), this.auditPepper), metadata,
    });
  }
}
