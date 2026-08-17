import { ApiError, LOCAL_E2E_DEMO_ENABLED, apiRequest } from './api-client';
import { loadLocalE2EDemoCatalog } from './local-e2e-runtime';
import * as Crypto from 'expo-crypto';
import {
  clearSession,
  loadSession,
  updateSessionUser,
  type CloudPayUser,
} from './session';
import { loadProviderReadCache, saveProviderWorkspaceCache } from './provider-read-cache';
import { mergeLocalDemoListings } from './demo-market';
import { ensureSparkCampaignProduct } from './campaign';
import type { DeviceAsset, DeviceOrder, DeviceProduct } from './device-commerce';
export * from './device-commerce';

export type ResourceKind = 'gpu' | 'token_capacity' | 'token_usage' | 'rack' | 'storage' | 'apple_silicon';

export type MarketResource = Readonly<{
  id: string;
  productCode: string;
  productKind?: 'hardware_device' | 'compute_capacity';
  campaignKey?: string | null;
  fulfillmentMode?: 'physical_delivery' | 'compute_sidecar_v1';
  shippingEstimate?: string;
  kind: ResourceKind;
  region: string;
  specifications: Record<string, unknown>;
  capacityTotal: string;
  capacityUnit: string;
  createdAt: string;
}>;

export type MarketCreditListing = Readonly<{
  id: string;
  offerId: string;
  resourceId: string;
  title: string;
  serviceMode: 'dedicated' | 'shared' | 'slice' | 'node' | 'reserved';
  productCode: string;
  productKind?: 'hardware_device' | 'compute_capacity';
  campaignKey?: string | null;
  fulfillmentMode?: 'physical_delivery' | 'compute_sidecar_v1';
  shippingEstimate?: string | null;
  kind: ResourceKind;
  region: string;
  specifications: Record<string, unknown>;
  sla: Record<string, unknown>;
  capacityTotal: string;
  capacityReserved: string;
  capacitySold: string;
  capacityAvailable: string;
  capacityUnit: string;
  minimumQuantity: string;
  unitCredits: string;
  status: 'active';
  startsAt: string;
  expiresAt: string;
  auditValidUntil: string;
  createdAt: string;
  audits: Readonly<{ resource: true; price: true }>;
  ownedByCurrentSubject: boolean;
  /** Server-authored purchase decision. Older servers omit these fields and fall back to readiness. */
  purchasable?: boolean;
  blockedReason?: string | null;
  demo?: Readonly<{
    mode: 'local_e2e'; label: '演示资源'; payment: 'sandbox_only';
    purchasable: boolean; simulatedAudit: true;
  }>;
  promotion?: null | Readonly<{
    kind: 'percentage'; label: string; discountPercent: number;
    originalUnitCredits: string; discountedUnitCredits: string;
    taxIncluded: boolean; startsAt: string; endsAt: string;
  }>;
  selloutEstimate: Readonly<{
    kind: 'gross_before_fee'; grossCredits: string; basis: 'remaining_capacity';
    remainingCapacity: string; asOf: string;
    disclosure: '按当前剩余容量全部售完测算，未扣服务费';
  }>;
}>;

export type CreditBalance = Readonly<{
  subjectId: string;
  unit: 'KAI_CREDIT';
  precision: 2;
  available: string;
  reserved: string;
  supplierReceivable: string;
  redeemableSupplierEarnings: string;
  payoutFrozen: string;
  total: string;
}>;

export type CreditPayoutProfile = Readonly<{
  status: 'pending_activation' | 'active' | 'suspended';
  activatedAt: string | null;
}>;

export type CreditPayoutStatus = 'submitted' | 'reviewing' | 'paying' | 'succeeded' | 'failed' | 'rejected' | 'cancelled';
export type CreditPayout = Readonly<{
  id: string;
  payoutNumber: string;
  status: CreditPayoutStatus;
  creditAmount: string;
  freezeTransactionId: string;
  resolutionTransactionId: string | null;
  companyPaymentReference: string | null;
  failureCode: string | null;
  resolutionReason: string | null;
  balances: Readonly<{
    availableBefore: string | null; availableAfter: string | null;
    frozenBefore: string | null; frozenAfter: string | null;
    resolutionAvailableBefore: string | null; resolutionAvailableAfter: string | null;
    resolutionFrozenBefore: string | null; resolutionFrozenAfter: string | null;
  }>;
  reviewedAt: string | null;
  payingAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}>;

export type CreditTopup = Readonly<{
  id: string;
  subjectId: string;
  provider: 'alipay' | 'wechat';
  channel: 'app';
  status: 'created' | 'pending' | 'succeeded' | 'failed' | 'expired' | 'cancelled' | 'manual_review';
  amountCny: string;
  creditAmount: string;
  conversion: '1 KAI卡时 = ¥1.002';
  createdAt: string;
  expiresAt: string;
  succeededAt: string | null;
  recovery: null | Readonly<{ state: 'checking' | 'needs_support'; message: string }>;
  checkoutPayload?: string | null;
}>;

export type CloudPayNotification = Readonly<{
  id: string;
  category: 'order' | 'payment' | 'delivery' | 'market' | 'account' | 'system';
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}>;

export type LegalDocuments = Readonly<{
  terms: { version: string; url: string | null };
  privacy: { version: string; url: string | null };
}>;

export type SubjectPermission =
  | 'subject.manage'
  | 'credits.read'
  | 'orders.read'
  | 'orders.buy'
  | 'orders.dispute.manage'
  | 'provider.read'
  | 'provider.profile.manage'
  | 'provider.resource.manage'
  | 'provider.offer.manage'
  | 'provider.listing.manage'
  | 'provider.order.manage'
  | 'provider.refund.approve';

export type CloudPayOrderStatus = 'reserved' | 'confirmed' | 'provisioning' | 'ready' | 'in_service'
  | 'acceptance_pending' | 'disputed' | 'accepted' | 'release_pending' | 'refund_pending'
  | 'closed' | 'cancelled' | 'expired' | 'refunded';

