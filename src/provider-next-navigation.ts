export type ProviderPublishIntent = 'sell' | 'supplier';
export type ProviderOfferMessageDestination = 'listing' | 'revision' | 'review';

export function providerOfferMessageDestination(status: string): ProviderOfferMessageDestination {
  if (status === 'approved') return 'listing';
  if (status === 'changes_requested' || status === 'rejected') return 'revision';
  return 'review';
}

export function providerOfferMessageActionLabel(status: unknown) {
  return status === 'approved' ? '去上架' : '查看方案';
}

export type ProviderNextNavigation = Readonly<{
  tab: 'orders' | 'workspace' | 'resources' | 'publish' | 'messages';
  orderId?: string;
  resourceId?: string;
  offerResourceId?: string;
  publishIntent?: ProviderPublishIntent;
  resumeDraftId?: string;
  revisionOfferId?: string;
  revealOfferId?: string;
  listingOfferId?: string;
  manageListingId?: string;
}>;

export function providerNextNavigation(route: string, entityId: string | null): ProviderNextNavigation {
  if (route === 'messages') return { tab: 'messages' };
  if (route === 'provider_order') return entityId ? { tab: 'orders', orderId: entityId } : { tab: 'orders' };
  if (route === 'provider_workspace') return { tab: 'workspace' };
  if (route === 'provider_resources') return entityId
    ? { tab: 'resources', resourceId: entityId }
    : { tab: 'resources' };
  if (route === 'provider_onboarding' || route === 'provider_review') {
    return { tab: 'publish', publishIntent: 'supplier' };
  }
  if (route === 'provider_resource_editor') return { tab: 'publish', publishIntent: 'sell' };
  if (route === 'provider_offer_create') return entityId
    ? { tab: 'publish', offerResourceId: entityId }
    : { tab: 'publish' };
  if (route === 'provider_offer_editor') return entityId
    ? { tab: 'publish', revisionOfferId: entityId }
    : { tab: 'publish' };
  if (route === 'provider_offer_review') return entityId
    ? { tab: 'publish', revealOfferId: entityId }
    : { tab: 'publish' };
  if (route === 'provider_listing_editor') return entityId
    ? { tab: 'publish', listingOfferId: entityId }
    : { tab: 'publish' };
  if (route === 'provider_listing_manager') return entityId
    ? { tab: 'publish', manageListingId: entityId }
    : { tab: 'publish' };
  return { tab: 'publish' };
}
