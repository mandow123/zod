import {
  createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify,
} from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const GPU_UUID = /^GPU-[A-Fa-f0-9-]{8,80}$/u;
const AGENT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const CLAIM_DOMAIN = 'kai-cloudpay/node-claim';
const HEARTBEAT_DOMAIN = 'kai-cloudpay/node-heartbeat';
export const NODE_PROTOCOL_SCHEMA_VERSION = 1;

function fail(code) { throw new Error(code); }
function digest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function text(value, minimum, maximum, code) {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) fail(code);
  return normalized;
}
function canonicalTime(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail('CLOCK_INVALID');
  return value;
}
function canonicalDigest(value) { if (!DIGEST.test(value)) fail('DIGEST_INVALID'); return value; }
function canonicalAgentVersion(value) { if (!AGENT_VERSION.test(value)) fail('AGENT_VERSION_INVALID'); return value; }
function canonicalSequence(value) {
  if (!/^[1-9]\d{0,18}$/u.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) fail('HEARTBEAT_SEQUENCE_INVALID');
  return BigInt(value).toString();
}

export function normalizeInventory(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64) fail('INVENTORY_INVALID');
  const normalized = raw.map((gpu) => {
    const uuid = text(gpu.uuid, 12, 84, 'INVENTORY_INVALID').toUpperCase();
    if (!GPU_UUID.test(uuid) || !Number.isInteger(gpu.memoryTotalMiB) || gpu.memoryTotalMiB < 1
      || gpu.memoryTotalMiB > 1_048_576 || !['Enabled', 'Disabled'].includes(gpu.migMode)
      || !['Default', 'Exclusive_Process', 'Prohibited', 'Exclusive_Thread'].includes(gpu.computeMode)) fail('INVENTORY_INVALID');
    return {
      stable: { uuid, model: text(gpu.model, 2, 120, 'INVENTORY_INVALID'), memoryTotalMiB: gpu.memoryTotalMiB },
      runtime: { uuid, driverVersion: text(gpu.driverVersion, 1, 64, 'INVENTORY_INVALID'),
        cudaVersion: text(gpu.cudaVersion, 1, 64, 'INVENTORY_INVALID'), migMode: gpu.migMode, computeMode: gpu.computeMode },
    };
  }).sort((left, right) => left.stable.uuid < right.stable.uuid ? -1 : left.stable.uuid > right.stable.uuid ? 1 : 0);
  if (new Set(normalized.map((item) => item.stable.uuid)).size !== normalized.length) fail('INVENTORY_INVALID');
  const stable = normalized.map((item) => item.stable);
  return { stable, inventoryDigest: digest(JSON.stringify(stable)), gpuSetDigest: digest(JSON.stringify(stable.map((gpu) => gpu.uuid))),
    runtimeDigest: digest(JSON.stringify(normalized.map((item) => item.runtime))) };
}

export function normalizeNodePublicKey(value) {
  const match = /^ed25519:([A-Za-z0-9+/=]{40,120})$/u.exec(value);
  if (!match?.[1]) fail('NODE_PUBLIC_KEY_INVALID');
  const raw = Buffer.from(match[1], 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== match[1]) fail('NODE_PUBLIC_KEY_INVALID');
  return `ed25519:${match[1]}`;
}

export function canonicalClaimProof(value) {
  if (!UUID.test(value.claimId) || !/^[A-Za-z0-9_-]{32,120}$/u.test(value.challenge)) fail('CLAIM_PROOF_INVALID');
  return JSON.stringify({ domain: CLAIM_DOMAIN, schemaVersion: NODE_PROTOCOL_SCHEMA_VERSION,
    claimId: value.claimId.toLowerCase(), challenge: value.challenge, publicKey: normalizeNodePublicKey(value.publicKey),
    observedAt: canonicalTime(value.observedAt), inventoryDigest: canonicalDigest(value.inventoryDigest),
    runtimeDigest: canonicalDigest(value.runtimeDigest), policyDigest: canonicalDigest(value.policyDigest),
    agentVersion: canonicalAgentVersion(value.agentVersion) });
}

export function canonicalHeartbeatProof(value) {
  if (!UUID.test(value.nodeId) || !UUID.test(value.bootId)) fail('HEARTBEAT_ID_INVALID');
  return JSON.stringify({ domain: HEARTBEAT_DOMAIN, schemaVersion: NODE_PROTOCOL_SCHEMA_VERSION,
    nodeId: value.nodeId.toLowerCase(), bootId: value.bootId.toLowerCase(), sequence: canonicalSequence(value.sequence),
    observedAt: canonicalTime(value.observedAt), inventoryDigest: canonicalDigest(value.inventoryDigest),
    runtimeDigest: canonicalDigest(value.runtimeDigest), policyDigest: canonicalDigest(value.policyDigest),
    agentVersion: canonicalAgentVersion(value.agentVersion) });
}

export function protocolPayloadDigest(canonical) { return digest(canonical); }
export function claimTokenHash(claimId, token, pepper) {
  if (!UUID.test(claimId) || !/^[A-Za-z0-9_-]{43,120}$/u.test(token)) fail('CLAIM_TOKEN_INVALID');
  return createHmac('sha256', pepper).update(`node-claim:v1:${claimId.toLowerCase()}:${token}`).digest('hex');
}

function rawPublicKey(key) {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') fail('NODE_KEY_INVALID');
  const raw = Buffer.from(jwk.x, 'base64url');
  if (raw.length !== 32) fail('NODE_KEY_INVALID');
  return `ed25519:${raw.toString('base64')}`;
}

export function signNodeProof(privateKey, canonical) {
  return `ed25519:${sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64')}`;
}