export type CloudPayOrderAction = 'cancel_order' | 'confirm_order' | 'start_delivery'
  | 'submit_delivery' | 'accept_delivery' | 'report_delivery_issue';

export type CloudPayOrder = Readonly<{
  id: string;
  orderNumber: string;
  status: CloudPayOrderStatus;
  side: 'buyer' | 'provider';
  listingId: string;
  title: string;
  productCode: string | null;
  region: string | null;
  quantity: string;
  capacityUnit: string;
  unitCredits: string;
  totalCredits: string;
  reservationExpiresAt: string;
  confirmedAt: string | null;
  deliveryStartedAt: string | null;
  deliveryReadyAt: string | null;
  acceptedAt: string | null;
  settlementAvailableAt: string | null;
  aftercarePolicy: Readonly<{
    model: 'metering_issue_before_acceptance' | 'delivery_aftercare';
    issueWindowHours: number | null;
    postAcceptanceRefundAvailable: boolean;
  }>;
  actions: CloudPayOrderAction[];
  requiresAttention: boolean;
  createdAt: string;
  updatedAt: string;
}>; 

export type OrderDelivery = Readonly<{
  details: Record<string, unknown>;
  digest: string;
  attemptNumber: number;
  status: 'ready' | 'completed' | 'superseded' | 'refunded';
}>;

export type CloudPayDeliveryDetails = Readonly<{
  endpoint: string;
  instructions: string;
  username?: string;
  temporaryPassword?: string;
}>;

export type CloudPayFulfillmentStatus = 'pending' | 'provisioning' | 'ready' | 'running'
  | 'stopping' | 'stopped' | 'failed';

export type CloudPayFulfillmentAction = 'provision_fulfillment' | 'create_access_session' | 'stop_fulfillment'
  | 'accept_fulfillment' | 'report_fulfillment_issue';

export type CloudPayFulfillment = Readonly<{
  id: string;
  status: CloudPayFulfillmentStatus;
  connection: Readonly<{
    protocol: string;
    host: string;
    port: number;
    hostKeyFingerprint: string;
    knownHostsEntry: string;
    displayName: string;
  }> | null;
  leaseExpiresAt: string | null;
  accessExpiresAt: string | null;
  acceptanceDueAt: string | null;
  acceptanceMode: 'pending' | 'buyer' | 'system' | 'operator' | 'disputed' | null;
  lastError: Readonly<{ code: string; retryable: boolean }> | null;
  startedAt: string | null;
  readyAt: string | null;
  runningAt: string | null;
  stoppedAt: string | null;
}>;

export type CloudPaySshConnection = Readonly<{
  protocol: 'ssh';
  host: string;
  port: number;
  username: 'kai';
  privateKey: string;
  hostKeyFingerprint: string;
  knownHostsEntry: string;
  expiresAt: string;
}>;

export type CloudPayFulfillmentResponse = Readonly<{
  ok: true;
  fulfillment: CloudPayFulfillment | null;
  accessAvailable: boolean;
  usage: Readonly<{
    billingModel: 'metered_capacity';
    purchasedCapacity: string;
    capacityUnit: string;
    consumedCapacity: string;
    purchasedCredits: string;
    consumedCredits: string;
    remainingCredits: string;
    measuredAt: string;
    evidenceDigest: string;
    acceptedAt: string | null;
    issueOpen: boolean;
  }> | null;
  actions: CloudPayFulfillmentAction[];
}>;

export type CloudPayFulfillmentIssue = Readonly<{
  id: string;
  kind: 'access' | 'metering';
  status: 'open' | 'resolved';
  description: string;
  descriptionDigest: string;
  openedAt: string;
  outcome: 'full_refund' | 'partial_refund' | 'reject_refund' | null;
  reason: string | null;
  reasonDigest: string | null;
  decidedAt: string | null;
  settlement: Readonly<{
    meteredCredits: string;
    providerCredits: string;
    buyerRefundCredits: string;
    unusedCredits: string;
    remedyRefundCredits: string;
  }> | null;
}>;

export type OrderDeliveryIssue = Readonly<{
  status: 'open' | 'rework_started' | 'reworked' | 'refunded' | 'escalated' | 'dismissed';
  requestedResolution: 'rework' | 'refund';
  description: string;
  digest: string;
  openedAt: string;
  actions: Array<'start_rework' | 'approve_refund' | 'escalate_dispute'>;
}>;

export type AftercareRefund = Readonly<{
  status: 'pending' | 'escalated' | 'succeeded' | 'rejected';
  description: string;
  descriptionDigest: string;
  creditAmount: string;
  requestedAt: string;
  escalationAvailableAt: string;
  escalatedBySide: 'buyer' | 'provider' | null;
  escalatedAt: string | null;
  providerResponse: string | null;
  providerResponseDigest: string | null;
  outcome: 'full_refund' | 'partial_refund' | 'reject_refund' | null;
  decisionReason: string | null;
  decisionReasonDigest: string | null;
  decidedAt: string | null;
  resolvedAt: string | null;
  actions: Array<'approve_refund' | 'contest_refund' | 'escalate_refund'>;
}>;

export type SupplierSettlement = Readonly<{
  status: 'succeeded';
  creditAmount: string;
  triggeredBy: 'provider' | 'system';
  acceptedAt: string;
  availableAt: string;
  settledAt: string;
}>;

