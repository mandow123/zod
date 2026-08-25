import { secretHash } from '../account/crypto.js';
import { AppError } from '../errors.js';
import { isIP } from 'node:net';
import {
  parseAndVerifyQixiangNotification, qixiangMd5Signature, type QixiangNotification, type QixiangPaymentType,
} from './qixiang.js';

export const QIXIANG_MERCHANT_ID = '4611';
export const QIXIANG_API_ORIGIN = 'https://api.payqixiang.cn';
export const QIXIANG_NOTIFY_URL = 'https://api.kaicloudpay.com/mobile/v1/credits/topups/qixiang/notify';
export const QIXIANG_RETURN_URL = 'https://api.kaicloudpay.com/payments/qixiang/return';

type QixiangFetch = typeof fetch;

export type QixiangCheckoutRequest = Readonly<{
  providerReference: string;
  paymentType: QixiangPaymentType;
  amountCents: number;
  name: string;
  clientIp: string;
  attemptToken: string;
}>;

export type QixiangCheckoutResult =
  | Readonly<{ providerPaymentId:string;state:'pending';checkoutUrl:string;responseDigest:string }>
  | Readonly<{ state:'ambiguous';responseDigest:string }>;

export type QixiangQueryRequest = Readonly<{
  providerReference: string;
  paymentType: QixiangPaymentType;
  amountCents: number;
  name: string;
  attemptToken: string;
}>;

export type QixiangQueryResult =
  | Readonly<{ state: 'pending'; providerStatus: string; responseDigest: string; normalizedPayload: Record<string, unknown>;
    providerPaymentId?:string;checkoutUrl?:string }>
  | Readonly<{
    state: 'paid'; providerStatus: '1'; providerTransactionId: string; providerReference: string;
    amountCents: number; paymentType: QixiangPaymentType; responseDigest: string;
    normalizedPayload: Record<string, unknown>;
  }>;

export type QixiangRefundResult = Readonly<{
  state: 'pending_confirmation';
  responseCode: 0 | 1;
  responseDigest: string;
}>;

const CREATE_RESPONSE_KEYS = new Set(['code', 'msg', 'trade_no', 'payurl', 'qrcode']);
const QUERY_RESPONSE_KEYS = new Set([
  'code', 'msg', 'trade_no', 'out_trade_no', 'api_trade_no', 'type', 'pid', 'addtime', 'endtime',
  'name', 'money', 'status', 'param', 'buyer', 'bill_trade_no', 'payurl',
]);
const REFUND_RESPONSE_KEYS = new Set(['code', 'msg']);

function exactObject(value: unknown, knownKeys: ReadonlySet<string>, code: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(code, 502, '七相支付返回了无法识别的数据。');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !knownKeys.has(key))) throw new AppError(code, 502, '七相支付返回了未知字段。');
  return result;
}

function stringField(value: unknown, field: string, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AppError('QIXIANG_RESPONSE_INVALID', 502, `七相支付响应字段 ${field} 无效。`);
  }
  return value;
}

function optionalEmptyStringField(value: unknown, field: string, maximum = 512) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AppError('QIXIANG_RESPONSE_INVALID', 502, `七相支付响应字段 ${field} 无效。`);
  }
  return value;
}

function integerCode(value: unknown) {
  if (!Number.isInteger(value)) throw new AppError('QIXIANG_RESPONSE_INVALID', 502, '七相支付响应状态码无效。');
  return value as number;
}

function binaryStatus(value:unknown){if(value===0||value==='0')return 0;if(value===1||value==='1')return 1;
  throw new AppError('QIXIANG_QUERY_RESPONSE_INVALID',502,'七相支付订单状态无效。');}

function amountText(amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('QIXIANG_AMOUNT_INVALID');
  return `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`;
}

function amountCents(value: unknown) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(value)) {
    throw new AppError('QIXIANG_RESPONSE_INVALID', 502, '七相支付响应金额格式无效。');
  }
  const [yuan = '0', cents = '00'] = value.split('.');
  const amount = BigInt(yuan) * 100n + BigInt(cents);
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('QIXIANG_RESPONSE_INVALID', 502, '七相支付响应金额无效。');
  }
  return Number(amount);
}

