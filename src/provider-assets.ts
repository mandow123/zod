import { apiRequest } from './api-client';
import type { ProviderAsset, ProviderAssetSummary } from './provider-asset-model';
export * from './provider-asset-model';

export async function loadProviderAssets() {
  const response = await apiRequest<{ ok: true; summary: ProviderAssetSummary; assets: ProviderAsset[] }>(
    '/mobile/v1/provider/assets', { auth: 'required', retry: true },
  );
  const assets = response.assets.map(normalizeProviderAsset);
  return {
    ...response,
    assets,
    summary: {
      ...response.summary,
      hosted: response.summary.hosted ?? 0,
      deploying: response.summary.deploying ?? 0,
      repurchased: response.summary.repurchased ?? 0,
      renewed: response.summary.renewed ?? 0,
      closed: response.summary.closed ?? 0,
    },
  };
}

export async function loadProviderAsset(assetId: string) {
  const response = await apiRequest<{ ok: true; asset: ProviderAsset }>(
    `/mobile/v1/provider/assets/${encodeURIComponent(assetId)}`, { auth: 'required', retry: true },
  );
  return normalizeProviderAsset(response.asset);
}

function normalizeProviderAsset(asset: ProviderAsset): ProviderAsset {
  const legacyViews = [
    ...(asset.status === 'operating' ? ['operating' as const] : []),
    ...(asset.attention && asset.attention.severity !== 'info' ? ['attention' as const] : []),
  ];
  return {
    ...asset,
    views: asset.views ?? legacyViews,
    lifecycleFacts: asset.lifecycleFacts ?? { renewedAt: null, repurchasedAt: null, closedAt: null },
  };
}
