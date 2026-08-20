import type { CloudPaySnapshot, DeviceProduct, MarketCreditListing } from './api';

export type PurchaseAvailability = Readonly<{ allowed: boolean; reason: string | null }>;

export function marketAvailability(snapshot: Pick<CloudPaySnapshot, 'online' | 'listingCatalogOnline' | 'creditCommerceReady' | 'commerceBlockers'>,
  buildAllowsOrders: boolean): PurchaseAvailability {
  if (!snapshot.online || !snapshot.listingCatalogOnline) return { allowed: false, reason: '市场连接中断' };
  if (!snapshot.creditCommerceReady) return { allowed: false, reason: snapshot.commerceBlockers[0] ?? '卡时履约服务暂未开放' };
  if (!buildAllowsOrders) return { allowed: false, reason: '此版本暂未开放新增购买' };
  return { allowed: true, reason: null };
}

export function deviceMarketAvailability(snapshot: Pick<CloudPaySnapshot, 'online' | 'deviceCatalogOnline' | 'creditCommerceReady' | 'commerceBlockers'>,
  buildAllowsOrders: boolean): PurchaseAvailability {
  if (!snapshot.online || !snapshot.deviceCatalogOnline) return { allowed: false, reason: '设备商品目录正在同步' };
  if (!snapshot.creditCommerceReady) return { allowed: false, reason: snapshot.commerceBlockers[0] ?? '卡时履约服务暂未开放' };
  if (!buildAllowsOrders) return { allowed: false, reason: '此版本暂未开放新增采购' };
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
  if (product.purchasable) return { allowed: true, reason: null };
  const reason = product.blockedReason === 'supplier_verification_pending'
    ? '供应方资料核验中，暂不可采购'
    : product.blockedReason === 'sold_out' ? '当前库存已售罄' : product.blockedReason;
  return { allowed: false, reason: reason ?? '当前商品暂不可购买' };
}
