import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

const SIGNATURE_KEYS = new Set(['sign', 'sign_type']);
const NOTIFICATION_KEYS = new Set([
  'pid', 'trade_no', 'out_trade_no', 'type', 'name', 'money', 'trade_status', 'param', 'sign', 'sign_type',
]);
const REQUIRED_NOTIFICATION_KEYS = [
  'pid', 'trade_no', 'out_trade_no', 'type', 'money', 'trade_status', 'sign', 'sign_type',
] as const;

export type QixiangPaymentType = 'alipay' | 'wxpay';

export type QixiangNotification = Readonly<{
  merchantId: string;
  providerTransactionId: string;
  providerReference: string;
  paymentType: QixiangPaymentType;
  name: string | null;
  amountCents: number;
  tradeStatus: 'TRADE_SUCCESS';
  passthrough: string | null;
  signature: string;
  signatureType: 'MD5';
  normalizedPayloadWithoutSign: Readonly<Record<string, string>>;
}>;

function safeText(value: string, field: string, maximum: number) {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AppError('QIXIANG_NOTIFICATION_INVALID', 400, `七相支付通知字段 ${field} 无效。`);
  }
  return value;
}

function decodeQueryComponent(value: string) {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    throw new AppError('QIXIANG_NOTIFICATION_INVALID', 400, '七相支付通知编码无效。');
  }
}

function parseUniqueQuery(rawQuery: string) {
  const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  if (query.length === 0 || Buffer.byteLength(query, 'utf8') > 8_192) {
    throw new AppError('QIXIANG_NOTIFICATION_INVALID', 400, '七相支付通知参数为空或过长。');
  }
  const parameters: Record<string, string> = {};
  for (const part of query.split('&')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || separator !== part.lastIndexOf('=')) {
      throw new AppError('QIXIANG_NOTIFICATION_INVALID', 400, '七相支付通知参数格式无效。');
    }
    const key = decodeQueryComponent(part.slice(0, separator));
    const value = decodeQueryComponent(part.slice(separator + 1));
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || !NOTIFICATION_KEYS.has(key) || Object.hasOwn(parameters, key)) {
      throw new AppError('QIXIANG_NOTIFICATION_INVALID', 400, '七相支付通知含重复或未知字段。');
    }
    parameters[key] = value;
  }
  for (const key of REQUIRED_NOTIFICATION_KEYS) {
    if (!Object.hasOwn(parameters, key) || parameters[key] === '') {
      throw new AppError('QIXIANG_NOTIFICATION_INVALID', 400, `七相支付通知缺少字段 ${key}。`);
    }
  }
  return parameters;
}

export function qixiangCanonicalText(parameters: Readonly<Record<string, string | null | undefined>>, merchantKey: string) {
  if (merchantKey.length === 0) throw new Error('QIXIANG_MERCHANT_KEY_REQUIRED');
  const names = Object.keys(parameters).filter((name) => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name)) throw new Error('QIXIANG_PARAMETER_NAME_INVALID');
    return !SIGNATURE_KEYS.has(name) && parameters[name] !== undefined && parameters[name] !== null && parameters[name] !== '';
  }).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return `${names.map((name) => `${name}=${parameters[name]}`).join('&')}${merchantKey}`;
}

export function qixiangMd5Signature(
  parameters: Readonly<Record<string, string | null | undefined>>,
  merchantKey: string,
) {
  return createHash('md5').update(qixiangCanonicalText(parameters, merchantKey), 'utf8').digest('hex');
}

export function verifyQixiangMd5Signature(
  parameters: Readonly<Record<string, string | null | undefined>>,
  merchantKey: string,
  receivedSignature: string,
) {
  if (!/^[0-9a-f]{32}$/u.test(receivedSignature)) return false;
  const expected = Buffer.from(qixiangMd5Signature(parameters, merchantKey), 'hex');
  const received = Buffer.from(receivedSignature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function moneyToCents(value: string) {
  if (!/^(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(value)) {
    throw new AppError('QIXIANG_NOTIFICATION_INVALID', 400, '七相支付通知金额格式无效。');
  }
  const [yuan = '0', cents = '00'] = value.split('.');
  const amount = BigInt(yuan) * 100n + BigInt(cents);
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('QIXIANG_NOTIFICATION_INVALID', 400, '七相支付通知金额无效。');
  }
  return Number(amount);
}

export function parseAndVerifyQixiangNotification(
  rawQuery: string,
  expectedMerchantId: string,
  merchantKey: string,
): QixiangNotification {
  const parameters = parseUniqueQuery(rawQuery);
  if (parameters.pid !== expectedMerchantId) {
    throw new AppError('PAYMENT_MERCHANT_MISMATCH', 400, '七相支付通知商户身份不匹配。');
  }
  if (parameters.sign_type !== 'MD5') {
    throw new AppError('PAYMENT_SIGNATURE_INVALID', 401, '七相支付通知签名类型无效。');
  }
  if (!verifyQixiangMd5Signature(parameters, merchantKey, parameters.sign!)) {
    throw new AppError('PAYMENT_SIGNATURE_INVALID', 401, '七相支付通知验签失败。');
  }
  if (parameters.trade_status !== 'TRADE_SUCCESS') {
    throw new AppError('QIXIANG_TRADE_STATUS_UNCONFIRMED', 409, '七相支付尚未确认成功。');
  }
  if (parameters.type !== 'alipay' && parameters.type !== 'wxpay') {
    throw new AppError('QIXIANG_NOTIFICATION_INVALID', 400, '七相支付通知渠道类型无效。');
  }
  return {
    merchantId: safeText(parameters.pid!, 'pid', 160),
    providerTransactionId: safeText(parameters.trade_no!, 'trade_no', 80),
    providerReference: (() => {
      const value = safeText(parameters.out_trade_no!, 'out_trade_no', 48);
      if (!/^[A-Z0-9]{20,48}$/u.test(value)) throw new AppError('QIXIANG_NOTIFICATION_INVALID', 400, '七相支付通知订单号无效。');
      return value;
    })(),
    paymentType: parameters.type,
    name: parameters.name ? safeText(parameters.name, 'name', 127) : null,
    amountCents: moneyToCents(parameters.money!),
    tradeStatus: 'TRADE_SUCCESS',
    passthrough: parameters.param ? safeText(parameters.param, 'param', 120) : null,
    signature: parameters.sign!,
    signatureType: 'MD5',
    normalizedPayloadWithoutSign: Object.freeze(Object.fromEntries(
      Object.entries(parameters).filter(([key]) => !SIGNATURE_KEYS.has(key)),
    )),
  };
}
