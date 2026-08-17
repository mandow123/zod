import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { creditAmount } from '../src/format.ts';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

async function pngInfo(path) {
  const buffer = await readFile(new URL(path, import.meta.url));
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] };
}

test('user-visible application identity is consistently Zod', async () => {
  const [configText, strings, app, components, profile, auth, security, workspace] = await Promise.all([
    source('../app.json'),
    source('../android/app/src/main/res/values/strings.xml'),
    source('../App.tsx'),
    source('../src/components.tsx'),
    source('../src/screens/ProfileScreen.tsx'),
    source('../src/AuthSheet.local-e2e.tsx'),
    source('../src/AccountSecuritySheet.tsx'),
    source('../src/WorkspaceHeader.tsx'),
  ]);
  assert.equal(JSON.parse(configText).expo.name, 'Zod');
  assert.equal(JSON.parse(configText).expo.icon, './assets/icon.png');
  assert.equal(JSON.parse(configText).expo.android.adaptiveIcon.foregroundImage, './assets/android-icon-foreground.png');
  assert.match(strings, /<string name="app_name">Zod<\/string>/u);
  for (const visibleSource of [app, components, profile, auth, security, workspace]) {
    assert.doesNotMatch(visibleSource, /登录 CloudPay|进入 CloudPay|注销 CloudPay|>K<|>KAI Cloud</u);
  }
  assert.match(app, />Z<\/Text>/u);
  assert.match(components, />Z<\/Text>/u);
  assert.deepEqual(await pngInfo('../assets/icon.png'), { width: 1024, height: 1024, colorType: 2 });
  assert.deepEqual(await pngInfo('../assets/android-icon-foreground.png'), { width: 512, height: 512, colorType: 6 });
});

test('commerce surfaces show card-hours only and consume server-authored Spark prices', async () => {
  const sources = await Promise.all([
    source('../src/screens/MarketScreen.tsx'),
    source('../src/SparkProductDetailSheet.tsx'),
    source('../src/DeviceOrderSheet.tsx'),
    source('../src/DeviceOrderDetailSheet.tsx'),
    source('../src/MarketOrderSheet.tsx'),
    source('../src/OrderCard.tsx'),
    source('../src/OrderDetailSheet.tsx'),
    source('../src/screens/UnifiedAssetsScreen.tsx'),
    source('../src/PublishFlowSheet.tsx'),
    source('../src/OfferWizardSheet.tsx'),
    source('../src/ListingPublishSheet.tsx'),
  ]);
  for (const commerceSource of sources) assert.doesNotMatch(commerceSource, /人民币|¥|cnyPrice|salePriceCny|listPriceCny/u);
  const detail = sources[1];
  assert.match(detail, /product\.pricing\.unitCredit/u);
  assert.match(detail, /product\.pricing\.listUnitCredit/u);
  assert.doesNotMatch(detail, /(?:0\.8|80\s*\/\s*100|discountPercent\s*\/)/u);
  assert.equal(creditAmount('40668.66'), '40668.66');
  assert.equal(creditAmount('32534.93'), '32534.93');
});

test('device fulfillment submits the TLS tracking number and exposes no manual settlement action', async () => {
  const [commerce, detail, actions] = await Promise.all([
    source('../src/device-commerce.ts'),
    source('../src/DeviceOrderDetailSheet.tsx'),
    source('../src/device-order-actions.ts'),
  ]);
  assert.match(commerce, /body: \{ logisticsProvider: input\.logisticsProvider, trackingNumber: input\.trackingNumber \}/u);
  assert.match(detail, /trackingNumber: tracking/u);
  for (const text of [commerce, detail, actions]) assert.doesNotMatch(text, /trackingDigest|settleDeviceOrder|'settle'/u);
});

test('供应方 App 兑付只公开卡时，旧需求人民币预算已删除', async () => {
  const [sheet, creditScreen, api, payoutService, marketRoutes, marketService, marketStore, marketTypes] = await Promise.all([
    source('../src/CreditPayoutSheet.tsx'),
    source('../src/screens/CreditScreen.tsx'),
    source('../src/api.ts'),
    source('../backend/src/payouts/service.ts'),
    source('../backend/src/market/routes.ts'),
    source('../backend/src/market/service.ts'),
    source('../backend/src/market/store.ts'),
    source('../backend/src/market/types.ts'),
  ]);
  for (const visible of [sheet, creditScreen]) assert.doesNotMatch(visible, /¥|amountCny|creditToCnyEstimate/u);
  const payoutContract = api.slice(api.indexOf('export type CreditPayout ='), api.indexOf('export type CreditTopup ='));
  assert.doesNotMatch(payoutContract, /amountCny|conversion|¥/u);
  assert.match(payoutService, /operator \? \{ subjectId: record\.subjectId, amountCny:/u);
  for (const demandSource of [marketRoutes, marketService, marketStore, marketTypes]) {
    assert.doesNotMatch(demandSource, /budgetMaxCents|budgetMaxCny|budget_max_cents/u);
  }
});
