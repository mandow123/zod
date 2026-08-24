import { describe, expect, it } from 'vitest';
import {
  parseAndVerifyQixiangNotification, qixiangCanonicalText, qixiangMd5Signature,
  verifyQixiangMd5Signature,
} from '../src/payment/qixiang.js';

const testKey = 'TESTKEY';

describe('qixiang strict MD5 protocol boundary', () => {
  it('sorts ASCII parameter names, omits empty and signature fields, and appends the key without URL encoding', () => {
    const fields = { pid: '1000', out_trade_no: 'ORDER1', money: '1.00', name: '', sign: 'ignored', sign_type: 'MD5' };
    expect(qixiangCanonicalText(fields, testKey)).toBe('money=1.00&out_trade_no=ORDER1&pid=1000TESTKEY');
    expect(qixiangMd5Signature(fields, testKey)).toBe('1a187c63a491211ed58fc8ee6d8c89bc');
    expect(verifyQixiangMd5Signature(fields, testKey, '1A187C63A491211ED58FC8EE6D8C89BC')).toBe(false);
    expect(verifyQixiangMd5Signature(fields, testKey, 'not-a-digest')).toBe(false);
  });

  it('accepts only one strict, signed success notification', () => {
    const fields = {
      pid: 'merchant-test', trade_no: 'QX-TRANSACTION-1', out_trade_no: 'KCT20260821123456789012', type: 'alipay',
      money: '12.30', trade_status: 'TRADE_SUCCESS', param: 'opaque-state', sign_type: 'MD5',
    };
    const sign = qixiangMd5Signature(fields, testKey);
    const raw = new URLSearchParams({ ...fields, sign }).toString();
    expect(parseAndVerifyQixiangNotification(raw, 'merchant-test', testKey)).toMatchObject({
      merchantId: 'merchant-test', providerTransactionId: 'QX-TRANSACTION-1', providerReference: 'KCT20260821123456789012',
      paymentType: 'alipay', amountCents: 1230, tradeStatus: 'TRADE_SUCCESS', passthrough: 'opaque-state',
    });
  });

  it.each([
    'pid=merchant-test&pid=other&trade_no=1&out_trade_no=2&type=alipay&money=1.00&trade_status=TRADE_SUCCESS&sign_type=MD5&sign=00000000000000000000000000000000',
    'pid=merchant-test&trade_no=1&out_trade_no=2&type=alipay&money=1.00&trade_status=TRADE_SUCCESS&unknown=x&sign_type=MD5&sign=00000000000000000000000000000000',
    'pid=merchant-test&trade_no=1&out_trade_no=2&type=alipay&money=1.00&trade_status=TRADE_SUCCESS&name=%ZZ&sign_type=MD5&sign=00000000000000000000000000000000',
  ])('rejects duplicate, unknown, or malformed query data before processing: %s', (raw) => {
    expect(() => parseAndVerifyQixiangNotification(raw, 'merchant-test', testKey)).toThrow();
  });

  it('rejects a validly signed non-success status and merchant mismatch', () => {
    const fields = { pid: 'merchant-test', trade_no: 'QX-1', out_trade_no: 'KCT20260821123456789012', type: 'wxpay', money: '1.00',
      trade_status: 'WAIT_BUYER_PAY', sign_type: 'MD5' };
    const raw = new URLSearchParams({ ...fields, sign: qixiangMd5Signature(fields, testKey) }).toString();
    expect(() => parseAndVerifyQixiangNotification(raw, 'merchant-test', testKey)).toThrowError(/尚未确认成功/u);
    expect(() => parseAndVerifyQixiangNotification(raw, 'other-merchant', testKey)).toThrowError(/商户身份不匹配/u);
  });

  it('enforces UTF-8 byte limits rather than JavaScript character counts', () => {
    const fields = { pid: 'merchant-test', trade_no: 'QX-1', out_trade_no: 'KCT20260821123456789012', type: 'wxpay',
      name: '算'.repeat(43), money: '1.00', trade_status: 'TRADE_SUCCESS', sign_type: 'MD5' };
    const raw = new URLSearchParams({ ...fields, sign: qixiangMd5Signature(fields, testKey) }).toString();
    expect(() => parseAndVerifyQixiangNotification(raw, 'merchant-test', testKey)).toThrowError(/name/u);
  });
});
