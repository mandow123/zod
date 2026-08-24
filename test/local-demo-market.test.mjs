import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { listingAvailability } from '../src/market-availability.ts';

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

test('测试挂牌保留不可购买事实且没有真实交易入口', () => {
  assert.match(api, /purchasable: listing\.demo\.simulatedAudit \? false : listing\.demo\.purchasable/u);
  assert.match(api, /blockedReason: listing\.demo\.simulatedAudit \|\| !listing\.demo\.purchasable \? '测试资源当前仅支持查看' : null/u);
  assert.match(api, /demo: \{ \.\.\.listing\.demo \}/u);
  assert.match(market, /item\.demo\?\.mode === 'local_e2e' \? <LocalDemoMarketRow key=\{item\.id\} item=\{item\} \/> : <MarketRow/u);
  assert.match(market, /filtered\.every\(\(item\) => item\.demo\?\.mode === 'local_e2e'\)/u);
  assert.match(market, /platformDemoOnly \? '测试资源目录，当前仅支持查看' : '即时开通，按卡时结算'/u);
  const demoCard = market.slice(market.indexOf('function LocalDemoMarketRow'), market.indexOf('function MarketRow'));
  for (const copy of ['测试资源', '测试容量', '可查看详情']) assert.match(demoCard, new RegExp(copy, 'u'));
  for (const copy of ['本地验收资源', '非生产库存', '仅供本机验收']) assert.doesNotMatch(demoCard, new RegExp(copy, 'u'));
  assert.doesNotMatch(demoCard, /Pressable|onBuy|createCloudPayOrder|资源与价格双审通过|实时可用|购买|下单/u);
  const productionCard = market.slice(market.indexOf('function MarketRow'), market.indexOf('function FilterChip'));
  assert.match(productionCard, /资源与价格双审通过/u);
  assert.match(productionCard, /onPress=\{onPress\}/u);
  assert.match(productionCard, /'购买'/u);
  const ready = { allowed: true, reason: null };
  assert.equal(listingAvailability(ready, { purchasable: false, blockedReason: '测试资源当前仅支持查看' }, true).allowed, false);
  assert.equal(listingAvailability(ready, {}, true).allowed, true);
});
