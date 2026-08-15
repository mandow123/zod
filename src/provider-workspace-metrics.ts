import type { ProviderWorkspace } from './api';

export function providerOrderNeedsAttention(order: Readonly<{
  actions: readonly unknown[]; status?: string; requiresAttention?: boolean;
}>) {
  return order.requiresAttention === true || order.actions.length > 0 || order.status === 'disputed';
}

export function providerOrderSection(orders: ReadonlyArray<Readonly<{
  actions: readonly unknown[]; status?: string; requiresAttention?: boolean;
}>>) {
  const actionable = orders.filter(providerOrderNeedsAttention).length;
  return actionable > 0
    ? { title: '订单处理', count: `${actionable} 笔待处理`, actionable }
    : { title: '近期订单', count: `${orders.length} 笔`, actionable };
}

export function providerWorkspaceMetrics(workspace: ProviderWorkspace) {
  return {
    resourceTotal: Object.values(workspace.resources).reduce((sum, value) => sum + value, 0),
    awaitingReview: workspace.resources.underReview + workspace.offers.underReview,
    needsAction: workspace.resources.awaitingMaterials + workspace.resources.rejected
      + workspace.offers.changesRequested + workspace.offers.rejected + workspace.offers.expired,
  } as const;
}

export function providerWorkspaceRoadmap(workspace: ProviderWorkspace) {
  const supplierDone = workspace.supplier?.status === 'approved';
  const resourceDone = workspace.resources.verified > 0;
  const listingTotal = Object.values(workspace.listings).reduce((sum, count) => sum + count, 0);
  const offerTotal = Object.values(workspace.offers).reduce((sum, count) => sum + count, 0);
  const nodeDone = workspace.resourceActions.some((action) => action.key === 'create_offer') || offerTotal > 0 || listingTotal > 0;
  const offerDone = workspace.offers.approved > 0 || listingTotal > 0;
  const listingDone = listingTotal > 0;
  const firstIncomplete = [supplierDone, resourceDone, nodeDone, offerDone, listingDone].findIndex((value) => !value);
  return { supplierDone, resourceDone, nodeDone, offerDone, listingDone, firstIncomplete } as const;
}
