import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const market = await readFile(new URL('../src/screens/MarketScreen.tsx', import.meta.url), 'utf8');
const api = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');

test('本地 Spark 只作为展示入口，采购切到后端权威设备订单', async () => {
  const [app, deviceOrder] = await Promise.all([
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/DeviceOrderSheet.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(api, /productKind\?: 'hardware_device' \| 'compute_capacity'/u);
  assert.match(api, /fulfillmentMode\?: 'physical_delivery' \| 'compute_sidecar_v1'/u);
  assert.match(market, /设备采购/u);
  assert.match(app, /onOpenSparkDetail=\{openSparkDetail\}/u);
  assert.match(market, /snapshot\.deviceProducts/u);
  assert.match(deviceOrder, /createDeviceOrder/u);
  assert.doesNotMatch(deviceOrder, /createCloudPayOrder/u);
});

test('资源较多时分批渲染，搜索筛选仍覆盖完整目录', () => {
  assert.match(market, /const LISTING_PAGE_SIZE = 20/u);
  assert.match(market, /const visibleListings = filtered\.slice\(0, visibleCount\)/u);
  assert.match(market, /setVisibleCount\(\(count\) => count \+ LISTING_PAGE_SIZE\)/u);
  assert.match(market, /继续显示/u);
});

test('本地演示只追加，真实市场在线状态仍由真实接口决定', () => {
  assert.match(api, /apiRequest<ListingsResponse>\('\/mobile\/v1\/market\/listings\?limit=50'/u);
  assert.match(api, /LOCAL_E2E_DEMO_ENABLED \? localE2EDemoListings\(\)/u);
  assert.match(api, /mergeLocalDemoListings\(realListingData, demoListingData\)/u);
  assert.match(api, /listingCatalogOnline: listingCatalog\.status === 'fulfilled'/u);
});
