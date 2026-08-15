import { createHash } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import https from 'node:https';
import { dirname, join } from 'node:path';
import {
  HeartbeatJournal, NodeIdentity, canonicalClaimProof, normalizeInventory, readSystemBootId, verifyNodeProof,
} from './node-protocol.mjs';
import { inspectNodeInventory } from './nvidia.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43,120}$/u;
const CHALLENGE = /^[A-Za-z0-9_-]{32,120}$/u;
const RESPONSE_LIMIT = 65_536;

export class NodeClientError extends Error {
  constructor(code, { terminal = true, status = null } = {}) {
    super(code); this.name = 'NodeClientError'; this.code = code; this.terminal = terminal; this.status = status;
  }
}

function fail(code, options) { throw new NodeClientError(code, options); }
function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}
function canonicalTime(value, code) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail(code);
  return value;
}
function validateBackendBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('NODE_CLAIM_BACKEND_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('NODE_CLAIM_BACKEND_URL_INVALID');
  }
  return url;
}

export function validateNodeClaim(value) {
  const keys = ['protocolVersion', 'backendBaseUrl', 'deploymentId', 'claimId', 'claimToken', 'challenge',
    'expectedPolicyDigest', 'expiresAt', 'consumePath'];
  if (!exactKeys(value, keys) || value.protocolVersion !== 1 || !UUID.test(value.deploymentId)
    || !UUID.test(value.claimId) || !TOKEN.test(value.claimToken) || !CHALLENGE.test(value.challenge)
    || !DIGEST.test(value.expectedPolicyDigest)) fail('NODE_CLAIM_INVALID');
  const backendBaseUrl = validateBackendBaseUrl(value.backendBaseUrl);
  const claimId = value.claimId.toLowerCase();
  if (value.consumePath !== `/node/v1/claims/${claimId}/consume`) fail('NODE_CLAIM_CONSUME_PATH_INVALID');
  const expiresAt = canonicalTime(value.expiresAt, 'NODE_CLAIM_EXPIRY_INVALID');
  return { ...value, claimId, deploymentId: value.deploymentId.toLowerCase(), expiresAt,
    backendBaseUrl: backendBaseUrl.toString() };
}

export function canReplaceExpiredNodeClaim(existing, replacement, now = Date.now()) {
  return existing.deploymentId === replacement.deploymentId && existing.claimId !== replacement.claimId
    && new Date(existing.expiresAt).getTime() <= now && new Date(replacement.expiresAt).getTime() > now;
}

export function validateNodeEnrollment(value) {
  const keys = ['version', 'backendBaseUrl', 'nodeId', 'bindingId', 'deploymentId', 'policyDigest', 'createdAt'];
  if (!exactKeys(value, keys) || value.version !== 1 || !UUID.test(value.nodeId) || !UUID.test(value.bindingId)
    || !UUID.test(value.deploymentId) || !DIGEST.test(value.policyDigest)) fail('NODE_ENROLLMENT_STATE_INVALID');
  canonicalTime(value.createdAt, 'NODE_ENROLLMENT_STATE_INVALID');
  return { ...value, backendBaseUrl: validateBackendBaseUrl(value.backendBaseUrl).toString(),
    nodeId: value.nodeId.toLowerCase(), bindingId: value.bindingId.toLowerCase(), deploymentId: value.deploymentId.toLowerCase() };
}

function validateClaimRequest(value, claim, publicKey) {
  const envelopeKeys = ['version', 'claimId', 'deploymentId', 'body'];
  const bodyKeys = ['publicKey', 'observedAt', 'agentVersion', 'inventory', 'inventoryDigest', 'runtimeDigest',
    'policyDigest', 'signature'];
  const gpuKeys = ['uuid', 'model', 'memoryTotalMiB', 'driverVersion', 'cudaVersion', 'migMode', 'computeMode'];
  if (!exactKeys(value, envelopeKeys) || value.version !== 1 || value.claimId !== claim.claimId
    || value.deploymentId !== claim.deploymentId || !exactKeys(value.body, bodyKeys)
    || !Array.isArray(value.body.inventory) || value.body.inventory.some((gpu) => !exactKeys(gpu, gpuKeys))
    || value.body.publicKey !== publicKey || value.body.policyDigest !== claim.expectedPolicyDigest) {
    fail('NODE_CLAIM_REQUEST_STATE_INVALID');
  }
  let normalized; let canonical;
  try {
    normalized = normalizeInventory(value.body.inventory);
    canonical = canonicalClaimProof({ claimId: claim.claimId, challenge: claim.challenge,
      publicKey: value.body.publicKey, observedAt: value.body.observedAt, inventoryDigest: value.body.inventoryDigest,
      runtimeDigest: value.body.runtimeDigest, policyDigest: value.body.policyDigest, agentVersion: value.body.agentVersion });
  } catch { fail('NODE_CLAIM_REQUEST_STATE_INVALID'); }
  if (normalized.inventoryDigest !== value.body.inventoryDigest || normalized.runtimeDigest !== value.body.runtimeDigest
    || !verifyNodeProof(publicKey, canonical, value.body.signature)) fail('NODE_CLAIM_REQUEST_STATE_INVALID');
  return value;
}

