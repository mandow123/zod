import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OutboundNodeClient, canReplaceExpiredNodeClaim, validateNodeClaim } from '../src/node-client.mjs';
import { HeartbeatJournal, normalizeInventory } from '../src/node-protocol.mjs';

const inventory = [
  { uuid: 'GPU-AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', model: 'NVIDIA H100 80GB HBM3', memoryTotalMiB: 81559,
    driverVersion: '580.173.02', cudaVersion: '13.0', migMode: 'Disabled', computeMode: 'Default' },
  { uuid: 'GPU-BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB', model: 'NVIDIA H100 80GB HBM3', memoryTotalMiB: 81559,
    driverVersion: '580.173.02', cudaVersion: '13.0', migMode: 'Disabled', computeMode: 'Default' },
];
const claim = {
  protocolVersion: 1,
  backendBaseUrl: 'https://api.kai.example/',
  deploymentId: '44444444-4444-4444-8444-444444444444',
  claimId: '11111111-1111-4111-8111-111111111111',
  claimToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
  challenge: 'challenge_0123456789ABCDEFGHijklmn',
  expectedPolicyDigest: `sha256:${'a'.repeat(64)}`,
  expiresAt: '2030-08-15T00:00:00.000Z',
  consumePath: '/node/v1/claims/11111111-1111-4111-8111-111111111111/consume',
};
function config(directory) {
  return { stateDirectory: directory, nodeClaimFile: join(directory, 'node-claim.json'), expectedGpuCount: 2,
    backendBaseUrl: 'https://api.kai.example/',
    nodeAgentVersion: '1.0.0', backendRequestTimeoutMs: 5_000, backendCaFile: null,
    nodeRetryMinMs: 250, nodeRetryMaxMs: 1_000, nodeHeartbeatIntervalMs: 10_000 };
}
async function claimFile(directory, value = claim) {
  await writeFile(join(directory, 'node-claim.json'), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(join(directory, 'node-claim.json'), 0o600);
}

test('claim envelope is strict and matches backend protocol v1', () => {
  assert.deepEqual(validateNodeClaim(claim), claim);
  assert.throws(() => validateNodeClaim({ ...claim, protocolVersion: 'kai-node-claim/v1' }), /NODE_CLAIM_INVALID/u);
  assert.throws(() => validateNodeClaim({ ...claim, extra: true }), /NODE_CLAIM_INVALID/u);
  assert.throws(() => validateNodeClaim({ ...claim, backendBaseUrl: 'http://api.kai.example/' }), /BACKEND_URL_INVALID/u);
  assert.throws(() => validateNodeClaim({ ...claim, consumePath: '/other' }), /CONSUME_PATH_INVALID/u);
});

test('claim backend URL must match the independently pinned HTTPS origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kai-outbound-url-pin-')); await claimFile(directory,
    { ...claim, backendBaseUrl: 'https://attacker.example/' });
  const client = new OutboundNodeClient(config(directory)); await client.identity.loadOrCreate();
  await assert.rejects(() => client.loadEnrollmentOrClaim(), /NODE_BACKEND_URL_PIN_MISMATCH/u);
});

test('an expired claim can only be replaced by a fresh claim for the same deployment', () => {
  const existing = validateNodeClaim({ ...claim, expiresAt: '2026-08-15T01:00:00.000Z' });
  const replacement = validateNodeClaim({ ...claim, claimId: '77777777-7777-4777-8777-777777777777',
    claimToken: 'Z'.repeat(43), consumePath: '/node/v1/claims/77777777-7777-4777-8777-777777777777/consume' });
  const now = Date.parse('2026-08-15T02:00:00.000Z');
  assert.equal(canReplaceExpiredNodeClaim(existing, replacement, now), true);
  assert.equal(canReplaceExpiredNodeClaim(existing, { ...replacement,
    deploymentId: '66666666-6666-4666-8666-666666666666' }, now), false);
  assert.equal(canReplaceExpiredNodeClaim({ ...existing, expiresAt: '2030-08-15T01:00:00.000Z' }, replacement, now), false);
});

