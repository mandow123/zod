import { randomBytes, randomUUID } from 'node:crypto';
import { secretHash } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import { AppError } from '../errors.js';
import { KAI_CNY_MICROS_PER_CREDIT } from '../listings/types.js';
import type { SubjectAccess } from '../subjects/types.js';
import type { CreditPayoutStore } from './store.js';
import type { CreditPayoutRecord, CreditPayoutStatus } from './types.js';
import { parseCreditMicros } from './types.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

export class CreditPayoutService {
  private readonly pepper: string;
  constructor(private readonly store: CreditPayoutStore, private readonly subjects: SubjectAccess,
    config: RuntimeConfig, private readonly now: () => Date = () => new Date()) {
    if (!config.AUDIT_PEPPER) throw new Error('AUDIT_PEPPER is required.');
    this.pepper = config.AUDIT_PEPPER;
  }

  async profile(principal: AccountPrincipal) {
    const subject = await this.subjects.current(principal.userId, 'credits.read');
    const profile = await this.store.profile(subject.subjectId);
    return profile ? { status: profile.status, activatedAt: profile.activatedAt?.toISOString() ?? null }
      : { status: 'pending_activation' as const, activatedAt: null };
  }

  async create(principal: AccountPrincipal, input: Readonly<{ creditAmount: string; idempotencyKey: string }>,
    _context: RequestContext) {
    this.idempotency(input.idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'credits.redeem');
    const creditMicros = parseCreditMicros(input.creditAmount);
    if (!creditMicros || creditMicros < 1_000_000n || creditMicros > 100_000_000_000n) {
      throw new AppError('PAYOUT_AMOUNT_INVALID', 400, '单次兑付需为 1.00 至 100,000.00 卡时。');
    }
    const cnyMicros = (creditMicros * KAI_CNY_MICROS_PER_CREDIT + 500_000n) / 1_000_000n;
    const paymentAmountCents = (cnyMicros + 5_000n) / 10_000n;
    const digest = this.digest({ action: 'create', subjectId: subject.subjectId, creditMicros: creditMicros.toString() });
    const result = await this.store.create({ id: randomUUID(), payoutNumber: this.number(), subjectId: subject.subjectId,
      userId: principal.userId, clientRequestId: input.idempotencyKey, payloadDigest: digest, creditMicros,
      conversionCnyMicrosPerCredit: KAI_CNY_MICROS_PER_CREDIT, cnyMicros, paymentAmountCents, now: this.now() });
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的兑付内容。');
    if (result.status === 'profile_pending') throw new AppError('PAYOUT_PROFILE_PENDING_ACTIVATION', 409,
      '收款主体和公司打款账户尚未完成核验，暂不能申请兑付。');
    if (result.status === 'insufficient_earnings') throw new AppError('PAYOUT_EARNINGS_INSUFFICIENT', 409,
      '可兑付的供应收益不足。');
    if (!('payout' in result)) throw new Error('unhandled payout creation result');
    return { replayed: result.status === 'replayed', payout: this.serialize(result.payout) };
  }

  async list(principal: AccountPrincipal, limit = 30) {
    const subject = await this.subjects.current(principal.userId, 'credits.read');
    return (await this.store.list(subject.subjectId, limit)).map((record) => this.serialize(record));
  }

  async get(principal: AccountPrincipal, payoutId: string) {
    const subject = await this.subjects.current(principal.userId, 'credits.read');
    const payout = await this.store.get(subject.subjectId, payoutId);
    if (!payout) throw new AppError('PAYOUT_NOT_FOUND', 404, '兑付记录不存在。');
    return this.serialize(payout);
  }

  async cancel(principal: AccountPrincipal, payoutId: string, idempotencyKey: string, context: RequestContext) {
    this.idempotency(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'credits.redeem');
    const payout = await this.store.get(subject.subjectId, payoutId);
    if (!payout) throw new AppError('PAYOUT_NOT_FOUND', 404, '兑付记录不存在。');
    const result = await this.store.transition({ payoutId, actorId: principal.userId, action: 'cancel', from: 'submitted',
      to: 'cancelled', clientRequestId: idempotencyKey,
      payloadDigest: this.digest({ action: 'cancel', payoutId, subjectId: subject.subjectId }), now: this.now(),
      reason: '供应方在审核前取消', failureCode: 'SUPPLIER_CANCELLED' });
    return this.transitionResult(result, context);
  }

  async queue(principal: AccountPrincipal, limit = 50) {
    this.operator(principal);
    return (await this.store.listQueue(limit)).map((record) => this.serialize(record, true));
  }

  async activateProfile(principal: AccountPrincipal, input: Readonly<{ subjectId: string; legalEntityDigest: string;
    recipientReference: string }>) {
    this.operator(principal);
    const result = await this.store.activateProfile({ ...input, operatorId: principal.userId, now: this.now() });
    if (!result) throw new AppError('PAYOUT_SUBJECT_NOT_FOUND', 404, '交易主体不存在或当前不可用。');
    return { subjectId: result.subjectId, status: result.status, activatedAt: result.activatedAt?.toISOString() ?? null };
  }

