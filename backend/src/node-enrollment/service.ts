import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AccountPrincipal } from '../account/types.js';
import { AppError } from '../errors.js';
import type { SubjectAccess } from '../subjects/types.js';
import type { ClaimConsumeResult, ClaimIssueResult, HeartbeatResult, NodeEnrollmentStore } from './store.js';
import type { RawGpuInventory } from './protocol.js';

export type NodeRequestContext = Readonly<{ requestId: string; ip: string }>;

export interface NodeEnrollmentAuditRecorder {
  record(input: Readonly<{ actorUserId: string | null; action: string; entityType: string; entityId: string;
    requestId: string; ip: string; details: Record<string, unknown> }>): Promise<void>;
}

type Operations = Pick<NodeEnrollmentStore, 'issueClaim' | 'consumeClaim' | 'recordHeartbeat' | 'revokeDeployment'>;
type ConsumeInput = Readonly<{ claimId: string; claimToken: string; publicKey: string; observedAt: string;
  agentVersion: string; inventory: readonly RawGpuInventory[]; inventoryDigest: string; runtimeDigest: string;
  policyDigest: string; signature: string }>;
type HeartbeatInput = Readonly<{ nodeId: string; bootId: string; sequence: string; observedAt: string;
  agentVersion: string; inventory: readonly RawGpuInventory[]; inventoryDigest: string; runtimeDigest: string;
  policyDigest: string; signature: string }>;

function digest(value: unknown) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function error(code: string, status: number, message: string): never { throw new AppError(code, status, message); }

