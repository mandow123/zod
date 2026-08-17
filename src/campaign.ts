import type { DeviceProduct, MarketCreditListing } from './api';

export const SPARK_CAMPAIGN_KEY = 'nvidia-dgx-spark-200-baige-20off';

export function isSparkCampaignProduct(product: DeviceProduct) {
  return product.productType === 'physical_delivery' && product.campaignKey === SPARK_CAMPAIGN_KEY;
}

export function isSparkCampaignListing(listing: MarketCreditListing) {
  return listing.productKind === 'hardware_device' && listing.campaignKey === SPARK_CAMPAIGN_KEY;
}
