import { randomUUID } from 'node:crypto';
import { secretHash } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import { AppError } from '../errors.js';
import type { PostgresTopupReversalStore, TopupReversalRecord } from './reversal-store.js';

export class TopupReversalService {
  private readonly pepper: string;
  constructor(private readonly store: PostgresTopupReversalStore, config: RuntimeConfig,
    private readonly now: () => Date = () => new Date()) {
    if (!config.AUDIT_PEPPER) throw new Error('AUDIT_PEPPER is required.');
    this.pepper = config.AUDIT_PEPPER;
  }

  async request(principal: AccountPrincipal, topupId: string, input: Readonly<{
    kind: 'refund' | 'chargeback'; amountCents: number; providerEventReference: string;
    evidenceDigest: string; idempotencyKey: string;
  }>) {
    this.operator(principal); this.key(input.idempotencyKey);
    const payloadDigest = secretHash(JSON.stringify({ topupId, kind: input.kind, amountCents: input.amountCents,
      providerEventReference: input.providerEventReference, evidenceDigest: input.evidenceDigest }), this.pepper);
    const result = await this.store.create({ id: randomUUID(), topupId, operatorId: principal.userId,
      ...input, clientRequestId: input.idempotencyKey, payloadDigest, now: this.now() });
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的充值冲正。');
    if (result.status === 'topup_not_found') throw new AppError('TOPUP_NOT_FOUND', 404, '充值记录不存在。');
    if (result.status === 'qixiang_refund_workflow_required') throw new AppError(
      'QIXIANG_REFUND_WORKFLOW_REQUIRED', 409, '该充值必须使用七相退款双审流程。');
    if (result.status === 'topup_not_settled') throw new AppError('TOPUP_REVERSAL_STATE_INVALID', 409, '仅已到账充值可以进入冲正流程。');
    if (result.status === 'amount_exceeds_remaining') throw new AppError('TOPUP_REVERSAL_AMOUNT_INVALID', 409, '冲正金额超过该充值尚可冲正的金额。');
    if (!('reversal' in result)) throw new Error('unhandled topup reversal creation result');
    return { replayed: result.status === 'replayed', reversal: this.serialize(result.reversal) };
  }

  async recoverCredits(principal: AccountPrincipal, reversalId: string) {
    this.operator(principal);
    const result = await this.store.recoverCredits({ reversalId, operatorId: principal.userId, now: this.now() });
    if (result.status === 'not_found') throw new AppError('TOPUP_REVERSAL_NOT_FOUND', 404, '充值冲正记录不存在。');
    if (result.status === 'same_operator') throw new AppError('TOPUP_REVERSAL_DUAL_CONTROL_REQUIRED', 409, '冲正申请与卡时回收必须由不同运营人员完成。');
    if (result.status === 'invalid_state') throw new AppError('TOPUP_REVERSAL_STATE_INVALID', 409, '该冲正记录当前不能回收卡时。');
    if (result.status === 'insufficient_credits') throw new AppError('TOPUP_REVERSAL_CREDITS_IN_USE', 409,
      '该充值对应卡时已被使用或冻结，暂不能安全回收，请先进入人工风险处置。');
    if (!('reversal' in result)) throw new Error('unhandled topup reversal recovery result');
    return { replayed: result.status === 'replayed', reversal: this.serialize(result.reversal) };
  }

  private serialize(value: TopupReversalRecord) {
    return { id: value.id, topupId: value.topupId, subjectId: value.subjectId, provider: value.provider,
      kind: value.kind, providerEventReference: value.providerEventReference, evidenceDigest: value.evidenceDigest,
      amountCny: (value.amountCents / 100).toFixed(2), creditAmount: formatCreditDisplayMicros(value.creditMicros),
      status: value.status, requestedByOperatorId: value.requestedByOperatorId,
      approvedByOperatorId: value.approvedByOperatorId, recoveryTransactionId: value.recoveryTransactionId,
      requestedAt: value.requestedAt.toISOString(), resolvedAt: value.resolvedAt?.toISOString() ?? null,
      externalMoneyMovement: {
        executedByThisService: false,
        state: value.status === 'credit_recovered_external_unverified'
          ? 'requires_provider_reconciliation' as const : 'not_started' as const,
        message: '本记录仅证明卡时账本处理；人民币退款或拒付结果必须以支付渠道回执为准。',
      } };
  }

  private key(value: string) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(value)) throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '请求缺少有效的幂等标识。');
  }
  private operator(principal: AccountPrincipal) {
    if (principal.role !== 'operator' && principal.role !== 'admin') throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要运营权限。');
  }
}
