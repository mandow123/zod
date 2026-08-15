import { createDecipheriv, createSign, createVerify, randomBytes } from 'node:crypto';
import { AlipaySdk } from 'alipay-sdk';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import { secretHash } from '../account/crypto.js';
import type {
  PaymentChannel, PaymentProviderName, ProviderCheckout, ProviderRefundRequest, ProviderRefundResult,
  VerifiedPaymentEvent, VerifiedRefundEvent,
  PaymentQueryResult,
} from './types.js';

export type CheckoutRequest = Readonly<{
  providerReference: string;
  orderNumber: string;
  amountCents: number;
  description: string;
  channel: PaymentChannel;
  clientIp: string;
  expiresAt: Date;
  notifyUrl?: string;
  returnUrl?: string;
}>;

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createCheckout(input: CheckoutRequest): Promise<ProviderCheckout>;
  queryPayment?(input: Readonly<{
    providerReference: string; expectedAmountCents: number; currency: 'CNY';
  }>): Promise<PaymentQueryResult>;
  executeRefund?(input: ProviderRefundRequest): Promise<ProviderRefundResult>;
  queryRefund?(input: ProviderRefundRequest): Promise<ProviderRefundResult>;
  verifyAlipayNotification?(payload: Record<string, string>): VerifiedPaymentEvent;
  verifyWechatNotification?(headers: Record<string, string | undefined>, rawBody: string): VerifiedPaymentEvent;
  verifyWechatRefundNotification?(headers: Record<string, string | undefined>, rawBody: string): VerifiedRefundEvent;
}

function pem(value: string) {
  return value.replaceAll('\\n', '\n');
}

function yuan(amountCents: number) {
  return (amountCents / 100).toFixed(2);
}

function yuanToCents(value: string) {
  if (!/^\d{1,12}(?:\.\d{1,2})?$/u.test(value)) throw new AppError('PAYMENT_AMOUNT_INVALID', 400, '支付金额格式无效。');
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}

export class AlipayProvider implements PaymentProvider {
  readonly name = 'alipay' as const;
  private readonly sdk: AlipaySdk;

  constructor(private readonly config: RuntimeConfig, private readonly auditPepper: string) {
    this.sdk = new AlipaySdk({
      appId: config.ALIPAY_APP_ID!,
      privateKey: pem(config.ALIPAY_PRIVATE_KEY!),
      alipayPublicKey: pem(config.ALIPAY_PUBLIC_KEY!),
      signType: 'RSA2',
    });
  }

  async createCheckout(input: CheckoutRequest) {
    const bizContent = {
      outTradeNo: input.providerReference,
      totalAmount: yuan(input.amountCents),
      subject: input.description.slice(0, 128),
      productCode: input.channel === 'app' ? 'QUICK_MSECURITY_PAY' : 'QUICK_WAP_WAY',
      timeExpire: input.expiresAt.toISOString().replace('T', ' ').slice(0, 19),
    };
    const parameters = {
      notifyUrl: input.notifyUrl ?? this.config.ALIPAY_NOTIFY_URL,
      ...(input.channel === 'h5' ? { returnUrl: input.returnUrl ?? this.config.ALIPAY_RETURN_URL } : {}),
      bizContent,
    };
    const checkoutPayload = input.channel === 'app'
      ? this.sdk.sdkExec('alipay.trade.app.pay', parameters)
      : this.sdk.pageExec('alipay.trade.wap.pay', 'GET', parameters);
    return { providerPaymentId: input.providerReference, checkoutPayload };
  }

