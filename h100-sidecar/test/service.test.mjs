import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { H100SidecarService, loadPolicies } from '../src/service.mjs';
import { StateStore } from '../src/state.mjs';

const ids = { lease: '10000000-0000-4000-8000-000000000001', order: '20000000-0000-4000-8000-000000000001',
  resource: '30000000-0000-4000-8000-000000000001', session: '40000000-0000-4000-8000-000000000001',
  boot: '50000000-0000-4000-8000-000000000001', binding: '60000000-0000-4000-8000-000000000001',
  node: '70000000-0000-4000-8000-000000000001' };
const gpu = 'GPU-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const policyDigest = `sha256:${'b'.repeat(64)}`;

class FakeDocker {
  constructor(workspaceRoot) { this.workspaceRoot = workspaceRoot; this.containers = new Map(); }
  async ensureCapacity() {}
  async ensureNetwork() {}
  projectId(leaseId) { return Number.parseInt(createHash('sha256').update(leaseId).digest('hex').slice(0, 7), 16) + 10_000; }
  async workspace(leaseId) {
    const path = join(this.workspaceRoot, leaseId); await mkdir(join(path, '.access'), { recursive: true, mode: 0o700 });
    await mkdir(join(path, 'data'), { recursive: true, mode: 0o700 }); return path;
  }
  async start({ leaseId, orderId, resourceId, gpuUuids, sshPort }) {
    const name = `kai-lease-${leaseId}`; const workspace = await this.workspace(leaseId);
    const value = { Id: 'a'.repeat(64), State: { Running: true, Health: { Status: 'healthy' } }, Config: { Labels: {
      'com.kai.lease-id': leaseId, 'com.kai.order-id': orderId, 'com.kai.resource-id': resourceId } },
      expected: { leaseId, orderId, resourceId, gpuUuids, sshPort, workspace } };
    this.containers.set(name, value); return { id: value.Id, name, workspace, quotaProjectId: this.projectId(leaseId),
      hostPublicKey: `ssh-ed25519 ${'A'.repeat(44)}`, hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` };
  }
  async verifyGpus() { return `${gpu}, NVIDIA H100 SXM5, 580.173.02`; }
  async waitHealthy(name) { return this.inspect(name); }
  async ensureHostKey() { return { hostPublicKey: `ssh-ed25519 ${'A'.repeat(44)}`,
    hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` }; }
  async listManaged() { return [...this.containers.keys()]; }
  async inspect(name) { return this.containers.get(name) ?? [...this.containers.values()].find((value) => value.Id === name) ?? null; }
  validateContainer(container, expected) {
    assert.deepEqual(container.expected, expected);
  }
  async stop(name) { const value = await this.inspect(name); if (value) value.State.Running = false; }
  async remove(name) {
    for (const [key, value] of this.containers) if (key === name || value.Id === name) this.containers.delete(key);
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kai-sidecar-test-')); const workspaceDirectory = join(root, 'workspaces');
  await mkdir(workspaceDirectory, { recursive: true });
  const config = { stateDirectory: join(root, 'state'), workspaceDirectory, sshPortStart: 22000, sshPortEnd: 22099,
    expectedGpuCount: 8, providerToken: 'p'.repeat(40), ticketSecret: 't'.repeat(40),
    sshPublicHost: 'gpu.example.com', publicOrigin: 'https://sidecar.internal:9443/', accessTtlSeconds: 300 };
  const docker = new FakeDocker(workspaceDirectory); let nowMs = Date.parse('2026-08-14T04:00:00.000Z');
  let mono = 1_000_000_000n;
  const state = new StateStore(config.stateDirectory, config); await state.load();
  const service = new H100SidecarService(config, state, docker, { now: () => new Date(nowMs), monotonicNs: () => mono,
    inspectNvidia: async () => ({ gpus: Array.from({ length: 8 }, (_, index) => ({
      uuid: index === 0 ? gpu : `GPU-${String(index).repeat(8)}-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      model: 'NVIDIA H100 SXM5', driverVersion: '580.173.02', memoryTotalMiB: 98_000,
      migMode: 'Disabled', computeMode: 'Default' })) }) });
  service.bootId = ids.boot; service.policies = { [ids.resource]: { capacityUnit: 'GPU时', allocatedAcceleratorCount: 1,
    bindingId: ids.binding, bindingGeneration: 1, policyDigest, nodeId: ids.node,
    modelPattern: '^NVIDIA H100', minimumMemoryMiB: 90_000, requiredMigMode: 'Disabled', requiredComputeMode: 'Default',
    allowedGpuUuids: [gpu] } };
  const advance = (milliseconds) => { nowMs += milliseconds; mono += BigInt(milliseconds) * 1_000_000n; };
  const provision = () => service.provision({ leaseId: ids.lease, orderId: ids.order, resourceId: ids.resource,
    bindingId: ids.binding, bindingGeneration: 1, policyDigest, nodeId: ids.node,
    quantity: '1.000000', capacityUnit: 'GPU时', allocatedAcceleratorCount: 1,
    hardExpiresAt: new Date(nowMs + 3_600_000).toISOString() });
  return { root, config, docker, state, service, advance, provision };
}

test('the same private backend exchange safely replays after a lost HTTP response without restarting metering', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  const access = await f.service.createAccess(`kai:${ids.lease}`, { sessionId: ids.session, ttlSeconds: 300 });
  const exchanged = await f.service.exchange(ids.session, access.ticket);
  assert.match(exchanged.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----/u);
  const runningAt = f.state.snapshot().leases[ids.lease].runningAt;
  const runningSequence = f.state.snapshot().leases[ids.lease].eventSequence;
  f.advance(10_000);
  assert.deepEqual(await f.service.createAccess(`kai:${ids.lease}`, { sessionId: ids.session, ttlSeconds: 300 }), access);
  assert.deepEqual(await f.service.exchange(ids.session, access.ticket), exchanged);
  assert.equal(f.state.snapshot().leases[ids.lease].runningAt, runningAt);
  assert.equal(f.state.snapshot().leases[ids.lease].eventSequence, runningSequence);
  const restartedState = new StateStore(f.config.stateDirectory, f.config); await restartedState.load();
  const restarted = new H100SidecarService(f.config, restartedState, f.docker, { now: f.service.now,
    monotonicNs: f.service.monotonicNs, inspectNvidia: f.service.inspectNvidia });
  restarted.bootId = ids.boot; restarted.policies = f.service.policies;
  assert.deepEqual(await restarted.exchange(ids.session, access.ticket), exchanged);
  assert.equal(restartedState.snapshot().leases[ids.lease].runningAt, runningAt);
  await assert.rejects(() => f.service.exchange(ids.session, `${access.ticket}invalid`), { code: 'ACCESS_TICKET_INVALID' });
  const persisted = await readFile(join(f.config.stateDirectory, 'state.json'), 'utf8');
  assert.doesNotMatch(persisted, /OPENSSH PRIVATE KEY/u);
  assert.match(f.state.snapshot().sessions[ids.session].encryptedPrivateKey, /^v1\./u);
  const authorized = await readFile(join(f.config.workspaceDirectory, ids.lease, '.access', 'authorized_keys'), 'utf8');
  assert.match(authorized, /^ssh-ed25519 /u);
  f.advance(300_001); await f.service.enforceDeadlines();
  assert.equal(await readFile(join(f.config.workspaceDirectory, ids.lease, '.access', 'authorized_keys'), 'utf8'), '');
  assert.equal(f.state.snapshot().sessions[ids.session], undefined);
});

test('stopping revokes every credential before returning and the stop receipt safely replays', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  const access = await f.service.createAccess(`kai:${ids.lease}`, { sessionId: ids.session, ttlSeconds: 300 });
  await f.service.exchange(ids.session, access.ticket);
  f.advance(60_000);
  const receipt = await f.service.stop(`kai:${ids.lease}`, `stop:${ids.lease}`);
  assert.equal(f.docker.containers.get(`kai-lease-${ids.lease}`).State.Running, false);
  assert.equal(await readFile(join(f.config.workspaceDirectory, ids.lease, '.access', 'authorized_keys'), 'utf8'), '');
  assert.equal(f.state.snapshot().sessions[ids.session].revoked, true);
  assert.equal(f.state.snapshot().sessions[ids.session].encryptedPrivateKey, null);
  await assert.rejects(() => f.service.exchange(ids.session, access.ticket), { code: 'ACCESS_TICKET_INVALID' });
  assert.deepEqual(await f.service.stop(`kai:${ids.lease}`, `stop:${ids.lease}`), receipt);
});

test('a failed container stop keeps access revoked and retries without billing past the first stop request', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  const access = await f.service.createAccess(`kai:${ids.lease}`, { sessionId: ids.session, ttlSeconds: 300 });
  await f.service.exchange(ids.session, access.ticket); f.advance(60_000);
  const stopDocker = f.docker.stop.bind(f.docker); let failOnce = true;
  f.docker.stop = async (name) => {
    if (failOnce) { failOnce = false; throw new Error('simulated docker stop failure'); }
    return stopDocker(name);
  };
  await assert.rejects(() => f.service.stop(`kai:${ids.lease}`, `stop:${ids.lease}`), /docker stop failure/u);
  assert.equal(f.state.snapshot().leases[ids.lease].status, 'stopping');
  assert.equal(f.state.snapshot().sessions[ids.session].revoked, true);
  assert.equal(await readFile(join(f.config.workspaceDirectory, ids.lease, '.access', 'authorized_keys'), 'utf8'), '');
  await assert.rejects(() => f.service.exchange(ids.session, access.ticket), { code: 'ACCESS_TICKET_INVALID' });
  f.advance(120_000);
  const receipt = await f.service.stop(`kai:${ids.lease}`, `stop:${ids.lease}`);
  assert.equal(receipt.consumedCapacityMicros, '16667');
  assert.equal(f.state.snapshot().leases[ids.lease].stoppedAt, new Date(f.service.now()).toISOString());
});

test('container crash before access fails the lease for an immediate full refund', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  f.docker.containers.get(`kai-lease-${ids.lease}`).State.Running = false; await f.service.reconcile();
  const status = await f.service.status(`kai:${ids.lease}`);
  assert.equal(status.status, 'failed'); assert.equal(status.failureCode, 'ACCESS_TARGET_UNAVAILABLE_BEFORE_START');
  assert.equal(f.state.snapshot().leases[ids.lease].runningAt, undefined);
});

test('running container crash stops monotonic metering at detection and caps purchased GPU-hours', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  const access = await f.service.createAccess(`kai:${ids.lease}`, { sessionId: ids.session, ttlSeconds: 300 });
  await f.service.exchange(ids.session, access.ticket);
  f.advance(1_800_000); f.docker.containers.get(`kai-lease-${ids.lease}`).State.Running = false;
  await f.service.reconcile(); const status = await f.service.status(`kai:${ids.lease}`);
  assert.equal(status.status, 'stopped'); assert.equal(status.receipt.consumedCapacityMicros, '500000');
});

test('restart reloads active state and a lost stop response is recovered from status', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  const restartedState = new StateStore(f.config.stateDirectory, f.config); await restartedState.load();
  const restarted = new H100SidecarService(f.config, restartedState, f.docker, { now: f.service.now,
    monotonicNs: f.service.monotonicNs, inspectNvidia: f.service.inspectNvidia });
  restarted.bootId = ids.boot; restarted.policies = f.service.policies; await restarted.reconcile();
  const receipt = await restarted.stop(`kai:${ids.lease}`, `stop:${ids.lease}`);
  const recovered = await restarted.status(`kai:${ids.lease}`);
  assert.equal(recovered.status, 'stopped'); assert.deepEqual(recovered.receipt, receipt);
});

test('reconcile cannot consume a stale container snapshot while provision is in flight', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const originalStart = f.docker.start.bind(f.docker); let release;
  const gate = new Promise((resolve) => { release = resolve; }); let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.docker.start = async (input) => { entered(); await gate; return originalStart(input); };
  const provisioning = f.provision(); await started; const reconciling = f.service.reconcile(); release();
  await Promise.all([provisioning, reconciling]);
  assert.equal(f.state.snapshot().leases[ids.lease].status, 'ready');
  assert.equal(f.docker.containers.get(`kai-lease-${ids.lease}`).State.Running, true);
});

test('issuing or failing to exchange a credential never starts metering', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  const access = await f.service.createAccess(`kai:${ids.lease}`, { sessionId: ids.session, ttlSeconds: 300 });
  assert.equal(f.state.snapshot().leases[ids.lease].status, 'ready');
  await assert.rejects(() => f.service.exchange(ids.session, `${access.ticket}invalid`), { code: 'ACCESS_TICKET_INVALID' });
  f.advance(120_000); const stopped = await f.service.stop(`kai:${ids.lease}`, `stop:${ids.lease}`);
  assert.equal(stopped.consumedCapacityMicros, '0');
});

test('a stale ready state cannot issue credentials or start billing after the container becomes unhealthy', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  const access = await f.service.createAccess(`kai:${ids.lease}`, { sessionId: ids.session, ttlSeconds: 300 });
  f.docker.containers.get(`kai-lease-${ids.lease}`).State.Health.Status = 'unhealthy';
  await assert.rejects(() => f.service.exchange(ids.session, access.ticket), { code: 'LEASE_ACCESS_NOT_HEALTHY' });
  assert.equal(f.state.snapshot().leases[ids.lease].status, 'failed');
  assert.equal(f.state.snapshot().leases[ids.lease].failureCode, 'ACCESS_TARGET_UNAVAILABLE_BEFORE_START');
  assert.equal(f.state.snapshot().leases[ids.lease].runningAt, undefined);
  assert.equal(f.state.snapshot().sessions[ids.session].revoked, true);
  assert.equal((await f.service.status(`kai:${ids.lease}`)).status, 'failed');
});

test('access fails before billing when the exact session key is no longer authorized', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  const access = await f.service.createAccess(`kai:${ids.lease}`, { sessionId: ids.session, ttlSeconds: 300 });
  await writeFile(join(f.config.workspaceDirectory, ids.lease, '.access', 'authorized_keys'), '', { mode: 0o600 });
  await assert.rejects(() => f.service.exchange(ids.session, access.ticket), { code: 'LEASE_ACCESS_NOT_HEALTHY' });
  assert.equal(f.state.snapshot().leases[ids.lease].runningAt, undefined);
  assert.equal(f.state.snapshot().leases[ids.lease].status, 'failed');
});

test('access fails before billing when the assigned GPU can no longer be verified', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  const access = await f.service.createAccess(`kai:${ids.lease}`, { sessionId: ids.session, ttlSeconds: 300 });
  f.docker.verifyGpus = async () => { throw new Error('assigned GPU missing'); };
  await assert.rejects(() => f.service.exchange(ids.session, access.ticket), { code: 'LEASE_ACCESS_NOT_HEALTHY' });
  assert.equal(f.state.snapshot().leases[ids.lease].runningAt, undefined);
  assert.equal(f.state.snapshot().leases[ids.lease].status, 'failed');
});

test('limits each lease to three live sessions and atomically removes expired sessions', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  for (let index = 1; index <= 3; index += 1) {
    await f.service.createAccess(`kai:${ids.lease}`, {
      sessionId: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`, ttlSeconds: 300,
    });
  }
  await assert.rejects(() => f.service.createAccess(`kai:${ids.lease}`, {
    sessionId: '40000000-0000-4000-8000-000000000004', ttlSeconds: 300,
  }), { code: 'LEASE_ACCESS_SESSION_LIMIT' });
  f.advance(300_001); await f.service.enforceDeadlines();
  assert.equal(Object.keys(f.state.snapshot().sessions).length, 0);
});

test('rejects a lease shorter than five minutes before any container is started', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(() => f.service.provision({ leaseId: ids.lease, orderId: ids.order, resourceId: ids.resource,
    bindingId: ids.binding, bindingGeneration: 1, policyDigest, nodeId: ids.node,
    quantity: '0.010000', capacityUnit: 'GPU时', allocatedAcceleratorCount: 1,
    hardExpiresAt: new Date(f.service.now().getTime() + 36_000).toISOString() }), { code: 'LEASE_DURATION_TOO_SHORT' });
  assert.equal(f.docker.containers.size, 0);
});

test('removes a container when health startup consumes the usable lease window', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.docker.waitHealthy = async (name) => { f.advance(3_550_001); return f.docker.inspect(name); };
  await assert.rejects(() => f.provision(), { code: 'LEASE_START_WINDOW_EXHAUSTED' });
  assert.equal(f.docker.containers.size, 0);
  assert.equal(f.state.snapshot().leases[ids.lease].status, 'failed');
});

test('fails closed before container startup when the audited binding contract is absent or mismatched', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const valid = { leaseId: ids.lease, orderId: ids.order, resourceId: ids.resource,
    bindingId: ids.binding, bindingGeneration: 1, policyDigest, nodeId: ids.node,
    quantity: '1.000000', capacityUnit: 'GPU时', allocatedAcceleratorCount: 1,
    hardExpiresAt: new Date(f.service.now().getTime() + 3_600_000).toISOString() };
  const mismatches = [
    { bindingId: '60000000-0000-4000-8000-000000000002' },
    { bindingGeneration: 2 },
    { policyDigest: `sha256:${'c'.repeat(64)}` },
    { nodeId: '70000000-0000-4000-8000-000000000002' },
  ];
  const { bindingId: _bindingId, ...withoutBinding } = valid;
  await assert.rejects(() => f.service.provision(withoutBinding), { code: 'PROVISION_REQUEST_INVALID' });
  for (const mismatch of mismatches) {
    await assert.rejects(() => f.service.provision({ ...valid, ...mismatch }), { code: 'RESOURCE_POLICY_MISMATCH' });
  }
  assert.equal(f.docker.containers.size, 0);
  assert.equal(Object.keys(f.state.snapshot().leases).length, 0);
});

test('persists and signs the exact binding contract and rejects lease replay after a rebind', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = await f.provision(); const lease = f.state.snapshot().leases[ids.lease];
  assert.deepEqual({ bindingId: lease.bindingId, bindingGeneration: lease.bindingGeneration,
    policyDigest: lease.policyDigest, nodeId: lease.nodeId },
  { bindingId: ids.binding, bindingGeneration: 1, policyDigest, nodeId: ids.node });
  assert.deepEqual({ bindingId: first.attestation.bindingId, bindingGeneration: first.attestation.bindingGeneration,
    policyDigest: first.attestation.policyDigest, nodeId: first.attestation.nodeId },
  { bindingId: ids.binding, bindingGeneration: 1, policyDigest, nodeId: ids.node });
  const { signature, ...signedPayload } = first.attestation;
  assert.equal(signature, `hmac-sha256:${createHmac('sha256', f.config.providerToken)
    .update(JSON.stringify(signedPayload)).digest('hex')}`);

  const rebound = { bindingId: '60000000-0000-4000-8000-000000000002', bindingGeneration: 2,
    policyDigest: `sha256:${'c'.repeat(64)}`, nodeId: '70000000-0000-4000-8000-000000000002' };
  f.service.policies = { [ids.resource]: { ...f.service.policies[ids.resource], ...rebound } };
  await assert.rejects(() => f.service.provision({ leaseId: ids.lease, orderId: ids.order, resourceId: ids.resource,
    ...rebound, quantity: '1.000000', capacityUnit: 'GPU时', allocatedAcceleratorCount: 1,
    hardExpiresAt: new Date(f.service.now().getTime() + 3_600_000).toISOString() }),
  { code: 'LEASE_IDEMPOTENCY_CONFLICT' });
});

