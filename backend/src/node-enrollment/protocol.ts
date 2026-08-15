import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify,
} from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const GPU_UUID = /^GPU-[A-Fa-f0-9-]{8,80}$/u;
const AGENT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const CLAIM_DOMAIN = 'kai-cloudpay/node-claim';
const HEARTBEAT_DOMAIN = 'kai-cloudpay/node-heartbeat';
export const NODE_PROTOCOL_SCHEMA_VERSION = 1;

export type RawGpuInventory = Readonly<{
  uuid: string;
  model: string;
  memoryTotalMiB: number;
  driverVersion: string;
  cudaVersion: string;
  migMode: 'Enabled' | 'Disabled';
  computeMode: 'Default' | 'Exclusive_Process' | 'Prohibited' | 'Exclusive_Thread';
}>;

export type StableGpuInventory = Readonly<{ uuid: string; model: string; memoryTotalMiB: number }>;

export type InventoryEvidence = Readonly<{
  stable: StableGpuInventory[];
  inventoryDigest: string;
  gpuSetDigest: string;
  runtimeDigest: string;
}>;

export type ClaimProof = Readonly<{
  claimId: string;
  challenge: string;
  publicKey: string;
  observedAt: string;
  inventoryDigest: string;
  runtimeDigest: string;
  policyDigest: string;
  agentVersion: string;
}>;

export type HeartbeatProof = Readonly<{
  nodeId: string;
  bootId: string;
  sequence: string;
  observedAt: string;
  inventoryDigest: string;
  runtimeDigest: string;
  policyDigest: string;
  agentVersion: string;
}>;

export class NodeProtocolError extends Error {
  constructor(readonly code: string) { super(code); }
}

function normalizedText(value: string, minimum: number, maximum: number, code: string) {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new NodeProtocolError(code);
  }
  return normalized;
}

function digest(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, nested]) => [key, stableValue(nested)]));
}

export function deriveExpectedPolicyDigest(input: Readonly<{
  resourceId: string; productCode: string; specifications: Record<string, unknown>;
  capacityUnit: string; verificationDigest: string; platformPolicyVersion: string;
}>) {
  if (!UUID.test(input.resourceId) || input.capacityUnit !== 'GPU时' || !DIGEST.test(input.verificationDigest)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{2,63}$/u.test(input.platformPolicyVersion)) {
    throw new NodeProtocolError('POLICY_INPUT_INVALID');
  }
  return digest(JSON.stringify({
    domain: 'kai-cloudpay/node-policy', schemaVersion: NODE_PROTOCOL_SCHEMA_VERSION,
    platformPolicyVersion: input.platformPolicyVersion,
    resourceId: input.resourceId.toLowerCase(), productCode: input.productCode.trim().toUpperCase(),
    capacityUnit: input.capacityUnit, verificationDigest: input.verificationDigest,
    specifications: stableValue(input.specifications),
  }));
}

export function normalizeInventory(raw: readonly RawGpuInventory[]): InventoryEvidence {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64) throw new NodeProtocolError('INVENTORY_INVALID');
  const normalized = raw.map((gpu) => {
    const uuid = normalizedText(gpu.uuid, 12, 84, 'INVENTORY_INVALID').toUpperCase();
    if (!GPU_UUID.test(uuid) || !Number.isInteger(gpu.memoryTotalMiB)
      || gpu.memoryTotalMiB < 1 || gpu.memoryTotalMiB > 1_048_576
      || !['Enabled', 'Disabled'].includes(gpu.migMode)
      || !['Default', 'Exclusive_Process', 'Prohibited', 'Exclusive_Thread'].includes(gpu.computeMode)) {
      throw new NodeProtocolError('INVENTORY_INVALID');
    }
    return {
      stable: {
        uuid,
        model: normalizedText(gpu.model, 2, 120, 'INVENTORY_INVALID'),
        memoryTotalMiB: gpu.memoryTotalMiB,
      },
      runtime: {
        uuid,
        driverVersion: normalizedText(gpu.driverVersion, 1, 64, 'INVENTORY_INVALID'),
        cudaVersion: normalizedText(gpu.cudaVersion, 1, 64, 'INVENTORY_INVALID'),
        migMode: gpu.migMode,
        computeMode: gpu.computeMode,
      },
    };
  }).sort((left, right) => left.stable.uuid < right.stable.uuid ? -1 : left.stable.uuid > right.stable.uuid ? 1 : 0);
  if (new Set(normalized.map((item) => item.stable.uuid)).size !== normalized.length) {
    throw new NodeProtocolError('INVENTORY_INVALID');
  }
  const stable = normalized.map((item) => item.stable);
  return {
    stable,
    inventoryDigest: digest(JSON.stringify(stable)),
    gpuSetDigest: digest(JSON.stringify(stable.map((gpu) => gpu.uuid))),
    runtimeDigest: digest(JSON.stringify(normalized.map((item) => item.runtime))),
  };
}

