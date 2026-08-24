import { describe, expect, it, vi } from 'vitest';
import { QixiangProvider } from '../src/payment/qixiang-provider.js';

const key = 'TEST_ONLY_QIXIANG_KEY';
const pepper = 'p'.repeat(32);
const base = { providerReference: 'KCT20260821123456789012', paymentType: 'alipay' as const,
  amountCents: 1230, name: '算力服务卡时权益（364天） KCT2026', clientIp: '203.0.113.9', attemptToken: 'opaque-attempt-001' };

function json(payload: unknown, status = 200, headers: Record<string,string> = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('QixiangProvider transport boundary', () => {
  it('creates only a jump checkout using the exact endpoint and encoded form after signing', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ code: 1, msg: 'ok', trade_no: 'QX-1', payurl: 'https://api.payqixiang.cn/pay/submit/opaque_1/' }));
    const provider = new QixiangProvider(key, pepper, fetcher);
    await expect(provider.createCheckout(base)).resolves.toMatchObject({ providerPaymentId: 'QX-1', state: 'pending' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.payqixiang.cn/mapi.php');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    const form = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(form)).toMatchObject({ pid: '4611', type: 'alipay', device: 'jump',
      out_trade_no: base.providerReference, money: '12.30', sign_type: 'MD5' });
    expect(form.get('sign')).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('fails closed on redirects, unknown response fields and off-origin checkout URLs', async () => {
    const redirect = new QixiangProvider(key, pepper, vi.fn(async () => new Response('', { status: 302 })) as typeof fetch);
    await expect(redirect.createCheckout(base)).rejects.toMatchObject({ code: 'QIXIANG_REDIRECT_REJECTED' });
    const unknown = new QixiangProvider(key, pepper, vi.fn(async () => json({ code: 1, msg: 'ok', trade_no: 'QX', payurl: 'https://api.payqixiang.cn/pay/submit/opaque/', extra: true })) as typeof fetch);
    await expect(unknown.createCheckout(base)).rejects.toMatchObject({ code: 'QIXIANG_CREATE_RESPONSE_INVALID' });
    const origin = new QixiangProvider(key, pepper, vi.fn(async () => json({ code: 1, msg: 'ok', trade_no: 'QX', payurl: 'https://evil.example/a' })) as typeof fetch);
    await expect(origin.createCheckout(base)).rejects.toMatchObject({ code: 'QIXIANG_CHECKOUT_URL_INVALID' });
  });

  it('uses only out_trade_no for active query and validates the complete immutable snapshot', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ code: 1, msg: 'ok', trade_no: 'QX-PAID', out_trade_no: base.providerReference,
      api_trade_no: 'UPSTREAM-1', type: 'alipay', pid: 4611, addtime: '2026-08-21 14:00:00', endtime: '2026-08-21 14:01:00', name: base.name,
      money: '12.30', status: 1, param: base.attemptToken, buyer: 'must-be-discarded' }));
    const provider = new QixiangProvider(key, pepper, fetcher);
    const result = await provider.queryOrder(base);
    expect(result).toMatchObject({ state: 'paid', providerTransactionId: 'QX-PAID', amountCents: 1230 });
    expect(fetcher.mock.calls[0]![0]).toContain('act=order&pid=4611&key=');
    expect(fetcher.mock.calls[0]![0]).toContain(`out_trade_no=${base.providerReference}`);
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.has('trade_no')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('must-be-discarded');

    const mismatch = new QixiangProvider(key, pepper, vi.fn(async () => json({ code: 1, msg: 'ok', trade_no: 'QX-PAID',
      out_trade_no: base.providerReference, api_trade_no: 'UPSTREAM-1', type: 'alipay', pid: '4611',
      addtime: '2026-08-21 14:00:00', endtime: '2026-08-21 14:01:00', name: base.name, money: '12.31', status: 1,
      param: base.attemptToken, buyer: null })) as typeof fetch);
    await expect(mismatch.queryOrder(base)).rejects.toMatchObject({ code: 'QIXIANG_QUERY_SNAPSHOT_MISMATCH' });
  });

  it.each([0, 1] as const)('treats refund response code %i as pending confirmation only', async (code) => {
    const provider = new QixiangProvider(key, pepper, vi.fn(async () => json({ code, msg: 'accepted' })) as typeof fetch);
    await expect(provider.requestRefund({ providerReference: base.providerReference, amountCents: 1230 }))
      .resolves.toMatchObject({ state: 'pending_confirmation', responseCode: code });
  });

  it('treats code 1/status 0 as unpaid but rejects provider code 0', async () => {
    const unpaid = new QixiangProvider(key, pepper, vi.fn(async () => json({ code: 1, msg: 'ok', status: 0,
      pid: '4611', out_trade_no: base.providerReference })) as typeof fetch);
    await expect(unpaid.queryOrder(base)).resolves.toMatchObject({ state: 'pending', providerStatus: '0' });
    const rejected = new QixiangProvider(key, pepper, vi.fn(async () => json({ code: 0, msg: 'denied' })) as typeof fetch);
    await expect(rejected.queryOrder(base)).rejects.toMatchObject({ code: 'QIXIANG_QUERY_REJECTED' });
  });

  it.each([
    'https://api.payqixiang.cn/cashier/one',
    'https://api.payqixiang.cn/pay/submit/a/?next=x',
    'https://api.payqixiang.cn/pay/submit/%2e%2e/',
    'https://api.payqixiang.cn/pay/submit/a%2fb/',
    'https://api.payqixiang.cn/pay/submit/a\\b/',
  ])('rejects a checkout URL outside the one-segment submit path: %s', async (payurl) => {
    const provider = new QixiangProvider(key, pepper, vi.fn(async () => json({ code: 1, msg: 'ok', trade_no: 'QX', payurl })) as typeof fetch);
    await expect(provider.createCheckout(base)).rejects.toMatchObject({ code: 'QIXIANG_CHECKOUT_URL_INVALID' });
  });

  it.each([
    [{ ...base, paymentType: 'card' }, 'QIXIANG_PAYMENT_TYPE_INVALID'],
    [{ ...base, clientIp: 'not-an-ip' }, 'QIXIANG_CLIENT_IP_INVALID'],
    [{ ...base, attemptToken: 'bad\nvalue' }, 'QIXIANG_ATTEMPT_TOKEN_INVALID'],
    [{ ...base, name: '算'.repeat(43) }, 'QIXIANG_PRODUCT_NAME_INVALID'],
  ])('rejects invalid runtime input before making a network request', async (input, code) => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new QixiangProvider(key, pepper, fetcher);
    await expect(provider.createCheckout(input as typeof base)).rejects.toThrow(String(code));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects non-success create/refund integer codes distinctly from malformed codes', async () => {
    const createRejected = new QixiangProvider(key, pepper, vi.fn(async () => json({ code: 2, msg: 'no' })) as typeof fetch);
    await expect(createRejected.createCheckout(base)).rejects.toMatchObject({ code: 'QIXIANG_CREATE_REJECTED' });
    const refundRejected = new QixiangProvider(key, pepper, vi.fn(async () => json({ code: 2, msg: 'no' })) as typeof fetch);
    await expect(refundRejected.requestRefund({ providerReference: base.providerReference, amountCents: 100 }))
      .rejects.toMatchObject({ code: 'QIXIANG_REFUND_REJECTED' });
    const malformed = new QixiangProvider(key, pepper, vi.fn(async () => json({ code: '1', msg: 'no' })) as typeof fetch);
    await expect(malformed.createCheckout(base)).rejects.toMatchObject({ code: 'QIXIANG_RESPONSE_INVALID' });
  });

  it('accepts an explicitly present empty create message', async () => {
    const provider = new QixiangProvider(key, pepper, vi.fn(async () => json({ code: 1, msg: '', trade_no: 'QX-1',
      payurl: 'https://api.payqixiang.cn/pay/submit/opaque/' })) as typeof fetch);
    await expect(provider.createCheckout(base)).resolves.toMatchObject({ providerPaymentId: 'QX-1', state: 'pending' });
  });

  it.each([
    [{ providerReference: 'bad-reference', amountCents: 100 }, 'QIXIANG_PROVIDER_REFERENCE_INVALID'],
    [{ providerReference: base.providerReference, amountCents: 99 }, 'QIXIANG_REFUND_AMOUNT_INVALID'],
    [{ providerReference: base.providerReference, amountCents: 5_000_000 }, 'QIXIANG_REFUND_AMOUNT_INVALID'],
    [{ providerReference: base.providerReference, amountCents: Number.NaN }, 'QIXIANG_REFUND_AMOUNT_INVALID'],
  ])('rejects an invalid refund request before network I/O', async (input, code) => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new QixiangProvider(key, pepper, fetcher);
    await expect(provider.requestRefund(input)).rejects.toThrow(String(code));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['trade_no','api_trade_no','addtime','endtime','msg','param','buyer'])(
    'rejects a paid response missing official field %s', async (missing) => {
      const payload: Record<string, unknown> = { code: 1, msg: 'ok', trade_no: 'QX-PAID', out_trade_no: base.providerReference,
        api_trade_no: 'UPSTREAM-1', type: 'alipay', pid: '4611', addtime: '2026-08-21 14:00:00',
        endtime: '2026-08-21 14:01:00', name: base.name, money: '12.30', status: 1, param: base.attemptToken, buyer: null };
      delete payload[missing];
      const provider = new QixiangProvider(key, pepper, vi.fn(async () => json(payload)) as typeof fetch);
      await expect(provider.queryOrder(base)).rejects.toBeTruthy();
    },
  );
});