export function verifyNodeProof(publicKey, canonical, signature) {
  const signatureMatch = /^ed25519:([A-Za-z0-9+/=]{80,160})$/u.exec(signature);
  if (!signatureMatch?.[1]) return false;
  try {
    const raw = Buffer.from(normalizeNodePublicKey(publicKey).slice('ed25519:'.length), 'base64');
    const bytes = Buffer.from(signatureMatch[1], 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== signatureMatch[1]) return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    return verify(null, Buffer.from(canonical, 'utf8'), key, bytes);
  } catch { return false; }
}

async function atomicWrite(directory, path, value, mode = 0o600) {
  const temporary = join(directory, `.${process.pid}-${Date.now()}-${createHash('sha256').update(path).digest('hex').slice(0, 8)}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path); await chmod(path, mode);
  const directoryHandle = await open(directory, 'r');
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}

async function securePrivateKey(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) fail('NODE_KEY_FILE_INSECURE');
}

async function secureDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) fail('NODE_STATE_DIRECTORY_INSECURE');
}

async function ensureSecureDirectory(path) {
  try { await secureDirectory(path); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try { await mkdir(path, { mode: 0o700 }); }
    catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
    await secureDirectory(path);
  }
}

async function secureStateFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) fail('HEARTBEAT_STATE_INSECURE');
}

export async function readSystemBootId(path = '/proc/sys/kernel/random/boot_id') {
  const value = (await readFile(path, 'utf8')).trim().toLowerCase();
  if (!UUID.test(value)) fail('BOOT_ID_INVALID');
  return value;
}

export class NodeIdentity {
  constructor(directory) { this.directory = directory; this.privateKeyPath = join(directory, 'node-ed25519.pem'); this.privateKey = null; this.publicKey = null; }
  async loadOrCreate() {
    await ensureSecureDirectory(this.directory);
    let encoded;
    try { await securePrivateKey(this.privateKeyPath); encoded = await readFile(this.privateKeyPath, 'utf8'); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const pair = generateKeyPairSync('ed25519');
      encoded = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
      await atomicWrite(this.directory, this.privateKeyPath, encoded, 0o600);
    }
    try { this.privateKey = createPrivateKey(encoded); this.publicKey = rawPublicKey(this.privateKey); }
    catch { fail('NODE_KEY_INVALID'); }
    return { publicKey: this.publicKey };
  }
  sign(canonical) { if (!this.privateKey) fail('NODE_KEY_NOT_LOADED'); return signNodeProof(this.privateKey, canonical); }
}

export class HeartbeatJournal {
  constructor(directory, identity, bootId) {
    this.directory = directory; this.path = join(directory, 'heartbeat-state.json'); this.identity = identity; this.bootId = bootId.toLowerCase();
    this.state = null; this.queue = Promise.resolve();
  }
  async load() {
    if (!UUID.test(this.bootId)) fail('BOOT_ID_INVALID');
    await ensureSecureDirectory(this.directory);
    try {
      await secureStateFile(this.path);
      this.state = JSON.parse(await readFile(this.path, 'utf8'));
      validateJournal(this.state, this.identity.publicKey);
      if (this.state.bootId !== this.bootId) {
        this.state = { version: 1, bootId: this.bootId, sequence: '0', pending: null }; await this.save(this.state);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.state = { version: 1, bootId: this.bootId, sequence: '0', pending: null }; await this.save(this.state);
    }
    return structuredClone(this.state);
  }
  prepare(fields) {
    return this.enqueue(async () => {
      if (this.state.pending) return structuredClone(this.state.pending);
      const sequence = (BigInt(this.state.sequence) + 1n).toString();
      const proof = { ...fields, bootId: this.bootId, sequence };
      const canonical = canonicalHeartbeatProof(proof); const signature = this.identity.sign(canonical);
      const event = { ...proof, signature, payloadDigest: protocolPayloadDigest(canonical) };
      const next = { ...this.state, sequence, pending: event }; await this.save(next); this.state = next;
      return structuredClone(event);
    });
  }
  acknowledge(payloadDigest) {
    return this.enqueue(async () => {
      if (!this.state.pending || this.state.pending.payloadDigest !== payloadDigest) fail('HEARTBEAT_ACK_CONFLICT');
      const next = { ...this.state, pending: null }; await this.save(next); this.state = next;
    });
  }
  enqueue(work) { const operation = this.queue.then(work); this.queue = operation.then(() => undefined, () => undefined); return operation; }
  async save(value) { validateJournal(value, this.identity.publicKey); await atomicWrite(this.directory, this.path, `${JSON.stringify(value)}\n`, 0o600); }
}

function validateJournal(value, publicKey) {
  if (!value || value.version !== 1 || !UUID.test(value.bootId) || !/^\d{1,19}$/u.test(value.sequence)
    || BigInt(value.sequence) > 9_223_372_036_854_775_807n || (value.pending !== null
      && (!value.pending || value.pending.bootId !== value.bootId || value.pending.sequence !== value.sequence
        || !DIGEST.test(value.pending.payloadDigest) || !/^ed25519:[A-Za-z0-9+/=]{80,160}$/u.test(value.pending.signature)))) {
    fail('HEARTBEAT_STATE_INVALID');
  }
  if (value.pending) {
    const { signature, payloadDigest, ...proof } = value.pending;
    try {
      const canonical = canonicalHeartbeatProof(proof);
      if (protocolPayloadDigest(canonical) !== payloadDigest || !verifyNodeProof(publicKey, canonical, signature)) {
        fail('HEARTBEAT_STATE_INVALID');
      }
    } catch { fail('HEARTBEAT_STATE_INVALID'); }
  }
}
