import { apiRequest } from './api-client';

export type AssetAction = Readonly<{ key: string; label: string; method: 'GET' | 'POST'; href: string }>;
type AssetBase = Readonly<{ id: string; status: string; actions: readonly AssetAction[]; updatedAt?: string }>;

export type PurchasedComputeAsset = AssetBase & Readonly<{
  assetType: 'purchased_compute'; orderNumber: string; title: string; quantity: string;
  capacityUnit: string; totalCredit: string; updatedAt: string;
}>;
export type PurchasedDeviceOrderAsset = AssetBase & Readonly<{
  assetType: 'purchased_device_order'; orderNumber: string; productId: string; quantity: number;
  totalCredit: string; updatedAt: string;
}>;
export type OwnedDeviceAsset = AssetBase & Readonly<{
  assetType: 'owned_device'; orderId: string; productId: string; title: string; quantity: number; acquiredAt: string;
}>;
export type ProvidedComputeAsset = AssetBase & Readonly<{
  assetType: 'provided_compute'; resourceId: string; title: string; region: string; statusLabel: string;
  statusDetail: string; managementMode: 'managed' | 'self_managed'; views: readonly string[];
  attention: null | Readonly<{ title: string; detail: string; severity: 'info' | 'warning' | 'critical' }>;
  updatedAt: string;
}>;
export type SuppliedDeviceOrderAsset = AssetBase & Readonly<{
  assetType: 'supplied_device_order'; orderNumber: string; productId: string; quantity: number;
  grossCredit: string; supplierNetCredit: string | null; updatedAt: string;
}>;

export type AssetPortfolio = Readonly<{
  subject: Readonly<{ id: string; kind: 'personal' | 'organization'; displayName: string }>;
  summary: Readonly<{
    total: number; actionRequired: number; purchasedCompute: number; purchasedDevices: number; ownedDevices: number;
    providedCompute: number; suppliedDeviceOrders: number; hosted: number; deploying: number; attention: number;
    repurchased: number; renewed: number; closed: number; operating: number;
  }>;
  groups: Readonly<{
    purchasedCompute: readonly PurchasedComputeAsset[];
    purchasedDeviceOrders: readonly PurchasedDeviceOrderAsset[];
    ownedDevices: readonly OwnedDeviceAsset[];
    providedCompute: readonly ProvidedComputeAsset[];
    suppliedDeviceOrders: readonly SuppliedDeviceOrderAsset[];
  }>;
}>;

export async function loadAssetPortfolio() {
  const response = await apiRequest<{ ok: true } & AssetPortfolio>('/mobile/v1/assets/summary', {
    auth: 'required', retry: false,
  });
  return response;
}
