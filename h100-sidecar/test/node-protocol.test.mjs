import { createPrivateKey } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HeartbeatJournal, NodeIdentity, canonicalClaimProof, canonicalHeartbeatProof, normalizeInventory,
  protocolPayloadDigest, signNodeProof, verifyNodeProof,
} from '../src/node-protocol.mjs';

const vector = JSON.parse(await readFile(new URL('../../test/fixtures/node-protocol-v1.json', import.meta.url), 'utf8'));

test('sidecar matches shared protocol v1 vectors', () => {
  assert.deepEqual(normalizeInventory(vector.rawInventory), vector.inventory);
  const key = createPrivateKey({ key: vector.privateJwk, format: 'jwk' });
  for (const proof of [
    { canonical: canonicalClaimProof(vector.claim.fields), vector: vector.claim },
    { canonical: canonicalHeartbeatProof(vector.heartbeat.fields), vector: vector.heartbeat },
  ]) {
    assert.equal(proof.canonical, proof.vector.canonical);
    assert.equal(protocolPayloadDigest(proof.canonical), proof.vector.payloadDigest);
    assert.equal(signNodeProof(key, proof.canonical), proof.vector.signature);
    assert.equal(verifyNodeProof(vector.publicKey, proof.canonical, proof.vector.signature), true);
  }
});

test('heartbeat journal persists before send and retries the exact pending event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kai-node-journal-'));
  const identity = new NodeIdentity(directory); await identity.loadOrCreate();
  const journal = new HeartbeatJournal(directory, identity, vector.heartbeat.fields.bootId); await journal.load();
  const fields = { ...vector.heartbeat.fields, nodeId: vector.heartbeat.fields.nodeId };
  delete fields.bootId; delete fields.sequence;
  const first = await journal.prepare(fields); const retry = await journal.prepare({ ...fields, observedAt: '2026-08-14T09:31:00.000Z' });
  assert.deepEqual(retry, first);
  assert.equal((await stat(join(directory, 'node-ed25519.pem'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'heartbeat-state.json'))).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(join(directory, 'heartbeat-state.json'), 'utf8'));
  assert.deepEqual(persisted.pending, first);
  await journal.acknowledge(first.payloadDigest);
  const second = await journal.prepare({ ...fields, observedAt: '2026-08-14T09:31:00.000Z' });
  assert.equal(second.sequence, '2');
});

test('node identity and journal fail closed on corrupt, permissive, or linked state', async () => {
  const keyDirectory = await mkdtemp(join(tmpdir(), 'kai-node-key-'));
  const identity = new NodeIdentity(keyDirectory); await identity.loadOrCreate();
  await chmod(join(keyDirectory, 'node-ed25519.pem'), 0o644);
  await assert.rejects(() => new NodeIdentity(keyDirectory).loadOrCreate(), /NODE_KEY_FILE_INSECURE/);
  await chmod(join(keyDirectory, 'node-ed25519.pem'), 0o600);
  await writeFile(join(keyDirectory, 'node-ed25519.pem'), 'corrupt', { mode: 0o600 });
  await assert.rejects(() => new NodeIdentity(keyDirectory).loadOrCreate(), /NODE_KEY_INVALID/);

  const journalDirectory = await mkdtemp(join(tmpdir(), 'kai-node-state-'));
  const journalIdentity = new NodeIdentity(journalDirectory); await journalIdentity.loadOrCreate();
  const statePath = join(journalDirectory, 'heartbeat-state.json');
  await writeFile(statePath, '{broken', { mode: 0o600 });
  await assert.rejects(() => new HeartbeatJournal(journalDirectory, journalIdentity,
    vector.heartbeat.fields.bootId).load());
  await writeFile(statePath, JSON.stringify({ version: 1, bootId: vector.heartbeat.fields.bootId,
    sequence: '1', pending: { ...vector.heartbeat.fields, signature: vector.heartbeat.signature,
      payloadDigest: vector.heartbeat.payloadDigest } }), { mode: 0o600 });
  await assert.rejects(() => new HeartbeatJournal(journalDirectory, journalIdentity,
    vector.heartbeat.fields.bootId).load(), /HEARTBEAT_STATE_INVALID/);
  await writeFile(statePath, JSON.stringify({ version: 1, bootId: vector.heartbeat.fields.bootId,
    sequence: '0', pending: null }), { mode: 0o600 });
  await chmod(statePath, 0o644);
  await assert.rejects(() => new HeartbeatJournal(journalDirectory, journalIdentity,
    vector.heartbeat.fields.bootId).load(), /HEARTBEAT_STATE_INSECURE/);

  const target = await mkdtemp(join(tmpdir(), 'kai-node-target-')); const parent = await mkdtemp(join(tmpdir(), 'kai-node-link-'));
  await chmod(target, 0o700); await symlink(target, join(parent, 'state'));
  await assert.rejects(() => new NodeIdentity(join(parent, 'state')).loadOrCreate(), /NODE_STATE_DIRECTORY_INSECURE/);
  const permissiveDirectory = await mkdtemp(join(tmpdir(), 'kai-node-permissive-')); await chmod(permissiveDirectory, 0o755);
  await assert.rejects(() => new NodeIdentity(permissiveDirectory).loadOrCreate(), /NODE_STATE_DIRECTORY_INSECURE/);
  const linkedDirectory = await mkdtemp(join(tmpdir(), 'kai-node-file-link-')); const linkedTarget = join(linkedDirectory, 'target');
  await writeFile(linkedTarget, 'corrupt', { mode: 0o600 }); await symlink(linkedTarget, join(linkedDirectory, 'node-ed25519.pem'));
  await assert.rejects(() => new NodeIdentity(linkedDirectory).loadOrCreate(), /NODE_KEY_FILE_INSECURE/);
  const journalLinkDirectory = await mkdtemp(join(tmpdir(), 'kai-node-journal-link-'));
  const linkIdentity = new NodeIdentity(journalLinkDirectory); await linkIdentity.loadOrCreate();
  const journalTarget = join(journalLinkDirectory, 'target-state');
  await writeFile(journalTarget, JSON.stringify({ version: 1, bootId: vector.heartbeat.fields.bootId,
    sequence: '0', pending: null }), { mode: 0o600 });
  await symlink(journalTarget, join(journalLinkDirectory, 'heartbeat-state.json'));
  await assert.rejects(() => new HeartbeatJournal(journalLinkDirectory, linkIdentity,
    vector.heartbeat.fields.bootId).load(), /HEARTBEAT_STATE_INSECURE/);
});
