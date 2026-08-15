import {
  createCipheriv, createSign, generateKeyPairSync, randomUUID,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AccountStore } from '../src/account/store.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import { AlipayProvider, WechatProvider, type CheckoutRequest, type PaymentProvider } from '../src/payment/providers.js';
import { PaymentService } from '../src/payment/service.js';
import type { PaymentStore, PreparePaymentResult } from '../src/payment/store.js';
import type {
  PaymentChannel, PaymentEventResult, PaymentIntentRecord, PaymentProviderName, ProviderCheckout, VerifiedPaymentEvent,
} from '../src/payment/types.js';

const now = new Date('2026-08-11T15:00:00.000Z');
const principal: AccountPrincipal = { userId: randomUUID(), sessionId: randomUUID(), role: 'member' };
const baseEnvironment = {
  NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://api.cloudpay.kai.com', DATABASE_URL: 'postgresql://test/cloudpay',
  ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32),
  AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'e'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
} as const;
const config = loadConfig(baseEnvironment);

class MemoryPaymentStore implements PaymentStore {
  intent: PaymentIntentRecord | null = null;
  applied: VerifiedPaymentEvent[] = [];

  async prepareIntent(input: {
    id: string; providerReference: string; buyerId: string; orderId: string; provider: PaymentProviderName; channel: PaymentChannel;
  }): Promise<PreparePaymentResult> {
    if (!this.intent) {
      this.intent = {
        id: input.id, orderId: input.orderId, orderNumber: 'CP20260811A1', buyerId: input.buyerId,
        provider: input.provider, providerReference: input.providerReference, providerPaymentId: null,
        channel: input.channel, status: 'created', amountCents: 12800, currency: 'CNY', checkoutPayload: null,
        expiresAt: new Date(now.getTime() + 15 * 60_000), reconciliationAttempts: 0,
        lastReconciledAt: null, reconciliationDeadLetteredAt: null, createdAt: now, updatedAt: now,
      };
    }
    return { status: 'ready', intent: this.intent };
  }
  async saveCheckout(intentId: string, checkout: ProviderCheckout) {
    if (!this.intent || this.intent.id !== intentId) return null;
    this.intent = { ...this.intent, status: 'pending', providerPaymentId: checkout.providerPaymentId, checkoutPayload: checkout.checkoutPayload };
    return this.intent;
  }
  async failCheckout(intentId: string) {
    if (this.intent?.id === intentId) this.intent = { ...this.intent, status: 'failed' };
  }
  async getForBuyer(buyerId: string, orderId: string) {
    return this.intent?.buyerId === buyerId && this.intent.orderId === orderId ? this.intent : null;
  }
  async applyVerifiedEvent(event: VerifiedPaymentEvent): Promise<PaymentEventResult> {
    this.applied.push(event);
    return 'succeeded';
  }
}

class FakeProvider implements PaymentProvider {
  calls: CheckoutRequest[] = [];
  constructor(readonly name: PaymentProviderName) {}
  async createCheckout(input: CheckoutRequest) {
    this.calls.push(input);
    return { providerPaymentId: 'provider-payment-1', checkoutPayload: 'signed-checkout-payload' };
  }
}

function rsaPair() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('payment checkout safety', () => {
  it('reuses a pending checkout and never creates a second provider payment on repeated taps', async () => {
    const store = new MemoryPaymentStore();
    const provider = new FakeProvider('wechat');
    const audits: string[] = [];
    const accounts = { recordAudit: async (input: { action: string }) => { audits.push(input.action); } } as unknown as AccountStore;
    const service = new PaymentService(store, accounts, new Map([['wechat', provider]]), config, () => now);
    const orderId = randomUUID();
    const first = await service.createCheckout(principal, { orderId, provider: 'wechat', channel: 'app' }, { requestId: 'pay-1', ip: '203.0.113.9' });
    const repeated = await service.createCheckout(principal, { orderId, provider: 'wechat', channel: 'app' }, { requestId: 'pay-2', ip: '203.0.113.9' });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.clientIp).toBe('203.0.113.9');
    expect(repeated.id).toBe(first.id);
    expect(repeated.checkoutPayload).toBe('signed-checkout-payload');
    expect(audits).toEqual(['PAYMENT_CHECKOUT_CREATED', 'PAYMENT_CHECKOUT_CREATED']);
  });

  it('fails closed instead of presenting a fake checkout when a provider is not configured', async () => {
    const store = new MemoryPaymentStore();
    const service = new PaymentService(store, {} as AccountStore, new Map(), config, () => now);
    await expect(service.createCheckout(principal, {
      orderId: randomUUID(), provider: 'alipay', channel: 'app',
    }, { requestId: 'pay-unavailable', ip: '203.0.113.9' })).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
    expect(store.intent).toBeNull();
  });
});