  async queryPayment(input: { providerReference: string; expectedAmountCents: number; currency: 'CNY' }): Promise<PaymentQueryResult> {
    const response = await this.sdk.exec('alipay.trade.query', {
      bizContent: { outTradeNo: input.providerReference },
    }, { validateSign: true });
    const payloadDigest = secretHash(JSON.stringify(response), this.auditPepper);
    if (response.code !== '10000') {
      if (response.code === '40004' && response.subCode === 'ACQ.TRADE_NOT_EXIST') {
        return { status: 'pending', providerStatus: 'TRADE_NOT_EXIST', payloadDigest };
      }
      throw new AppError('PAYMENT_QUERY_FAILED', 502, response.subMsg || response.msg || '支付宝支付状态查询失败。');
    }
    const providerStatus = String(response.tradeStatus ?? 'UNKNOWN');
    if (['WAIT_BUYER_PAY', 'TRADE_NOT_EXIST'].includes(providerStatus)) return { status: 'pending', providerStatus, payloadDigest };
    const succeeded = ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(providerStatus);
    const failed = providerStatus === 'TRADE_CLOSED';
    if (!succeeded && !failed) throw new AppError('PAYMENT_PROVIDER_RESPONSE_INVALID', 502, '支付宝返回了无法识别的支付状态。');
    if (String(response.sellerUserId ?? response.sellerId ?? '') !== this.config.ALIPAY_SELLER_ID) {
      throw new AppError('PAYMENT_MERCHANT_MISMATCH', 502, '支付宝查询返回的收款账户不匹配。');
    }
    const amountCents = response.totalAmount === undefined ? input.expectedAmountCents : yuanToCents(String(response.totalAmount));
    const transactionId = String(response.tradeNo ?? `${input.providerReference}:${providerStatus}`);
    return {
      status: 'settled',
      event: {
        provider: this.name, eventId: `query:${input.providerReference}:${providerStatus}:${transactionId}`,
        providerReference: input.providerReference, providerTransactionId: transactionId,
        status: succeeded ? 'succeeded' : 'failed', amountCents, currency: input.currency,
        payloadDigest, normalizedPayload: { source: 'active_query', tradeStatus: providerStatus },
      },
    };
  }

  verifyAlipayNotification(payload: Record<string, string>): VerifiedPaymentEvent {
    if (!this.sdk.checkNotifySignV2(payload)) throw new AppError('PAYMENT_SIGNATURE_INVALID', 401, '支付通知验签失败。');
    if (payload.app_id !== this.config.ALIPAY_APP_ID) throw new AppError('PAYMENT_APP_ID_MISMATCH', 400, '支付通知应用标识不匹配。');
    if (payload.seller_id !== this.config.ALIPAY_SELLER_ID) throw new AppError('PAYMENT_MERCHANT_MISMATCH', 400, '支付通知收款账户不匹配。');
    const providerReference = payload.out_trade_no;
    const providerTransactionId = payload.trade_no;
    if (!providerReference || !providerTransactionId || !payload.total_amount) throw new AppError('PAYMENT_NOTIFICATION_INVALID', 400, '支付通知字段不完整。');
    const status = ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(payload.trade_status ?? '') ? 'succeeded' : 'failed';
    const normalizedPayload = {
      tradeStatus: payload.trade_status ?? 'UNKNOWN',
      buyerId: payload.buyer_id ? secretHash(payload.buyer_id, this.auditPepper) : null,
      notifyTime: payload.notify_time ?? null,
    };
    return {
      provider: this.name,
      eventId: payload.notify_id || `${providerTransactionId}:${payload.trade_status ?? 'UNKNOWN'}`,
      providerReference, providerTransactionId, status,
      amountCents: yuanToCents(payload.total_amount), currency: 'CNY',
      payloadDigest: secretHash(JSON.stringify(payload), this.auditPepper), normalizedPayload,
    };
  }

  async executeRefund(input: ProviderRefundRequest): Promise<ProviderRefundResult> {
    const response = await this.sdk.exec('alipay.trade.refund', {
      bizContent: {
        outTradeNo: input.providerReference,
        refundAmount: yuan(input.amountCents),
        refundReason: input.reason.slice(0, 256),
        outRequestNo: input.refundReference,
      },
    }, { validateSign: true });
    if (response.code !== '10000') throw new AppError('REFUND_PROVIDER_REJECTED', 502, response.subMsg || response.msg || '支付宝退款请求失败。');
    const providerRefundId = String(response.tradeNo ?? response.outTradeNo ?? input.providerReference);
    const refundFee = response.refundFee === undefined ? input.amountCents : yuanToCents(String(response.refundFee));
    if (refundFee !== input.amountCents) throw new AppError('REFUND_PROVIDER_AMOUNT_MISMATCH', 502, '支付宝退款返回金额不一致。');
    return { providerRefundId, status: response.fundChange === 'N' ? 'pending' : 'succeeded' };
  }

