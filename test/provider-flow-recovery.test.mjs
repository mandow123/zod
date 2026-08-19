import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { authSubmissionDisabled, startFreshLegalDocumentLoad } from '../src/auth-legal-documents.ts';
import {
  discardOfferConflict,
  offerConflictCopy,
  reloadLatestOfferAfterConflict,
  shouldPromptOfferConflictResolution,
} from '../src/offer-wizard-form.ts';

test('offer conflict lets the provider reload or leave without overwriting server state', async () => {
  const events = [];
  discardOfferConflict(() => events.push('discard'), () => events.push('close'));
  assert.deepEqual(events, ['discard', 'close']);
  assert.equal(shouldPromptOfferConflictResolution('conflict'), true);
  assert.equal(shouldPromptOfferConflictResolution('saved'), false);

  const draft = { id: 'draft-1' };
  const latestDraft = { id: 'draft-1', version: 2 };
  let hydrated;
  await reloadLatestOfferAfterConflict({
    current: draft,
    discardLocal: () => events.push('discard-draft'),
    loadDraft: async (id) => { assert.equal(id, draft.id); return latestDraft; },
    loadRevision: async () => { throw new Error('revision loader must not run'); },
    hydrate: (value) => { hydrated = value; },
  });
  assert.equal(hydrated, latestDraft);

  const revision = { id: 'revision-1', offerId: 'offer-1' };
  const latestRevision = { ...revision, version: 3 };
  await reloadLatestOfferAfterConflict({
    current: revision,
    discardLocal: () => events.push('discard-revision'),
    loadDraft: async () => { throw new Error('draft loader must not run'); },
    loadRevision: async (offerId) => { assert.equal(offerId, revision.offerId); return latestRevision; },
    hydrate: (value) => { hydrated = value; },
  });
  assert.equal(hydrated, latestRevision);
  assert.equal(offerConflictCopy.exitLabel, '退出不覆盖');
  assert.equal(offerConflictCopy.reloadLabel, '重新读取');
});

test('production login never reuses legal documents from an earlier sheet opening', async () => {
  let documents = { version: 'old' };
  let resolveOld;
  const oldRequest = startFreshLegalDocumentLoad({
    reset: () => { documents = null; },
    load: () => new Promise((resolve) => { resolveOld = resolve; }),
    accept: (value) => { documents = value; },
    reject: (reason) => { throw reason; },
  });
  assert.equal(documents, null);
  oldRequest.cancel();
  resolveOld({ version: 'stale' });
  await oldRequest.settled;
  assert.equal(documents, null);

  const currentRequest = startFreshLegalDocumentLoad({
    reset: () => { documents = null; },
    load: async () => ({ version: 'current' }),
    accept: (value) => { documents = value; },
    reject: (reason) => { throw reason; },
  });
  await currentRequest.settled;
  assert.deepEqual(documents, { version: 'current' });
  assert.equal(authSubmissionDisabled({
    busy: false, externalBusy: false, canStart: true, hasDocuments: true, consented: true,
  }), false);
  assert.equal(authSubmissionDisabled({
    busy: false, externalBusy: false, canStart: true, hasDocuments: false, consented: true,
  }), true);
});

test('listing initial-load failure exposes a retry that reruns the loading effect', async () => {
  const source = await readFile(new URL('../src/ListingPublishSheet.tsx', import.meta.url), 'utf8');
  assert.match(source, /const \[loadRevision, setLoadRevision\] = useState\(0\)/u);
  assert.match(source, /\}, \[loadRevision, offerId, visible\]\)/u);
  assert.match(source, /initialLoadFailed = !loading && Boolean\(error\) && \(!offer \|\| !resource \|\| !approvedPrice\)/u);
  assert.match(source, /setLoadRevision\(\(value\) => value \+ 1\)/u);
  assert.match(source, /accessibilityLabel="重新读取挂牌信息"/u);
});

test('provider node recovery copy is distinct from resource evidence copy', async () => {
  const source = await readFile(new URL('../src/screens/ProviderWorkspaceScreen.tsx', import.meta.url), 'utf8');
  const nodeCopy = source.indexOf("if (key === 'connect_resource_node')");
  const resourceCopy = source.indexOf("if (key.includes('resource'))");
  assert.ok(nodeCopy >= 0 && nodeCopy < resourceCopy);
  assert.match(source, /接入执行节点/u);
  assert.match(source, /执行节点已离线/u);
});

test('offer wizard keeps the active field above the Android keyboard', async () => {
  const source = await readFile(new URL('../src/OfferWizardSheet.tsx', import.meta.url), 'utf8');
  assert.match(source, /behavior=\{Platform\.OS === 'ios' \? 'padding' : 'height'\}/u);
});
