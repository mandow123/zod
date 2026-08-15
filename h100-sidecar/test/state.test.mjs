import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/state.mjs';

test('serializes concurrent updates without losing either mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kai-state-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(root); await store.load();
  await Promise.all([store.update(async (state) => { state.a = 1; }), store.update(async (state) => { state.b = 2; })]);
  assert.deepEqual(store.snapshot(), { version: 1, leases: {}, sessions: {}, a: 1, b: 2 });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')), store.snapshot());
});

test('fails closed on parseable but malformed persisted state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kai-state-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, leases: { bad: {} }, sessions: {} }));
  await assert.rejects(() => new StateStore(root).load(), /SIDECAR_STATE_INVALID/u);
});

test('no-op updates do not fsync state and terminal archives stay individually replayable at scale', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kai-state-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(root); await store.load(); let saves = 0; const original = store.saveValue.bind(store);
  store.saveValue = async (value) => { saves += 1; return original(value); };
  await store.update(async () => undefined); assert.equal(saves, 0);
  for (let index = 0; index < 1_000; index += 1) {
    const leaseId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await store.writeArchive(leaseId, { leaseId, status: 'stopped', consumedCapacityMicros: String(index) });
  }
  assert.deepEqual(await store.archivedLease('10000000-0000-4000-8000-000000000731'), {
    leaseId: '10000000-0000-4000-8000-000000000731', status: 'stopped', consumedCapacityMicros: '731',
  });
  assert.ok((await readFile(join(root, 'state.json'))).byteLength < 1_024);
});

test('persistent quota registry rejects a project collision after restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kai-state-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const first = new StateStore(root); await first.load();
  await first.reserveProject(12345, '10000000-0000-4000-8000-000000000001');
  const restarted = new StateStore(root); await restarted.load();
  await assert.rejects(() => restarted.reserveProject(12345, '10000000-0000-4000-8000-000000000002'),
    /WORKSPACE_QUOTA_PROJECT_COLLISION/u);
});