export class NodeEnrollmentService {
  constructor(
    private readonly store: Operations,
    private readonly subjects: SubjectAccess,
    private readonly audit: NodeEnrollmentAuditRecorder,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issueClaim(principal: AccountPrincipal, assetId: string, clientRequestId: string, context: NodeRequestContext) {
    if (!/^[A-Za-z0-9._:-]{16,120}$/u.test(clientRequestId)) {
      error('NODE_CLAIM_IDEMPOTENCY_KEY_INVALID', 400, '缺少有效的幂等键。');
    }
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    const issuedAt = this.now(); const deploymentId = randomUUID(); const claimId = randomUUID();
    const claimToken = randomBytes(32).toString('base64url'); const challenge = randomBytes(32).toString('base64url');
    const requestPayloadDigest = digest({ domain: 'kai-cloudpay/provider-node-claim-request', schemaVersion: 1,
      subjectId: subject.subjectId, userId: principal.userId, assetId: assetId.toLowerCase() });
    const result = await this.store.issueClaim({ deploymentId, claimId, assetId, subjectId: subject.subjectId,
      userId: principal.userId, claimToken, challenge, expiresAt: new Date(issuedAt.getTime() + 600_000),
      gpuFingerprintKeyVersion: 1, clientRequestId, requestPayloadDigest });
    if (result.status === 'not_eligible') error('NODE_CLAIM_ASSET_NOT_ELIGIBLE', 409, '这项资源当前不能接入节点。');
    if (result.status === 'already_bound') error('NODE_CLAIM_ALREADY_BOUND', 409, '这项资源已经连接节点。');
    if (result.status === 'idempotency_conflict') error('NODE_CLAIM_IDEMPOTENCY_CONFLICT', 409, '幂等键已用于其他请求。');
    if (result.status === 'claim_recovery_failed') error('NODE_CLAIM_RECOVERY_FAILED', 503, '认领凭证暂时无法恢复，请联系支持人员。');
    const success = result as Extract<ClaimIssueResult, { status: 'issued' | 'replayed' }>;
    await this.audit.record({ actorUserId: principal.userId, action: success.status === 'issued'
      ? 'NODE_CLAIM_ISSUED' : 'NODE_CLAIM_REPLAYED', entityType: 'ASSET_DEPLOYMENT', entityId: success.deploymentId,
      requestId: context.requestId, ip: context.ip, details: { assetId, claimId: success.claimId,
        deploymentGeneration: success.deploymentGeneration, claimGeneration: success.claimGeneration } });
    return { replayed: success.status === 'replayed', deploymentId: success.deploymentId,
      deploymentGeneration: success.deploymentGeneration, claimId: success.claimId,
      claimGeneration: success.claimGeneration, claimToken: success.claimToken, challenge: success.challenge,
      expectedPolicyDigest: success.expectedPolicyDigest, expiresAt: success.expiresAt.toISOString() };
  }

  async revoke(principal: AccountPrincipal, assetId: string, deploymentId: string, context: NodeRequestContext) {
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    const result = await this.store.revokeDeployment({
      subjectId: subject.subjectId, assetId, deploymentId, now: this.now(),
    });
    if (result.status === 'not_found') error('NODE_ENROLLMENT_NOT_FOUND', 404, '没有找到可撤销的节点接入。');
    if (result.status === 'obligations_active') error('NODE_ENROLLMENT_IN_USE', 409, '资源仍有挂牌、订单或交付任务，暂时不能断开。');
    const replayed = result.status === 'already_revoked';
    await this.audit.record({ actorUserId: principal.userId, action: replayed
      ? 'NODE_ENROLLMENT_REVOKE_REPLAYED' : 'NODE_ENROLLMENT_REVOKED',
      entityType: 'ASSET_DEPLOYMENT', entityId: deploymentId, requestId: context.requestId, ip: context.ip,
      details: { assetId } });
    return { revoked: true, replayed };
  }

  async consume(input: ConsumeInput, context: NodeRequestContext) {
    const result = await this.store.consumeClaim({ ...input, now: this.now() });
    if (result.status === 'invalid') error('NODE_CLAIM_INVALID', 401, '认领凭证或节点签名无效。');
    if (result.status === 'expired') error('NODE_CLAIM_EXPIRED', 410, '认领凭证已过期。');
    if (result.status === 'conflict') error('NODE_CLAIM_CONFLICT', 409, '认领请求与已保存结果不一致。');
    if (result.status === 'policy_mismatch') error('NODE_POLICY_MISMATCH', 409, '节点策略与已审核资源不一致。');
    if (result.status === 'inventory_mismatch') error('NODE_INVENTORY_MISMATCH', 409, '节点上报资源与已审核资料不一致。');
    if (result.status === 'key_conflict') error('NODE_KEY_CONFLICT', 409, '节点密钥已被其他接入占用。');
    if (result.status === 'gpu_conflict') error('NODE_GPU_CONFLICT', 409, 'GPU 已连接到其他资源。');
    const success = result as Extract<ClaimConsumeResult, { status: 'bound' | 'replayed' }>;
    await this.audit.record({ actorUserId: null, action: success.status === 'bound' ? 'NODE_BOUND' : 'NODE_BIND_REPLAYED',
      entityType: 'COMPUTE_NODE', entityId: success.nodeId, requestId: context.requestId, ip: context.ip,
      details: { deploymentId: success.deploymentId, bindingId: success.bindingId } });
    return { replayed: success.status === 'replayed', nodeId: success.nodeId, bindingId: success.bindingId,
      deploymentId: success.deploymentId };
  }

  async heartbeat(input: HeartbeatInput, context: NodeRequestContext) {
    const result = await this.store.recordHeartbeat({ ...input, now: this.now() });
    if (['policy_mismatch', 'runtime_mismatch', 'agent_version_mismatch', 'inventory_mismatch'].includes(result.status)) {
      return { replayed: false, accepted: true, nodeId: input.nodeId, sequence: input.sequence,
        observedAt: input.observedAt, readiness: 'checking' as const, blocker: result.status };
    }
    if (result.status !== 'accepted' && result.status !== 'replayed') {
      this.throwHeartbeat(result as Exclude<HeartbeatResult, { status: 'accepted' | 'replayed' }>);
    }
    const accepted = result as Extract<HeartbeatResult, { status: 'accepted' | 'replayed' }>;
    return { replayed: accepted.status === 'replayed', accepted: true, nodeId: accepted.nodeId, sequence: accepted.sequence,
      observedAt: accepted.observedAt.toISOString(), readiness: accepted.readiness };
  }

  private throwHeartbeat(result: Exclude<HeartbeatResult, { status: 'accepted' | 'replayed' }>): never {
    const mapping: Record<typeof result.status, readonly [string, number, string]> = {
      not_found: ['NODE_NOT_FOUND', 404, '节点不存在。'], revoked: ['NODE_REVOKED', 410, '节点接入已撤销。'],
      clock_invalid: ['NODE_CLOCK_INVALID', 422, '节点时间与服务器时间不一致。'],
      policy_mismatch: ['NODE_POLICY_MISMATCH', 409, '节点策略发生变化。'],
      runtime_mismatch: ['NODE_RUNTIME_MISMATCH', 409, '节点运行环境发生变化。'],
      agent_version_mismatch: ['NODE_AGENT_VERSION_MISMATCH', 409, '节点程序版本不受支持。'],
      inventory_mismatch: ['NODE_INVENTORY_MISMATCH', 409, '节点资源信息发生变化。'],
      signature_invalid: ['NODE_SIGNATURE_INVALID', 401, '节点签名无效。'],
      sequence_conflict: ['NODE_SEQUENCE_CONFLICT', 409, '节点心跳顺序冲突。'],
      boot_replay: ['NODE_BOOT_REPLAY', 409, '节点启动标识已使用。'],
    };
    const [code, status, message] = mapping[result.status]; return error(code, status, message);
  }
}
