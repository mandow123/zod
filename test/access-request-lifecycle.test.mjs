import assert from 'node:assert/strict';
import test from 'node:test';
import { accessRequestIsCurrent } from '../src/access-request-lifecycle.ts';

const current = {
  mounted: true,
  appState: 'active',
  currentOrderId: 'order-1',
  requestedOrderId: 'order-1',
  currentGeneration: 7,
  requestedGeneration: 7,
};

test('access credentials may be revealed only to the still-active requesting order', () => {
  assert.equal(accessRequestIsCurrent(current), true);
  assert.equal(accessRequestIsCurrent({ ...current, mounted: false }), false);
  assert.equal(accessRequestIsCurrent({ ...current, appState: 'background' }), false);
  assert.equal(accessRequestIsCurrent({ ...current, appState: 'inactive' }), false);
  assert.equal(accessRequestIsCurrent({ ...current, currentOrderId: 'order-2' }), false);
  assert.equal(accessRequestIsCurrent({ ...current, currentGeneration: 8 }), false);
});
