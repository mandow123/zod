import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('白鸽在线只属于市场 Spark 商品卡和专属详情', async () => {
  const [app, home, market, wallet, provider, api, detail, campaign] = await Promise.all([
    source('../App.tsx'),
    source('../src/screens/HomeScreen.tsx'),
    source('../src/screens/MarketScreen.tsx'),
    source('../src/CreditWalletSheet.tsx'),
    source('../src/screens/ProviderWorkspaceScreen.tsx'),
    source('../src/api.ts'),
    source('../src/SparkProductDetailSheet.tsx'),
    source('../src/campaign.ts'),
  ]);

  for (const sourceText of [wallet, provider]) {
    assert.doesNotMatch(sourceText, /白鸽|CampaignBanner|featuredCampaign|onOpenCampaign/u);
  }
  assert.match(home, /spark\.supplier\.displayName\}·上海特供/u);
  assert.doesNotMatch(api, /featuredCampaign|loadFeaturedCampaign|\/mobile\/v1\/campaigns/u);
  assert.doesNotMatch(app, /campaignVisible|featuredCampaign|onOpenCampaign/u);
  assert.doesNotMatch(market, /CampaignBanner|featuredCampaign/u);
  assert.match(market, /isSparkCampaignListing\(item\)/u);
  assert.match(campaign, /nvidia-dgx-spark-200-baige-20off/u);
  assert.doesNotMatch(market, /02672000-0000-4000-8000-000000000200|02672 白鸽在线特供款/u);
  assert.match(market, /onOpenSparkDetail\(product\)/u);
  assert.match(detail, /baige-spark-campaign-v1\.jpg/u);
});

test('Spark 专属详情使用后端权威商品、200台和真实设备订单', async () => {
  const [market, detail, api, order, campaign] = await Promise.all([
    source('../src/screens/MarketScreen.tsx'),
    source('../src/SparkProductDetailSheet.tsx'),
    source('../src/api.ts'),
    source('../src/DeviceOrderSheet.tsx'),
    source('../src/campaign.ts'),
  ]);

  assert.match(campaign, /product\.campaignKey === SPARK_CAMPAIGN_KEY/u);
  assert.match(campaign, /listing\.campaignKey === SPARK_CAMPAIGN_KEY/u);
  assert.match(detail, /product\.title/u);
  assert.match(detail, /product\.inventory\.total/u);
  assert.match(detail, /product\.pricing\.discountPercent === 20 \? '8 折'/u);
  assert.match(detail, /product\.pricing\.listUnitCredit/u);
  assert.doesNotMatch(detail, /¥|salePriceCny|listPriceCny/u);
  assert.match(detail, /product\.expectedDelivery\.label/u);
  assert.match(detail, /purchaseAllowed \? '立即购买' : '暂不可购买'/u);
  assert.match(api, /\/mobile\/v1\/device-products/u);
  assert.match(api, /\/mobile\/v1\/device-orders/u);
  assert.match(order, /DEVICE_PRODUCT_PENDING_ACTIVATION/u);
  assert.match(order, /本次没有生成订单/u);
});
