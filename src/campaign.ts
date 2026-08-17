import type { MarketCreditListing } from './api';
import type { DeviceProduct } from './device-commerce';

export const SPARK_CAMPAIGN_KEY = 'nvidia-dgx-spark-200-baige-20off';
export const SPARK_PRODUCT_ID = '02672000-0000-4000-8000-000000000200';

export const bundledSparkCampaignProduct: DeviceProduct = Object.freeze({
  id: SPARK_PRODUCT_ID,
  sku: 'NVIDIA-DGX-SPARK-200-BAIGE',
  title: 'NVIDIA DGX Spark',
  productType: 'physical_delivery',
  campaignKey: SPARK_CAMPAIGN_KEY,
  catalogSource: 'bundled_campaign',
  template: { key: 'nvidia-dgx-spark-preorder-v1' },
  supplier: { displayName: '白鸽在线', verified: false },
  activationStatus: 'pending_activation',
  purchasable: false,
  blockedReason: '商品目录同步中，请下拉刷新',
  capabilities: {
    creditOnly: true,
    requiresShippingAddress: true,
    physicalDelivery: true,
    maxQuantityPerOrder: 20,
  },
  inventory: { total: 200, reserved: 0, sold: 0, available: 200 },
  pricing: { listUnitCredit: '40668.66', unitCredit: '32534.93', discountPercent: 20 },
  expectedDelivery: { days: 90, label: '预计3个月发货' },
  specifications: {
    brand: 'NVIDIA',
    model: 'DGX Spark',
    fulfillment: 'preorder',
    region: '华东-上海',
  },
});

export function ensureSparkCampaignProduct(products: readonly DeviceProduct[]) {
  const authoritative = products.find(isSparkCampaignProduct);
  return authoritative ? [authoritative, ...products.filter((item) => !isSparkCampaignProduct(item))]
    : [bundledSparkCampaignProduct, ...products];
}

export function deviceProductRegion(product: DeviceProduct) {
  const region = product.specifications.region;
  return typeof region === 'string' && region.trim() ? region.trim() : null;
}

export function isSparkCampaignProduct(product: DeviceProduct) {
  return product.productType === 'physical_delivery' && product.campaignKey === SPARK_CAMPAIGN_KEY;
}

export function isSparkCampaignListing(listing: MarketCreditListing) {
  return listing.productKind === 'hardware_device' && listing.campaignKey === SPARK_CAMPAIGN_KEY;
}