test('202 claim and replayed heartbeat persist enrollment, clear token, and advance exact journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kai-outbound-node-')); await claimFile(directory);
  const calls = []; let claimAttempts = 0; let heartbeatAttempts = 0;
  const transport = async (request) => {
    calls.push({ ...request, ca: request.ca ? '<ca>' : null });
    if (request.url.pathname.includes('/claims/')) {
      claimAttempts += 1;
      if (claimAttempts === 1) throw new Error('response lost after backend commit');
      return { status: 202, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, node: { replayed: true, nodeId: '22222222-2222-4222-8222-222222222222',
          bindingId: '33333333-3333-4333-8333-333333333333', deploymentId: claim.deploymentId, protocolVersion: 1,
          heartbeatPath: '/node/v1/nodes/22222222-2222-4222-8222-222222222222/heartbeats' } }) };
    }
    heartbeatAttempts += 1;
    if (heartbeatAttempts === 1) throw new Error('connection reset with sensitive transport details');
    const heartbeatRequest = JSON.parse(request.body);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true,
      heartbeat: { replayed: heartbeatAttempts === 2, accepted: true,
        nodeId: '22222222-2222-4222-8222-222222222222', sequence: heartbeatRequest.sequence,
        readiness: heartbeatAttempts === 2 ? 'checking' : 'ready' } }) };
  };
  const logs = []; const times = ['2026-08-15T01:00:00.000Z', '2026-08-15T01:00:01.000Z', '2026-08-15T01:00:02.000Z'];
  const client = new OutboundNodeClient(config(directory), { transport, inspectInventory: async () => inventory,
    bootId: async () => '55555555-5555-4555-8555-555555555555', clock: () => new Date(times.shift() ?? '2026-08-15T01:00:03.000Z'),
    random: () => 0.5, sleep: (ms) => ms === 10_000 ? new Promise(() => {}) : Promise.resolve(), log: (entry) => logs.push(entry) });
  const enrolled = await client.start();
  assert.equal(enrolled.nodeId, '22222222-2222-4222-8222-222222222222');
  await assert.rejects(() => stat(join(directory, 'node-claim.json')), { code: 'ENOENT' });
  assert.equal((await stat(join(directory, 'node-enrollment.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(directory, 'node-enrollment.json'), 'utf8')).policyDigest, claim.expectedPolicyDigest);
  assert.match(calls[0].headers.authorization, /^NodeClaim /u);
  assert.equal(calls[0].headers.authorization, `NodeClaim ${claim.claimToken}`);
  const claimCalls = calls.filter((entry) => entry.url.pathname.includes('/claims/'));
  assert.equal(claimCalls.length, 2);
  assert.equal(claimCalls[0].body, claimCalls[1].body);
  const heartbeatCalls = calls.filter((entry) => entry.url.pathname.includes('/heartbeats'));
  assert.equal(heartbeatCalls.length, 2);
  assert.equal(heartbeatCalls[0].body, heartbeatCalls[1].body);
  assert.equal(JSON.parse(heartbeatCalls[0].body).payloadDigest, undefined);
  assert.equal(JSON.parse(await readFile(join(directory, 'heartbeat-state.json'), 'utf8')).pending, null);
  assert.equal(client.isReady(), false);
  await client.sendHeartbeat();
  assert.equal(client.isReady(), true);
  const logText = JSON.stringify(logs);
  assert.doesNotMatch(logText, new RegExp(claim.claimToken, 'u'));
  assert.doesNotMatch(logText, /GPU-AAAAAAAA/u);
  assert.doesNotMatch(logText, /ed25519:/u);
});

test('401, 409, and 410 failures are fail-closed and retain claim for operator diagnosis', async () => {
  for (const status of [401, 409, 410]) {
    const directory = await mkdtemp(join(tmpdir(), `kai-outbound-denied-${status}-`)); await claimFile(directory);
    const client = new OutboundNodeClient(config(directory), { inspectInventory: async () => inventory,
      clock: () => new Date('2026-08-15T01:00:00.000Z'), transport: async () => ({ status,
        headers: { 'content-type': 'application/json' }, body: '{"error":"denied"}' }) });
    await client.identity.loadOrCreate(); await client.loadEnrollmentOrClaim();
    await assert.rejects(() => client.retry('node_claim_consume', () => client.consumeClaim()),
      new RegExp(`NODE_BACKEND_${status}`, 'u'));
    assert.equal((await stat(join(directory, 'node-claim.json'))).mode & 0o777, 0o600);
    await assert.rejects(() => stat(join(directory, 'node-enrollment.json')), { code: 'ENOENT' });
  }
});

test('restart uses durable enrollment without consuming or requiring another claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kai-outbound-restart-')); await claimFile(directory);
  const first = new OutboundNodeClient(config(directory), { inspectInventory: async () => inventory,
    clock: () => new Date('2026-08-15T01:00:00.000Z'), transport: async () => ({ status: 200,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, node: { replayed: false,
        nodeId: '22222222-2222-4222-8222-222222222222', bindingId: '33333333-3333-4333-8333-333333333333',
        deploymentId: claim.deploymentId, protocolVersion: 1,
        heartbeatPath: '/node/v1/nodes/22222222-2222-4222-8222-222222222222/heartbeats' } }) }) });
  await first.identity.loadOrCreate(); await first.loadEnrollmentOrClaim(); await first.consumeClaim();
  const restarted = new OutboundNodeClient(config(directory), { inspectInventory: async () => inventory });
  await restarted.identity.loadOrCreate(); await restarted.loadEnrollmentOrClaim();
  assert.equal(restarted.enrollment.nodeId, '22222222-2222-4222-8222-222222222222');
  assert.equal(restarted.claim, null);
});