function canonicalTime(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new NodeProtocolError('CLOCK_INVALID');
  return value;
}

function canonicalAgentVersion(value: string) {
  if (!AGENT_VERSION.test(value)) throw new NodeProtocolError('AGENT_VERSION_INVALID');
  return value;
}

function canonicalDigest(value: string) {
  if (!DIGEST.test(value)) throw new NodeProtocolError('DIGEST_INVALID');
  return value;
}

function canonicalSequence(value: string) {
  if (!/^[1-9]\d{0,18}$/u.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new NodeProtocolError('HEARTBEAT_SEQUENCE_INVALID');
  }
  return BigInt(value).toString();
}

export function canonicalClaimProof(value: ClaimProof) {
  if (!UUID.test(value.claimId) || !/^[A-Za-z0-9_-]{32,120}$/u.test(value.challenge)) {
    throw new NodeProtocolError('CLAIM_PROOF_INVALID');
  }
  return JSON.stringify({
    domain: CLAIM_DOMAIN,
    schemaVersion: NODE_PROTOCOL_SCHEMA_VERSION,
    claimId: value.claimId.toLowerCase(),
    challenge: value.challenge,
    publicKey: normalizeNodePublicKey(value.publicKey),
    observedAt: canonicalTime(value.observedAt),
    inventoryDigest: canonicalDigest(value.inventoryDigest),
    runtimeDigest: canonicalDigest(value.runtimeDigest),
    policyDigest: canonicalDigest(value.policyDigest),
    agentVersion: canonicalAgentVersion(value.agentVersion),
  });
}

export function canonicalHeartbeatProof(value: HeartbeatProof) {
  if (!UUID.test(value.nodeId) || !UUID.test(value.bootId)) throw new NodeProtocolError('HEARTBEAT_ID_INVALID');
  return JSON.stringify({
    domain: HEARTBEAT_DOMAIN,
    schemaVersion: NODE_PROTOCOL_SCHEMA_VERSION,
    nodeId: value.nodeId.toLowerCase(),
    bootId: value.bootId.toLowerCase(),
    sequence: canonicalSequence(value.sequence),
    observedAt: canonicalTime(value.observedAt),
    inventoryDigest: canonicalDigest(value.inventoryDigest),
    runtimeDigest: canonicalDigest(value.runtimeDigest),
    policyDigest: canonicalDigest(value.policyDigest),
    agentVersion: canonicalAgentVersion(value.agentVersion),
  });
}

export function protocolPayloadDigest(canonical: string) { return digest(canonical); }

export function claimTokenHash(claimId: string, token: string, pepper: string) {
  if (!UUID.test(claimId) || !/^[A-Za-z0-9_-]{43,120}$/u.test(token)) throw new NodeProtocolError('CLAIM_TOKEN_INVALID');
  return createHmac('sha256', pepper).update(`node-claim:v1:${claimId.toLowerCase()}:${token}`).digest('hex');
}

type ClaimTokenAad = Readonly<{ claimId: string; deploymentId: string; clientRequestId: string }>;

