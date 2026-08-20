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

test('正式包保持快线禁用，staging 快线只按服务端支付单状态流转', async () => {
  const [wallet, formalSource, stagingSource] = await Promise.all([
    source('../src/CreditWalletSheet.tsx'),
    source('../src/QuicklinePaymentSource.ts'),
    source('../src/QuicklinePaymentSource.staging.ts'),
  ]);
  assert.match(wallet, /1 卡时 = 1\.002 元/u);
  assert.match(wallet, /快线支付/u);
  assert.match(wallet, /支付通道接入中/u);
  assert.match(wallet, /disabled=\{quickline\.source !== 'staging' \|\| quicklinePendingConfirmation \|\| Boolean\(quote\.error\) \|\| !quote\.cardHours\}/u);
  assert.match(wallet, /quickline\.source === 'staging' \? '进入快线支付' : '支付通道接入中'/u);
  assert.match(wallet, /支付结果只以服务端状态为准，不会在本地提前宣称到账/u);
  assert.match(wallet, /QuicklineConfirmPanel/u);
  assert.match(wallet, /quickline\.create\(amountInput\)/u);
  assert.match(wallet, /quickline\.load\(selectedQuickline\.id\)/u);
  assert.match(wallet, /recovered = await quickline\.recover\(\)/u);
  assert.match(wallet, /AppState\.addEventListener\('change'.*state === 'active'.*refresh\(\)/us);
  assert.match(wallet, /上一笔支付结果待确认.*确认前不能新建/u);
  assert.doesNotMatch(wallet, /setTimeout\(\(\) => setPreviewCheckout\('succeeded'\)|PreviewCheckoutState/u);
  assert.doesNotMatch(wallet, /createCreditTopup|launchNativeTopup|randomUUID|logo-alipay|logo-wechat/u);
  assert.doesNotMatch(wallet, /setSelectedTopup\(\{[^)]*status/u);
  assert.match(wallet, /listCreditTopups\(\)/u);
  assert.match(wallet, /loadCreditTopup\(selectedTopup\.id\)/u);
  assert.match(wallet, /topupProviderLabel\(topup\.provider\)/u);
  assert.match(wallet, /provider === 'alipay' \? '支付宝' : '微信支付'/u);
  assert.match(formalSource, /source: 'formal'/u);
  assert.doesNotMatch(formalSource, /staging-sandbox-api|createStagingTopup|\/mobile\/v1\/staging/u);
  assert.match(stagingSource, /createStagingTopup\(request\.amount, request\.idempotencyKey\)/u);
  assert.match(stagingSource, /loadStagingTopup\(id\)/u);
  assert.match(stagingSource, /loadStagingTopups\(\)/u);
  assert.match(stagingSource, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
  assert.match(stagingSource, /loadStagingPrincipalFingerprint/u);
  assert.match(stagingSource, /recover: async \(\)/u);
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
