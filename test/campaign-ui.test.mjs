import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('白鸽在线只属于市场 Spark 商品卡和专属详情', async () => {
  const [app, home, market, wallet, provider, api, detail] = await Promise.all([
    source('../App.tsx'),
    source('../src/screens/HomeScreen.tsx'),
    source('../src/screens/MarketScreen.tsx'),
    source('../src/CreditWalletSheet.tsx'),
    source('../src/screens/ProviderWorkspaceScreen.tsx'),
    source('../src/api.ts'),
    source('../src/SparkProductDetailSheet.tsx'),
  ]);

  for (const sourceText of [home, wallet, provider]) {
    assert.doesNotMatch(sourceText, /白鸽|CampaignBanner|featuredCampaign|onOpenCampaign/u);
  }
  assert.doesNotMatch(api, /featuredCampaign|loadFeaturedCampaign|\/mobile\/v1\/campaigns/u);
  assert.doesNotMatch(app, /campaignVisible|featuredCampaign|onOpenCampaign/u);
  assert.doesNotMatch(market, /CampaignBanner|featuredCampaign/u);
  assert.match(market, /isBaigeSparkListing\(item\)/u);
  assert.match(market, /02672 白鸽在线特供款/u);
  assert.match(market, /onOpenSparkDetail\(item\)/u);
  assert.match(detail, /baige-spark-campaign-v1\.jpg/u);
});

test('Spark 专属详情使用200台、8折和3个月唯一口径且没有假操作', async () => {
  const [market, detail, catalog] = await Promise.all([
    source('../src/screens/MarketScreen.tsx'),
    source('../src/SparkProductDetailSheet.tsx'),
    source('../backend/scripts/local-e2e-demo-catalog.ts'),
  ]);

  assert.match(market, /item\.productCode === 'NVIDIA Spark'/u);
  assert.match(market, /item\.title === '02672 白鸽在线特供款'/u);
  assert.match(market, /item\.capacityTotal === '200\.000000'/u);
  assert.match(market, /item\.promotion\?\.discountPercent === 20/u);
  assert.match(market, /item\.promotion\.originalReferenceCny === '32600\.00'/u);
  assert.match(market, /item\.promotion\.discountedReferenceCny === '26080\.00'/u);
  assert.match(market, /采购通道待开放/u);
  assert.doesNotMatch(market, /预约采购/u);
  assert.match(detail, /NVIDIA Spark/u);
  assert.match(detail, /200 台限量/u);
  assert.match(detail, /8 折 · 优惠 20%/u);
  assert.match(detail, /含税原价 ¥32,600\.00，活动价 ¥26,080\.00/u);
  assert.match(detail, /listing\.shippingEstimate \?\? '预计3个月发货'/u);
  assert.doesNotMatch(detail, /立即购买|立即预约|抢购/u);
  assert.match(catalog, /capacity = spark \? 200n/u);
  assert.match(catalog, /discountedReferenceCny: '26080\.00'/u);
  assert.match(catalog, /label: '限时8折', discountPercent: 20/u);
});
