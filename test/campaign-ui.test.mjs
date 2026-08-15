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

  for (const sourceText of [wallet, provider]) {
    assert.doesNotMatch(sourceText, /白鸽|CampaignBanner|featuredCampaign|onOpenCampaign/u);
  }
  assert.match(home, /spark\.supplier\.displayName\}·上海特供/u);
  assert.doesNotMatch(api, /featuredCampaign|loadFeaturedCampaign|\/mobile\/v1\/campaigns/u);
  assert.doesNotMatch(app, /campaignVisible|featuredCampaign|onOpenCampaign/u);
  assert.doesNotMatch(market, /CampaignBanner|featuredCampaign/u);
  assert.match(market, /isBaigeSparkListing\(item\)/u);
  assert.match(market, /02672 白鸽在线特供款/u);
  assert.match(market, /onOpenSparkDetail\(product\)/u);
  assert.match(detail, /baige-spark-campaign-v1\.jpg/u);
});

test('Spark 专属详情使用后端权威商品、200台和真实设备订单', async () => {
  const [market, detail, api, order] = await Promise.all([
    source('../src/screens/MarketScreen.tsx'),
    source('../src/SparkProductDetailSheet.tsx'),
    source('../src/api.ts'),
    source('../src/DeviceOrderSheet.tsx'),
  ]);

  assert.match(market, /item\.productCode === 'NVIDIA DGX Spark'/u);
  assert.match(market, /item\.title === '02672 白鸽在线特供款'/u);
  assert.match(market, /item\.capacityTotal === '200\.000000'/u);
  assert.match(detail, /NVIDIA DGX Spark/u);
  assert.match(detail, /200 台限量/u);
  assert.match(detail, /8 折 · 优惠 20%/u);
  assert.match(detail, /product\.expectedDelivery\.label/u);
  assert.match(detail, /product\.purchasable \? '立即购买' : '暂不可购买'/u);
  assert.match(api, /\/mobile\/v1\/device-products/u);
  assert.match(api, /\/mobile\/v1\/device-orders/u);
  assert.match(order, /DEVICE_PRODUCT_PENDING_ACTIVATION/u);
  assert.match(order, /本次没有生成订单/u);
});