  async queryRefund(input: ProviderRefundRequest): Promise<ProviderRefundResult> {
    const response = await this.sdk.exec('alipay.trade.fastpay.refund.query', {
      bizContent: { outTradeNo: input.providerReference, outRequestNo: input.refundReference },
    }, { validateSign: true });
    if (response.code !== '10000') throw new AppError('REFUND_QUERY_FAILED', 502, response.subMsg || response.msg || '支付宝退款状态查询失败。');
    if (response.refundAmount !== undefined && yuanToCents(String(response.refundAmount)) !== input.amountCents) {
      throw new AppError('REFUND_PROVIDER_AMOUNT_MISMATCH', 502, '支付宝退款查询金额不一致。');
    }
    const providerRefundId = String(response.tradeNo ?? response.outTradeNo ?? input.providerReference);
    const status = response.refundStatus === 'REFUND_SUCCESS' || response.refundAmount !== undefined ? 'succeeded' : 'pending';
    return { providerRefundId, status };
  }
}

type WechatFetch = typeof fetch;

export class WechatProvider implements PaymentProvider {
  readonly name = 'wechat' as const;
  private readonly privateKey: string;
  private readonly platformCertificate: string;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly auditPepper: string,
    private readonly fetcher: WechatFetch = fetch,
  ) {
    this.privateKey = pem(config.WECHAT_PRIVATE_KEY!);
    this.platformCertificate = pem(config.WECHAT_PLATFORM_CERTIFICATE!);
  }

  async createCheckout(input: CheckoutRequest) {
    const path = input.channel === 'app' ? '/v3/pay/transactions/app' : '/v3/pay/transactions/h5';
    const body = JSON.stringify({
      appid: this.config.WECHAT_APP_ID,
      mchid: this.config.WECHAT_MCH_ID,
      description: input.description.slice(0, 127),
      out_trade_no: input.providerReference,
      time_expire: input.expiresAt.toISOString(),
      notify_url: input.notifyUrl ?? this.config.WECHAT_NOTIFY_URL,
      amount: { total: input.amountCents, currency: 'CNY' },
      ...(input.channel === 'h5' ? { scene_info: { payer_client_ip: input.clientIp, h5_info: { type: 'Wap' } } } : {}),
    });
    const payload = await this.wechatRequest<{ prepay_id?: string; h5_url?: string; code?: string; message?: string }>('POST', path, body);
    if (input.channel === 'h5') {
      if (!payload.h5_url) throw new AppError('PAYMENT_PROVIDER_RESPONSE_INVALID', 502, '微信支付未返回收银台地址。');
      return { providerPaymentId: input.providerReference, checkoutPayload: payload.h5_url };
    }
    if (!payload.prepay_id) throw new AppError('PAYMENT_PROVIDER_RESPONSE_INVALID', 502, '微信支付未返回预支付标识。');
    const appTimestamp = Math.floor(Date.now() / 1000).toString();
    const appNonce = randomBytes(16).toString('hex');
    const appSigner = createSign('RSA-SHA256');
    appSigner.update(`${this.config.WECHAT_APP_ID}\n${appTimestamp}\n${appNonce}\n${payload.prepay_id}\n`);
    return {
      providerPaymentId: payload.prepay_id,
      checkoutPayload: JSON.stringify({
        appId: this.config.WECHAT_APP_ID, partnerId: this.config.WECHAT_MCH_ID, prepayId: payload.prepay_id,
        package: 'Sign=WXPay', nonceStr: appNonce, timestamp: appTimestamp,
        sign: appSigner.sign(this.privateKey, 'base64'),
      }),
    };
  }

  async queryPayment(input: { providerReference: string; expectedAmountCents: number; currency: 'CNY' }): Promise<PaymentQueryResult> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(input.providerReference)}?mchid=${encodeURIComponent(this.config.WECHAT_MCH_ID!)}`;
    const payload = await this.wechatRequest<{
      appid?: string; mchid?: string;
      transaction_id?: string; trade_state?: string; trade_state_desc?: string;
      amount?: { total?: number; currency?: string }; code?: string; message?: string;
    }>('GET', path, '', ['ORDERNOTEXIST']);
    const payloadDigest = secretHash(JSON.stringify(payload), this.auditPepper);
    if (payload.code === 'ORDERNOTEXIST') return { status: 'pending', providerStatus: 'ORDERNOTEXIST', payloadDigest };
    if (payload.appid !== this.config.WECHAT_APP_ID || payload.mchid !== this.config.WECHAT_MCH_ID) {
      throw new AppError('PAYMENT_MERCHANT_MISMATCH', 502, '微信支付查询返回的商户身份不匹配。');
    }
    const providerStatus = payload.trade_state ?? 'UNKNOWN';
    if (['NOTPAY', 'USERPAYING'].includes(providerStatus)) return { status: 'pending', providerStatus, payloadDigest };
    const succeeded = providerStatus === 'SUCCESS';
    const failed = ['CLOSED', 'REVOKED', 'PAYERROR'].includes(providerStatus);
    if (!succeeded && !failed) throw new AppError('PAYMENT_PROVIDER_RESPONSE_INVALID', 502, '微信支付返回了无法识别的支付状态。');
    if (succeeded && (!Number.isInteger(payload.amount?.total) || !payload.transaction_id)) {
      throw new AppError('PAYMENT_PROVIDER_RESPONSE_INVALID', 502, '微信支付查询结果缺少交易金额或流水号。');
    }
    const amountCents = payload.amount?.total ?? input.expectedAmountCents;
    const currency = payload.amount?.currency ?? input.currency;
    const transactionId = payload.transaction_id ?? `${input.providerReference}:${providerStatus}`;
    return {
      status: 'settled',
      event: {
        provider: this.name, eventId: `query:${input.providerReference}:${providerStatus}:${transactionId}`,
        providerReference: input.providerReference, providerTransactionId: transactionId,
        status: succeeded ? 'succeeded' : 'failed', amountCents, currency,
        payloadDigest, normalizedPayload: { source: 'active_query', tradeState: providerStatus },
      },
    };
  }

  async executeRefund(input: ProviderRefundRequest): Promise<ProviderRefundResult> {
    const payload = await this.wechatRequest<{
      refund_id?: string; status?: string; code?: string; message?: string;
      amount?: { refund?: number; total?: number; currency?: string };
    }>('POST', '/v3/refund/domestic/refunds', JSON.stringify({
      out_trade_no: input.providerReference,
      out_refund_no: input.refundReference,
      reason: input.reason.slice(0, 80),
      notify_url: this.config.WECHAT_REFUND_NOTIFY_URL,
      amount: { refund: input.amountCents, total: input.originalAmountCents, currency: input.currency },
    }));
    if (!payload.refund_id || !payload.status) throw new AppError('REFUND_PROVIDER_RESPONSE_INVALID', 502, '微信支付未返回退款状态。');
    if (!payload.amount || payload.amount.refund !== input.amountCents || payload.amount.total !== input.originalAmountCents || payload.amount.currency !== input.currency) {
      throw new AppError('REFUND_PROVIDER_AMOUNT_MISMATCH', 502, '微信退款返回金额不一致。');
    }
    return { providerRefundId: payload.refund_id, status: this.refundStatus(payload.status) };
  }

  async queryRefund(input: ProviderRefundRequest): Promise<ProviderRefundResult> {
    const payload = await this.wechatRequest<{
      refund_id?: string; status?: string; code?: string; message?: string;
      amount?: { refund?: number; total?: number; currency?: string };
    }>(
      'GET', `/v3/refund/domestic/refunds/${encodeURIComponent(input.refundReference)}`, '',
    );
    if (!payload.refund_id || !payload.status) throw new AppError('REFUND_PROVIDER_RESPONSE_INVALID', 502, '微信支付未返回退款查询结果。');
    if (!payload.amount || payload.amount.refund !== input.amountCents || payload.amount.total !== input.originalAmountCents || payload.amount.currency !== input.currency) {
      throw new AppError('REFUND_PROVIDER_AMOUNT_MISMATCH', 502, '微信退款查询金额不一致。');
    }
    return { providerRefundId: payload.refund_id, status: this.refundStatus(payload.status) };
  }

  verifyWechatNotification(headers: Record<string, string | undefined>, rawBody: string): VerifiedPaymentEvent {
    const event = this.verifyWechatEnvelope(headers, rawBody);
    const transaction = this.decryptWechatResource<{
      appid?: string; mchid?: string;
      out_trade_no?: string; transaction_id?: string; trade_state?: string; amount?: { total?: number; currency?: string };
    }>(event.resource);
    if (!transaction.out_trade_no || !transaction.transaction_id || !Number.isInteger(transaction.amount?.total)) {
      throw new AppError('PAYMENT_NOTIFICATION_INVALID', 400, '微信支付交易字段不完整。');
    }
    if (transaction.appid !== this.config.WECHAT_APP_ID || transaction.mchid !== this.config.WECHAT_MCH_ID) {
      throw new AppError('PAYMENT_MERCHANT_MISMATCH', 400, '微信支付通知商户身份不匹配。');
    }
    return {
      provider: this.name, eventId: event.id, providerReference: transaction.out_trade_no,
      providerTransactionId: transaction.transaction_id,
      status: transaction.trade_state === 'SUCCESS' ? 'succeeded' : 'failed',
      amountCents: transaction.amount!.total!, currency: transaction.amount?.currency ?? 'CNY',
      payloadDigest: secretHash(rawBody, this.auditPepper),
      normalizedPayload: { eventType: event.event_type ?? null, tradeState: transaction.trade_state ?? 'UNKNOWN' },
    };
  }

  verifyWechatRefundNotification(headers: Record<string, string | undefined>, rawBody: string): VerifiedRefundEvent {
    const event = this.verifyWechatEnvelope(headers, rawBody);
    const refund = this.decryptWechatResource<{
      out_refund_no?: string; refund_id?: string; refund_status?: string;
      amount?: { refund?: number; total?: number; currency?: string };
    }>(event.resource);
    if (!refund.out_refund_no || !refund.refund_id || !Number.isInteger(refund.amount?.refund) || !Number.isInteger(refund.amount?.total)) {
      throw new AppError('REFUND_NOTIFICATION_INVALID', 400, '微信退款通知字段不完整。');
    }
    return {
      provider: this.name, eventId: event.id, refundReference: refund.out_refund_no,
      providerRefundId: refund.refund_id, status: this.refundStatus(refund.refund_status ?? 'ABNORMAL'),
      amountCents: refund.amount!.refund!, originalAmountCents: refund.amount!.total!,
      currency: refund.amount?.currency ?? 'CNY', payloadDigest: secretHash(rawBody, this.auditPepper),
      normalizedPayload: { eventType: event.event_type ?? null, refundStatus: refund.refund_status ?? 'UNKNOWN' },
    };
  }

  private verifyWechatEnvelope(headers: Record<string, string | undefined>, rawBody: string) {
    const timestamp = headers['wechatpay-timestamp'];
    const nonce = headers['wechatpay-nonce'];
    const signature = headers['wechatpay-signature'];
    const serial = headers['wechatpay-serial'];
    if (!timestamp || !nonce || !signature || !serial || serial !== this.config.WECHAT_PLATFORM_CERT_SERIAL) {
      throw new AppError('PAYMENT_SIGNATURE_HEADERS_INVALID', 401, '微信支付通知签名头无效。');
    }
    const notificationAgeSeconds = Date.now() / 1000 - Number(timestamp);
    if (!Number.isFinite(notificationAgeSeconds) || notificationAgeSeconds < -300 || notificationAgeSeconds > 25 * 60 * 60) {
      throw new AppError('PAYMENT_NOTIFICATION_EXPIRED', 401, '微信支付通知时间无效。');
    }
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
    if (!verifier.verify(this.platformCertificate, signature, 'base64')) throw new AppError('PAYMENT_SIGNATURE_INVALID', 401, '微信支付通知验签失败。');
    const event = JSON.parse(rawBody) as {
      id?: string; event_type?: string;
      resource?: { ciphertext?: string; nonce?: string; associated_data?: string };
    };
    if (!event.id || !event.resource?.ciphertext || !event.resource.nonce) throw new AppError('PAYMENT_NOTIFICATION_INVALID', 400, '微信支付通知字段不完整。');
    return {
      id: event.id,
      ...(event.event_type === undefined ? {} : { event_type: event.event_type }),
      resource: {
        ciphertext: event.resource.ciphertext,
        nonce: event.resource.nonce,
        ...(event.resource.associated_data === undefined ? {} : { associated_data: event.resource.associated_data }),
      },
    };
  }

  private decryptWechatResource<T>(resource: { ciphertext: string; nonce: string; associated_data?: string }) {
    const ciphertext = Buffer.from(resource.ciphertext, 'base64');
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.config.WECHAT_API_V3_KEY!), Buffer.from(resource.nonce));
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(resource.associated_data ?? ''));
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')) as T;
  }

  private async wechatRequest<T>(method: 'GET' | 'POST', path: string, body: string, allowedErrorCodes: string[] = []): Promise<T> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const signer = createSign('RSA-SHA256');
    signer.update(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`);
    const signature = signer.sign(this.privateKey, 'base64');
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.WECHAT_MCH_ID}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.config.WECHAT_MERCHANT_CERT_SERIAL}"`;
    const response = await this.fetcher(`https://api.mch.weixin.qq.com${path}`, {
      method, headers: { Authorization: authorization, Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': 'KAI-CloudPay/1.0' },
      ...(method === 'POST' ? { body } : {}), signal: AbortSignal.timeout(10_000),
    });
    const rawBody = await response.text();
    const responseTimestamp = response.headers.get('wechatpay-timestamp');
    const responseNonce = response.headers.get('wechatpay-nonce');
    const responseSignature = response.headers.get('wechatpay-signature');
    const responseSerial = response.headers.get('wechatpay-serial');
    if (!responseTimestamp || !responseNonce || !responseSignature || responseSerial !== this.config.WECHAT_PLATFORM_CERT_SERIAL) {
      throw new AppError('PAYMENT_PROVIDER_SIGNATURE_HEADERS_INVALID', 502, '微信支付响应签名头无效。');
    }
    const responseAge = Math.abs(Date.now() / 1000 - Number(responseTimestamp));
    if (!Number.isFinite(responseAge) || responseAge > 300) throw new AppError('PAYMENT_PROVIDER_RESPONSE_EXPIRED', 502, '微信支付响应时间无效。');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${responseTimestamp}\n${responseNonce}\n${rawBody}\n`);
    if (!verifier.verify(this.platformCertificate, responseSignature, 'base64')) {
      throw new AppError('PAYMENT_PROVIDER_SIGNATURE_INVALID', 502, '微信支付响应验签失败。');
    }
    let payload: T & { message?: string };
    try {
      payload = JSON.parse(rawBody) as T & { message?: string };
    } catch {
      throw new AppError('PAYMENT_PROVIDER_RESPONSE_INVALID', 502, '微信支付返回了无法识别的数据。');
    }
    const errorCode = (payload as { code?: string }).code;
    if (!response.ok && (!errorCode || !allowedErrorCodes.includes(errorCode))) {
      throw new AppError('REFUND_PROVIDER_REJECTED', 502, payload.message || '微信支付服务暂时不可用。');
    }
    return payload;
  }

  private refundStatus(status: string): ProviderRefundResult['status'] {
    if (status === 'SUCCESS') return 'succeeded';
    if (['CLOSED', 'ABNORMAL'].includes(status)) return 'failed';
    return 'pending';
  }
}

export function createPaymentProviders(config: RuntimeConfig) {
  const auditPepper = config.AUDIT_PEPPER;
  const providers = new Map<PaymentProviderName, PaymentProvider>();
  if (!auditPepper) return providers;
  if (config.readiness.capabilities.alipay.available) providers.set('alipay', new AlipayProvider(config, auditPepper));
  if (config.readiness.capabilities.wechat.available) providers.set('wechat', new WechatProvider(config, auditPepper));
  return providers;
}