function claimTokenAad(value: ClaimTokenAad) {
  if (!UUID.test(value.claimId) || !UUID.test(value.deploymentId)
    || value.clientRequestId.length < 16 || value.clientRequestId.length > 120) {
    throw new NodeProtocolError('CLAIM_TOKEN_AAD_INVALID');
  }
  return JSON.stringify({ domain: 'kai-cloudpay/node-claim-token', schemaVersion: 1,
    claimId: value.claimId.toLowerCase(), deploymentId: value.deploymentId.toLowerCase(),
    clientRequestId: value.clientRequestId });
}

function claimTokenKey(base64Key: string) {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32 || key.toString('base64') !== base64Key) throw new NodeProtocolError('CLAIM_TOKEN_KEY_INVALID');
  return key;
}

export function encryptClaimToken(token: string, base64Key: string, aad: ClaimTokenAad) {
  if (!/^[A-Za-z0-9_-]{43,120}$/u.test(token)) throw new NodeProtocolError('CLAIM_TOKEN_INVALID');
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', claimTokenKey(base64Key), nonce);
  cipher.setAAD(Buffer.from(claimTokenAad(aad)));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: encrypted.toString('base64url'), nonce: nonce.toString('base64url') };
}

export function decryptClaimToken(ciphertext: string, nonce: string, base64Key: string, aad: ClaimTokenAad) {
  try {
    const encrypted = Buffer.from(ciphertext, 'base64url'); const nonceBytes = Buffer.from(nonce, 'base64url');
    if (encrypted.length < 17 || nonceBytes.length !== 12 || encrypted.toString('base64url') !== ciphertext
      || nonceBytes.toString('base64url') !== nonce) throw new Error('invalid envelope');
    const body = encrypted.subarray(0, -16); const tag = encrypted.subarray(-16);
    const decipher = createDecipheriv('aes-256-gcm', claimTokenKey(base64Key), nonceBytes);
    decipher.setAAD(Buffer.from(claimTokenAad(aad))); decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    if (!/^[A-Za-z0-9_-]{43,120}$/u.test(token)) throw new Error('invalid plaintext');
    return token;
  } catch (error) {
    if (error instanceof NodeProtocolError && error.code === 'CLAIM_TOKEN_KEY_INVALID') throw error;
    throw new NodeProtocolError('CLAIM_TOKEN_RECOVERY_FAILED');
  }
}

export function gpuUuidFingerprint(uuid: string, pepper: string, keyVersion: number) {
  const normalized = uuid.normalize('NFKC').trim().toUpperCase();
  if (!GPU_UUID.test(normalized) || keyVersion !== 1) {
    throw new NodeProtocolError('INVENTORY_INVALID');
  }
  return createHmac('sha256', pepper).update(`gpu-uuid:v${keyVersion}:${normalized}`).digest('hex');
}

export function constantTimeHashEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeNodePublicKey(value: string) {
  const match = /^ed25519:([A-Za-z0-9+/=]{40,120})$/u.exec(value);
  if (!match?.[1]) throw new NodeProtocolError('NODE_PUBLIC_KEY_INVALID');
  const raw = Buffer.from(match[1], 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== match[1]) throw new NodeProtocolError('NODE_PUBLIC_KEY_INVALID');
  return `ed25519:${match[1]}`;
}

export function nodeKeyFingerprint(publicKey: string) {
  const raw = Buffer.from(normalizeNodePublicKey(publicKey).slice('ed25519:'.length), 'base64');
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

export function verifyNodeProof(publicKey: string, canonical: string, signature: string) {
  const match = /^ed25519:([A-Za-z0-9+/=]{80,160})$/u.exec(signature);
  if (!match?.[1]) return false;
  const signatureBytes = Buffer.from(match[1], 'base64');
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== match[1]) return false;
  const raw = Buffer.from(normalizeNodePublicKey(publicKey).slice('ed25519:'.length), 'base64');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
  return verify(null, Buffer.from(canonical, 'utf8'), key, signatureBytes);
}
