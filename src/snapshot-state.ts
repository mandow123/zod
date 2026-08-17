import type { CloudPaySnapshot } from './api';

export const initialSnapshot: CloudPaySnapshot = {
  online: false,
  loading: true,
  updatedAt: null,
  resources: [],
  listings: [],
  listingCatalogOnline: false,
  deviceCatalogOnline: false,
  priceNotice: '正在读取市场数据…',
  authenticated: false,
  user: null,
  sessionState: 'anonymous',
  notifications: [],
  unreadCount: 0,
  alipayReady: false,
  wechatReady: false,
  smsReady: false,
  pushReady: false,
  releaseReady: false,
  releaseBlockers: [],
  creditCommerceReady: false,
  commerceBlockers: [],
  subjects: [],
  currentSubjectId: null,
  creditBalance: null,
  deviceProducts: [],
  deviceOrders: [],
  deviceAssets: [],
  payoutProfile: null,
  payouts: [],
  commerceError: null,
  providerWorkspace: null,
  providerWorkspaceError: null,
  providerWorkspaceCachedAt: null,
  orders: [],
  orderCursors: { buyer: null, provider: null },
  orderErrors: { buyer: null, provider: null },
  aftercareReviews: [],
  error: null,
};

/**
 * Creates an intentionally empty subject-scoped view while a newly selected
 * trading subject is loading. No balance, order, asset or payout may cross the
 * subject boundary, even as a temporary offline fallback.
 */
export function beginSubjectTransition(current: CloudPaySnapshot, subjectId: string): CloudPaySnapshot {
  return {
    ...current,
    currentSubjectId: subjectId,
    subjects: current.subjects.map((subject) => ({ ...subject, selected: subject.id === subjectId })),
    creditBalance: null,
    deviceOrders: [],
    deviceAssets: [],
    payoutProfile: null,
    payouts: [],
    commerceError: null,
    providerWorkspace: null,
    providerWorkspaceError: null,
    providerWorkspaceCachedAt: null,
    orders: [],
    orderCursors: { buyer: null, provider: null },
    orderErrors: { buyer: null, provider: null },
    aftercareReviews: [],
  };
}

export function mergeSnapshot(current: CloudPaySnapshot, next: CloudPaySnapshot): CloudPaySnapshot {
  const sameAccount = Boolean(current.user && next.user && current.user.id === next.user.id);
  if (!sameAccount || !next.authenticated) return next;
  const sameSubject = Boolean(current.currentSubjectId && next.currentSubjectId
    && next.currentSubjectId === current.currentSubjectId);
  const workspaceMatchesSubject = sameSubject
    && current.providerWorkspace?.subject.id === next.currentSubjectId;
  const currentBuyerOrders = current.orders.filter((order) => order.side === 'buyer');
  const currentProviderOrders = current.orders.filter((order) => order.side === 'provider');
  const nextBuyerOrders = next.orders.filter((order) => order.side === 'buyer');
  const nextProviderOrders = next.orders.filter((order) => order.side === 'provider');
  return {
    ...next,
    deviceProducts: next.commerceError && sameSubject ? current.deviceProducts : next.deviceProducts,
    deviceOrders: next.commerceError && sameSubject ? current.deviceOrders : next.deviceOrders,
    deviceAssets: next.commerceError && sameSubject ? current.deviceAssets : next.deviceAssets,
    payoutProfile: next.commerceError && sameSubject ? current.payoutProfile : next.payoutProfile,
    payouts: next.commerceError && sameSubject ? current.payouts : next.payouts,
    providerWorkspace: next.providerWorkspace
      ?? (next.providerWorkspaceError && workspaceMatchesSubject ? current.providerWorkspace : null),
    providerWorkspaceCachedAt: next.providerWorkspace
      ? next.providerWorkspaceCachedAt
      : next.providerWorkspaceError && workspaceMatchesSubject && current.providerWorkspace
        ? current.providerWorkspaceCachedAt ?? current.updatedAt?.toISOString() ?? null
        : null,
    orders: [
      ...(next.orderErrors.buyer && sameSubject ? currentBuyerOrders : nextBuyerOrders),
      ...(next.orderErrors.provider && sameSubject ? currentProviderOrders : nextProviderOrders),
    ],
    orderCursors: {
      buyer: next.orderErrors.buyer && sameSubject ? current.orderCursors.buyer : next.orderCursors.buyer,
      provider: next.orderErrors.provider && sameSubject ? current.orderCursors.provider : next.orderCursors.provider,
    },
  };
}
