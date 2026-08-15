import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const market = await readFile(new URL('../src/screens/MarketScreen.tsx', import.meta.url), 'utf8');
const api = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');

test('本地 Spark 明确按整机实物商品展示，不冒充算力订单', () => {
  assert.match(api, /productKind\?: 'hardware_device' \| 'compute_capacity'/u);
  assert.match(api, /fulfillmentMode\?: 'physical_delivery' \| 'compute_sidecar_v1'/u);
  assert.match(market, /整机商品 · 实物交付 · 含税/u);
  assert.match(market, /采购通道待开放/u);
  assert.doesNotMatch(market, /预约采购/u);
  assert.match(market, /不扣 KAI 卡时/u);
  assert.match(market, /含税原价 ¥\{groupedCny\(item\.promotion\.originalReferenceCny\)\}/u);
  assert.match(market, /按当前库存满售预计成交额/u);
  assert.match(market, /不是累计收益或历史收入/u);
  assert.match(market, /模拟资源审计/u);
  assert.match(market, /模拟价格审计/u);
  assert.doesNotMatch(market, /item\.demo[^\n]{0,200}onBuy/u);
});

test('资源较多时分批渲染，搜索筛选仍覆盖完整目录', () => {
  assert.match(market, /const LISTING_PAGE_SIZE = 20/u);
  assert.match(market, /const visibleListings = filtered\.slice\(0, visibleCount\)/u);
  assert.match(market, /setVisibleCount\(\(current\) => Math\.min\(current \+ LISTING_PAGE_SIZE, filtered\.length\)\)/u);
  assert.match(market, /继续显示/u);
});

test('本地演示只追加，真实市场在线状态仍由真实接口决定', () => {
  assert.match(api, /apiRequest<ListingsResponse>\('\/mobile\/v1\/market\/listings\?limit=50'/u);
  assert.match(api, /LOCAL_E2E_DEMO_ENABLED \? localE2EDemoListings\(\)/u);
  assert.match(api, /mergeLocalDemoListings\(realListingData, demoListingData\)/u);
  assert.match(api, /listingCatalogOnline: listingCatalog\.status === 'fulfilled'/u);
});