async function secureFile(path, code) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) fail(code);
}
async function atomicWrite(directory, path, value) {
  const temporary = join(directory, `.${process.pid}-${Date.now()}-${createHash('sha256').update(path).digest('hex').slice(0, 8)}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directoryHandle = await open(directory, 'r');
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}
async function removeDurably(path) {
  try { await unlink(path); } catch (error) { if (error?.code !== 'ENOENT') throw error; return; }
  const handle = await open(dirname(path), 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function httpsJsonRequest({ url, headers, body, timeoutMs, ca }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'POST', headers: { ...headers,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body), accept: 'application/json' },
    timeout: timeoutMs, minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(ca ? { ca } : {}) }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) { response.destroy(new NodeClientError('NODE_RESPONSE_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new NodeClientError('NODE_REQUEST_TIMEOUT', { terminal: false })));
    request.on('error', reject); request.end(body);
  });
}

function responseJson(response) {
  const contentType = String(response.headers?.['content-type'] ?? '');
  if (!/^application\/json(?:;|$)/iu.test(contentType)) fail('NODE_RESPONSE_CONTENT_TYPE_INVALID');
  try { return JSON.parse(response.body); } catch { fail('NODE_RESPONSE_JSON_INVALID'); }
}
function classifyResponse(response) {
  if ([200, 202].includes(response.status)) return;
  if ([401, 409, 410].includes(response.status)) fail(`NODE_BACKEND_${response.status}`, { status: response.status });
  if ([408, 425, 429].includes(response.status) || response.status >= 500) {
    fail(`NODE_BACKEND_${response.status || 'UNAVAILABLE'}`, { terminal: false, status: response.status || null });
  }
  fail(`NODE_BACKEND_${response.status || 'INVALID'}`, { status: response.status || null });
}
function safeError(error) {
  if (error instanceof NodeClientError) return error;
  if (/^(?:CERT_|ERR_TLS_CERT_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|INVALID_CA|UNABLE_TO_(?:GET_ISSUER_CERT(?:_LOCALLY)?|VERIFY_LEAF_SIGNATURE))/u
    .test(String(error?.code ?? ''))) return new NodeClientError('NODE_TLS_VALIDATION_FAILED');
  return new NodeClientError('NODE_NETWORK_ERROR', { terminal: false });
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class OutboundNodeClient {
  constructor(config, dependencies = {}) {
    this.config = config; this.transport = dependencies.transport ?? httpsJsonRequest;
    this.inspectInventory = dependencies.inspectInventory ?? inspectNodeInventory;
    this.bootId = dependencies.bootId ?? readSystemBootId; this.clock = dependencies.clock ?? (() => new Date());
    this.sleep = dependencies.sleep ?? delay; this.random = dependencies.random ?? Math.random;
    this.log = dependencies.log ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
    this.identity = dependencies.identity ?? new NodeIdentity(config.stateDirectory);
    this.enrollmentPath = join(config.stateDirectory, 'node-enrollment.json'); this.enrollment = null;
    this.claimRequestPath = join(config.stateDirectory, 'node-claim-request.json');
    this.claim = null; this.journal = null; this.readiness = 'offline'; this.closed = false; this.loopPromise = null;
  }

  async start() {
    const enrollment = await this.connectOnce();
    this.loopPromise = this.loop();
    return enrollment;
  }

  async connectOnce() {
    await this.identity.loadOrCreate();
    await this.loadEnrollmentOrClaim();
    if (!this.enrollment) await this.retry('node_claim_consume', () => this.consumeClaim());
    this.journal = new HeartbeatJournal(this.config.stateDirectory, this.identity, await this.bootId());
    await this.journal.load();
    await this.retry('node_heartbeat', () => this.sendHeartbeat());
    return { ...this.enrollment };
  }

  async loadEnrollmentOrClaim() {
    let persistedEnrollment = null;
    try {
      await secureFile(this.enrollmentPath, 'NODE_ENROLLMENT_STATE_INSECURE');
      persistedEnrollment = validateNodeEnrollment(JSON.parse(await readFile(this.enrollmentPath, 'utf8')));
      if (persistedEnrollment.backendBaseUrl !== this.config.backendBaseUrl) fail('NODE_BACKEND_URL_PIN_MISMATCH');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    let pendingClaim = null;
    try {
      await secureFile(this.config.nodeClaimFile, 'NODE_CLAIM_FILE_INSECURE');
      pendingClaim = validateNodeClaim(JSON.parse(await readFile(this.config.nodeClaimFile, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT' && persistedEnrollment) {
        this.enrollment = persistedEnrollment;
        try { await secureFile(this.claimRequestPath, 'NODE_CLAIM_REQUEST_STATE_INSECURE'); await removeDurably(this.claimRequestPath); }
        catch (pendingError) { if (pendingError?.code !== 'ENOENT') throw pendingError; }
        return;
      }
      if (error?.code === 'ENOENT') fail('NODE_CLAIM_FILE_REQUIRED');
      if (error instanceof SyntaxError) fail('NODE_CLAIM_JSON_INVALID');
      throw error;
    }
    if (pendingClaim.backendBaseUrl !== this.config.backendBaseUrl) fail('NODE_BACKEND_URL_PIN_MISMATCH');
    if (persistedEnrollment?.deploymentId === pendingClaim.deploymentId) {
      this.enrollment = persistedEnrollment;
      await removeDurably(this.config.nodeClaimFile);
      try { await secureFile(this.claimRequestPath, 'NODE_CLAIM_REQUEST_STATE_INSECURE'); await removeDurably(this.claimRequestPath); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      return;
    }
    this.enrollment = null; this.claim = pendingClaim;
    if (this.clock().getTime() >= new Date(this.claim.expiresAt).getTime()) {
      try {
        await secureFile(this.claimRequestPath, 'NODE_CLAIM_REQUEST_STATE_INSECURE');
        validateClaimRequest(JSON.parse(await readFile(this.claimRequestPath, 'utf8')), this.claim, this.identity.publicKey);
      } catch (error) { if (error?.code === 'ENOENT') fail('NODE_CLAIM_EXPIRED'); throw error; }
    }
  }

  async inventory() {
    const raw = await this.inspectInventory(); const normalized = normalizeInventory(raw);
    if (raw.length !== this.config.expectedGpuCount) fail('NODE_GPU_COUNT_MISMATCH');
    return { raw, normalized };
  }

  async request(url, authorization, body) {
    let ca;
    if (this.config.backendCaFile) ca = await readFile(this.config.backendCaFile);
    try { return await this.transport({ url, headers: authorization ? { authorization } : {}, body: JSON.stringify(body),
      timeoutMs: this.config.backendRequestTimeoutMs, ca }); }
    catch (error) { throw safeError(error); }
  }

  async consumeClaim() {
    if (!this.claim) fail('NODE_CLAIM_FILE_REQUIRED');
    const body = await this.claimRequest();
    const response = await this.request(new URL(this.claim.consumePath, this.claim.backendBaseUrl),
      `NodeClaim ${this.claim.claimToken}`, body);
    classifyResponse(response); const parsed = responseJson(response); const node = parsed?.node;
    const expectedHeartbeatPath = `/node/v1/nodes/${String(node?.nodeId).toLowerCase()}/heartbeats`;
    if (parsed?.ok !== true || !node || !UUID.test(node.nodeId) || !UUID.test(node.bindingId)
      || !UUID.test(node.deploymentId) || node.deploymentId.toLowerCase() !== this.claim.deploymentId
      || node.protocolVersion !== 1 || node.heartbeatPath !== expectedHeartbeatPath) {
      fail('NODE_CLAIM_RESPONSE_INVALID');
    }
    const enrollment = validateNodeEnrollment({ version: 1, backendBaseUrl: this.claim.backendBaseUrl,
      nodeId: node.nodeId.toLowerCase(), bindingId: node.bindingId.toLowerCase(), deploymentId: node.deploymentId.toLowerCase(),
      policyDigest: this.claim.expectedPolicyDigest, createdAt: this.clock().toISOString() });
    await removeDurably(join(this.config.stateDirectory, 'heartbeat-state.json'));
    await atomicWrite(this.config.stateDirectory, this.enrollmentPath, `${JSON.stringify(enrollment)}\n`);
    await removeDurably(this.config.nodeClaimFile);
    await removeDurably(this.claimRequestPath);
    this.enrollment = enrollment; this.claim.claimToken = ''; this.claim = null;
    this.log({ level: 'info', event: 'node_claim_accepted', status: response.status, replayed: node.replayed === true });
  }

  async claimRequest() {
    try {
      await secureFile(this.claimRequestPath, 'NODE_CLAIM_REQUEST_STATE_INSECURE');
      return validateClaimRequest(JSON.parse(await readFile(this.claimRequestPath, 'utf8')),
        this.claim, this.identity.publicKey).body;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (this.clock().getTime() >= new Date(this.claim.expiresAt).getTime()) fail('NODE_CLAIM_EXPIRED');
    const { raw, normalized } = await this.inventory(); const observedAt = this.clock().toISOString();
    const proof = { claimId: this.claim.claimId, challenge: this.claim.challenge, publicKey: this.identity.publicKey,
      observedAt, inventoryDigest: normalized.inventoryDigest, runtimeDigest: normalized.runtimeDigest,
      policyDigest: this.claim.expectedPolicyDigest, agentVersion: this.config.nodeAgentVersion };
    const body = { publicKey: this.identity.publicKey, observedAt, agentVersion: this.config.nodeAgentVersion, inventory: raw,
      inventoryDigest: normalized.inventoryDigest, runtimeDigest: normalized.runtimeDigest,
      policyDigest: this.claim.expectedPolicyDigest, signature: this.identity.sign(canonicalClaimProof(proof)) };
    const pending = validateClaimRequest({ version: 1, claimId: this.claim.claimId,
      deploymentId: this.claim.deploymentId, body }, this.claim, this.identity.publicKey);
    await atomicWrite(this.config.stateDirectory, this.claimRequestPath, `${JSON.stringify(pending)}\n`);
    return pending.body;
  }

  async sendHeartbeat() {
    const { raw, normalized } = await this.inventory();
    const event = await this.journal.prepare({ nodeId: this.enrollment.nodeId, observedAt: this.clock().toISOString(), inventory: raw,
      agentVersion: this.config.nodeAgentVersion, inventoryDigest: normalized.inventoryDigest,
      runtimeDigest: normalized.runtimeDigest, policyDigest: this.enrollment.policyDigest });
    const { payloadDigest, ...body } = event;
    const response = await this.request(new URL(`/node/v1/nodes/${this.enrollment.nodeId}/heartbeats`,
      this.enrollment.backendBaseUrl), null, body);
    classifyResponse(response); const parsed = responseJson(response); const heartbeat = parsed?.heartbeat;
    if (parsed?.ok !== true || !heartbeat || heartbeat.accepted !== true
      || !['ready', 'checking'].includes(heartbeat.readiness)
      || String(heartbeat.nodeId).toLowerCase() !== this.enrollment.nodeId
      || String(heartbeat.sequence) !== event.sequence) fail('NODE_HEARTBEAT_RESPONSE_INVALID');
    await this.journal.acknowledge(payloadDigest);
    this.readiness = heartbeat.readiness;
    this.log({ level: 'info', event: 'node_heartbeat_accepted', status: response.status,
      sequence: event.sequence, replayed: heartbeat.replayed === true, readiness: heartbeat.readiness ?? 'checking' });
  }

  async retry(event, operation) {
    let attempt = 0;
    while (!this.closed) {
      try { return await operation(); }
      catch (cause) {
        const error = safeError(cause);
        if (error.terminal) throw error;
        attempt += 1;
        const base = Math.min(this.config.nodeRetryMaxMs, this.config.nodeRetryMinMs * (2 ** Math.min(attempt - 1, 20)));
        const waitMs = Math.max(1, Math.round(base * (0.5 + this.random())));
        this.log({ level: 'warn', event: `${event}_retry`, code: error.code, status: error.status, attempt, waitMs });
        await this.sleep(waitMs);
      }
    }
    fail('NODE_CLIENT_CLOSED');
  }

  async loop() {
    while (!this.closed) { await this.sleep(this.config.nodeHeartbeatIntervalMs); if (!this.closed) await this.retry('node_heartbeat', () => this.sendHeartbeat()); }
  }
  isReady() { return this.readiness === 'ready'; }
  async close() { this.closed = true; if (this.loopPromise) { try { await this.loopPromise; } catch { /* fatal was reported by owner */ } } }
}
