const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CLAIM_TOKEN = /^[A-Za-z0-9_-]{43,120}$/u;
const CHALLENGE = /^[A-Za-z0-9_-]{32,120}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export class NodeClaimEnvelopeError extends Error {
  readonly code: 'BACKEND_URL_INVALID' | 'CLAIM_EXPIRED' | 'CLAIM_INVALID';
  constructor(code: 'BACKEND_URL_INVALID' | 'CLAIM_EXPIRED' | 'CLAIM_INVALID', message: string) {
    super(message); this.name = 'NodeClaimEnvelopeError'; this.code = code;
  }
}

export type ProviderNodeClaim = Readonly<{
  protocolVersion: 1;
  deploymentId: string;
  deploymentGeneration: number;
  claimId: string;
  claimGeneration: number;
  claimToken: string;
  challenge: string;
  expectedPolicyDigest: string;
  expiresAt: string;
  consumePath: string;
  replayed: boolean;
}>;

export type NodeClaimEnvelope = Readonly<{
  protocolVersion: 1;
  backendBaseUrl: string;
  deploymentId: string;
  claimId: string;
  claimToken: string;
  challenge: string;
  expectedPolicyDigest: string;
  expiresAt: string;
  consumePath: string;
}>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeClaimEnvelopeError('CLAIM_INVALID', '节点接入配置格式不正确。');
  }
  return value as Record<string, unknown>;
}

export function buildNodeClaimEnvelope(
  value: unknown,
  backendBaseUrl: string,
  now = Date.now(),
  allowInsecureLocalE2e = false,
): NodeClaimEnvelope {
  const claim = record(value);
  const deploymentId = String(claim.deploymentId ?? '').toLowerCase();
  const claimId = String(claim.claimId ?? '').toLowerCase();
  const consumePath = String(claim.consumePath ?? '');
  const expiresAt = String(claim.expiresAt ?? '');
  const expiry = Date.parse(expiresAt);
  let base: URL;
  try { base = new URL(backendBaseUrl); }
  catch { throw new NodeClaimEnvelopeError('BACKEND_URL_INVALID', '节点服务地址无效。'); }
  const localE2eHttp = allowInsecureLocalE2e && base.protocol === 'http:'
    && ['10.0.2.2', '127.0.0.1', 'localhost'].includes(base.hostname);
  if ((!localE2eHttp && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash
    || !/^\/+$/u.test(base.pathname)) {
    throw new NodeClaimEnvelopeError('BACKEND_URL_INVALID', '节点接入只允许使用安全的 HTTPS 根地址。');
  }
  const canonicalBase = base.toString().replace(/\/+$/u, '');
  if (claim.protocolVersion !== 1 || !UUID.test(deploymentId) || !UUID.test(claimId)
    || !Number.isInteger(claim.deploymentGeneration) || Number(claim.deploymentGeneration) < 1
    || !Number.isInteger(claim.claimGeneration) || Number(claim.claimGeneration) < 1
    || typeof claim.replayed !== 'boolean'
    || typeof claim.claimToken !== 'string' || !CLAIM_TOKEN.test(claim.claimToken)
    || typeof claim.challenge !== 'string' || !CHALLENGE.test(claim.challenge)
    || typeof claim.expectedPolicyDigest !== 'string' || !DIGEST.test(claim.expectedPolicyDigest)
    || !Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt
    || consumePath !== `/node/v1/claims/${claimId}/consume`) {
    throw new NodeClaimEnvelopeError('CLAIM_INVALID', '节点接入配置未通过安全校验，请重新生成。');
  }
  if (expiry <= now) throw new NodeClaimEnvelopeError('CLAIM_EXPIRED', '一次性配置已失效，正在重新生成。');
  if (expiry > now + 11 * 60_000) {
    throw new NodeClaimEnvelopeError('CLAIM_INVALID', '节点接入配置未通过安全校验，请重新生成。');
  }
  return {
    protocolVersion: 1, backendBaseUrl: canonicalBase, deploymentId, claimId,
    claimToken: claim.claimToken, challenge: claim.challenge,
    expectedPolicyDigest: claim.expectedPolicyDigest, expiresAt, consumePath,
  };
}

export function serializeNodeClaimEnvelope(envelope: NodeClaimEnvelope) {
  return JSON.stringify(envelope);
}

export const NODE_ENROLL_COMMAND = 'sudo kai-h100-sidecar-enroll';