  async review(principal: AccountPrincipal, payoutId: string, idempotencyKey: string, context: RequestContext) {
    return this.operatorTransition(principal, payoutId, idempotencyKey, context, 'review', 'submitted', 'reviewing', {});
  }
  async pay(principal: AccountPrincipal, payoutId: string, idempotencyKey: string, context: RequestContext) {
    return this.operatorTransition(principal, payoutId, idempotencyKey, context, 'pay', 'reviewing', 'paying', {});
  }
  async succeed(principal: AccountPrincipal, payoutId: string, idempotencyKey: string, context: RequestContext,
    input: Readonly<{ companyPaymentReference: string; companyPaymentFlowDigest: string; companyPaymentAmountCents: number }>) {
    return this.operatorTransition(principal, payoutId, idempotencyKey, context, 'succeed', 'paying', 'succeeded',
      { ...input, companyPaymentAmountCents: BigInt(input.companyPaymentAmountCents) });
  }
  async fail(principal: AccountPrincipal, payoutId: string, idempotencyKey: string, context: RequestContext,
    input: Readonly<{ failureCode: string; reason: string }>) {
    return this.operatorTransition(principal, payoutId, idempotencyKey, context, 'fail', 'paying', 'failed', input);
  }
  async reject(principal: AccountPrincipal, payoutId: string, idempotencyKey: string, context: RequestContext,
    input: Readonly<{ reason: string }>) {
    return this.operatorTransition(principal, payoutId, idempotencyKey, context, 'reject', 'reviewing', 'rejected',
      { ...input, failureCode: 'OPERATOR_REJECTED' });
  }

  private async operatorTransition(principal: AccountPrincipal, payoutId: string, idempotencyKey: string,
    context: RequestContext, action: 'review' | 'pay' | 'succeed' | 'fail' | 'reject', from: CreditPayoutStatus,
    to: CreditPayoutStatus, details: Readonly<{ companyPaymentReference?: string; companyPaymentFlowDigest?: string;
      companyPaymentAmountCents?: bigint;
      failureCode?: string; reason?: string }>) {
    this.operator(principal); this.idempotency(idempotencyKey);
    const result = await this.store.transition({ payoutId, actorId: principal.userId, action, from, to,
      clientRequestId: idempotencyKey, payloadDigest: this.digest({ action, payoutId, ...details }), now: this.now(), ...details });
    return this.transitionResult(result, context, true);
  }

  private transitionResult(result: Awaited<ReturnType<CreditPayoutStore['transition']>>, _context: RequestContext,
    operator = false) {
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的操作。');
    if (result.status === 'not_found') throw new AppError('PAYOUT_NOT_FOUND', 404, '兑付记录不存在。');
    if (result.status === 'invalid_state') throw new AppError('PAYOUT_STATE_INVALID', 409, '兑付状态已变化，请刷新后重试。');
    if (!('payout' in result)) throw new Error('unhandled payout transition result');
    return { replayed: result.status === 'replayed', payout: this.serialize(result.payout, operator) };
  }

  private serialize(record: CreditPayoutRecord, operator = false) {
    const credits = (value: bigint | null) => value === null ? null : formatCreditDisplayMicros(value);
    return {
      id: record.id, payoutNumber: record.payoutNumber, status: record.status,
      creditAmount: formatCreditDisplayMicros(record.creditMicros), freezeTransactionId: record.freezeTransactionId,
      resolutionTransactionId: record.resolutionTransactionId, companyPaymentReference: record.companyPaymentReference,
      failureCode: record.failureCode, resolutionReason: record.resolutionReason,
      balances: {
        supplierEarningsBefore: credits(record.supplierEarningsBeforeMicros),
        supplierEarningsAfter: credits(record.supplierEarningsAfterMicros),
        frozenBefore: credits(record.frozenBeforeMicros), frozenAfter: credits(record.frozenAfterMicros),
        resolutionSupplierEarningsBefore: credits(record.resolutionSupplierEarningsBeforeMicros),
        resolutionSupplierEarningsAfter: credits(record.resolutionSupplierEarningsAfterMicros),
        resolutionFrozenBefore: credits(record.resolutionFrozenBeforeMicros),
        resolutionFrozenAfter: credits(record.resolutionFrozenAfterMicros),
      },
      reviewedAt: record.reviewedAt?.toISOString() ?? null, payingAt: record.payingAt?.toISOString() ?? null,
      resolvedAt: record.resolvedAt?.toISOString() ?? null, createdAt: record.createdAt.toISOString(),
      ...(operator ? { subjectId: record.subjectId, amountCny: this.cny(record.paymentAmountCents),
        conversion: '1 KAI卡时 = ¥1.002', companyPaymentFlowDigest: record.companyPaymentFlowDigest,
        companyPaymentAmountCny: record.companyPaymentAmountCents === null ? null : this.cny(record.companyPaymentAmountCents) } : {}),
    };
  }

  private cny(cents: bigint) { return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`; }
  private number() { return `KPO${this.now().getTime().toString(36).toUpperCase()}${randomBytes(5).toString('hex').toUpperCase()}`; }
  private idempotency(value: string) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(value)) throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '请求缺少有效的幂等标识。');
  }
  private digest(value: unknown) { return secretHash(JSON.stringify(value), this.pepper); }
  private operator(principal: AccountPrincipal) {
    if (principal.role !== 'operator' && principal.role !== 'admin') throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要运营权限。');
  }
}
