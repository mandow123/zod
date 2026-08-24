import assert from 'node:assert/strict';
import test from 'node:test';
import {
  messageNavigationIntent,
  providerNextIntent,
  providerOfferMessageIntent,
  resolveProviderOfferMessageIntent,
} from '../src/core/app-navigation-intents.ts';

test('provider actions become UI-neutral navigation intents', () => {
  assert.deepEqual(providerNextIntent('provider_order', 'order-1', false), {
    kind: 'open-order', tab: 'orders', side: 'provider', orderId: 'order-1',
  });
  assert.deepEqual(providerNextIntent('provider_resources', 'resource-1', false), {
    kind: 'open-resource', resourceId: 'resource-1',
  });
  assert.deepEqual(providerNextIntent('provider_onboarding', null, false), {
    kind: 'open-publish-intent', publishIntent: 'supplier',
  });
});

test('revision intents preserve resumable drafts without leaking workspace state', () => {
  assert.deepEqual(providerNextIntent('provider_offer_editor', 'offer-1', true), {
    kind: 'open-offer-wizard', offerWizard: { resumeDraftId: 'offer-1' },
  });
  assert.deepEqual(providerNextIntent('provider_offer_editor', 'offer-1', false), {
    kind: 'open-offer-wizard', offerWizard: { revisionOfferId: 'offer-1' },
  });
});

test('notification data maps to order-side intents before App performs side effects', () => {
  assert.deepEqual(messageNavigationIntent({ data: { route: 'provider_order', orderId: 'order-1' } }), {
    kind: 'open-order', tab: 'messages', side: 'provider', orderId: 'order-1',
  });
  assert.deepEqual(messageNavigationIntent({ data: { route: 'buyer_order', orderId: 'order-2' } }), {
    kind: 'open-order', tab: 'orders', side: 'buyer', orderId: 'order-2',
  });
  assert.deepEqual(messageNavigationIntent({ data: { route: 'provider_resource', resourceId: 'resource-1' } }), {
    kind: 'open-resource', resourceId: 'resource-1',
  });
  assert.equal(messageNavigationIntent({ data: { route: 'unknown' } }), null);
});

test('provider offer status maps to one publish flow intent', () => {
  assert.deepEqual(providerOfferMessageIntent('offer-1', 'approved'), {
    kind: 'publish-listing', offerId: 'offer-1',
  });
  assert.deepEqual(providerOfferMessageIntent('offer-1', 'changes_requested'), {
    kind: 'open-offer-wizard', offerWizard: { revisionOfferId: 'offer-1' },
  });
  assert.deepEqual(providerOfferMessageIntent('offer-1', 'submitted'), {
    kind: 'reveal-offer', offerId: 'offer-1',
  });
});

test('provider offer enters publish before loading and stays there when loading fails', async () => {
  let activeTab = 'messages';
  let tabObservedByLoader = null;
  await assert.rejects(
    resolveProviderOfferMessageIntent(
      'offer-1',
      () => { activeTab = 'publish'; },
      async () => {
        tabObservedByLoader = activeTab;
        throw new Error('offer unavailable');
      },
    ),
    /offer unavailable/u,
  );
  assert.equal(tabObservedByLoader, 'publish');
  assert.equal(activeTab, 'publish');
});
