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

test('正式快线只挂载七相面板，staging 流程继续物理隔离', async () => {
  const [app, credit, wallet, panel, formalSource, stagingSource] = await Promise.all([
    source('../App.tsx'),
    source('../src/screens/CreditScreen.tsx'),
    source('../src/CreditWalletSheet.tsx'),
    source('../src/QixiangTopupPanel.tsx'),
    source('../src/QuicklinePaymentSource.ts'),
    source('../src/QuicklinePaymentSource.staging.ts'),
  ]);
  assert.match(app, /snapshot\.authenticated \|\| distributionPolicy\.stagingDemo \? <CreditWalletSheet/u);
  assert.match(credit, /quicklineAvailable \? <Pressable onPress=\{onOpenWallet\}.*快线支付/us);
  assert.match(wallet, /quickline\.source !== 'staging' && qixiangCapability \? <QixiangTopupPanel/u);
  assert.doesNotMatch(wallet, /listCreditTopups|loadCreditTopup|CreditTopup/u);
  assert.match(panel, /支付通道：七相支付（支付宝）/u);
  assert.match(panel, /充值套餐/u);
  assert.match(panel, /自定义金额（元）/u);
  assert.match(panel, /TOPUP_PACKAGES/u);
  assert.match(panel, /使用七相支付/u);
  assert.match(panel, /WebBrowser\.openBrowserAsync\(safeUrl/u);
  assert.match(panel, /await WebBrowser\.openBrowserAsync[\s\S]*await observeReturn\(attempt\)/u);
  assert.match(panel, /createQixiangBrowserReturnCoordinator/u);
  assert.doesNotMatch(panel, /WebView|openAuthSessionAsync|wxpay|wechat|MD5|Basic/u);
  assert.match(panel, /observeQixiangBrowserReturn/u);
  assert.match(panel, /AppState\.addEventListener\('change'/u);
  assert.match(panel, /Linking\.addEventListener\('url'/u);
  assert.match(panel, /loadQixiangTopupWhenEnabled/u);
  assert.match(panel, /checkout \? <Pressable[^>]*onPress=\{\(\) => void openCheckout\(checkout\)\}/u);
  assert.match(panel, /recheckQixiangTopupByUser/u);
  assert.match(panel, /onPress=\{\(\) => void recheck\(\)\}/u);
  assert.match(panel, /loadLegalBootstrap\(\)/u);
  assert.match(panel, /运营主体：\{operatorName\}/u);
  assert.doesNotMatch(panel, /legalEntityName:\s*['"]/u);
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
  assert.match(formalSource, /source: 'formal'/u);
  assert.doesNotMatch(formalSource, /staging-sandbox-api|createStagingTopup|\/mobile\/v1\/staging/u);
  assert.match(stagingSource, /createStagingTopup\(request\.amount, request\.idempotencyKey\)/u);
  assert.match(stagingSource, /loadStagingTopup\(id\)/u);
  assert.match(stagingSource, /loadStagingTopups\(\)/u);
  assert.match(stagingSource, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
  assert.match(stagingSource, /loadStagingPrincipalFingerprint/u);
  assert.match(stagingSource, /recover: async \(\)/u);
});

test('七相支付结果只由严格服务端状态渲染并提供诚实恢复动作', async () => {
  const panel = await source('../src/QixiangTopupPanel.tsx');
  for (const label of ['等待支付', '支付待确认', '服务端核对中', '到账成功', '支付未完成', '收银台已过期', '人工核对中']) {
    assert.match(panel, new RegExp(label, 'u'));
  }
  for (const action of ['返回卡时', '重新核对', '联系客服']) {
    assert.match(panel, new RegExp(action, 'u'));
  }
  assert.match(panel, /selected\.status === 'succeeded'/u);
  assert.match(panel, /返回 App、关闭浏览器或收到链接都不代表支付成功/u);
  assert.match(panel, /有效期 364 天/u);
  assert.match(panel, /不可转让，不可提现或兑换现金/u);
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