test('resource policy files require a complete binding contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kai-sidecar-policy-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); const path = join(root, 'policies.json');
  const policy = { bindingId: ids.binding, bindingGeneration: 1, policyDigest, nodeId: ids.node,
    capacityUnit: 'GPU时', allocatedAcceleratorCount: 1, modelPattern: '^NVIDIA H100', minimumMemoryMiB: 90_000,
    requiredMigMode: 'Disabled', requiredComputeMode: 'Default', allowedGpuUuids: [gpu] };
  await writeFile(path, JSON.stringify({ [ids.resource]: policy }));
  assert.deepEqual((await loadPolicies(path))[ids.resource], policy);
  const { nodeId: _nodeId, ...incomplete } = policy;
  await writeFile(path, JSON.stringify({ [ids.resource]: incomplete }));
  await assert.rejects(() => loadPolicies(path), /RESOURCE_POLICY_INVALID/u);
});

test('reconcile fails a not-yet-used lease when the local resource policy has been rebound', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await f.provision();
  f.service.policies = { [ids.resource]: { ...f.service.policies[ids.resource], bindingGeneration: 2,
    bindingId: '60000000-0000-4000-8000-000000000002', policyDigest: `sha256:${'c'.repeat(64)}` } };
  await f.service.reconcile();
  const lease = f.state.snapshot().leases[ids.lease];
  assert.equal(lease.status, 'failed');
  assert.equal(lease.failureCode, 'ACCESS_TARGET_UNAVAILABLE_BEFORE_START');
  assert.equal(f.docker.containers.size, 0);
});
