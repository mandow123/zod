import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) { return readFile(new URL(path, import.meta.url), 'utf8'); }

test('V2 keeps one five-item navigation and moves the view switch into My', async () => {
  const [app, components, profile] = await Promise.all([
    source('../App.tsx'), source('../src/components.tsx'), source('../src/screens/ProfileScreen.tsx'),
  ]);
  for (const entry of [
    "{ key: 'home', label: '首页'", "{ key: 'market', label: '市场'",
    "{ key: 'assets', label: '我的资产'", "{ key: 'messages', label: '消息'",
    "{ key: 'profile', label: '我的'",
  ]) assert.match(components, new RegExp(entry.replace(/[{}]/gu, '\\$&'), 'u'));
  assert.doesNotMatch(app, /<WorkspaceHeader/u);
  assert.match(profile, /使用算力/u);
  assert.match(profile, /提供算力/u);
  assert.match(app, /KAI_CLOUD_UNIFIED_ASSETS_V2/u);
});

test('device purchase uses only the authoritative product and order endpoints', async () => {
  const [commerce, order, app] = await Promise.all([
    source('../src/device-commerce.ts'), source('../src/DeviceOrderSheet.tsx'), source('../App.tsx'),
  ]);
  for (const route of ['/mobile/v1/device-products', '/mobile/v1/device-orders', '/mobile/v1/device-assets']) {
    assert.match(commerce, new RegExp(route.replaceAll('/', '\\/'), 'u'));
  }
  assert.match(commerce, /device-products/u);
  assert.match(order, /purchaseAllowed/u);
  assert.match(order, /inventory\.available/u);
  assert.match(order, /balance\.available/u);
  assert.match(order, /shippingAddressReference/u);
  assert.match(order, /idempotencyKey/u);
  assert.doesNotMatch(order, /伪成功|模拟成功/u);
});

test('production Spark cards come from the authoritative device catalog without demo duplication', async () => {
  const [commerce, home, market, campaign] = await Promise.all([
    source('../src/device-commerce.ts'), source('../src/screens/HomeScreen.tsx'), source('../src/screens/MarketScreen.tsx'), source('../src/campaign.ts'),
  ]);
  assert.match(commerce, /'\/mobile\/v1\/device-products', \{ auth: 'optional'/u);
  assert.match(home, /snapshot\.deviceProducts\.find/u);
  assert.match(market, /snapshot\.deviceProducts\.filter/u);
  assert.match(market, /!isSparkCampaignListing\(item\)/u);
  assert.match(campaign, /nvidia-dgx-spark-200-baige-20off/u);
});

test('provider asset totals never estimate settled earnings from gross closed orders', async () => {
  const [assets, credits, payout, api] = await Promise.all([
    source('../src/screens/UnifiedAssetsScreen.tsx'), source('../src/screens/CreditScreen.tsx'), source('../src/CreditPayoutSheet.tsx'), source('../src/api.ts'),
  ]);
  assert.doesNotMatch(assets, /closed[\s\S]{0,160}totalCredits|addCredits/u);
  assert.doesNotMatch(assets, /已结算收益/u);
  assert.match(api, /redeemableSupplierEarnings: string/u);
  assert.match(credits, /balance\.redeemableSupplierEarnings/u);
  assert.match(credits, /balance\.supplierReceivable/u);
  assert.match(credits, /supplierQualified/u);
  assert.match(payout, /balance\.redeemableSupplierEarnings/u);
  assert.doesNotMatch(payout, /balance\.available/u);
  assert.doesNotMatch(payout, /balance\?\.available/u);
});

test('unified assets shows backend evidence for device states and payout balances', async () => {
  const [assets, payout, api] = await Promise.all([
    source('../src/screens/UnifiedAssetsScreen.tsx'), source('../src/CreditPayoutSheet.tsx'), source('../src/api.ts'),
  ]);
  for (const label of ['托管与部署', '待处理', '生命周期', '运营中']) {
    assert.match(assets, new RegExp(label, 'u'));
  }
  assert.match(assets, /loadAssetPortfolio/u);
  assert.match(assets, /portfolio\.groups\.purchasedDeviceOrders/u);
  assert.match(assets, /portfolio\.groups\.suppliedDeviceOrders/u);
  assert.match(assets, /payoutProfile\?\.status === 'active'/u);
  assert.match(payout, /PAYOUT_PROFILE_PENDING_ACTIVATION/u);
  assert.match(payout, /本次没有冻结卡时/u);
  assert.match(api, /\/mobile\/v1\/credits\/payout-profile/u);
  assert.match(api, /\/mobile\/v1\/credits\/payouts/u);
});

test('device checkout uses a normal address book and keeps references internal', async () => {
  const [commerce, order] = await Promise.all([source('../src/device-commerce.ts'), source('../src/DeviceOrderSheet.tsx')]);
  assert.match(commerce, /loadShippingAddresses/u);
  assert.match(commerce, /\/mobile\/v1\/shipping-addresses/u);
  assert.match(commerce, /createShippingAddress/u);
  assert.match(commerce, /deleteShippingAddress/u);
  assert.match(order, /收货地址/u);
  assert.match(order, /新增地址/u);
  assert.match(order, /保存并使用/u);
  assert.match(order, /selectedAddress\.reference/u);
  assert.match(order, /shippingAddressReference: selectedAddress\.reference/u);
  assert.doesNotMatch(order, /收货地址编号|address-vault-token|填写.*token|填写.*编号/u);
});
