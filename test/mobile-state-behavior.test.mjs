import assert from 'node:assert/strict';
import test from 'node:test';
import { availableDeviceOrderActions } from '../src/device-order-actions.ts';
import { creditToCnyEstimate, cnyYuanToCreditEstimate } from '../src/format.ts';
import { deviceProductAvailability, listingAvailability, marketAvailability } from '../src/market-availability.ts';
import { beginSubjectTransition, mergeSnapshot } from '../src/snapshot-state.ts';

function snapshot(overrides = {}) {
  return {
    authenticated: true, user: { id: 'user-1' }, currentSubjectId: 'subject-a', subjects: [],
    creditBalance: { subjectId: 'subject-a' }, deviceProducts: [{ id: 'product-a' }],
    deviceOrders: [{ id: 'device-order-a' }], deviceAssets: [{ id: 'asset-a' }],
    payoutProfile: { status: 'active' }, payouts: [{ id: 'payout-a' }], commerceError: null,
    providerWorkspace: null, providerWorkspaceError: null, providerWorkspaceCachedAt: null,
    orders: [], orderCursors: { buyer: null, provider: null }, orderErrors: { buyer: null, provider: null },
    aftercareReviews: [{ refundId: 'refund-a' }], ...overrides,
  };
}

test('trading-subject transition removes every subject-owned read model before refresh', () => {
  const next = beginSubjectTransition(snapshot(), 'subject-b');
  assert.equal(next.currentSubjectId, 'subject-b');
  assert.equal(next.creditBalance, null);
  assert.deepEqual(next.deviceOrders, []);
  assert.deepEqual(next.deviceAssets, []);
  assert.equal(next.payoutProfile, null);
  assert.deepEqual(next.payouts, []);
  assert.deepEqual(next.orders, []);
  assert.deepEqual(next.aftercareReviews, []);
});

test('failed refresh never carries commerce data across trading subjects', () => {
  const current = snapshot();
  const next = snapshot({ currentSubjectId: 'subject-b', commerceError: 'offline', deviceOrders: [], deviceAssets: [], payouts: [] });
  const merged = mergeSnapshot(current, next);
  assert.deepEqual(merged.deviceOrders, []);
  assert.deepEqual(merged.deviceAssets, []);
  assert.deepEqual(merged.payouts, []);
});

test('server-authored device actions override local status fallback', () => {
  assert.deepEqual(availableDeviceOrderActions({ status: 'reserved' }), []);
  assert.deepEqual(availableDeviceOrderActions({ status: 'reserved', side: 'buyer', actions: ['cancel'] }), ['cancel']);
  assert.deepEqual(availableDeviceOrderActions({ status: 'reserved', side: 'provider', actions: ['confirm'] }), ['confirm']);
  assert.deepEqual(availableDeviceOrderActions({ status: 'received', side: 'provider', actions: [] }), []);
});

test('market fails closed for outages, backend blockers, build policy and unsupported delivery', () => {
  const ready = { online: true, listingCatalogOnline: true, creditCommerceReady: true, commerceBlockers: [] };
  assert.deepEqual(marketAvailability({ ...ready, online: false }, true), { allowed: false, reason: '市场连接中断' });
  assert.deepEqual(marketAvailability({ ...ready, creditCommerceReady: false, commerceBlockers: ['PAYMENT'] }, true), { allowed: false, reason: 'PAYMENT' });
  assert.equal(marketAvailability(ready, false).allowed, false);
  assert.equal(listingAvailability(marketAvailability(ready, true), { purchasable: false, blockedReason: '已售罄' }, true).reason, '已售罄');
  assert.equal(listingAvailability(marketAvailability(ready, true), { purchasable: true }, false).allowed, false);
  assert.equal(deviceProductAvailability(marketAvailability(ready, true), { purchasable: true }).allowed, true);
});

test('card-hour previews use decimal integer rounding instead of binary floating point', () => {
  assert.equal(creditToCnyEstimate('2.50'), '2.51');
  assert.equal(creditToCnyEstimate('100000.00'), '100200.00');
  assert.equal(cnyYuanToCreditEstimate(1), '0.99');
  assert.equal(cnyYuanToCreditEstimate(100), '99.80');
  assert.equal(cnyYuanToCreditEstimate(500), '499.00');
  assert.equal(cnyYuanToCreditEstimate(1000), '998.00');
  assert.equal(cnyYuanToCreditEstimate(5000), '4990.01');
});