export type AftercareReview = Readonly<{
  order: Readonly<{
    id: string;
    orderNumber: string;
    status: CloudPayOrderStatus;
    title: string;
    productCode: string | null;
    region: string | null;
    quantity: string;
    capacityUnit: string;
    unitCredits: string;
    totalCredits: string;
    deliveryReadyAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  refundId: string;
  escalatedBySide: 'buyer' | 'provider';
  escalatedAt: string;
  description: string;
  descriptionDigest: string;
  creditAmount: string;
  providerResponse: string | null;
  providerResponseDigest: string | null;
  delivery: Readonly<{ attemptNumber: number; details: Record<string, unknown>; digest: string }>;
}>;

export type TradingSubject = Readonly<{
  id: string;
  kind: 'personal' | 'organization';
  displayName: string;
  role: 'owner' | 'admin' | 'provider_manager' | 'provider_operator' | 'viewer';
  status: 'active' | 'suspended' | 'closed';
  selected: boolean;
  permissions: SubjectPermission[];
}>;

export type ProviderWorkspace = Readonly<{
  mode: 'provider';
  sameAccount: true;
  requiresRelogin: false;
  subject: TradingSubject;
  canManage: boolean;
  supplier: null | Readonly<{
    id: string;
    legalName: string;
    status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'suspended';
    rejectionReason: string | null;
  }>;
  resources: Readonly<{
    draft: number;
    awaitingMaterials: number;
    underReview: number;
    verified: number;
    rejected: number;
    suspended: number;
    retired: number;
  }>;
  offers: Readonly<{
    draft: number;
    underReview: number;
    changesRequested: number;
    approved: number;
    rejected: number;
    suspended: number;
    expired: number;
  }>;
  listings: Readonly<{ selling: number; scheduled: number; scheduledPaused: number; paused: number; soldOut: number }>;
  resourceActions: ProviderResourceAction[];
  resume: null | Readonly<{
    kind: 'wizard_draft' | 'offer';
    id: string;
    title: string;
    status: 'draft' | 'under_review' | 'changes_requested' | 'approved' | 'rejected' | 'suspended' | 'expired';
    version: number;
    submissionVersion: number;
    currentStep?: 'service' | 'terms' | 'price' | 'review';
    updatedAt: string;
  }>;
  nextAction: Readonly<{
    key: string;
    label: string;
    route: string;
    entityId: string | null;
  }>;
}>;

export type ProviderResourceAction = Readonly<{
  resourceId: string;
  key: 'resolve_offer_review' | 'reaudit_expired_offer' | 'resume_offer_draft' | 'publish_approved_offer'
    | 'track_offer_review' | 'view_offer_draft' | 'manage_listing' | 'create_offer';
  label: string;
  route: 'provider_offer_editor' | 'provider_offer_review' | 'provider_listing_editor'
    | 'provider_listing_manager' | 'provider_publish';
  entityId: string;
  target: 'offer_revision' | 'wizard_draft' | 'offer_review' | 'offer_listing' | 'listing' | 'resource';
}>;

export type CloudPaySnapshot = {
  online: boolean;
  loading: boolean;
  updatedAt: Date | null;
  resources: MarketResource[];
  listings: MarketCreditListing[];
  listingCatalogOnline: boolean;
  deviceCatalogOnline: boolean;
  priceNotice: string;
  authenticated: boolean;
  user: CloudPayUser | null;
  sessionState: 'anonymous' | 'authenticated' | 'offline';
  notifications: CloudPayNotification[];
  unreadCount: number;
  alipayReady: boolean;
  wechatReady: boolean;
  smsReady: boolean;
  pushReady: boolean;
  releaseReady: boolean;
  releaseBlockers: string[];
  creditCommerceReady: boolean;
  commerceBlockers: string[];
  subjects: TradingSubject[];
  currentSubjectId: string | null;
  creditBalance: CreditBalance | null;
  deviceProducts: DeviceProduct[];
  deviceOrders: DeviceOrder[];
  deviceAssets: DeviceAsset[];
  payoutProfile: CreditPayoutProfile | null;
  payouts: CreditPayout[];
  commerceError: string | null;
  providerWorkspace: ProviderWorkspace | null;
  providerWorkspaceError: string | null;
  providerWorkspaceCachedAt: string | null;
  orders: CloudPayOrder[];
  orderCursors: Readonly<{ buyer: string | null; provider: string | null }>;
  orderErrors: Readonly<{ buyer: string | null; provider: string | null }>;
  aftercareReviews: AftercareReview[];
  error: string | null;
};

type HealthResponse = { ok: boolean };
type ResourcesResponse = { ok: boolean; resources: MarketResource[]; nextCursor: string | null };
type ListingsResponse = { ok: boolean; listings: MarketCreditListing[] };
type LocalE2EDemoCatalogResponse = { ok: true; listings: Array<{
  id: string; resourceId: string; title: string; productCode: string; kind: ResourceKind; region: string;
  productKind: 'hardware_device' | 'compute_capacity';
  fulfillmentMode: 'physical_delivery' | 'compute_sidecar_v1';
  serviceMode: MarketCreditListing['serviceMode']; capacityTotal: string; capacityReserved: string;
  capacitySold: string; capacityAvailable: string; capacityUnit: string; minimumQuantity: string;
  unitCredits: string; status: 'active'; startsAt: string; expiresAt: string;
  shippingEstimate?: string | null;
  demo: NonNullable<MarketCreditListing['demo']>; promotion: MarketCreditListing['promotion'];
  selloutEstimate: MarketCreditListing['selloutEstimate'];
}> };

async function localE2EDemoListings(): Promise<ListingsResponse> {
  const response = await loadLocalE2EDemoCatalog<LocalE2EDemoCatalogResponse>();
  return { ok: response.ok, listings: response.listings.map((listing) => ({
    ...listing,
    offerId: listing.resourceId,
    specifications: { source: 'local_e2e_catalog', productCode: listing.productCode },
    sla: { mode: 'sandbox_preview' },
    auditValidUntil: listing.expiresAt,
    createdAt: listing.startsAt,
    audits: { resource: true, price: true },
    ownedByCurrentSubject: false,
  })) };
}
type ReadinessResponse = {
  ok: boolean;
  capabilities: { sms: boolean; push: boolean; alipay: boolean; wechat: boolean; creditCommerce?: boolean };
  commerce?: { ready: boolean; blockers: string[] };
  release: { ready: boolean; blockers: string[] };
};
type MeResponse = { ok: boolean; user: CloudPayUser };
type NotificationsResponse = {
  ok: boolean;
  notifications: CloudPayNotification[];
  unreadCount: number;
  nextCursor: string | null;
};
type SubjectsResponse = { ok: true; currentSubjectId: string | null; subjects: TradingSubject[] };
type ProviderBootstrapResponse = { ok: true; workspace: ProviderWorkspace };
type OrdersResponse = { ok: true; orders: CloudPayOrder[]; nextCursor: string | null };
type CreditBalanceResponse = { ok: true; balance: CreditBalance };
type DeviceProductsResponse = { ok: true; products: DeviceProduct[] };
type DeviceOrdersResponse = { ok: true; orders: DeviceOrder[] };
type DeviceAssetsResponse = { ok: true; assets: DeviceAsset[] };
type CreditPayoutProfileResponse = { ok: true; profile: CreditPayoutProfile };
type CreditPayoutsResponse = { ok: true; payouts: CreditPayout[] };

function reasonOf(result: PromiseSettledResult<unknown>) {
  if (result.status === 'fulfilled') return null;
  return result.reason instanceof Error ? result.reason.message : '服务暂时不可用。';
}

async function recoverProtectedRead<T>(result: PromiseSettledResult<T>, read: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  if (result.status === 'fulfilled'
    || !(result.reason instanceof ApiError)
    || ![500, 502, 503, 504].includes(result.reason.status)
    || !await loadSession()) return result;
  try {
    return { status: 'fulfilled', value: await read() };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

export async function loadCloudPaySnapshot(): Promise<CloudPaySnapshot> {
  const storedSession = await loadSession();
  const publicReads = Promise.allSettled([
    apiRequest<HealthResponse>('/mobile/v1/health', { retry: false }),
    apiRequest<ResourcesResponse>('/mobile/v1/market/resources?limit=50', { retry: false }),
    apiRequest<ListingsResponse>('/mobile/v1/market/listings?limit=50', { auth: 'optional', retry: false }),
    apiRequest<DeviceProductsResponse>('/mobile/v1/device-products', { auth: 'optional', retry: false }),
    apiRequest<ReadinessResponse>('/mobile/v1/readiness', { retry: false }),
    LOCAL_E2E_DEMO_ENABLED ? localE2EDemoListings() : Promise.resolve({ ok: true, listings: [] } as ListingsResponse),
  ]);

  let user = storedSession?.user ?? null;
  let accountConfirmed = false;
  let notifications: CloudPayNotification[] = [];
  let unreadCount = 0;
  let accountError: string | null = null;
  let subjects: TradingSubject[] = [];
  let currentSubjectId: string | null = null;
  let creditBalance: CreditBalance | null = null;
  let deviceProducts: DeviceProduct[] = [];
  let protectedDeviceCatalogOnline = false;
  let deviceOrders: DeviceOrder[] = [];
  let deviceAssets: DeviceAsset[] = [];
  let payoutProfile: CreditPayoutProfile | null = null;
  let payouts: CreditPayout[] = [];
  let commerceError: string | null = null;
  let providerWorkspace: ProviderWorkspace | null = null;
  let providerWorkspaceError: string | null = null;
  let providerWorkspaceCachedAt: string | null = null;
  let orders: CloudPayOrder[] = [];
  let orderCursors: CloudPaySnapshot['orderCursors'] = { buyer: null, provider: null };
  let orderErrors: CloudPaySnapshot['orderErrors'] = { buyer: null, provider: null };
  let aftercareReviews: AftercareReview[] = [];

  if (storedSession) {
    let [me, activity, subjectResult, balanceResult, providerResult, buyerOrderResult, providerOrderResult,
      deviceProductsResult, deviceOrdersResult, deviceAssetsResult, payoutProfileResult, payoutsResult] = await Promise.allSettled([
      apiRequest<MeResponse>('/mobile/v1/me', { auth: 'required', retry: false }),
      apiRequest<NotificationsResponse>('/mobile/v1/notifications?limit=50', { auth: 'required', retry: false }),
      apiRequest<SubjectsResponse>('/mobile/v1/subjects', { auth: 'required', retry: false }),
      apiRequest<CreditBalanceResponse>('/mobile/v1/credits/balance', { auth: 'required', retry: false }),
      apiRequest<ProviderBootstrapResponse>('/mobile/v1/provider/bootstrap', { auth: 'required', retry: false }),
      apiRequest<OrdersResponse>('/mobile/v1/orders?limit=20&side=buyer', { auth: 'required', retry: false }),
      apiRequest<OrdersResponse>('/mobile/v1/orders?limit=20&side=provider', { auth: 'required', retry: false }),
      apiRequest<DeviceProductsResponse>('/mobile/v1/device-products', { auth: 'required', retry: false }),
      apiRequest<DeviceOrdersResponse>('/mobile/v1/device-orders', { auth: 'required', retry: false }),
      apiRequest<DeviceAssetsResponse>('/mobile/v1/device-assets', { auth: 'required', retry: false }),
      apiRequest<CreditPayoutProfileResponse>('/mobile/v1/credits/payout-profile', { auth: 'required', retry: false }),
      apiRequest<CreditPayoutsResponse>('/mobile/v1/credits/payouts?limit=30', { auth: 'required', retry: false }),
    ]);
    // Keep the fast parallel snapshot, then recover only failed read models one
    // by one. This prevents one busy replica or an embedded acceptance database
    // from leaving a signed-in provider behind a permanent partial-data screen.
    [me, activity, subjectResult, balanceResult, providerResult, buyerOrderResult, providerOrderResult,
      deviceProductsResult, deviceOrdersResult, deviceAssetsResult, payoutProfileResult, payoutsResult] = [
      await recoverProtectedRead(me, () => apiRequest<MeResponse>('/mobile/v1/me', { auth: 'required', retry: false })),
      await recoverProtectedRead(activity, () => apiRequest<NotificationsResponse>('/mobile/v1/notifications?limit=50', { auth: 'required', retry: false })),
      await recoverProtectedRead(subjectResult, () => apiRequest<SubjectsResponse>('/mobile/v1/subjects', { auth: 'required', retry: false })),
      await recoverProtectedRead(balanceResult, () => apiRequest<CreditBalanceResponse>('/mobile/v1/credits/balance', { auth: 'required', retry: false })),
      await recoverProtectedRead(providerResult, () => apiRequest<ProviderBootstrapResponse>('/mobile/v1/provider/bootstrap', { auth: 'required', retry: false })),
      await recoverProtectedRead(buyerOrderResult, () => apiRequest<OrdersResponse>('/mobile/v1/orders?limit=20&side=buyer', { auth: 'required', retry: false })),
      await recoverProtectedRead(providerOrderResult, () => apiRequest<OrdersResponse>('/mobile/v1/orders?limit=20&side=provider', { auth: 'required', retry: false })),
      await recoverProtectedRead(deviceProductsResult, () => apiRequest<DeviceProductsResponse>('/mobile/v1/device-products', { auth: 'required', retry: false })),
      await recoverProtectedRead(deviceOrdersResult, () => apiRequest<DeviceOrdersResponse>('/mobile/v1/device-orders', { auth: 'required', retry: false })),
      await recoverProtectedRead(deviceAssetsResult, () => apiRequest<DeviceAssetsResponse>('/mobile/v1/device-assets', { auth: 'required', retry: false })),
      await recoverProtectedRead(payoutProfileResult, () => apiRequest<CreditPayoutProfileResponse>('/mobile/v1/credits/payout-profile', { auth: 'required', retry: false })),
      await recoverProtectedRead(payoutsResult, () => apiRequest<CreditPayoutsResponse>('/mobile/v1/credits/payouts?limit=30', { auth: 'required', retry: false })),
    ];
    if (me.status === 'fulfilled') {
      user = me.value.user;
      accountConfirmed = true;
      await updateSessionUser(me.value.user);
    } else {
      accountError = reasonOf(me);
      if (me.reason instanceof ApiError && me.reason.status === 401) user = null;
    }
    if (activity.status === 'fulfilled') {
      notifications = activity.value.notifications;
      unreadCount = activity.value.unreadCount;
    } else if (!accountError) {
      accountError = reasonOf(activity);
    }
    if (subjectResult.status === 'fulfilled') {
      subjects = subjectResult.value.subjects;
      currentSubjectId = subjectResult.value.currentSubjectId;
    } else if (!accountError) {
      accountError = reasonOf(subjectResult);
    }
    if (balanceResult.status === 'fulfilled') {
      creditBalance = balanceResult.value.balance;
    } else if (!accountError) {
      accountError = reasonOf(balanceResult);
    }
    if (providerResult.status === 'fulfilled') {
      providerWorkspace = providerResult.value.workspace;
      await saveProviderWorkspaceCache(storedSession.user.id, providerWorkspace.subject.id, providerWorkspace);
    } else {
      providerWorkspaceError = reasonOf(providerResult);
      const cached = await loadProviderReadCache(storedSession.user.id,
        subjectResult.status === 'fulfilled' ? subjectResult.value.currentSubjectId : null);
      if (cached?.workspace) {
        providerWorkspace = cached.workspace;
        providerWorkspaceCachedAt = cached.savedAt;
        if (!currentSubjectId) currentSubjectId = cached.subjectId;
        if (subjects.length === 0) subjects = [cached.workspace.subject];
      }
      if (!accountError) accountError = providerWorkspaceError;
    }
    if (buyerOrderResult.status === 'fulfilled' || providerOrderResult.status === 'fulfilled') {
      orders = [
        ...(buyerOrderResult.status === 'fulfilled' ? buyerOrderResult.value.orders : []),
        ...(providerOrderResult.status === 'fulfilled' ? providerOrderResult.value.orders : []),
      ];
      orderCursors = {
        buyer: buyerOrderResult.status === 'fulfilled' ? buyerOrderResult.value.nextCursor : null,
        provider: providerOrderResult.status === 'fulfilled' ? providerOrderResult.value.nextCursor : null,
      };
    }
    orderErrors = {
      buyer: buyerOrderResult.status === 'rejected' ? reasonOf(buyerOrderResult) : null,
      provider: providerOrderResult.status === 'rejected' ? reasonOf(providerOrderResult) : null,
    };
    if (buyerOrderResult.status === 'rejected' && providerOrderResult.status === 'rejected' && !accountError) {
      accountError = reasonOf(buyerOrderResult) ?? reasonOf(providerOrderResult);
    }
    protectedDeviceCatalogOnline = deviceProductsResult.status === 'fulfilled';
    deviceProducts = deviceProductsResult.status === 'fulfilled' ? deviceProductsResult.value.products : [];
    deviceOrders = deviceOrdersResult.status === 'fulfilled' ? deviceOrdersResult.value.orders : [];
    deviceAssets = deviceAssetsResult.status === 'fulfilled' ? deviceAssetsResult.value.assets : [];
    payoutProfile = payoutProfileResult.status === 'fulfilled' ? payoutProfileResult.value.profile : null;
    payouts = payoutsResult.status === 'fulfilled' ? payoutsResult.value.payouts : [];
    commerceError = [deviceProductsResult, deviceOrdersResult, deviceAssetsResult, payoutProfileResult, payoutsResult]
      .map(reasonOf).find((value): value is string => Boolean(value)) ?? null;
    if (user?.role === 'operator' || user?.role === 'admin') {
      try {
        const reviewResult = await apiRequest<{ ok: true; refunds: AftercareReview[] }>(
          '/mobile/v1/operator/aftercare-refunds?limit=50', { auth: 'required' },
        );
        aftercareReviews = reviewResult.refunds;
      } catch (reason) {
        if (!accountError) accountError = reason instanceof Error ? reason.message : '平台售后队列暂时无法读取。';
      }
    }

    // A concurrent protected request may discover that the refresh family has
    // been revoked and clear SecureStore after another request already returned
    // cached account data. Re-check the session before publishing the snapshot
    // so the UI never presents a stale account beside an unusable workspace.
    const confirmedSession = await loadSession();
    if (!confirmedSession) {
      user = null;
      accountConfirmed = false;
      notifications = [];
      unreadCount = 0;
      subjects = [];
      currentSubjectId = null;
      creditBalance = null;
      providerWorkspace = null;
      providerWorkspaceError = null;
      providerWorkspaceCachedAt = null;
      orders = [];
      orderCursors = { buyer: null, provider: null };
      orderErrors = { buyer: null, provider: null };
      aftercareReviews = [];
      deviceProducts = [];
      deviceOrders = [];
      deviceAssets = [];
      payoutProfile = null;
      payouts = [];
      commerceError = null;
      accountError = '登录已失效，请重新登录。';
    }
  }

  const [health, resourceCatalog, listingCatalog, publicDeviceProducts, readiness, demoCatalog] = await publicReads;

  const serviceOnline = health.status === 'fulfilled' && health.value.ok;
  const resourceData = resourceCatalog.status === 'fulfilled' && Array.isArray(resourceCatalog.value.resources)
    ? resourceCatalog.value.resources
    : [];
  const realListingData = listingCatalog.status === 'fulfilled' && Array.isArray(listingCatalog.value.listings)
    ? listingCatalog.value.listings
    : [];
  const demoListingData = demoCatalog.status === 'fulfilled' && Array.isArray(demoCatalog.value.listings)
    ? demoCatalog.value.listings
    : [];
  const listingData = mergeLocalDemoListings(realListingData, demoListingData);
  if (deviceProducts.length === 0 && publicDeviceProducts.status === 'fulfilled') {
    deviceProducts = publicDeviceProducts.value.products;
  }
  deviceProducts = ensureSparkCampaignProduct(deviceProducts);
  const ready = readiness.status === 'fulfilled' ? readiness.value : null;
  const errors = [reasonOf(health), reasonOf(resourceCatalog), reasonOf(listingCatalog), accountError]
    .filter((value): value is string => Boolean(value));

  return {
    online: serviceOnline,
    loading: false,
    updatedAt: new Date(),
    resources: resourceData,
    listings: listingData,
    listingCatalogOnline: listingCatalog.status === 'fulfilled',
    deviceCatalogOnline: protectedDeviceCatalogOnline || publicDeviceProducts.status === 'fulfilled',
    priceNotice: listingCatalog.status === 'fulfilled'
      ? '市场价格均为审核通过的 KAI 卡时价。'
      : '市场暂时不可连接，下拉即可重试。',
    authenticated: Boolean(user),
    user,
    sessionState: user ? (accountConfirmed ? 'authenticated' : 'offline') : 'anonymous',
    notifications,
    unreadCount,
    alipayReady: ready?.capabilities.alipay ?? false,
    wechatReady: ready?.capabilities.wechat ?? false,
    smsReady: ready?.capabilities.sms ?? false,
    pushReady: ready?.capabilities.push ?? false,
    releaseReady: ready?.release.ready ?? false,
    releaseBlockers: ready?.release.blockers ?? [],
    creditCommerceReady: LOCAL_E2E_DEMO_ENABLED
      || ready?.commerce?.ready
      || ready?.capabilities.creditCommerce
      || false,
    commerceBlockers: LOCAL_E2E_DEMO_ENABLED ? [] : ready?.commerce?.blockers ?? ready?.release.blockers ?? [],
    subjects,
    currentSubjectId,
    creditBalance,
    deviceProducts,
    deviceOrders,
    deviceAssets,
    payoutProfile,
    payouts,
    commerceError,
    providerWorkspace,
    providerWorkspaceError,
    providerWorkspaceCachedAt,
    orders,
    orderCursors,
    orderErrors,
    aftercareReviews,
    error: errors[0] ?? null,
  };
}

export async function loadCachedProviderState() {
  const session = await loadSession();
  if (!session) return null;
  const cached = await loadProviderReadCache(session.user.id);
  if (!cached?.workspace) return null;
  return {
    user: session.user,
    subjectId: cached.subjectId,
    workspace: cached.workspace,
    cachedAt: cached.savedAt,
  };
}

export async function loadCloudPayOrders(side: 'buyer' | 'provider', cursor?: string | null, limit = 20) {
  const query = new URLSearchParams({ side, limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return apiRequest<OrdersResponse>(`/mobile/v1/orders?${query.toString()}`, { auth: 'required' });
}

export async function loadCloudPayOrder(orderId: string) {
  const response = await apiRequest<{ ok: true; order: CloudPayOrder }>(`/mobile/v1/orders/${encodeURIComponent(orderId)}`, {
    auth: 'required',
  });
  return response.order;
}

export async function selectTradingSubject(subjectId: string) {
  const response = await apiRequest<{ ok: true; subject: TradingSubject }>('/mobile/v1/me/current-subject', {
    method: 'PUT', auth: 'required', retry: false, body: { subjectId },
  });
  return response.subject;
}

export async function createOrganizationSubject(displayName: string, requestId: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; subject: TradingSubject }>('/mobile/v1/subjects/organizations', {
    method: 'POST', auth: 'required', retry: false, body: { displayName },
    headers: { 'idempotency-key': requestId },
  });
  return response.subject;
}

export async function loadLegalDocuments() {
  const response = await apiRequest<{ ok: true; documents: LegalDocuments }>('/mobile/v1/legal', { retry: true });
  return response.documents;
}

export async function logoutCloudPay() {
  try {
    await apiRequest<{ ok: true; revoked: boolean }>('/mobile/v1/auth/logout', {
      method: 'POST', auth: 'required', retry: false,
    });
  } finally {
    await clearSession();
  }
}

export async function markNotificationRead(notificationId: string) {
  await apiRequest<{ ok: true; read: true }>(`/mobile/v1/notifications/${encodeURIComponent(notificationId)}/read`, {
    method: 'POST', auth: 'required', retry: false,
  });
}

export async function markAllNotificationsRead() {
  await apiRequest<{ ok: true; updated: number }>('/mobile/v1/notifications/read-all', {
    method: 'POST', auth: 'required', retry: false,
  });
}

function orderActionKey(prefix: string) {
  return `${prefix}:${Crypto.randomUUID()}`;
}

export async function createCloudPayOrder(
  listingId: string,
  quantity: string,
  idempotencyKey: string,
) {
  const response = await apiRequest<{ ok: true; replayed: boolean; order: CloudPayOrder }>('/mobile/v1/orders', {
    method: 'POST', auth: 'required', retry: false, body: { listingId, quantity },
    headers: { 'idempotency-key': idempotencyKey },
  });
  return response.order;
}

export async function loadCreditPayoutProfile() {
  const response = await apiRequest<CreditPayoutProfileResponse>('/mobile/v1/credits/payout-profile', {
    auth: 'required', retry: false,
  });
  return response.profile;
}

export async function loadCreditPayouts() {
  const response = await apiRequest<CreditPayoutsResponse>('/mobile/v1/credits/payouts?limit=30', {
    auth: 'required', retry: false,
  });
  return response.payouts;
}

export async function createCreditPayout(creditAmount: string, idempotencyKey: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; payout: CreditPayout }>('/mobile/v1/credits/payouts', {
    method: 'POST', auth: 'required', retry: false, body: { creditAmount },
    headers: { 'idempotency-key': idempotencyKey },
  });
  return response.payout;
}

export async function cancelCreditPayout(payoutId: string, idempotencyKey = orderActionKey('credit-payout-cancel')) {
  const response = await apiRequest<{ ok: true; replayed: boolean; payout: CreditPayout }>(
    `/mobile/v1/credits/payouts/${encodeURIComponent(payoutId)}/cancel`, {
      method: 'POST', auth: 'required', retry: false, body: {}, headers: { 'idempotency-key': idempotencyKey },
    },
  );
  return response.payout;
}

export async function listCreditTopups() {
  const response = await apiRequest<{ ok: true; topups: CreditTopup[] }>('/mobile/v1/credits/topups?limit=30', {
    auth: 'required', retry: false,
  });
  return response.topups;
}

export async function loadCreditTopup(topupId: string) {
  const response = await apiRequest<{ ok: true; topup: CreditTopup }>(
    `/mobile/v1/credits/topups/${encodeURIComponent(topupId)}`, { auth: 'required', retry: false },
  );
  return response.topup;
}

export async function createCreditTopup(amountCents: number, provider: 'alipay' | 'wechat', idempotencyKey: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; topup: CreditTopup }>('/mobile/v1/credits/topups', {
    method: 'POST', auth: 'required', retry: false,
    body: { amountCents, provider, channel: 'app' },
    headers: { 'idempotency-key': idempotencyKey },
  });
  return response.topup;
}

function orderAction(
  orderId: string,
  path: string,
  prefix: string,
  body: Record<string, unknown> = {},
  idempotencyKey = orderActionKey(prefix),
  retry = false,
) {
  return apiRequest<{ ok: true; replayed: boolean; order: CloudPayOrder }>(
    `/mobile/v1/${path.replace('{orderId}', encodeURIComponent(orderId))}`, {
      method: 'POST', auth: 'required', retry, body,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
}

export function confirmCloudPayOrder(orderId: string, idempotencyKey?: string) {
  return orderAction(orderId, 'provider/orders/{orderId}/confirm', 'order-confirm', {}, idempotencyKey, true);
}

export function cancelCloudPayOrder(orderId: string) {
  return orderAction(orderId, 'orders/{orderId}/cancel', 'order-cancel');
}

export function startCloudPayDelivery(orderId: string, idempotencyKey?: string) {
  return orderAction(orderId, 'provider/orders/{orderId}/delivery/start', 'delivery-start', {}, idempotencyKey, true);
}

export function submitCloudPayDelivery(orderId: string, details: CloudPayDeliveryDetails) {
  return orderAction(orderId, 'provider/orders/{orderId}/delivery/ready', 'delivery-ready', { details });
}

export function acceptCloudPayDelivery(orderId: string) {
  return orderAction(orderId, 'orders/{orderId}/accept', 'delivery-accept');
}

export function loadCloudPaySupplierSettlement(orderId: string) {
  return apiRequest<{ ok: true; order: CloudPayOrder; settlement: SupplierSettlement }>(
    `/mobile/v1/orders/${encodeURIComponent(orderId)}/settlement`, { auth: 'required', retry: false },
  );
}

export function reportCloudPayDeliveryIssue(
  orderId: string,
  requestedResolution: 'rework' | 'refund',
  description: string,
) {
  return orderAction(orderId, 'orders/{orderId}/delivery/issue', 'delivery-issue', {
    requestedResolution, description,
  });
}

export function startCloudPayDeliveryRework(orderId: string) {
  return orderAction(orderId, 'provider/orders/{orderId}/delivery/rework/start', 'delivery-rework');
}

export function approveCloudPayDeliveryRefund(orderId: string) {
  return orderAction(orderId, 'provider/orders/{orderId}/refund/approve', 'delivery-refund');
}

export function escalateCloudPayDeliveryDispute(orderId: string) {
  return orderAction(orderId, 'orders/{orderId}/dispute/escalate', 'delivery-escalate');
}

export async function loadCloudPayDelivery(orderId: string) {
  return apiRequest<{ ok: true; order: CloudPayOrder; delivery: OrderDelivery | null }>(
    `/mobile/v1/orders/${encodeURIComponent(orderId)}/delivery`, { auth: 'required', retry: false },
  );
}

export function loadCloudPayFulfillment(orderId: string) {
  return apiRequest<CloudPayFulfillmentResponse>(
    `/mobile/v1/orders/${encodeURIComponent(orderId)}/fulfillment`, { auth: 'required', retry: false },
  );
}

export function provisionCloudPayFulfillment(orderId: string, idempotencyKey?: string) {
  return apiRequest<CloudPayFulfillmentResponse>(
    `/mobile/v1/provider/orders/${encodeURIComponent(orderId)}/fulfillment/provision`, {
      method: 'POST', auth: 'required', retry: true, body: {},
      headers: { 'idempotency-key': idempotencyKey ?? orderActionKey('fulfillment-provision') },
    },
  );
}

export function createCloudPayAccessSession(orderId: string, idempotencyKey?: string) {
  return apiRequest<Omit<CloudPayFulfillmentResponse, 'fulfillment'> & {
    fulfillment: CloudPayFulfillment; session: CloudPaySshConnection;
  }>(
    `/mobile/v1/orders/${encodeURIComponent(orderId)}/fulfillment/access-session`, {
      method: 'POST', auth: 'required', retry: false, body: {},
      headers: { 'idempotency-key': idempotencyKey ?? orderActionKey('fulfillment-access') },
    },
  );
}

export function stopCloudPayFulfillment(orderId: string, idempotencyKey?: string) {
  return apiRequest<CloudPayFulfillmentResponse & { replayed: boolean }>(
    `/mobile/v1/orders/${encodeURIComponent(orderId)}/fulfillment/stop`, {
      method: 'POST', auth: 'required', retry: true, body: {},
      headers: { 'idempotency-key': idempotencyKey ?? orderActionKey('fulfillment-stop') },
    },
  );
}

export function acceptCloudPayFulfillment(orderId: string, idempotencyKey?: string) {
  return apiRequest<CloudPayFulfillmentResponse & Readonly<{
    settlement: Readonly<{ capturedCredits: string; refundedCredits: string }>;
  }>>(`/mobile/v1/orders/${encodeURIComponent(orderId)}/fulfillment/accept`, {
    method: 'POST', auth: 'required', retry: true, body: {},
    headers: { 'idempotency-key': idempotencyKey ?? orderActionKey('fulfillment-accept') },
  });
}

export function reportCloudPayFulfillmentIssue(
  orderId: string,
  kind: 'access' | 'metering',
  description: string,
  idempotencyKey?: string,
) {
  return apiRequest<Readonly<{ ok: true; issue: Readonly<{
    id: string; kind: 'access' | 'metering'; status: 'open'; openedAt: string;
  }> }>>(
  `/mobile/v1/orders/${encodeURIComponent(orderId)}/fulfillment/issue`, {
    method: 'POST', auth: 'required', retry: true, body: { kind, description },
    headers: { 'idempotency-key': idempotencyKey ?? orderActionKey('fulfillment-issue') },
  });
}

export function loadCloudPayFulfillmentIssue(orderId: string) {
  return apiRequest<Readonly<{ ok: true; issue: CloudPayFulfillmentIssue | null }>>(
    `/mobile/v1/orders/${encodeURIComponent(orderId)}/fulfillment/issue`, { auth: 'required', retry: false },
  );
}

export async function loadCloudPayDeliveryIssue(orderId: string) {
  return apiRequest<{ ok: true; order: CloudPayOrder; issue: OrderDeliveryIssue }>(
    `/mobile/v1/orders/${encodeURIComponent(orderId)}/delivery/issue`, { auth: 'required', retry: false },
  );
}

export async function loadAftercareRefund(orderId: string) {
  const response = await apiRequest<{ ok: true; order: CloudPayOrder; aftercareRefund: AftercareRefund }>(
    `/mobile/v1/orders/${encodeURIComponent(orderId)}/aftercare/refund`, { auth: 'required', retry: false },
  );
  return response;
}

export async function requestAftercareRefund(orderId: string, description: string, creditAmount: string) {
  return apiRequest<{ ok: true; replayed: boolean; order: CloudPayOrder }>(
    `/mobile/v1/orders/${encodeURIComponent(orderId)}/aftercare/refund`, {
      method: 'POST', auth: 'required', retry: false, body: { description, creditAmount },
      headers: { 'idempotency-key': orderActionKey('aftercare-request') },
    },
  );
}

export async function approveAftercareRefund(orderId: string) {
  return apiRequest<{ ok: true; replayed: boolean; order: CloudPayOrder }>(
    `/mobile/v1/provider/orders/${encodeURIComponent(orderId)}/aftercare/refund/approve`, {
      method: 'POST', auth: 'required', retry: false, body: {},
      headers: { 'idempotency-key': orderActionKey('aftercare-approve') },
    },
  );
}

export async function contestAftercareRefund(orderId: string, response: string) {
  return apiRequest<{ ok: true; replayed: boolean; order: CloudPayOrder }>(
    `/mobile/v1/provider/orders/${encodeURIComponent(orderId)}/aftercare/refund/contest`, {
      method: 'POST', auth: 'required', retry: false, body: { response },
      headers: { 'idempotency-key': orderActionKey('aftercare-contest') },
    },
  );
}

export async function escalateAftercareRefund(orderId: string) {
  return apiRequest<{ ok: true; replayed: boolean; order: CloudPayOrder }>(
    `/mobile/v1/orders/${encodeURIComponent(orderId)}/aftercare/refund/escalate`, {
      method: 'POST', auth: 'required', retry: false, body: {},
      headers: { 'idempotency-key': orderActionKey('aftercare-escalate') },
    },
  );
}

export async function decideAftercareRefund(
  orderId: string,
  outcome: 'approve_refund' | 'reject_refund',
  reason: string,
) {
  return apiRequest<{ ok: true; replayed: boolean; decisionId: string; outcome: typeof outcome }>(
    `/mobile/v1/operator/aftercare-refunds/${encodeURIComponent(orderId)}/decision`, {
      method: 'POST', auth: 'required', retry: false, body: { outcome, reason },
      headers: { 'idempotency-key': orderActionKey('aftercare-decision') },
    },
  );
}
