import assert from 'node:assert/strict';
import test from 'node:test';
import { messageNavigationIntent, providerNextIntent } from '../src/core/app-navigation-intents.ts';

test('provider workspace order intent carries provider side into orders', () => {
  assert.deepEqual(providerNextIntent('provider_order', 'order-1', false), {
    kind: 'open-order', tab: 'orders', side: 'provider', orderId: 'order-1',
  });
});

test('message order intents preserve provider and buyer context', () => {
  assert.deepEqual(messageNavigationIntent({ data: { route: 'provider_order', orderId: 'provider-order-1' } }), {
    kind: 'open-order', tab: 'messages', side: 'provider', orderId: 'provider-order-1',
  });
  assert.deepEqual(messageNavigationIntent({ data: { route: 'buyer_order', orderId: 'buyer-order-1' } }), {
    kind: 'open-order', tab: 'orders', side: 'buyer', orderId: 'buyer-order-1',
  });
});
