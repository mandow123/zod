import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { AccountStore } from '../account/store.js';
import { secretHash } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { PaymentProvider } from './providers.js';
import type { PaymentStore } from './store.js';
import type { PaymentChannel, PaymentProviderName } from './types.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function paymentClientIp(value: string) {
  const normalized = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (!isIP(normalized)) throw new AppError('PAYMENT_CLIENT_IP_INVALID', 400, '当前网络信息无效，请切换网络后重试。');
  return normalized;
}

export class PaymentService {
  private readonly auditPepper: string;

  constructor(
    private readonly store: PaymentStore,
    private readonly accountStore: AccountStore,
    private readonly providers: ReadonlyMap<PaymentProviderName, PaymentProvider>,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
  }

  async createCheckout(
    principal: AccountPrincipal,
    input: Readonly<{ orderId: string; provider: PaymentProviderName; channel: PaymentChannel }>,
    context: RequestContext,
  ) {
    const provider = this.providers.get(input.provider);
    if (!provider) throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE', 503, '该支付方式暂时不可用，请选择其他方式。');
    const prepared = await this.store.prepareIntent({
      id: randomUUID(),
      providerReference: `KP${this.now().getTime().toString(36).toUpperCase()}${randomBytes(6).toString('hex').toUpperCase()}`,
      buyerId: principal.userId,
      orderId: input.orderId,
      provider: input.provider,
      channel: input.channel,
      now: this.now(),
    });
    if (prepared.status === 'order_not_found') throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    if (prepared.status === 'reservation_expired') throw new AppError('PAYMENT_WINDOW_EXPIRED', 409, '订单支付时间已结束，请重新下单。');
    if (prepared.status === 'order_not_payable') throw new AppError('ORDER_NOT_PAYABLE', 409, '订单当前不能发起支付。');

    let intent = prepared.intent;
    if (!intent.checkoutPayload || intent.status === 'created') {
      try {
        const checkout = await provider.createCheckout({
          providerReference: intent.providerReference,
          orderNumber: intent.orderNumber,
          amountCents: intent.amountCents,
          description: `KAI CloudPay 订单 ${intent.orderNumber}`,
          channel: intent.channel,
          clientIp: paymentClientIp(context.ip),
          expiresAt: intent.expiresAt,
        });
        const saved = await this.store.saveCheckout(intent.id, checkout);
        if (!saved) throw new AppError('PAYMENT_STATE_CHANGED', 409, '支付状态已变化，请刷新订单后重试。');
        intent = saved;
      } catch (error) {
        await this.store.failCheckout(intent.id);
        throw error;
      }
    }
    await this.accountStore.recordAudit({
      actorId: principal.userId,
      actorKind: 'user',
      action: 'PAYMENT_CHECKOUT_CREATED',
      entityType: 'PAYMENT_INTENT',
      entityId: intent.id,
      requestId: context.requestId,
      ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      payloadDigest: secretHash(JSON.stringify({ provider: intent.provider, channel: intent.channel }), this.auditPepper),
      metadata: { provider: intent.provider, channel: intent.channel, orderId: intent.orderId },
    });
    return this.serialize(intent, true);
  }

  async status(principal: AccountPrincipal, orderId: string) {
    const intent = await this.store.getForBuyer(principal.userId, orderId);
    if (!intent) throw new AppError('PAYMENT_NOT_FOUND', 404, '该订单还没有支付记录。');
    return this.serialize(intent, false);
  }

  async alipayNotification(payload: Record<string, string>) {
    const provider = this.providers.get('alipay');
    if (!provider?.verifyAlipayNotification) throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE', 503, '支付宝回调能力未配置。');
    const event = provider.verifyAlipayNotification(payload);
    return this.store.applyVerifiedEvent(event, this.now());
  }

  async wechatNotification(headers: Record<string, string | undefined>, rawBody: string) {
    const provider = this.providers.get('wechat');
    if (!provider?.verifyWechatNotification) throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE', 503, '微信支付回调能力未配置。');
    const event = provider.verifyWechatNotification(headers, rawBody);
    return this.store.applyVerifiedEvent(event, this.now());
  }

  private serialize(intent: Awaited<ReturnType<PaymentStore['getForBuyer']>> & {}, includeCheckout: boolean) {
    if (!intent) throw new Error('payment intent is required');
    return {
      id: intent.id,
      orderId: intent.orderId,
      provider: intent.provider,
      channel: intent.channel,
      status: intent.status,
      amountCents: intent.amountCents,
      amountCny: (intent.amountCents / 100).toFixed(2),
      currency: intent.currency,
      expiresAt: intent.expiresAt.toISOString(),
      recovery: intent.status === 'pending' ? {
        state: intent.reconciliationDeadLetteredAt ? 'needs_support' : 'checking',
        attempts: intent.reconciliationAttempts,
        lastCheckedAt: intent.lastReconciledAt?.toISOString() ?? null,
        message: intent.reconciliationDeadLetteredAt
          ? '支付渠道暂未返回最终结果；如已扣款请勿重复支付，客服将继续核对。'
          : '正在通过支付渠道主动确认结果，无需重复提交。',
      } : null,
      ...(includeCheckout ? { checkoutPayload: intent.checkoutPayload } : {}),
    };
  }
}