export function controlledQixiangCheckoutUrl(value: unknown) {
  const raw = stringField(value, 'payurl', 2_048);
  if (!/^https:\/\/api\.payqixiang\.cn\/pay\/submit\/[A-Za-z0-9_-]{1,256}\/$/u.test(raw)) {
    throw new AppError('QIXIANG_CHECKOUT_URL_INVALID', 502, '七相支付收银台地址不在允许范围内。');
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError('QIXIANG_CHECKOUT_URL_INVALID', 502, '七相支付收银台地址无效。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'api.payqixiang.cn' || url.port || url.username || url.password
    || url.search || url.hash || url.pathname.split('/').filter(Boolean).length !== 3) {
    throw new AppError('QIXIANG_CHECKOUT_URL_INVALID', 502, '七相支付收银台地址不在允许范围内。');
  }
  return url.toString();
}

function utf8Length(value: string) { return Buffer.byteLength(value, 'utf8'); }

export class QixiangProvider {
  constructor(
    private readonly merchantKey: string,
    private readonly auditPepper: string,
    private readonly fetcher: QixiangFetch = fetch,
  ) {
    if (!merchantKey || /[\r\n\u0000]/u.test(merchantKey)) throw new Error('QIXIANG_MERCHANT_KEY_INVALID');
    if (!auditPepper) throw new Error('AUDIT_PEPPER_REQUIRED');
  }

  async createCheckout(input: QixiangCheckoutRequest): Promise<QixiangCheckoutResult> {
    this.validateRequest(input);
    const fields = {
      pid: QIXIANG_MERCHANT_ID, type: input.paymentType, out_trade_no: input.providerReference,
      notify_url: QIXIANG_NOTIFY_URL, return_url: QIXIANG_RETURN_URL, name: input.name,
      money: amountText(input.amountCents), clientip: input.clientIp, device: 'jump', param: input.attemptToken,
    };
    const body = new URLSearchParams({ ...fields, sign: qixiangMd5Signature(fields, this.merchantKey), sign_type: 'MD5' }).toString();
    const payload = exactObject(await this.requestJson('/mapi.php', { method: 'POST', body }), CREATE_RESPONSE_KEYS, 'QIXIANG_CREATE_RESPONSE_INVALID');
    const digest = secretHash(JSON.stringify(payload), this.auditPepper);
    const code = integerCode(payload.code);
    optionalEmptyStringField(payload.msg, 'msg', 512);
    if (code !== 1) throw new AppError('QIXIANG_CREATE_REJECTED', 502, '七相支付未创建收银台。');
    const tradeNo = stringField(payload.trade_no, 'trade_no', 80);
    if (input.paymentType === 'alipay' || input.paymentType === 'wxpay') {
      if (payload.payurl === undefined) return { state: 'ambiguous', responseDigest: digest };
      return { providerPaymentId: tradeNo, state: 'pending', checkoutUrl: controlledQixiangCheckoutUrl(payload.payurl), responseDigest: digest };
    }
    throw new Error('QIXIANG_PAYMENT_TYPE_INVALID');
  }

  verifyNotification(rawQuery: string): QixiangNotification {
    return parseAndVerifyQixiangNotification(rawQuery, QIXIANG_MERCHANT_ID, this.merchantKey);
  }

  async queryOrder(input: QixiangQueryRequest): Promise<QixiangQueryResult> {
    this.validateRequest({ ...input, clientIp: '127.0.0.1' });
    const path = `/api.php?act=order&pid=${QIXIANG_MERCHANT_ID}&key=${encodeURIComponent(this.merchantKey)}&out_trade_no=${encodeURIComponent(input.providerReference)}`;
    const payload = exactObject(await this.requestJson(path, { method: 'GET' }), QUERY_RESPONSE_KEYS, 'QIXIANG_QUERY_RESPONSE_INVALID');
    const digest = secretHash(JSON.stringify(payload), this.auditPepper);
    const code = integerCode(payload.code);
    stringField(payload.msg, 'msg', 512);
    if (code !== 1) throw new AppError('QIXIANG_QUERY_REJECTED', 502, '七相支付拒绝了订单查询。');
    const status=binaryStatus(payload.status);
    const returnedPid = payload.pid === 4611 ? '4611' : payload.pid === '4611' ? payload.pid : null;
    const providerReference = stringField(payload.out_trade_no, 'out_trade_no', 48);
    if (returnedPid !== QIXIANG_MERCHANT_ID || providerReference !== input.providerReference) {
      throw new AppError('QIXIANG_QUERY_SNAPSHOT_MISMATCH', 409, '七相支付查询结果与充值快照不一致。');
    }
    if (status === 0) {const normalizedPayload={code:1,status:0,outTradeNo:providerReference,pid:QIXIANG_MERCHANT_ID};
      const recoveryKeys=['trade_no','type','addtime','name','money','param','buyer','payurl'];
      if(!recoveryKeys.every((key)=>Object.hasOwn(payload,key)))return{state:'pending',providerStatus:'0',responseDigest:digest,
        normalizedPayload};
      const providerPaymentId=stringField(payload.trade_no,'trade_no',80);
      const paymentType=payload.type;const returnedName=stringField(payload.name,'name',127);
      const returnedAmount=amountCents(payload.money);this.providerTime(payload.addtime,'addtime');
      const returnedParameter=payload.param===null?null:stringField(payload.param,'param',120);
      if(payload.buyer!==null&&typeof payload.buyer!=='string')throw new AppError('QIXIANG_QUERY_RESPONSE_INVALID',502,
        '七相支付订单查询字段无效。');
      if(payload.bill_trade_no!==undefined&&payload.bill_trade_no!==null&&typeof payload.bill_trade_no!=='string')
        throw new AppError('QIXIANG_QUERY_RESPONSE_INVALID',502,'七相支付订单查询字段无效。');
      if(paymentType!==input.paymentType||returnedName!==input.name||returnedAmount!==input.amountCents
        ||returnedParameter!==input.attemptToken)throw new AppError('QIXIANG_QUERY_SNAPSHOT_MISMATCH',409,
        '七相支付查询结果与充值快照不一致。');
      const checkoutUrl=payload.payurl===null
        ?controlledQixiangCheckoutUrl(`${QIXIANG_API_ORIGIN}/pay/submit/${providerPaymentId}/`)
        :controlledQixiangCheckoutUrl(payload.payurl);
      return{state:'pending',providerStatus:'0',responseDigest:digest,normalizedPayload,providerPaymentId,checkoutUrl};}
    const providerTransactionId = stringField(payload.trade_no, 'trade_no', 80);
    const apiTradeNo = stringField(payload.api_trade_no, 'api_trade_no', 160);
    const addTime = this.providerTime(payload.addtime, 'addtime');
    const endTime = this.providerTime(payload.endtime, 'endtime');
    const paymentType = payload.type;
    const returnedAmount = amountCents(payload.money);
    const returnedName = stringField(payload.name, 'name', 127);
    if (!Object.hasOwn(payload, 'param') || !Object.hasOwn(payload, 'buyer')) {
      throw new AppError('QIXIANG_QUERY_RESPONSE_INVALID', 502, '七相支付订单查询字段不完整。');
    }
    const returnedParameter = payload.param === null ? null : stringField(payload.param, 'param', 120);
    if (payload.buyer !== null && typeof payload.buyer !== 'string') {
      throw new AppError('QIXIANG_QUERY_RESPONSE_INVALID', 502, '七相支付订单查询字段无效。');
    }
    if (paymentType !== input.paymentType || returnedAmount !== input.amountCents
      || returnedName !== input.name || returnedParameter !== input.attemptToken) {
      throw new AppError('QIXIANG_QUERY_SNAPSHOT_MISMATCH', 409, '七相支付查询结果与充值快照不一致。');
    }
    return {
      state: 'paid', providerStatus: '1', providerTransactionId, providerReference, amountCents: returnedAmount,
      paymentType: input.paymentType, responseDigest: digest,
      normalizedPayload: {
        code: 1, status: 1, tradeNo: providerTransactionId, outTradeNo: providerReference,
        apiTradeNo, type: input.paymentType, pid: QIXIANG_MERCHANT_ID, addTime, endTime,
      },
    };
  }

  async requestRefund(input: Readonly<{ providerReference: string; amountCents: number }>): Promise<QixiangRefundResult> {
    if (!/^[A-Z0-9]{20,48}$/u.test(input.providerReference)) throw new Error('QIXIANG_PROVIDER_REFERENCE_INVALID');
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 100 || input.amountCents > 4_999_999) {
      throw new Error('QIXIANG_REFUND_AMOUNT_INVALID');
    }
    const body = new URLSearchParams({ pid: QIXIANG_MERCHANT_ID, key: this.merchantKey,
      out_trade_no: input.providerReference, money: amountText(input.amountCents) }).toString();
    const payload = exactObject(await this.requestJson('/api.php?act=refund', { method: 'POST', body }), REFUND_RESPONSE_KEYS,
      'QIXIANG_REFUND_RESPONSE_INVALID');
    const code = integerCode(payload.code);
    optionalEmptyStringField(payload.msg, 'msg', 512);
    if (code !== 0 && code !== 1) throw new AppError('QIXIANG_REFUND_REJECTED', 502, '七相支付拒绝了退款请求。');
    return { state: 'pending_confirmation', responseCode: code, responseDigest: secretHash(JSON.stringify(payload), this.auditPepper) };
  }

  private async requestJson(path: string, input: Readonly<{ method: 'GET' | 'POST'; body?: string }>) {
    let response: Response;
    try {
      response = await this.fetcher(`${QIXIANG_API_ORIGIN}${path}`, {
        method: input.method, redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json', 'User-Agent': 'KAI-CloudPay/1.0',
          ...(input.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}) },
        ...(input.body === undefined ? {} : { body: input.body }),
      });
    } catch {
      throw new AppError('QIXIANG_NETWORK_ERROR', 502, '七相支付服务暂时无法连接。');
    }
    if (response.status >= 300 && response.status < 400) throw new AppError('QIXIANG_REDIRECT_REJECTED', 502, '七相支付返回了未允许的跳转。');
    if (!response.ok) throw new AppError('QIXIANG_HTTP_ERROR', 502, '七相支付服务返回失败。');
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/json')) throw new AppError('QIXIANG_RESPONSE_INVALID', 502, '七相支付响应类型无效。');
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > 32_768) throw new AppError('QIXIANG_RESPONSE_INVALID', 502, '七相支付响应过长。');
    try { return JSON.parse(raw) as unknown; } catch { throw new AppError('QIXIANG_RESPONSE_INVALID', 502, '七相支付返回了无法识别的数据。'); }
  }

  private validateRequest(input: QixiangQueryRequest & { clientIp?: string }) {
    if (!/^[A-Z0-9]{20,48}$/u.test(input.providerReference)) throw new Error('QIXIANG_PROVIDER_REFERENCE_INVALID');
    if (input.paymentType !== 'alipay' && input.paymentType !== 'wxpay') throw new Error('QIXIANG_PAYMENT_TYPE_INVALID');
    if (!input.name || utf8Length(input.name) > 127 || /[\u0000-\u001f\u007f]/u.test(input.name)) {
      throw new Error('QIXIANG_PRODUCT_NAME_INVALID');
    }
    if (!/^[A-Za-z0-9_-]{16,120}$/u.test(input.attemptToken)) throw new Error('QIXIANG_ATTEMPT_TOKEN_INVALID');
    if ('clientIp' in input && input.clientIp !== undefined && isIP(input.clientIp) === 0) throw new Error('QIXIANG_CLIENT_IP_INVALID');
    amountText(input.amountCents);
  }

  private providerTime(value: unknown, field: string) {
    const result = stringField(value, field, 19);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(result)) {
      throw new AppError('QIXIANG_QUERY_RESPONSE_INVALID', 502, `七相支付响应字段 ${field} 无效。`);
    }
    return result;
  }
}
