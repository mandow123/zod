import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCloudPayMarketPayload } from '../src/cloudpay-market-candles.ts';

function validPayload() {
  return {
    ok: true,
    kind: 'gpu',
    product: { id: 'B200', name: 'NVIDIA B200', unit: '元 / 配置时' },
    region: { id: 'shanghai', name: '上海' },
    interval: '1d',
    source: 'verified_listing',
    reference_only: true,
    candles: [
      { time: 1781395200, open: 203.0274, high: 204.3618, low: 199.7654, close: 201.174, volume: 1553.19 },
      { time: 1781481600, open: 201.2, high: 205, low: 200.1, close: 204.5, volume: 900 },
    ],
    updated_at: '2026-08-24T01:56:15+00:00',
    notice: '平台报价参考盘，不代表外部交易所成交价。',
    options: {
      products: {
        gpu: [{ id: 'B200', name: 'NVIDIA B200' }], token: [{ id: 'token', name: 'Token' }],
        rack: [{ id: 'rack', name: '机柜' }], server: [{ id: 'server', name: '服务器' }],
      },
      regions: [{ id: 'shanghai', name: '上海' }],
      intervals: ['1h', '1d', '1w'],
    },
  };
}

test('decodes and sorts the CloudPay OHLC response', () => {
  const input = validPayload();
  input.candles.reverse();
  const decoded = decodeCloudPayMarketPayload(input);
  assert.equal(decoded.product.id, 'B200');
  assert.equal(decoded.referenceOnly, true);
  assert.equal(decoded.candles.length, 2);
  assert.ok(decoded.candles[0].time < decoded.candles[1].time);
  assert.deepEqual(decoded.options.intervals, ['1h', '1d', '1w']);
});

test('rejects malformed or internally impossible candles', () => {
  const malformed = validPayload();
  malformed.candles[0].high = 190;
  assert.throws(() => decodeCloudPayMarketPayload(malformed), /K线数值无效/u);
  const empty = validPayload();
  empty.candles = [];
  assert.throws(() => decodeCloudPayMarketPayload(empty), /暂无有效K线/u);
});
