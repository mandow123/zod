import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  centsText,
  estimateTopupCardHourCents,
  parseTopupAmount,
  topupQuote,
} from '../src/topup-checkout.ts';

async function source(path) { return readFile(new URL(path, import.meta.url), 'utf8'); }

test('快线充值预估使用分单位整数算法并始终显示两位小数', () => {
  assert.equal(topupQuote('1.00').cardHours, '0.99');
  assert.equal(topupQuote('1.01').cardHours, '1.00');
  assert.equal(topupQuote('100.00').cardHours, '99.80');
  assert.equal(topupQuote('1000.00').cardHours, '998.00');
  assert.equal(topupQuote('100000.00').cardHours, '99800.39');
  assert.equal(topupQuote('1.01').cardHours?.split('.')[1]?.length, 2);
  assert.equal(centsText(1), '0.01');
  assert.equal(centsText(9980), '99.80');
  assert.equal(estimateTopupCardHourCents(100), 99);
  assert.equal(estimateTopupCardHourCents(10_000_000), 9_980_039);
});

test('实付金额只接受两位小数和 1.00 至 100000.00', () => {
  assert.deepEqual(parseTopupAmount(''), { amountCents: null, error: null });
  assert.equal(parseTopupAmount('0.99').amountCents, null);
  assert.equal(parseTopupAmount('100000.01').amountCents, null);
  assert.equal(parseTopupAmount('1.001').amountCents, null);
  assert.equal(parseTopupAmount('abc').amountCents, null);
  assert.equal(parseTopupAmount('1.00').amountCents, 100);
  assert.equal(parseTopupAmount('100000.00').amountCents, 10_000_000);
});

test('支付通道未接通时不能创建支付单、启动收银台或模拟到账', async () => {
  const wallet = await source('../src/CreditWalletSheet.tsx');
  assert.match(wallet, /1 卡时 = 1\.002 元/u);
  assert.match(wallet, /快线支付/u);
  assert.match(wallet, /支付通道接入中/u);
  assert.match(wallet, /accessibilityState=\{\{ disabled: true \}\} disabled/u);
  assert.doesNotMatch(wallet, /createCreditTopup|launchNativeTopup|randomUUID|logo-alipay|logo-wechat/u);
  assert.doesNotMatch(wallet, /setSelectedTopup\(\{[^)]*status/u);
  assert.match(wallet, /listCreditTopups\(\)/u);
  assert.match(wallet, /loadCreditTopup\(selectedTopup\.id\)/u);
  assert.match(wallet, /topupProviderLabel\(topup\.provider\)/u);
  assert.match(wallet, /provider === 'alipay' \? '支付宝' : '微信支付'/u);
});

test('六种支付结果只由真实充值记录状态渲染并提供恢复动作', async () => {
  const wallet = await source('../src/CreditWalletSheet.tsx');
  for (const label of ['准备收银台', '处理中', '到账成功', '未完成', '已取消', '人工核对']) {
    assert.match(wallet, new RegExp(label, 'u'));
  }
  for (const action of ['返回卡时', '重新查询', '联系客服']) {
    assert.match(wallet, new RegExp(action, 'u'));
  }
  assert.match(wallet, /topup: CreditTopup/u);
  assert.match(wallet, /selectedTopup \? <TopupStatusPanel/u);
});

test('市场、商品与订单继续不展示法币或参考价', async () => {
  const sources = await Promise.all([
    source('../src/screens/MarketScreen.tsx'),
    source('../src/SparkProductDetailSheet.tsx'),
    source('../src/MarketOrderSheet.tsx'),
    source('../src/DeviceOrderSheet.tsx'),
  ]);
  for (const text of sources) {
    assert.doesNotMatch(text, /人民币|¥|￥|参考价|amountCny|conversion/u);
  }
});
