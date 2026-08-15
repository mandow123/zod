import { createHash, createHmac } from 'node:crypto';
import { readFile, writeFile, rename, chmod, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectNvidia } from './nvidia.mjs';
import { decryptForTicket, encryptForTicket, evidenceDigest, generateSshKeyPair, ticketDigest, ticketFor } from './security.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GPU_UUID = /^GPU-[A-Fa-f0-9-]+$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ACTIVE = new Set(['provisioning', 'ready', 'running', 'stopping']);
const MAX_ACTIVE_SESSIONS_PER_LEASE = 3;
const MIN_LEASE_CAPACITY_MICROS = 83_334n;

export class SidecarError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
function quantityMicros(value) {
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/u.test(value)) throw new SidecarError(400, 'QUANTITY_INVALID');
  const [whole, fraction = ''] = value.split('.'); const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (result <= 0n) throw new SidecarError(400, 'QUANTITY_INVALID'); return result;
}
function nextSequence(state) { state.eventSequence = Number(state.eventSequence ?? 0) + 1; return state.eventSequence; }
function inputDigest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export class H100SidecarService {
  constructor(config, state, docker, options = {}) {
    this.config = config; this.state = state; this.docker = docker; this.inspectNvidia = options.inspectNvidia ?? inspectNvidia;
    this.now = options.now ?? (() => new Date()); this.monotonicNs = options.monotonicNs ?? (() => process.hrtime.bigint());
    this.bootId = null; this.policies = null; this.timer = null; this.maintenancePromise = null; this.accessRequestTimes = new Map();
  }
  async initialize() {
    await this.state.load();
    this.bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    this.policies = await loadPolicies(this.config.resourcePoliciesFile);
    const hardware = await this.inspectNvidia();
    if (hardware.gpus.length !== this.config.expectedGpuCount) throw new Error('EXPECTED_GPU_COUNT_MISMATCH');
    await this.reconcile(); await this.enforceDeadlines();
    this.timer = setInterval(() => void this.maintenance().catch((error) => {
      process.stderr.write(`${JSON.stringify({ level: 'error', event: 'sidecar_maintenance_failed',
        code: error instanceof Error ? error.message : 'UNKNOWN' })}\n`);
    }), 5_000); this.timer.unref();
  }
  async close() { if (this.timer) clearInterval(this.timer); this.timer = null; await this.maintenancePromise; await this.state.drain(); }

  async provision(body) {
    const input = validateProvision(body, this.policies, this.now()); const hardware = await this.inspectNvidia();
    if (await this.state.archivedLease(input.leaseId)) throw new SidecarError(409, 'LEASE_TERMINAL');
    const policy = this.policies[input.resourceId];
    const availableOnNode = new Map(hardware.gpus.map((gpu) => [gpu.uuid, gpu]));
    if (policy.allowedGpuUuids.some((uuid) => !availableOnNode.has(uuid))) throw new SidecarError(503, 'RESOURCE_GPU_NOT_PRESENT');
    for (const uuid of policy.allowedGpuUuids) {
      const device = availableOnNode.get(uuid);
      if (!new RegExp(policy.modelPattern, 'u').test(device.model) || device.memoryTotalMiB < policy.minimumMemoryMiB
        || device.migMode !== policy.requiredMigMode || device.computeMode !== policy.requiredComputeMode) {
        throw new SidecarError(503, 'RESOURCE_GPU_POLICY_MISMATCH');
      }
    }
    const outcome = await this.state.update(async (state) => {
      const prior = state.leases[input.leaseId];
      const digest = inputDigest(input);
      if (prior && prior.inputDigest !== digest) throw new SidecarError(409, 'LEASE_IDEMPOTENCY_CONFLICT');
      if (prior?.status === 'ready' || prior?.status === 'running') return this.provisionResponse(prior, hardware);
      if (prior && !['provisioning'].includes(prior.status)) throw new SidecarError(409, 'LEASE_TERMINAL');
      const used = new Set(Object.values(state.leases).filter((lease) => lease.leaseId !== input.leaseId && ACTIVE.has(lease.status))
        .flatMap((lease) => lease.gpuUuids));
      const gpuUuids = prior?.gpuUuids ?? policy.allowedGpuUuids.filter((uuid) => !used.has(uuid)).slice(0, policy.allocatedAcceleratorCount);
      if (gpuUuids.length !== policy.allocatedAcceleratorCount) throw new SidecarError(409, 'GPU_CAPACITY_UNAVAILABLE');
      const sshPort = prior?.sshPort ?? firstFreePort(state, this.config);
      const createdAt = prior?.createdAt ?? this.now().toISOString();
      const lease = prior ?? { leaseId: input.leaseId, providerLeaseId: `kai:${input.leaseId}`, orderId: input.orderId,
        resourceId: input.resourceId, quantity: input.quantity, quantityMicros: input.quantityMicros,
        bindingId: input.bindingId, bindingGeneration: input.bindingGeneration,
        policyDigest: input.policyDigest, nodeId: input.nodeId,
        capacityUnit: input.capacityUnit, allocatedAcceleratorCount: policy.allocatedAcceleratorCount,
        hardExpiresAt: input.hardExpiresAt, gpuUuids, sshPort, inputDigest: digest, createdAt, status: 'provisioning' };
      state.leases[input.leaseId] = lease;
      const quotaProjectId = this.docker.projectId(input.leaseId);
      if (Object.values(state.leases).some((candidate) => candidate.leaseId !== input.leaseId
        && (candidate.quotaProjectId ?? this.docker.projectId(candidate.leaseId)) === quotaProjectId)) {
        throw new SidecarError(409, 'WORKSPACE_QUOTA_PROJECT_COLLISION');
      }
      await this.state.reserveProject(quotaProjectId, input.leaseId);
      lease.quotaProjectId = quotaProjectId;
      let container;
      try {
        await this.docker.ensureCapacity(Object.values(state.leases).filter((candidate) => ACTIVE.has(candidate.status)).length);
        container = await this.docker.start({ leaseId: input.leaseId, orderId: input.orderId, resourceId: input.resourceId,
          gpuUuids, sshPort });
        lease.quotaProjectId = container.quotaProjectId;
        await this.docker.verifyGpus(container.name, gpuUuids);
        await this.docker.waitHealthy(container.name);
        if (new Date(input.hardExpiresAt).getTime() - this.now().getTime() < 60_000) {
          throw new SidecarError(409, 'LEASE_START_WINDOW_EXHAUSTED');
        }
      } catch (error) {
        if (container?.name) await this.docker.remove(container.name).catch(() => undefined);
        lease.status = 'failed'; lease.failureCode = 'CONTAINER_PROVISION_FAILED'; lease.failedAt = this.now().toISOString();
        lease.eventSequence = nextSequence(state);
        return { error };
      }
      const now = this.now(); const sequence = nextSequence(state);
      Object.assign(lease, { containerId: container.id, containerName: container.name, workspace: container.workspace,
        hostPublicKey: container.hostPublicKey, hostKeyFingerprint: container.hostKeyFingerprint,
        status: 'ready', readyAt: now.toISOString(), eventSequence: sequence });
      return this.provisionResponse(lease, hardware);
    });
    if ('error' in outcome) throw outcome.error;
    return outcome;
  }

  provisionResponse(lease, hardware) {
    const allocated = hardware.gpus.filter((gpu) => lease.gpuUuids.includes(gpu.uuid));
    if (allocated.length !== lease.allocatedAcceleratorCount) throw new SidecarError(503, 'GPU_ATTESTATION_MISMATCH');
    const observedAt = this.now().toISOString();
    const attestation = { nonce: lease.leaseId, observedAt, orderId: lease.orderId, resourceId: lease.resourceId,
      bindingId: lease.bindingId, bindingGeneration: lease.bindingGeneration,
      policyDigest: lease.policyDigest, nodeId: lease.nodeId,
      capacityUnit: lease.capacityUnit, allocatedGpuUuids: lease.gpuUuids, hardExpiresAt: lease.hardExpiresAt,
      hostKeyFingerprint: lease.hostKeyFingerprint, bootId: this.bootId, eventSequence: lease.eventSequence,
      heartbeatId: `heartbeat:${lease.eventSequence}:${lease.leaseId}`,
      acceleratorModel: allocated[0].model, nodeAcceleratorCount: hardware.gpus.length,
      allocatedAcceleratorCount: allocated.length, driverVersion: allocated[0].driverVersion,
      memoryTotalMiB: allocated[0].memoryTotalMiB, migMode: allocated[0].migMode, computeMode: allocated[0].computeMode,
      evidenceDigest: evidenceDigest(this.config.ticketSecret, { observedAt, orderId: lease.orderId,
        resourceId: lease.resourceId, bindingId: lease.bindingId, bindingGeneration: lease.bindingGeneration,
        policyDigest: lease.policyDigest, nodeId: lease.nodeId, gpuUuids: lease.gpuUuids,
        containerId: lease.containerId, sequence: lease.eventSequence }) };
    attestation.signature = responseSignature(this.config.providerToken, attestationSignaturePayload(attestation));
    return { providerLeaseId: lease.providerLeaseId,
      connection: { protocol: 'ssh', host: this.config.sshPublicHost, port: lease.sshPort,
        hostKeyFingerprint: lease.hostKeyFingerprint,
        knownHostsEntry: `[${this.config.sshPublicHost}]:${lease.sshPort} ${lease.hostPublicKey}`,
        displayName: 'KAI H100 安全工作区' },
      attestation };
  }

  async createAccess(providerLeaseId, body) {
    const leaseId = parseProviderLeaseId(providerLeaseId); const sessionId = body?.sessionId;
    if (!UUID.test(sessionId) || !Number.isInteger(body?.ttlSeconds) || body.ttlSeconds < 60
      || body.ttlSeconds > this.config.accessTtlSeconds) throw new SidecarError(400, 'ACCESS_REQUEST_INVALID');
    this.enforceAccessRate(leaseId);
    return this.state.update(async (state) => {
      cleanupSessions(state, this.now());
      const lease = state.leases[leaseId]; const now = this.now();
      if (!lease || !['ready', 'running'].includes(lease.status) || new Date(lease.hardExpiresAt) <= now) {
        throw new SidecarError(409, 'LEASE_ACCESS_UNAVAILABLE');
      }
      const existing = state.sessions[sessionId]; const ticket = ticketFor(this.config.ticketSecret, leaseId, sessionId);
      if (existing) {
        if (existing.leaseId !== leaseId) throw new SidecarError(409, 'SESSION_IDEMPOTENCY_CONFLICT');
        if (existing.revoked || new Date(existing.expiresAt) <= now) throw new SidecarError(409, 'SESSION_EXPIRED');
        return accessResponse(this.config, existing, ticket);
      }
      const activeSessions = Object.values(state.sessions).filter((session) => !session.revoked
        && new Date(session.expiresAt) > now);
      if (activeSessions.filter((session) => session.leaseId === leaseId).length >= MAX_ACTIVE_SESSIONS_PER_LEASE) {
        throw new SidecarError(429, 'LEASE_ACCESS_SESSION_LIMIT');
      }
      if (activeSessions.length >= (this.config.maxActiveSessionsGlobal ?? 64)) {
        throw new SidecarError(429, 'GLOBAL_ACCESS_SESSION_LIMIT');
      }
      const expiresAt = new Date(Math.min(now.getTime() + body.ttlSeconds * 1_000, new Date(lease.hardExpiresAt).getTime()));
      const keys = await generateSshKeyPair(`kai:${leaseId}:${sessionId}`);
      const session = { sessionId, leaseId, orderId: lease.orderId, resourceId: lease.resourceId,
        ticketDigest: ticketDigest(ticket, this.config.ticketSecret), encryptedPrivateKey: encryptForTicket(keys.privateKey, ticket,
          this.config.ticketSecret), publicKey: keys.publicKey, expiresAt: expiresAt.toISOString(), createdAt: now.toISOString(),
        used: false, revoked: false };
      state.sessions[sessionId] = session;
      lease.eventSequence = nextSequence(state);
      await this.syncAuthorizedKeys(state, leaseId);
      return accessResponse(this.config, session, ticket);
    });
  }

  enforceAccessRate(leaseId) {
    const cutoff = this.now().getTime() - 60_000;
    const recent = (this.accessRequestTimes.get(leaseId) ?? []).filter((value) => value > cutoff);
    if (recent.length >= 10) throw new SidecarError(429, 'ACCESS_REQUEST_RATE_LIMIT');
    recent.push(this.now().getTime()); this.accessRequestTimes.set(leaseId, recent);
  }

  async assertAccessUsable(lease, session) {
    try {
      await this.docker.ensureNetwork();
      const container = await this.docker.inspect(lease.containerName);
      if (!container?.State?.Running || container.State?.Health?.Status !== 'healthy') throw new Error('CONTAINER_NOT_HEALTHY');
      this.docker.validateContainer(container, { leaseId: lease.leaseId, orderId: lease.orderId,
        resourceId: lease.resourceId, gpuUuids: lease.gpuUuids, sshPort: lease.sshPort, workspace: lease.workspace });
      await this.docker.verifyGpus(lease.containerName, lease.gpuUuids);
      const workspace = await this.docker.workspace(lease.leaseId);
      if (workspace !== lease.workspace) throw new Error('WORKSPACE_IDENTITY_MISMATCH');
      const authorized = (await readFile(join(workspace, '.access', 'authorized_keys'), 'utf8')).split(/\r?\n/u);
      if (!authorized.includes(session.publicKey)) throw new Error('SESSION_PUBLIC_KEY_NOT_AUTHORIZED');
    } catch {
      throw new SidecarError(503, 'LEASE_ACCESS_NOT_HEALTHY');
    }
  }

  async exchange(sessionId, ticket) {
    if (!UUID.test(sessionId) || typeof ticket !== 'string') throw new SidecarError(401, 'ACCESS_TICKET_INVALID');
    const outcome = await this.state.update(async (state) => {
      const session = state.sessions[sessionId]; const now = this.now(); const lease = session && state.leases[session.leaseId];
      if (!session || !lease || session.revoked || new Date(session.expiresAt) <= now
        || ticketDigest(ticket, this.config.ticketSecret) !== session.ticketDigest
        || typeof session.encryptedPrivateKey !== 'string'
        || !['ready', 'running'].includes(lease.status)) throw new SidecarError(401, 'ACCESS_TICKET_INVALID');
      try { await this.assertAccessUsable(lease, session); }
      catch (error) {
        if (lease.status !== 'ready' || lease.runningAt) throw error;
        await this.revokeLeaseSessions(state, lease.leaseId);
        await this.docker.stop(lease.containerName).catch(() => undefined);
        await this.docker.remove(lease.containerName).catch(() => undefined);
        Object.assign(lease, { status: 'failed', failureCode: 'ACCESS_TARGET_UNAVAILABLE_BEFORE_START',
          failedAt: now.toISOString(), eventSequence: nextSequence(state) });
        return { error };
      }
      const privateKey = decryptForTicket(session.encryptedPrivateKey, ticket, this.config.ticketSecret);
      if (!session.used) {
        session.used = true; session.exchangedAt = now.toISOString();
        if (lease.status === 'ready') Object.assign(lease, { status: 'running', runningAt: now.toISOString(),
          runningMonoNs: this.monotonicNs().toString(), runningBootId: this.bootId });
        lease.eventSequence = nextSequence(state);
      }
      return { value: { protocol: 'ssh', host: this.config.sshPublicHost, port: lease.sshPort, username: 'kai',
        privateKey, hostKeyFingerprint: lease.hostKeyFingerprint,
        knownHostsEntry: `[${this.config.sshPublicHost}]:${lease.sshPort} ${lease.hostPublicKey}`,
        expiresAt: session.expiresAt } };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  async stop(providerLeaseId, operationId) {
    const leaseId = parseProviderLeaseId(providerLeaseId);
    if (!/^[A-Za-z0-9:_-]{8,200}$/u.test(operationId)) throw new SidecarError(400, 'STOP_OPERATION_INVALID');
    const archived = await this.state.archivedLease(leaseId);
    if (archived) {
      if (archived.status !== 'stopped' || archived.stopOperationId !== operationId) throw new SidecarError(409, 'STOP_OPERATION_CONFLICT');
      return this.stopResponse(archived);
    }
    const prepared = await this.state.update(async (state) => {
      const lease = state.leases[leaseId]; if (!lease) throw new SidecarError(404, 'LEASE_NOT_FOUND');
      if (lease.stopOperationId && lease.stopOperationId !== operationId) throw new SidecarError(409, 'STOP_OPERATION_CONFLICT');
      if (lease.status === 'stopped') return { receipt: this.stopResponse(lease) };
      if (!['ready', 'running', 'stopping'].includes(lease.status)) throw new SidecarError(409, 'LEASE_NOT_STOPPABLE');
      if (lease.status !== 'stopping' || !lease.stopRequestedAt) {
        Object.assign(lease, { status: 'stopping', stopOperationId: operationId,
          stopRequestedAt: this.now().toISOString(), stopRequestedMonoNs: this.monotonicNs().toString(),
          stopRequestedBootId: this.bootId, eventSequence: nextSequence(state) });
      }
      await this.revokeLeaseSessions(state, leaseId);
      return { containerName: lease.containerName };
    });
    if (prepared.receipt) return prepared.receipt;
    await this.docker.stop(prepared.containerName);
    return this.state.update(async (state) => {
      const lease = state.leases[leaseId]; if (!lease) throw new SidecarError(404, 'LEASE_NOT_FOUND');
      if (lease.status === 'stopped' && lease.stopOperationId === operationId) return this.stopResponse(lease);
      if (lease.status !== 'stopping' || lease.stopOperationId !== operationId) {
        throw new SidecarError(409, 'STOP_OPERATION_CONFLICT');
      }
      this.finalizeStopped(state, lease, this.now(), operationId, 'requested');
      return this.stopResponse(lease);
    });
  }

  async status(providerLeaseId) {
    const leaseId = parseProviderLeaseId(providerLeaseId);
    await this.reconcile();
    const lease = this.state.snapshot().leases[leaseId] ?? await this.state.archivedLease(leaseId);
    if (!lease) throw new SidecarError(404, 'LEASE_NOT_FOUND');
    if (lease.status === 'stopped') return { status: 'stopped', receipt: this.stopResponse(lease) };
    if (lease.status === 'failed') return { status: 'failed', failureCode: lease.failureCode ?? 'SIDECAR_LEASE_FAILED',
      providerLeaseId: lease.providerLeaseId, eventSequence: lease.eventSequence };
    return { status: lease.status, providerLeaseId: lease.providerLeaseId, eventSequence: lease.eventSequence,
      hardExpiresAt: lease.hardExpiresAt };
  }

  stopResponse(lease) {
    const response = { providerLeaseId: lease.providerLeaseId, operationId: lease.stopOperationId,
      consumedCapacityMicros: lease.consumedCapacityMicros, meteringEvidenceDigest: lease.meteringEvidenceDigest,
      stoppedAt: lease.stoppedAt, bootId: lease.stoppedBootId, eventSequence: lease.eventSequence };
    response.receiptSignature = responseSignature(this.config.providerToken, response); return response;
  }

  consumedMicros(lease, stoppedAt) {
    if (!lease.runningAt) return 0n;
    const requestedAt = lease.stopRequestedAt ? new Date(lease.stopRequestedAt) : null;
    const meteringEndedAt = requestedAt && requestedAt <= stoppedAt ? requestedAt : stoppedAt;
    let elapsedNs;
    if (lease.runningBootId === this.bootId && lease.runningMonoNs && lease.stopRequestedBootId === this.bootId
      && lease.stopRequestedMonoNs) elapsedNs = BigInt(lease.stopRequestedMonoNs) - BigInt(lease.runningMonoNs);
    else elapsedNs = BigInt(Math.max(0, meteringEndedAt.getTime() - new Date(lease.runningAt).getTime())) * 1_000_000n;
    if (elapsedNs < 0n) elapsedNs = 0n;
    const measured = (elapsedNs * BigInt(lease.allocatedAcceleratorCount) * 1_000_000n + 3_599_999_999_999n)
      / 3_600_000_000_000n;
    return measured > BigInt(lease.quantityMicros) ? BigInt(lease.quantityMicros) : measured;
  }

  finalizeStopped(state, lease, stoppedAt, operationId, reason) {
    const consumed = this.consumedMicros(lease, stoppedAt); const sequence = nextSequence(state);
    Object.assign(lease, { status: 'stopped', stopOperationId: operationId, stoppedAt: stoppedAt.toISOString(),
      consumedCapacityMicros: consumed.toString(), stoppedBootId: this.bootId, stopReason: reason,
      meteringEvidenceDigest: evidenceDigest(this.config.ticketSecret, { providerLeaseId: lease.providerLeaseId,
        operationId, orderId: lease.orderId, resourceId: lease.resourceId, gpuUuids: lease.gpuUuids,
        runningAt: lease.runningAt ?? null, stoppedAt: stoppedAt.toISOString(), consumed: consumed.toString(),
        meteringEndedAt: lease.stopRequestedAt ?? stoppedAt.toISOString(),
        bootId: this.bootId, sequence }), eventSequence: sequence });
  }

  async revokeLeaseSessions(state, leaseId) {
    for (const session of Object.values(state.sessions)) if (session.leaseId === leaseId) {
      session.revoked = true; session.encryptedPrivateKey = null;
    }
    await this.syncAuthorizedKeys(state, leaseId);
  }

  async syncAuthorizedKeys(state, leaseId) {
    const lease = state.leases[leaseId]; if (!lease?.workspace) return;
    const verifiedWorkspace = await this.docker.workspace(leaseId);
    if (verifiedWorkspace !== lease.workspace) throw new Error('WORKSPACE_IDENTITY_MISMATCH');
    const directory = join(verifiedWorkspace, '.access'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const now = this.now(); const keys = Object.values(state.sessions).filter((session) => session.leaseId === leaseId
      && !session.revoked && new Date(session.expiresAt) > now).map((session) => session.publicKey);
    const temporary = join(directory, `.authorized_keys-${process.pid}.tmp`); const target = join(directory, 'authorized_keys');
    await writeFile(temporary, keys.length ? `${keys.join('\n')}\n` : '', { mode: 0o600 });
    await rename(temporary, target); await chmod(target, 0o600);
    const file = await open(target, 'r'); try { await file.sync(); } finally { await file.close(); }
    const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
  }

  async maintenance() {
    if (this.maintenancePromise) return this.maintenancePromise;
    this.maintenancePromise = (async () => {
      await this.reconcile(); await this.enforceDeadlines();
      await this.state.archiveTerminals(new Date(this.now().getTime() - 48 * 3_600_000),
        async (lease) => this.docker.cleanupWorkspace(lease));
    })();
    try { await this.maintenancePromise; } finally { this.maintenancePromise = null; }
  }

  async enforceDeadlines() {
    const now = this.now(); const snapshot = this.state.snapshot();
    for (const lease of Object.values(snapshot.leases)) {
      if (['ready', 'running', 'stopping'].includes(lease.status) && new Date(lease.hardExpiresAt) <= now) {
        await this.stop(lease.providerLeaseId, lease.stopOperationId ?? `deadline:${lease.leaseId}`);
      }
    }
    await this.state.update(async (state) => {
      for (const session of Object.values(state.sessions)) {
        if (!session.revoked && new Date(session.expiresAt) <= now) {
          session.revoked = true; session.encryptedPrivateKey = null;
        }
      }
      for (const lease of Object.values(state.leases)) await this.syncAuthorizedKeys(state, lease.leaseId);
      cleanupSessions(state, now);
    });
  }

  async reconcile() {
    await this.state.update(async (state) => {
      let networkValid = true; try { await this.docker.ensureNetwork(); } catch { networkValid = false; }
      const managed = new Map(); const duplicates = new Set();
      for (const id of await this.docker.listManaged()) {
        const inspected = await this.docker.inspect(id); const leaseId = inspected?.Config?.Labels?.['com.kai.lease-id'];
        if (!UUID.test(leaseId)) { await this.docker.stop(id); await this.docker.remove(id); continue; }
        if (duplicates.has(leaseId)) { await this.docker.stop(id); await this.docker.remove(id); continue; }
        if (managed.has(leaseId)) {
          const prior = managed.get(leaseId); await this.docker.stop(prior.Id); await this.docker.remove(prior.Id);
          await this.docker.stop(id); await this.docker.remove(id); managed.delete(leaseId); duplicates.add(leaseId); continue;
        }
        managed.set(leaseId, inspected);
      }
      const seenGpu = new Set();
      for (const lease of Object.values(state.leases)) {
        if (!ACTIVE.has(lease.status)) continue;
        const container = managed.get(lease.leaseId);
        const policy = this.policies?.[lease.resourceId];
        let policyValid = Boolean(container) && networkValid && Boolean(policy)
          && policy.bindingId === lease.bindingId && policy.bindingGeneration === lease.bindingGeneration
          && policy.policyDigest === lease.policyDigest && policy.nodeId === lease.nodeId
          && policy.allocatedAcceleratorCount === lease.allocatedAcceleratorCount
          && lease.gpuUuids.every((uuid) => policy.allowedGpuUuids.includes(uuid));
        if (container) {
          try { this.docker.validateContainer(container, { leaseId: lease.leaseId, orderId: lease.orderId,
            resourceId: lease.resourceId, gpuUuids: lease.gpuUuids, sshPort: lease.sshPort, workspace: lease.workspace }); }
          catch { policyValid = false; }
          try {
            const hostKey = await this.docker.ensureHostKey(lease.workspace);
            if (hostKey.hostPublicKey !== lease.hostPublicKey || hostKey.hostKeyFingerprint !== lease.hostKeyFingerprint) {
              policyValid = false;
            }
          } catch { policyValid = false; }
        }
        const unhealthy = container?.State?.Running && container?.State?.Health?.Status !== 'healthy';
        if (unhealthy) lease.unhealthyObservations = Number(lease.unhealthyObservations ?? 0) + 1;
        else lease.unhealthyObservations = 0;
        const invalid = !container || !container.State?.Running || !policyValid || lease.unhealthyObservations >= 3
          || lease.gpuUuids.some((uuid) => seenGpu.has(uuid));
        if (invalid) {
          if (container) { await this.docker.stop(container.Id); await this.docker.remove(container.Id); }
          await this.revokeLeaseSessions(state, lease.leaseId);
          if (lease.status === 'ready' && !lease.runningAt) {
            Object.assign(lease, { status: 'failed', failureCode: 'ACCESS_TARGET_UNAVAILABLE_BEFORE_START',
              failedAt: this.now().toISOString(), eventSequence: nextSequence(state) });
          } else {
            this.finalizeStopped(state, lease, this.now(), lease.stopOperationId ?? `reconcile:${lease.leaseId}`,
              'container_invalid');
          }
          continue;
        }
        lease.gpuUuids.forEach((uuid) => seenGpu.add(uuid)); managed.delete(lease.leaseId);
      }
      for (const orphan of managed.values()) { await this.docker.stop(orphan.Id); await this.docker.remove(orphan.Id); }
    });
  }
}

function validateProvision(body, policies, now) {
  if (!body || !UUID.test(body.leaseId) || !UUID.test(body.orderId) || !UUID.test(body.resourceId)
    || !UUID.test(body.bindingId) || !Number.isSafeInteger(body.bindingGeneration) || body.bindingGeneration < 1
    || !SHA256_DIGEST.test(body.policyDigest) || !UUID.test(body.nodeId)
    || body.capacityUnit !== 'GPU时' || !Number.isInteger(body.allocatedAcceleratorCount)
    || typeof body.hardExpiresAt !== 'string') throw new SidecarError(400, 'PROVISION_REQUEST_INVALID');
  const policy = policies[body.resourceId];
  if (!policy || policy.capacityUnit !== body.capacityUnit
    || policy.allocatedAcceleratorCount !== body.allocatedAcceleratorCount
    || policy.bindingId !== body.bindingId || policy.bindingGeneration !== body.bindingGeneration
    || policy.policyDigest !== body.policyDigest || policy.nodeId !== body.nodeId) {
    throw new SidecarError(403, 'RESOURCE_POLICY_MISMATCH');
  }
  const micros = quantityMicros(body.quantity); const hardExpiresAt = new Date(body.hardExpiresAt);
  if (micros < MIN_LEASE_CAPACITY_MICROS) throw new SidecarError(400, 'LEASE_DURATION_TOO_SHORT');
  const expectedDuration = Number((micros * 3_600_000n) / (BigInt(policy.allocatedAcceleratorCount) * 1_000_000n));
  const remaining = hardExpiresAt.getTime() - now.getTime();
  if (!Number.isFinite(hardExpiresAt.getTime()) || remaining <= 0 || remaining > expectedDuration + 30_000
    || remaining < Math.max(1_000, expectedDuration - 60_000)) throw new SidecarError(400, 'HARD_EXPIRY_INVALID');
  return { leaseId: body.leaseId, orderId: body.orderId, resourceId: body.resourceId, quantity: body.quantity,
    quantityMicros: micros.toString(), capacityUnit: body.capacityUnit,
    bindingId: body.bindingId, bindingGeneration: body.bindingGeneration,
    policyDigest: body.policyDigest, nodeId: body.nodeId,
    allocatedAcceleratorCount: body.allocatedAcceleratorCount, hardExpiresAt: hardExpiresAt.toISOString() };
}
export async function loadPolicies(path) {
  const value = JSON.parse(await readFile(path, 'utf8')); const output = {};
  for (const [resourceId, policy] of Object.entries(value)) {
    if (!UUID.test(resourceId) || policy?.capacityUnit !== 'GPU时' || policy.allocatedAcceleratorCount !== 1
      || !UUID.test(policy.bindingId) || !Number.isSafeInteger(policy.bindingGeneration) || policy.bindingGeneration < 1
      || !SHA256_DIGEST.test(policy.policyDigest) || !UUID.test(policy.nodeId)
      || !Array.isArray(policy.allowedGpuUuids) || policy.allowedGpuUuids.length < 1
      || policy.allowedGpuUuids.some((uuid) => !GPU_UUID.test(uuid))
      || typeof policy.modelPattern !== 'string' || policy.modelPattern !== '^NVIDIA H100'
      || !Number.isInteger(policy.minimumMemoryMiB) || policy.minimumMemoryMiB < 90_000
      || policy.requiredMigMode !== 'Disabled' || policy.requiredComputeMode !== 'Default') throw new Error('RESOURCE_POLICY_INVALID');
    output[resourceId] = { capacityUnit: 'GPU时', allocatedAcceleratorCount: 1,
      bindingId: policy.bindingId, bindingGeneration: policy.bindingGeneration,
      policyDigest: policy.policyDigest, nodeId: policy.nodeId,
      modelPattern: policy.modelPattern, minimumMemoryMiB: policy.minimumMemoryMiB,
      requiredMigMode: 'Disabled', requiredComputeMode: 'Default',
      allowedGpuUuids: [...new Set(policy.allowedGpuUuids)] };
  }
  if (!Object.keys(output).length) throw new Error('RESOURCE_POLICY_EMPTY'); return Object.freeze(output);
}
function firstFreePort(state, config) {
  const used = new Set(Object.values(state.leases).filter((lease) => ACTIVE.has(lease.status)).map((lease) => lease.sshPort));
  for (let port = config.sshPortStart; port <= config.sshPortEnd; port += 1) if (!used.has(port)) return port;
  throw new SidecarError(409, 'SSH_PORT_CAPACITY_UNAVAILABLE');
}
function parseProviderLeaseId(value) {
  const leaseId = typeof value === 'string' && value.startsWith('kai:') ? value.slice(4) : '';
  if (!UUID.test(leaseId)) throw new SidecarError(404, 'LEASE_NOT_FOUND'); return leaseId;
}
function accessResponse(config, session, ticket) {
  return { ticket, uri: new URL(`/v1/access-sessions/${session.sessionId}/exchange`, config.publicOrigin).toString(),
    expiresAt: session.expiresAt };
}
function responseSignature(secret, payload) {
  return `hmac-sha256:${createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')}`;
}
function attestationSignaturePayload(value) {
  return { nonce: value.nonce, observedAt: value.observedAt, orderId: value.orderId, resourceId: value.resourceId,
    bindingId: value.bindingId, bindingGeneration: value.bindingGeneration, policyDigest: value.policyDigest,
    nodeId: value.nodeId, capacityUnit: value.capacityUnit, allocatedGpuUuids: value.allocatedGpuUuids,
    hardExpiresAt: value.hardExpiresAt, hostKeyFingerprint: value.hostKeyFingerprint, bootId: value.bootId,
    eventSequence: value.eventSequence, heartbeatId: value.heartbeatId, acceleratorModel: value.acceleratorModel,
    nodeAcceleratorCount: value.nodeAcceleratorCount, allocatedAcceleratorCount: value.allocatedAcceleratorCount,
    driverVersion: value.driverVersion, memoryTotalMiB: value.memoryTotalMiB, migMode: value.migMode,
    computeMode: value.computeMode, evidenceDigest: value.evidenceDigest };
}
function cleanupSessions(state, now) {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (new Date(session.expiresAt) <= now) { session.revoked = true; session.encryptedPrivateKey = null; }
    if (session.revoked && session.encryptedPrivateKey === null) delete state.sessions[sessionId];
  }
}
