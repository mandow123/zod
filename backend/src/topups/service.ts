import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { AccountStore } from '../account/store.js';
import { secretHash } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import { KAI_CNY_MICROS_PER_CREDIT } from '../listings/types.js';
import type { PaymentProvider } from '../payment/providers.js';
import type { PaymentChannel, PaymentProviderName } from '../payment/types.js';
import type { SubjectAccess } from '../subjects/types.js';
import type { CreditTopupStore } from './store.js';
import type { CreditTopupRecord } from './types.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

function clientIp(value: string) {
  const normalized = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (!isIP(normalized)) throw new AppError('TOPUP_CLIENT_IP_INVALID', 400, '当前网络信息无效，请切换网络后重试。');
  return normalized;
}

export function creditMicrosForTopup(amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('positive safe integer cents are required');
  const cnyMicros = BigInt(amountCents) * 10_000n;
  return cnyMicros * 1_000_000n / KAI_CNY_MICROS_PER_CREDIT;
}

export class CreditTopupService {
  private readonly auditPepper: string;

  constructor(
    private readonly store: CreditTopupStore,
    private readonly accounts: AccountStore,
    private readonly subjects: SubjectAccess,
    private readonly providers: ReadonlyMap<PaymentProviderName, PaymentProvider>,
    private readonly config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!config.AUDIT_PEPPER) throw new Error('AUDIT_PEPPER is required.');
    this.auditPepper = config.AUDIT_PEPPER;
  }

  async create(
    principal: AccountPrincipal,
    input: Readonly<{ amountCents: number; provider: PaymentProviderName; channel: PaymentChannel; idempotencyKey: string }>,
    context: RequestContext,
  ) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(input.idempotencyKey)) {
      throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '充值请求缺少有效的幂等标识。');
    }
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 100 || input.amountCents > 10_000_000) {
      throw new AppError('TOPUP_AMOUNT_INVALID', 400, '单次充值金额需在 ¥1.00 至 ¥100,000.00 之间。');
    }
    if (input.channel !== 'app') throw new AppError('TOPUP_CHANNEL_UNAVAILABLE', 400, '请在 KAI CloudPay App 内完成充值。');
    const provider = this.providers.get(input.provider);
    if (!provider) throw new AppError('TOPUP_PROVIDER_UNAVAILABLE', 503, '该充值方式暂时不可用，请选择其他方式。');
    const subject = await this.subjects.current(principal.userId, 'credits.read');
    const creditMicros = creditMicrosForTopup(input.amountCents);
    const payloadDigest = secretHash(JSON.stringify({
      subjectId: subject.subjectId, amountCents: input.amountCents, provider: input.provider, channel: input.channel,
    }), this.auditPepper);
    const prepared = await this.store.prepare({
      id: randomUUID(), subjectId: subject.subjectId, userId: principal.userId, provider: input.provider,
      providerReference: `KCT${this.now().getTime().toString(36).toUpperCase()}${randomBytes(6).toString('hex').toUpperCase()}`,
      channel: input.channel, amountCents: input.amountCents, creditMicros,
      conversionCnyMicrosPerCredit: KAI_CNY_MICROS_PER_CREDIT,
      clientRequestId: input.idempotencyKey, payloadDigest, expiresAt: new Date(this.now().getTime() + 30 * 60_000),
    });
    if (prepared.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的充值内容。');
    let topup = prepared.topup;
    if (topup.status === 'created') {
      try {
        const checkout = await provider.createCheckout({
          providerReference: topup.providerReference,
          orderNumber: topup.providerReference,
          amountCents: topup.amountCents,
          description: `KAI CloudPay 卡时充值 ${topup.providerReference}`,
          channel: topup.channel,
          clientIp: clientIp(context.ip),
          expiresAt: topup.expiresAt,
          notifyUrl: topup.provider === 'alipay'
            ? this.topupNotifyUrl('alipay')
            : this.topupNotifyUrl('wechat'),
        });
        const saved = await this.store.saveCheckout(topup.id, checkout);
        if (!saved) throw new AppError('TOPUP_STATE_CHANGED', 409, '充值状态已变化，请刷新后查看。');
        topup = saved;
      } catch (error) {
        await this.store.failCheckout(topup.id);
        throw error;
      }
      await this.accounts.recordAudit({
        actorId: principal.userId, actorKind: 'user', action: 'KAI_CREDIT_TOPUP_CREATED',
        entityType: 'KAI_CREDIT_TOPUP', entityId: topup.id, requestId: context.requestId,
        ipHash: secretHash(context.ip || 'unknown', this.auditPepper), payloadDigest,
        metadata: { subjectId: subject.subjectId, provider: topup.provider, amountCents: topup.amountCents, creditMicros: topup.creditMicros.toString() },
      });
    }
    return { replayed: prepared.status === 'replayed', topup: this.serialize(topup, true) };
  }

  private topupNotifyUrl(provider: PaymentProviderName) {
    const key = provider === 'alipay' ? 'TOPUP_ALIPAY_NOTIFY_URL' : 'TOPUP_WECHAT_NOTIFY_URL';
    const value = this.config[key];
    if (!value) throw new AppError('TOPUP_PROVIDER_UNAVAILABLE', 503, '充值回调地址未配置。');
    return value;
  }

  async get(principal: AccountPrincipal, topupId: string) {
    const subject = await this.subjects.current(principal.userId, 'credits.read');
    const topup = await this.store.get(subject.subjectId, topupId);
    if (!topup) throw new AppError('TOPUP_NOT_FOUND', 404, '充值记录不存在。');
    // The authenticated owner may need the still-valid signed checkout payload after the App resumes.
    // Credit issuance remains callback/query driven; returning it never marks the top-up as paid.
    return this.serialize(topup, topup.status === 'pending' && topup.expiresAt > this.now());
  }

  async list(principal: AccountPrincipal, limit = 30) {
    const subject = await this.subjects.current(principal.userId, 'credits.read');
    return Promise.all((await this.store.list(subject.subjectId, limit)).map((topup) => this.serialize(topup, false)));
  }

  async alipayNotification(payload: Record<string, string>) {
    const provider = this.providers.get('alipay');
    if (!provider?.verifyAlipayNotification) throw new AppError('TOPUP_PROVIDER_UNAVAILABLE', 503, '支付宝充值回调未配置。');
    return this.store.applyVerifiedEvent(provider.verifyAlipayNotification(payload), this.now());
  }

  async wechatNotification(headers: Record<string, string | undefined>, rawBody: string) {
    const provider = this.providers.get('wechat');
    if (!provider?.verifyWechatNotification) throw new AppError('TOPUP_PROVIDER_UNAVAILABLE', 503, '微信充值回调未配置。');
    return this.store.applyVerifiedEvent(provider.verifyWechatNotification(headers, rawBody), this.now());
  }

  private serialize(topup: CreditTopupRecord, includeCheckout: boolean) {
    return {
      id: topup.id, subjectId: topup.subjectId, provider: topup.provider, channel: topup.channel, status: topup.status,
      amountCny: (topup.amountCents / 100).toFixed(2), creditAmount: this.formatCredits(topup.creditMicros),
      conversion: '1 KAI卡时 = ¥1.002', expiresAt: topup.expiresAt.toISOString(),
      createdAt: topup.createdAt.toISOString(), succeededAt: topup.succeededAt?.toISOString() ?? null,
      recovery: topup.status === 'pending' ? {
        state: topup.reconciliationDeadLetteredAt ? 'needs_support' : 'checking',
        message: topup.reconciliationDeadLetteredAt
          ? '充值结果需要人工核对。如已扣款，请勿重复充值。'
          : '正在向支付渠道确认结果，请勿重复充值。',
      } : null,
      ...(includeCheckout ? { checkoutPayload: topup.checkoutPayload } : {}),
    };
  }

  private formatCredits(value: bigint) {
    const whole = value / 1_000_000n; const fraction = (value % 1_000_000n).toString().padStart(6, '0');
    return `${whole}.${fraction}`;
  }
}