test('restart after a lost claim response replays the exact durable request even after claim expiry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kai-outbound-claim-replay-')); await claimFile(directory);
  let originalBody;
  const first = new OutboundNodeClient(config(directory), { inspectInventory: async () => inventory,
    clock: () => new Date('2026-08-15T01:00:00.000Z'), transport: async (request) => {
      originalBody = request.body; throw new Error('response lost after commit');
    } });
  await first.identity.loadOrCreate(); await first.loadEnrollmentOrClaim();
  await assert.rejects(() => first.consumeClaim(), /NODE_NETWORK_ERROR/u);
  assert.equal((await stat(join(directory, 'node-claim-request.json'))).mode & 0o777, 0o600);

  let replayBody;
  const restarted = new OutboundNodeClient(config(directory), { inspectInventory: async () => {
    throw new Error('a durable replay must not recollect inventory');
  }, clock: () => new Date('2031-08-15T01:00:00.000Z'), transport: async (request) => {
    replayBody = request.body;
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, node: {
      replayed: true, nodeId: '22222222-2222-4222-8222-222222222222',
      bindingId: '33333333-3333-4333-8333-333333333333', deploymentId: claim.deploymentId, protocolVersion: 1,
      heartbeatPath: '/node/v1/nodes/22222222-2222-4222-8222-222222222222/heartbeats' } }) };
  } });
  await restarted.identity.loadOrCreate(); await restarted.loadEnrollmentOrClaim(); await restarted.consumeClaim();
  assert.equal(replayBody, originalBody);
  await assert.rejects(() => stat(join(directory, 'node-claim-request.json')), { code: 'ENOENT' });
  await assert.rejects(() => stat(join(directory, 'node-claim.json')), { code: 'ENOENT' });
});

test('a revoked deployment can reconnect on the same machine without deleting its stable identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kai-outbound-reenroll-')); await claimFile(directory);
  const oldClient = new OutboundNodeClient(config(directory), { inspectInventory: async () => inventory,
    clock: () => new Date('2026-08-15T01:00:00.000Z'), transport: async () => ({ status: 200,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, node: { replayed: false,
        nodeId: '22222222-2222-4222-8222-222222222222', bindingId: '33333333-3333-4333-8333-333333333333',
        deploymentId: claim.deploymentId, protocolVersion: 1,
        heartbeatPath: '/node/v1/nodes/22222222-2222-4222-8222-222222222222/heartbeats' } }) }) });
  await oldClient.identity.loadOrCreate(); await oldClient.loadEnrollmentOrClaim(); await oldClient.consumeClaim();
  const originalPrivateKey = await readFile(join(directory, 'node-ed25519.pem'), 'utf8');
  const oldJournal = new HeartbeatJournal(directory, oldClient.identity, '55555555-5555-4555-8555-555555555555');
  await oldJournal.load(); const normalized = normalizeInventory(inventory);
  await oldJournal.prepare({ nodeId: '22222222-2222-4222-8222-222222222222',
    observedAt: '2026-08-15T01:00:30.000Z', agentVersion: '1.0.0', inventory,
    inventoryDigest: normalized.inventoryDigest, runtimeDigest: normalized.runtimeDigest,
    policyDigest: claim.expectedPolicyDigest });

  const replacement = { ...claim, deploymentId: '66666666-6666-4666-8666-666666666666',
    claimId: '77777777-7777-4777-8777-777777777777', claimToken: 'Z'.repeat(43), challenge: 'Y'.repeat(43),
    consumePath: '/node/v1/claims/77777777-7777-4777-8777-777777777777/consume' };
  await claimFile(directory, replacement); const requests = [];
  const replacementClient = new OutboundNodeClient(config(directory), { inspectInventory: async () => inventory,
    bootId: async () => '55555555-5555-4555-8555-555555555555', clock: () => new Date('2026-08-15T01:01:00.000Z'),
    sleep: (ms) => ms === 10_000 ? new Promise(() => {}) : Promise.resolve(), log: () => undefined,
    transport: async (request) => {
      requests.push(request);
      if (request.url.pathname.includes('/claims/')) return { status: 200, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, node: { replayed: false, nodeId: '88888888-8888-4888-8888-888888888888',
          bindingId: '99999999-9999-4999-8999-999999999999', deploymentId: replacement.deploymentId,
          protocolVersion: 1, heartbeatPath: '/node/v1/nodes/88888888-8888-4888-8888-888888888888/heartbeats' } }) };
      const sent = JSON.parse(request.body);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true,
        heartbeat: { accepted: true, replayed: false, nodeId: '88888888-8888-4888-8888-888888888888',
          sequence: sent.sequence, readiness: 'ready' } }) };
    } });
  const enrolled = await replacementClient.start();
  assert.equal(enrolled.deploymentId, replacement.deploymentId);
  assert.equal(await readFile(join(directory, 'node-ed25519.pem'), 'utf8'), originalPrivateKey);
  const heartbeat = JSON.parse(requests.find((request) => request.url.pathname.includes('/heartbeats')).body);
  assert.equal(heartbeat.nodeId, '88888888-8888-4888-8888-888888888888');
  assert.equal(heartbeat.sequence, '1');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'heartbeat-state.json'), 'utf8')),
    { version: 1, bootId: '55555555-5555-4555-8555-555555555555', sequence: '1', pending: null });
  await assert.rejects(() => stat(join(directory, 'node-claim.json')), { code: 'ENOENT' });
});
