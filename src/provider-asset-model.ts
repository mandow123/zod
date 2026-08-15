import type { ResourceDeliveryReadiness } from './resource-delivery-readiness';

export type ProviderAssetStatus = 'pending_connection' | 'standby' | 'operating' | 'operating_issue';
export type ProviderAssetView = 'hosted' | 'deploying' | 'attention' | 'repurchased' | 'renewed' | 'closed' | 'operating';
export type ProviderAssetFilter = 'all' | ProviderAssetView | 'pending_connection' | 'standby';
export type ProviderNodeEnrollmentStatus = 'unbound' | 'claim_issued' | 'checking' | 'ready' | 'offline' | 'revoked';

export type ProviderAssetAction = Readonly<{
  key: 'view_resource' | 'view_fulfillment' | 'resubmit_resource' | 'create_offer' | 'manage_listing'
    | 'resume_offer_draft' | 'resolve_offer_review' | 'reaudit_expired_offer'
    | 'publish_approved_offer' | 'track_offer_review' | 'view_offer_draft';
  label: string;
  route: 'provider_resources' | 'provider_order' | 'provider_offer_create' | 'provider_listing_manager'
    | 'provider_offer_editor' | 'provider_offer_review' | 'provider_listing_editor';
  entityId: string;
  target: 'resource' | 'fulfillment' | 'listing' | 'wizard_draft' | 'offer_revision' | 'offer_review' | 'offer_listing';
}>;

export type ProviderAsset = Readonly<{
  id: string;
  resourceId: string;
  name: string;
  productCode: string;
  region: string;
  specifications: Record<string, unknown>;
  managementMode: 'self_managed' | 'platform_hosted';
  status: ProviderAssetStatus;
  statusLabel: string;
  statusDetail: string;
  materialStatus: 'draft' | 'pending_verification' | 'verified' | 'rejected' | 'suspended' | 'retired';
  deliveryReadiness: ResourceDeliveryReadiness;
  nodeEnrollment: Readonly<{
    deploymentId: string | null;
    generation: number | null;
    status: ProviderNodeEnrollmentStatus;
  }>;
  nodeAction: null | Readonly<{
    key: 'issue_node_claim' | 'revoke_node_enrollment';
    label: string;
    deploymentId: string | null;
  }>;
  lifecycle: 'registered' | 'active' | 'retired';
  lifecycleFacts: Readonly<{
    renewedAt: string | null;
    repurchasedAt: string | null;
    closedAt: string | null;
  }>;
  views: readonly ProviderAssetView[];
  attention: null | Readonly<{
    title: string;
    detail: string;
    severity: 'info' | 'warning' | 'critical';
  }>;
  nextAction: ProviderAssetAction | null;
  updatedAt: string;
}>;

export type ProviderAssetSummary = Readonly<{
  total: number;
  pendingConnection: number;
  standby: number;
  operating: number;
  operatingIssue: number;
  attention: number;
  hosted: number;
  deploying: number;
  repurchased: number;
  renewed: number;
  closed: number;
}>;

export function filterProviderAssets(assets: readonly ProviderAsset[], filter: ProviderAssetFilter) {
  if (filter === 'all') return [...assets];
  if (['pending_connection', 'standby'].includes(filter)) {
    return assets.filter((asset) => asset.status === filter && !providerAssetHasView(asset, 'closed'));
  }
  return assets.filter((asset) => providerAssetHasView(asset, filter as ProviderAssetView));
}

export function providerAssetHasView(asset: ProviderAsset, view: ProviderAssetView) {
  if (asset.views?.includes(view)) return true;
  if (view === 'attention') return asset.attention !== null && asset.attention.severity !== 'info';
  if (view === 'operating') return asset.status === 'operating';
  return false;
}

export function providerAssetManagementLabel(mode: ProviderAsset['managementMode']) {
  return mode === 'platform_hosted' ? '托管设备' : '自有设备';
}

export function providerAssetMaterialLabel(status: ProviderAsset['materialStatus']) {
  return {
    draft: '资料草稿', pending_verification: '资料待核验', verified: '资料已核验',
    rejected: '资料需补充', suspended: '资源已暂停', retired: '资源已退役',
  }[status];
}

export function providerAssetLifecycleLabel(status: ProviderAsset['lifecycle']) {
  return { registered: '已登记', active: '使用中', retired: '设备关闭' }[status];
}

export function providerAssetViewLabel(view: ProviderAssetView) {
  return {
    hosted: '托管设备', deploying: '部署中', attention: '待处理', repurchased: '已回购',
    renewed: '已续产', closed: '设备关闭', operating: '运营中',
  }[view];
}

export function providerAssetActionAllowed(action: ProviderAssetAction | null, canManage: boolean) {
  return Boolean(action && (['view_resource', 'view_fulfillment', 'track_offer_review', 'view_offer_draft']
    .includes(action.key) || canManage));
}
