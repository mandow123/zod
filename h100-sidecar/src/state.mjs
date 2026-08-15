import { mkdir, open, readFile, rename, chmod, readdir, unlink, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const EMPTY = Object.freeze({ version: 1, leases: {}, sessions: {} });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GPU_UUID = /^GPU-[A-Fa-f0-9-]+$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const STATUS = new Set(['provisioning', 'ready', 'running', 'stopping', 'stopped', 'failed']);

export class StateStore {
  constructor(directory, config = null) { this.directory = directory; this.path = join(directory, 'state.json'); this.config = config;
    this.archiveDirectory = join(directory, 'archive'); this.projectDirectory = join(directory, 'projects');
    this.value = structuredClone(EMPTY); this.queue = Promise.resolve(); }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.archiveDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.projectDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    for (const name of await readdir(this.directory)) {
      if (/^\.state-\d+-\d+\.tmp$/u.test(name)) await unlink(join(this.directory, name));
    }
    try {
      const metadata = await stat(this.path);
      if (metadata.size > (this.config?.stateMaxBytes ?? 1_048_576)) throw new Error('SIDECAR_STATE_TOO_LARGE');
      const decoded = JSON.parse(await readFile(this.path, 'utf8'));
      validateState(decoded, this.config);
      this.value = decoded;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.saveValue(this.value);
    }
    return this.value;
  }
  snapshot() { return structuredClone(this.value); }
  async drain() { await this.queue; }
  update(mutator) {
    const operation = this.queue.then(async () => {
      const before = JSON.stringify(this.value); const next = structuredClone(this.value); const result = await mutator(next);
      if (JSON.stringify(next) === before) return result;
      await this.saveValue(next); this.value = next; return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async reserveProject(projectId, leaseId) {
    if (!Number.isInteger(projectId) || projectId < 1 || !UUID.test(leaseId)) invalid();
    const path = join(this.projectDirectory, String(projectId));
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(`${leaseId}\n`); await handle.sync(); } finally { await handle.close(); }
      const directory = await open(this.projectDirectory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if ((await readFile(path, 'utf8')).trim() !== leaseId) throw new Error('WORKSPACE_QUOTA_PROJECT_COLLISION');
    }
  }
  async archivedLease(leaseId) {
    if (!UUID.test(leaseId)) return null;
    try { return JSON.parse(await readFile(join(this.archiveDirectory, `${leaseId}.json`), 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }
  archiveTerminals(cutoff, cleanup = async () => undefined) {
    return this.update(async (state) => {
      const archived = [];
      for (const [leaseId, lease] of Object.entries(state.leases)) {
        const terminalAt = lease.status === 'stopped' ? lease.stoppedAt : lease.status === 'failed' ? lease.failedAt : null;
        if (!terminalAt || new Date(terminalAt) > cutoff) continue;
        await this.writeArchive(leaseId, lease);
        await cleanup(lease);
        delete state.leases[leaseId];
        for (const [sessionId, session] of Object.entries(state.sessions)) if (session.leaseId === leaseId) delete state.sessions[sessionId];
        archived.push(leaseId);
      }
      return archived;
    });
  }
  async writeArchive(leaseId, lease) {
    const path = join(this.archiveDirectory, `${leaseId}.json`); const serialized = `${JSON.stringify(lease)}\n`;
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      const directory = await open(this.archiveDirectory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if ((await readFile(path, 'utf8')) !== serialized) throw new Error('SIDECAR_ARCHIVE_CONFLICT');
    }
  }
  async saveValue(value) {
    validateState(value, this.config);
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized) > (this.config?.stateMaxBytes ?? 1_048_576)) throw new Error('SIDECAR_STATE_TOO_LARGE');
    const temporary = join(this.directory, `.state-${process.pid}-${Date.now()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.path); await chmod(this.path, 0o600);
    const directoryHandle = await open(this.directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  }
}

function validateState(value, config) {
  if (!plainObject(value) || value.version !== 1 || !plainObject(value.leases) || !plainObject(value.sessions)) invalid();
  if (Object.keys(value.sessions).length > (config?.maxActiveSessionsGlobal ?? 64)) invalid();
  const seenPorts = new Set(); const activeGpus = new Set(); const projectIds = new Set();
  for (const [id, lease] of Object.entries(value.leases)) {
    const projectId = 10_000 + Number.parseInt(createHash('sha256').update(id).digest('hex').slice(0, 7), 16);
    if (projectIds.has(projectId)) invalid(); projectIds.add(projectId);
    if (!UUID.test(id) || !plainObject(lease) || lease.leaseId !== id || lease.providerLeaseId !== `kai:${id}`
      || !UUID.test(lease.orderId) || !UUID.test(lease.resourceId) || !STATUS.has(lease.status)
      || !UUID.test(lease.bindingId) || !Number.isSafeInteger(lease.bindingGeneration) || lease.bindingGeneration < 1
      || !SHA256_DIGEST.test(lease.policyDigest) || !UUID.test(lease.nodeId)
      || lease.capacityUnit !== 'GPU时' || lease.allocatedAcceleratorCount !== 1
      || !Array.isArray(lease.gpuUuids) || lease.gpuUuids.length !== 1 || !GPU_UUID.test(lease.gpuUuids[0])
      || typeof lease.quantityMicros !== 'string' || !/^[1-9]\d{0,23}$/u.test(lease.quantityMicros)
      || !validTime(lease.createdAt) || !validTime(lease.hardExpiresAt)
      || (lease.eventSequence !== undefined && (!Number.isSafeInteger(lease.eventSequence) || lease.eventSequence < 1))) invalid();
    if (lease.containerName !== undefined && lease.containerName !== `kai-lease-${id}`) invalid();
    if (lease.quotaProjectId !== undefined && lease.quotaProjectId !== projectId) invalid();
    if (lease.sshPort !== undefined && (!Number.isInteger(lease.sshPort) || lease.sshPort < 1 || lease.sshPort > 65_535)) invalid();
    if (lease.workspace !== undefined && (!config?.workspaceDirectory || !inside(config.workspaceDirectory, lease.workspace))) invalid();
    if (config && lease.sshPort !== undefined
      && (lease.sshPort < config.sshPortStart || lease.sshPort > config.sshPortEnd)) invalid();
    if (['ready', 'running', 'stopping'].includes(lease.status)) {
      if (typeof lease.containerId !== 'string' || !/^[a-f0-9]{12,64}$/u.test(lease.containerId)
        || !lease.workspace || !Number.isInteger(lease.sshPort) || seenPorts.has(lease.sshPort)
        || activeGpus.has(lease.gpuUuids[0]) || typeof lease.hostPublicKey !== 'string'
        || !/^ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(lease.hostPublicKey)
        || typeof lease.hostKeyFingerprint !== 'string'
        || !/^SHA256:[A-Za-z0-9+/]+$/u.test(lease.hostKeyFingerprint)
        || (lease.unhealthyObservations !== undefined && (!Number.isInteger(lease.unhealthyObservations)
          || lease.unhealthyObservations < 0 || lease.unhealthyObservations > 3))) invalid();
      seenPorts.add(lease.sshPort); activeGpus.add(lease.gpuUuids[0]);
    }
    if (lease.status === 'stopped' && (!validTime(lease.stoppedAt)
      || typeof lease.stopOperationId !== 'string' || !/^[A-Za-z0-9:_-]{8,200}$/u.test(lease.stopOperationId)
      || typeof lease.consumedCapacityMicros !== 'string' || !/^\d{1,24}$/u.test(lease.consumedCapacityMicros)
      || BigInt(lease.consumedCapacityMicros) > BigInt(lease.quantityMicros)
      || typeof lease.meteringEvidenceDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(lease.meteringEvidenceDigest))) invalid();
    if (lease.stopRequestedAt !== undefined && (!validTime(lease.stopRequestedAt)
      || typeof lease.stopRequestedMonoNs !== 'string' || !/^\d+$/u.test(lease.stopRequestedMonoNs)
      || !UUID.test(lease.stopRequestedBootId))) invalid();
  }
  for (const [id, session] of Object.entries(value.sessions)) {
    if (!UUID.test(id) || !plainObject(session) || session.sessionId !== id || !UUID.test(session.leaseId)
      || !value.leases[session.leaseId] || !UUID.test(session.orderId) || !UUID.test(session.resourceId)
      || typeof session.ticketDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(session.ticketDigest)
      || typeof session.publicKey !== 'string' || !session.publicKey.startsWith('ssh-ed25519 ')
      || typeof session.used !== 'boolean' || typeof session.revoked !== 'boolean'
      || !validTime(session.createdAt) || !validTime(session.expiresAt)
      || (session.encryptedPrivateKey !== null && (typeof session.encryptedPrivateKey !== 'string'
        || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(session.encryptedPrivateKey)))) invalid();
  }
}

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validTime(value) { return typeof value === 'string' && Number.isFinite(new Date(value).getTime()); }
function inside(base, candidate) {
  const root = resolve(base); const path = resolve(candidate); return path.startsWith(`${root}${sep}`);
}
function invalid() { throw new Error('SIDECAR_STATE_INVALID'); }
