import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) { return readFile(new URL(path, import.meta.url), 'utf8'); }

test('Spark campaign remains a unique visible device product when the remote catalog is unavailable', async () => {
  const [api, campaign, market] = await Promise.all([
    source('../src/api.ts'), source('../src/campaign.ts'), source('../src/screens/MarketScreen.tsx'),
  ]);
  assert.match(api, /ensureSparkCampaignProduct\(deviceProducts\)/u);
  assert.match(campaign, /SPARK_PRODUCT_ID = '02672000-0000-4000-8000-000000000200'/u);
  assert.match(campaign, /displayName: '白鸽在线'/u);
  assert.match(campaign, /total: 200/u);
  assert.match(campaign, /listUnitCredit: '40668\.66'/u);
  assert.match(campaign, /unitCredit: '32534\.93'/u);
  assert.match(campaign, /discountPercent: 20/u);
  assert.match(campaign, /products\.filter\(\(item\) => !isSparkCampaignProduct\(item\)\)/u);
  assert.match(market, /MarketSection = '算力租用' \| '设备采购' \| '预约算力'/u);
  assert.match(market, /useState<MarketSection>\(FORMAL_MARKET_FRESH_SECTION\)/u);
  assert.match(market, /deviceProductRegion\(item\) === region/u);
  assert.match(market, /02672 spark dgx/u);
});

test('compute market separates supplier inquiries, platform listings, and CloudPay K-line', async () => {
  const [market, klinePanel, candles, commerce, purchase, assets] = await Promise.all([
    source('../src/screens/MarketScreen.tsx'), source('../src/CloudPayKlinePanel.tsx'),
    source('../src/cloudpay-market-candles.ts'), source('../src/vast-commerce.ts'),
    source('../src/VastPurchaseSheet.tsx'), source('../src/screens/UnifiedAssetsScreen.tsx'),
  ]);
  assert.match(market, /ComputeSource = '供应商询价' \| '平台保障' \| 'CloudPay K线'/u);
  assert.match(market, /const computeSources: ComputeSource\[\] = \['供应商询价', '平台保障', 'CloudPay K线'\]/u);
  assert.match(market, /useState<ComputeSource>\('供应商询价'\)/u);
  assert.match(market, /supplierRentalMarket \? supplierDirectoryState === 'error'/u);
  assert.match(market, /loadSupplierQuoteDirectory/u);
  assert.match(market, /supplierDirectoryItems\.length/u);
  assert.match(market, /section !== '算力租用' \|\| computeSource !== '平台保障'/u);
  assert.match(market, /section === '设备采购' \? !snapshot\.deviceCatalogOnline/u);
  assert.match(market, /cloudPayKlineMarket \? <CloudPayKlinePanel/u);
  assert.doesNotMatch(market, /Vast\.ai|VastPurchaseSheet|loadVastOffers|VastOfferRow/u);
  assert.match(klinePanel, /CloudPay 同源行情/u);
  assert.match(klinePanel, /<KlineChart candles=/u);
  assert.match(klinePanel, /payload\.notice/u);
  assert.match(candles, /https:\/\/api\.kaicloudpay\.com\/api\/market\/candles/u);
  assert.match(candles, /decodeCloudPayMarketPayload/u);
  assert.match(candles, /referenceOnly: payload\.reference_only === true/u);
  assert.match(market, /const platformDirectoryFallback =/u);
  assert.match(market, /stagingPlatformMarket \? Boolean\(commerce\.error\) && !platformDirectoryFallback/u);
  assert.match(market, /!snapshot\.listingCatalogOnline && supplierDirectoryState !== 'available'/u);
  assert.match(market, /平台保障（审核中）/u);
  assert.match(market, /平台保障候选 · 100 家待审核/u);
  assert.match(market, /不代表现货或已审核库存/u);
  assert.match(market, /supplierDirectoryFiltered\.slice\(0, visibleCount\)/u);
  assert.doesNotMatch(market, /const marketUnavailable =[^;]*!snapshot\.online/u);
  for (const route of ['/mobile/v1/vast/offers', '/mobile/v1/vast/quotes', '/mobile/v1/vast/orders']) {
    assert.match(commerce, new RegExp(route.replaceAll('/', '\\/'), 'u'));
  }
  assert.match(purchase, /确认并预留/u);
  assert.match(purchase, /平台不会重复创建实例/u);
  assert.match(assets, /loadVastOrders/u);
  assert.match(assets, /pending_reconciliation: '状态核对中'/u);
  for (const text of [market, commerce, purchase, assets]) assert.doesNotMatch(text, /¥|人民币|参考价格|美元|USD/u);
});
