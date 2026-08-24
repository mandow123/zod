import type { CloudPayNotification } from '../api.ts';
import type { AppRouteKey } from '../navigation.ts';
import {
  providerNextNavigation,
  providerOfferMessageDestination,
  type ProviderPublishIntent,
} from '../provider-next-navigation.ts';

export type OfferWizardIntent = Readonly<{
  resumeDraftId?: string;
  resourceId?: string;
  revisionOfferId?: string;
}>;

export type OrderSide = 'buyer' | 'provider';

/** UI-neutral commands that cross a screen boundary. App.tsx is the sole executor. */
export type AppNavigationIntent =
  | Readonly<{ kind: 'navigate'; tab: AppRouteKey }>
  | Readonly<{ kind: 'open-order'; tab: 'messages' | 'orders'; side: OrderSide; orderId: string }>
  | Readonly<{ kind: 'open-resource'; resourceId: string }>
  | Readonly<{ kind: 'open-offer-wizard'; offerWizard: OfferWizardIntent }>
  | Readonly<{ kind: 'open-publish-intent'; publishIntent: ProviderPublishIntent }>
  | Readonly<{ kind: 'reveal-offer'; offerId: string }>
  | Readonly<{ kind: 'publish-listing'; offerId: string }>
  | Readonly<{ kind: 'manage-listing'; listingId: string }>;

export function providerNextIntent(
  route: string,
  entityId: string | null,
  canResumeRevisionDraft: boolean,
): AppNavigationIntent {
  const destination = providerNextNavigation(route, entityId);
  if (destination.orderId) {
    return { kind: 'open-order', tab: 'orders', side: 'provider', orderId: destination.orderId };
  }
  if (destination.resourceId) return { kind: 'open-resource', resourceId: destination.resourceId };
  if (destination.offerResourceId) return { kind: 'open-offer-wizard', offerWizard: { resourceId: destination.offerResourceId } };
  if (destination.publishIntent) return { kind: 'open-publish-intent', publishIntent: destination.publishIntent };
  if (destination.resumeDraftId) return { kind: 'open-offer-wizard', offerWizard: { resumeDraftId: destination.resumeDraftId } };
  if (destination.revisionOfferId) {
    return {
      kind: 'open-offer-wizard',
      offerWizard: canResumeRevisionDraft
        ? { resumeDraftId: destination.revisionOfferId }
        : { revisionOfferId: destination.revisionOfferId },
    };
  }
  if (destination.revealOfferId) return { kind: 'reveal-offer', offerId: destination.revealOfferId };
  if (destination.listingOfferId) return { kind: 'publish-listing', offerId: destination.listingOfferId };
  if (destination.manageListingId) return { kind: 'manage-listing', listingId: destination.manageListingId };
  return { kind: 'navigate', tab: destination.tab };
}

export function messageNavigationIntent(message: CloudPayNotification): AppNavigationIntent | null {
  if (message.data.route === 'provider_order' && typeof message.data.orderId === 'string') {
    return { kind: 'open-order', tab: 'messages', side: 'provider', orderId: message.data.orderId };
  }
  if (message.data.route === 'buyer_order' && typeof message.data.orderId === 'string') {
    return { kind: 'open-order', tab: 'orders', side: 'buyer', orderId: message.data.orderId };
  }
  if (message.data.route === 'provider_resource' && typeof message.data.resourceId === 'string') {
    return { kind: 'open-resource', resourceId: message.data.resourceId };
  }
  return null;
}

export function providerOfferMessageIntent(offerId: string, status: string): AppNavigationIntent {
  const destination = providerOfferMessageDestination(status);
  if (destination === 'revision') return { kind: 'open-offer-wizard', offerWizard: { revisionOfferId: offerId } };
  if (destination === 'listing') return { kind: 'publish-listing', offerId };
  return { kind: 'reveal-offer', offerId };
}

/** Preserves the existing failure path: publish is visible before offer loading begins. */
export async function resolveProviderOfferMessageIntent(
  offerId: string,
  enterPublish: () => void,
  loadOfferStatus: (offerId: string) => Promise<string>,
): Promise<AppNavigationIntent> {
  enterPublish();
  const status = await loadOfferStatus(offerId);
  return providerOfferMessageIntent(offerId, status);
}
