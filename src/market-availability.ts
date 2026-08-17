import type { CloudPaySnapshot, DeviceProduct, MarketCreditListing } from './api';

export type PurchaseAvailability = Readonly<{ allowed: boolean; reason: string | null }>;

export function marketAvailability(snapshot: Pick<CloudPaySnapshot, 'online' | 'listingCatalogOnline' | 'creditCommerceReady' | 'commerceBlockers'>,
  buildAllowsOrders: boolean): PurchaseAvailability {
  if (!snapshot.online || !snapshot.listingCatalogOnline) return { allowed: false, reason: '市场连接中断' };
  if (!snapshot.creditCommerceReady) return { allowed: false, reason: snapshot.commerceBlockers[0] ?? '交易服务暂未开放' };
  if (!buildAllowsOrders) return { allowed: false, reason: '此版本暂未开放新增购买' };
  return { allowed: true, reason: null };
}

export function listingAvailability(base: PurchaseAvailability, listing: Pick<MarketCreditListing, 'purchasable' | 'blockedReason'>,
  supportedDelivery: boolean): PurchaseAvailability {
  if (!base.allowed) return base;
  if (listing.purchasable === false) return { allowed: false, reason: listing.blockedReason ?? '当前资源暂不可购买' };
  if (!supportedDelivery) return { allowed: false, reason: '当前交付方式暂未开放 App 购买' };
  return { allowed: true, reason: null };
}

export function deviceProductAvailability(base: PurchaseAvailability,
  product: Pick<DeviceProduct, 'purchasable' | 'blockedReason'>): PurchaseAvailability {
  if (!base.allowed) return base;
  return product.purchasable ? { allowed: true, reason: null }
    : { allowed: false, reason: product.blockedReason ?? '当前商品暂不可购买' };
}
