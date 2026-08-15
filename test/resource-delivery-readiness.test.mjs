import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resourceIsDeliverable, resourceNodeCopy, resourceNodeUiState } from '../src/resource-delivery-readiness.ts';

test('missing node state fails closed as waiting for connection', () => {
  assert.equal(resourceNodeUiState(undefined), 'unbound');
  assert.equal(resourceNodeCopy(undefined).label, '待接入');
  assert.equal(resourceIsDeliverable(undefined), false);
});

test('backend node states map directly to the five user-facing states', () => {
  assert.equal(resourceNodeUiState({ status: 'unbound', label: '', nodeLastSeenAt: null }), 'unbound');
  assert.equal(resourceNodeUiState({ status: 'checking', label: '', nodeLastSeenAt: '2026-08-14T08:00:00.000Z' }), 'checking');
  assert.equal(resourceNodeUiState({ status: 'ready', label: '', nodeLastSeenAt: '2026-08-14T08:00:00.000Z' }), 'ready');
  assert.equal(resourceNodeUiState({ status: 'offline', label: '', nodeLastSeenAt: '2026-08-14T07:00:00.000Z' }), 'offline');
  assert.equal(resourceNodeUiState({ status: 'revoked', label: '', nodeLastSeenAt: null }), 'revoked');
});

test('only the explicit ready state opens selling actions', () => {
  for (const status of ['unbound', 'checking', 'offline', 'revoked']) {
    assert.equal(resourceIsDeliverable({ status, label: '', nodeLastSeenAt: null }), false);
  }
  assert.equal(resourceIsDeliverable({ status: 'ready', label: '', nodeLastSeenAt: null }), true);
});

test('asset actions come from backend while selling and listing still fail closed on backend readiness', async () => {
  const [assetsScreen, wizard, listing] = await Promise.all([
    readFile(new URL('../src/screens/ProviderResourcesScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/OfferWizardSheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/ListingPublishSheet.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(assetsScreen, /asset\.nextAction/u);
  assert.match(assetsScreen, /asset\.deliveryReadiness\.label/u);
  assert.match(wizard, /verified\.filter\(\(item\) => resourceIsDeliverable\(item\.deliveryReadiness\)\)/u);
  assert.match(wizard, /if \(!resourceIsDeliverable\(resource\.deliveryReadiness\)\)/u);
  assert.match(listing, /if \(!resourceIsDeliverable\(resource\.deliveryReadiness\)\)/u);
  assert.match(listing, /disabled=\{!deliverable \|\| submitting/u);
});