describe('provider notification verification', () => {
  it('actively queries a signed WeChat transaction after the app or callback is interrupted', async () => {
    const merchant = rsaPair();
    const platform = rsaPair();
    const requests: string[] = [];
    const wechatConfig = loadConfig({
      ...baseEnvironment,
      WECHAT_APP_ID: 'wx-app', WECHAT_MCH_ID: 'merchant-id', WECHAT_API_V3_KEY: '0'.repeat(32),
      WECHAT_PRIVATE_KEY: merchant.privateKey, WECHAT_MERCHANT_CERT_SERIAL: 'merchant-serial',
      WECHAT_PLATFORM_CERT_SERIAL: 'platform-serial', WECHAT_NOTIFY_URL: 'https://api.cloudpay.kai.com/mobile/v1/payments/wechat/notify',
      WECHAT_REFUND_NOTIFY_URL: 'https://api.cloudpay.kai.com/mobile/v1/payments/wechat/refund-notify',
      WECHAT_PLATFORM_CERTIFICATE: platform.publicKey,
    });
    const fetcher = (async (url: string | URL | Request) => {
      requests.push(String(url));
      const missing = String(url).includes('KP-MISSING');
      const body = JSON.stringify(missing
        ? { code: 'ORDERNOTEXIST', message: 'order does not exist' }
        : { appid: 'wx-app', mchid: 'merchant-id', transaction_id: 'WX-QUERY-TX-01', trade_state: 'SUCCESS', amount: { total: 12800, currency: 'CNY' } });
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = 'query-response-nonce';
      const signer = createSign('RSA-SHA256');
      signer.update(`${timestamp}\n${nonce}\n${body}\n`);
      return new Response(body, { status: missing ? 404 : 200, headers: {
        'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce,
        'wechatpay-signature': signer.sign(platform.privateKey, 'base64'), 'wechatpay-serial': 'platform-serial',
      } });
    }) as typeof fetch;
    const provider = new WechatProvider(wechatConfig, 'd'.repeat(32), fetcher);
    await expect(provider.queryPayment({
      providerReference: 'KP-QUERY-01', expectedAmountCents: 12800, currency: 'CNY',
    })).resolves.toMatchObject({
      status: 'settled', event: {
        providerReference: 'KP-QUERY-01', providerTransactionId: 'WX-QUERY-TX-01', status: 'succeeded', amountCents: 12800,
      },
    });
    expect(requests[0]).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/KP-QUERY-01?mchid=merchant-id');
    await expect(provider.queryPayment({
      providerReference: 'KP-MISSING', expectedAmountCents: 12800, currency: 'CNY',
    })).resolves.toMatchObject({ status: 'pending', providerStatus: 'ORDERNOTEXIST' });
  });

  it('maps an RSA-verified Alipay trade query into the same recovery event', async () => {
    const merchant = rsaPair();
    const alipay = rsaPair();
    const alipayConfig = loadConfig({
      ...baseEnvironment,
      ALIPAY_APP_ID: '202600000000001', ALIPAY_PRIVATE_KEY: merchant.privateKey, ALIPAY_PUBLIC_KEY: alipay.publicKey,
      ALIPAY_SELLER_ID: '208800000000001',
      ALIPAY_NOTIFY_URL: 'https://api.cloudpay.kai.com/mobile/v1/payments/alipay/notify',
      ALIPAY_RETURN_URL: 'https://cloudpay.kai.com/payment/result',
    });
    const provider = new AlipayProvider(alipayConfig, 'd'.repeat(32));
    (provider as unknown as { sdk: { exec: () => Promise<Record<string, string>> } }).sdk = {
      exec: async () => ({ code: '10000', tradeStatus: 'TRADE_SUCCESS', tradeNo: 'ALI-QUERY-TX-01', totalAmount: '128.00', sellerUserId: '208800000000001' }),
    };
    await expect(provider.queryPayment({
      providerReference: 'KP-ALI-QUERY-01', expectedAmountCents: 12800, currency: 'CNY',
    })).resolves.toMatchObject({
      status: 'settled', event: {
        providerReference: 'KP-ALI-QUERY-01', providerTransactionId: 'ALI-QUERY-TX-01', status: 'succeeded', amountCents: 12800,
      },
    });
    (provider as unknown as { sdk: { exec: () => Promise<Record<string, string>> } }).sdk = {
      exec: async () => ({ code: '10000', tradeStatus: 'TRADE_SUCCESS', tradeNo: 'ALI-WRONG-SELLER', totalAmount: '128.00', sellerUserId: 'wrong-seller' }),
    };
    await expect(provider.queryPayment({
      providerReference: 'KP-ALI-WRONG-SELLER', expectedAmountCents: 12800, currency: 'CNY',
    })).rejects.toMatchObject({ code: 'PAYMENT_MERCHANT_MISMATCH' });
  });

  it('sends an idempotent WeChat refund reference, original amount, and dedicated callback URL', async () => {
    const merchant = rsaPair();
    const platform = rsaPair();
    const requests: Array<{ url: string; body: string }> = [];
    const wechatConfig = loadConfig({
      ...baseEnvironment,
      WECHAT_APP_ID: 'wx-app', WECHAT_MCH_ID: 'merchant-id', WECHAT_API_V3_KEY: '0'.repeat(32),
      WECHAT_PRIVATE_KEY: merchant.privateKey, WECHAT_MERCHANT_CERT_SERIAL: 'merchant-serial',
      WECHAT_PLATFORM_CERT_SERIAL: 'platform-serial', WECHAT_NOTIFY_URL: 'https://api.cloudpay.kai.com/mobile/v1/payments/wechat/notify',
      WECHAT_REFUND_NOTIFY_URL: 'https://api.cloudpay.kai.com/mobile/v1/payments/wechat/refund-notify',
      WECHAT_PLATFORM_CERTIFICATE: platform.publicKey,
    });
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body ?? '') });
      const body = JSON.stringify({
        refund_id: 'WX-REFUND-API-01', status: 'PROCESSING',
        amount: { refund: 5000, total: 12800, currency: 'CNY' },
      });
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = 'response-nonce';
      const signer = createSign('RSA-SHA256');
      signer.update(`${timestamp}\n${nonce}\n${body}\n`);
      return new Response(body, {
        status: 200, headers: {
          'content-type': 'application/json', 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce,
          'wechatpay-signature': signer.sign(platform.privateKey, 'base64'), 'wechatpay-serial': 'platform-serial',
        },
      });
    }) as typeof fetch;
    const provider = new WechatProvider(wechatConfig, 'd'.repeat(32), fetcher);
    await expect(provider.executeRefund({
      refundReference: '00000000-0000-4000-8000-000000000002', providerReference: 'KP-ORIGINAL-02',
      amountCents: 5000, originalAmountCents: 12800, currency: 'CNY', reason: '服务未达到承诺标准',
    })).resolves.toEqual({ providerRefundId: 'WX-REFUND-API-01', status: 'pending' });
    expect(requests[0]?.url).toBe('https://api.mch.weixin.qq.com/v3/refund/domestic/refunds');
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      out_trade_no: 'KP-ORIGINAL-02', out_refund_no: '00000000-0000-4000-8000-000000000002',
      notify_url: 'https://api.cloudpay.kai.com/mobile/v1/payments/wechat/refund-notify',
      amount: { refund: 5000, total: 12800, currency: 'CNY' },
    });
    const unsignedProvider = new WechatProvider(wechatConfig, 'd'.repeat(32), (async () => new Response(JSON.stringify({
      refund_id: 'UNTRUSTED', status: 'SUCCESS', amount: { refund: 5000, total: 12800, currency: 'CNY' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch);
    await expect(unsignedProvider.executeRefund({
      refundReference: '00000000-0000-4000-8000-000000000002', providerReference: 'KP-ORIGINAL-02',
      amountCents: 5000, originalAmountCents: 12800, currency: 'CNY', reason: '服务未达到承诺标准',
    })).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_SIGNATURE_HEADERS_INVALID' });
  });

  it('verifies and decrypts a WeChat Pay v3 callback and rejects a modified body', () => {
    const merchant = rsaPair();
    const platform = rsaPair();
    const apiV3Key = '0123456789abcdef0123456789abcdef';
    const wechatConfig = loadConfig({
      ...baseEnvironment,
      WECHAT_APP_ID: 'wx-app', WECHAT_MCH_ID: 'merchant-id', WECHAT_API_V3_KEY: apiV3Key,
      WECHAT_PRIVATE_KEY: merchant.privateKey, WECHAT_MERCHANT_CERT_SERIAL: 'merchant-serial',
      WECHAT_PLATFORM_CERT_SERIAL: 'platform-serial', WECHAT_NOTIFY_URL: 'https://api.cloudpay.kai.com/mobile/v1/payments/wechat/notify',
      WECHAT_REFUND_NOTIFY_URL: 'https://api.cloudpay.kai.com/mobile/v1/payments/wechat/refund-notify',
      WECHAT_PLATFORM_CERTIFICATE: platform.publicKey,
    });
    const transaction = JSON.stringify({
      appid: 'wx-app', mchid: 'merchant-id',
      out_trade_no: 'KPREFERENCE01', transaction_id: 'WXTRANSACTION01', trade_state: 'SUCCESS',
      amount: { total: 12800, currency: 'CNY' },
    });
    const resourceNonce = '0123456789ab';
    const associatedData = 'transaction';
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(resourceNonce));
    cipher.setAAD(Buffer.from(associatedData));
    const ciphertext = Buffer.concat([cipher.update(transaction), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const rawBody = JSON.stringify({
      id: 'EVENT-01', event_type: 'TRANSACTION.SUCCESS',
      resource: { ciphertext, nonce: resourceNonce, associated_data: associatedData },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const notificationNonce = 'callback-nonce';
    const signer = createSign('RSA-SHA256');
    signer.update(`${timestamp}\n${notificationNonce}\n${rawBody}\n`);
    const headers = {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': notificationNonce,
      'wechatpay-signature': signer.sign(platform.privateKey, 'base64'),
      'wechatpay-serial': 'platform-serial',
    };
    const provider = new WechatProvider(wechatConfig, 'd'.repeat(32));
    expect(provider.verifyWechatNotification(headers, rawBody)).toMatchObject({
      provider: 'wechat', eventId: 'EVENT-01', providerReference: 'KPREFERENCE01', amountCents: 12800, status: 'succeeded',
    });
    expect(() => provider.verifyWechatNotification(headers, `${rawBody} `)).toThrowError();

    const refundPlaintext = JSON.stringify({
      out_refund_no: '00000000-0000-4000-8000-000000000001', refund_id: 'WXREFUND01', refund_status: 'SUCCESS',
      amount: { refund: 5000, total: 12800, currency: 'CNY' },
    });
    const refundNonce = 'abcdef012345';
    const refundCipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(refundNonce));
    refundCipher.setAAD(Buffer.from(associatedData));
    const refundCiphertext = Buffer.concat([
      refundCipher.update(refundPlaintext), refundCipher.final(), refundCipher.getAuthTag(),
    ]).toString('base64');
    const refundRawBody = JSON.stringify({
      id: 'REFUND-EVENT-01', event_type: 'REFUND.SUCCESS',
      resource: { ciphertext: refundCiphertext, nonce: refundNonce, associated_data: associatedData },
    });
    const refundSigner = createSign('RSA-SHA256');
    refundSigner.update(`${timestamp}\n${notificationNonce}\n${refundRawBody}\n`);
    const refundHeaders = { ...headers, 'wechatpay-signature': refundSigner.sign(platform.privateKey, 'base64') };
    expect(provider.verifyWechatRefundNotification(refundHeaders, refundRawBody)).toMatchObject({
      provider: 'wechat', eventId: 'REFUND-EVENT-01', refundReference: '00000000-0000-4000-8000-000000000001',
      providerRefundId: 'WXREFUND01', amountCents: 5000, originalAmountCents: 12800, status: 'succeeded',
    });
  });

  it('checks Alipay RSA2 signatures before accepting success and amount', () => {
    const merchant = rsaPair();
    const alipay = rsaPair();
    const alipayConfig = loadConfig({
      ...baseEnvironment,
      ALIPAY_APP_ID: '202600000000001', ALIPAY_PRIVATE_KEY: merchant.privateKey, ALIPAY_PUBLIC_KEY: alipay.publicKey,
      ALIPAY_SELLER_ID: '208800000000001',
      ALIPAY_NOTIFY_URL: 'https://api.cloudpay.kai.com/mobile/v1/payments/alipay/notify',
      ALIPAY_RETURN_URL: 'https://cloudpay.kai.com/payment/result',
    });
    const payload: Record<string, string> = {
      app_id: '202600000000001', seller_id: '208800000000001', out_trade_no: 'KPREFERENCE02', trade_no: 'ALIPAYTRANSACTION01',
      trade_status: 'TRADE_SUCCESS', total_amount: '128.00', notify_id: 'NOTIFY-02', sign_type: 'RSA2',
    };
    const content = Object.keys(payload).sort().map((key) => `${key}=${payload[key]}`).join('&');
    const signer = createSign('RSA-SHA256');
    signer.update(content, 'utf8');
    payload.sign = signer.sign(alipay.privateKey, 'base64');
    const provider = new AlipayProvider(alipayConfig, 'd'.repeat(32));
    expect(provider.verifyAlipayNotification(payload)).toMatchObject({
      provider: 'alipay', providerReference: 'KPREFERENCE02', amountCents: 12800, status: 'succeeded',
    });
    expect(() => provider.verifyAlipayNotification({ ...payload, total_amount: '1.00' })).toThrowError();
  });
});
