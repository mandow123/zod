import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import {
  canonicalClaimProof, canonicalHeartbeatProof, claimTokenHash, constantTimeHashEqual, decryptClaimToken,
  deriveExpectedPolicyDigest, encryptClaimToken, gpuUuidFingerprint, nodeKeyFingerprint, normalizeInventory, normalizeNodePublicKey,
  protocolPayloadDigest, verifyNodeProof, type RawGpuInventory,
} from './protocol.js';

export type ClaimIssueResult =
  | Readonly<{ status: 'issued' | 'replayed'; deploymentId: string; deploymentGeneration: number;
    claimId: string; claimGeneration: number; claimToken: string; challenge: string;
    expectedPolicyDigest: string; expiresAt: Date }>
  | Readonly<{ status: 'not_eligible' | 'already_bound' | 'idempotency_conflict' | 'claim_recovery_failed' }>;

export type ClaimConsumeResult =
  | Readonly<{ status: 'bound' | 'replayed'; nodeId: string; bindingId: string; deploymentId: string }>
  | Readonly<{ status: 'invalid' | 'expired' | 'conflict' | 'policy_mismatch' | 'inventory_mismatch'
    | 'key_conflict' | 'gpu_conflict' }>;

export type HeartbeatResult =
  | Readonly<{ status: 'accepted' | 'replayed'; readiness: 'ready' | 'checking' | 'offline';
    nodeId: string; observedAt: Date; sequence: string }>
  | Readonly<{ status: 'not_found' | 'revoked' | 'clock_invalid' | 'policy_mismatch' | 'runtime_mismatch'
    | 'agent_version_mismatch' | 'inventory_mismatch'
    | 'signature_invalid' | 'sequence_conflict' | 'boot_replay' }>;

type DeploymentRow = QueryResultRow & {
  id: string; asset_id: string; supplier_id: string; resource_id: string; generation: number;
  status: 'claim_issued' | 'node_bound' | 'revoked'; expected_policy_digest: string;
  gpu_fingerprint_key_version: number; verification_digest: string;
};

type ClaimDeploymentRow = QueryResultRow & {
  claim_id: string; deployment_id: string; claim_generation: number; token_hash: string; challenge: string;
  claim_status: 'issued' | 'consumed' | 'revoked'; expires_at: Date; request_payload_digest: string;
  consumed_payload_digest: string | null; consumed_node_id: string | null; consumed_binding_id: string | null;
  asset_id: string; supplier_id: string; resource_id: string; deployment_generation: number;
  deployment_status: 'claim_issued' | 'node_bound' | 'revoked'; expected_policy_digest: string;
  gpu_fingerprint_key_version: number; verification_digest: string; product_code: string;
  specifications: Record<string, unknown>;
};

function validHeartbeatTime(observedAt: Date, now: Date) {
  return observedAt.getTime() > now.getTime() - 120_000 && observedAt.getTime() <= now.getTime() + 30_000;
}

type InventoryMismatch = 'GPU_COUNT_MISMATCH' | 'GPU_MODEL_MISMATCH' | 'GPU_MEMORY_MISMATCH';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const GPU_FAMILIES = ['H100', 'H200', 'H800', 'A100', 'A800', 'L40S', 'L40', 'RTX5090', 'RTX4090'] as const;

function compactGpuName(value: string) { return value.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/gu, ''); }

function auditedGpuFamily(productCode: string) {
  const compact = compactGpuName(productCode);
  return GPU_FAMILIES.find((family) => compact.includes(family)) ?? null;
}

// Audit policy v1 treats the published capacity as a marketed GB/GiB class.
// NVIDIA's reported usable total is commonly below the label, so the lower
// bound allows 3% device/firmware reserve after decimal-GB conversion. The
// upper bound catches a materially different audited SKU without requiring an
// impossible byte-exact match.
function auditedMemoryRangeMiB(memoryClassGb: number) {
  return { minimum: Math.floor(memoryClassGb * 1_000 * 0.97), maximum: Math.ceil(memoryClassGb * 1_024 * 1.03) };
}

export function inventoryMismatchForResource(
  inventory: ReturnType<typeof normalizeInventory>, productCode: string, specifications: Record<string, unknown>,
): InventoryMismatch | null {
  const gpuCount = specifications.gpuCount;
  const memory = specifications.memoryGiBPerGpu;
  if (!Number.isInteger(gpuCount) || gpuCount !== inventory.stable.length) return 'GPU_COUNT_MISMATCH';
  const family = auditedGpuFamily(productCode);
  if (!family || inventory.stable.some((gpu) => !compactGpuName(gpu.model).includes(family))) {
    return 'GPU_MODEL_MISMATCH';
  }
  if (!Number.isInteger(memory)) return 'GPU_MEMORY_MISMATCH';
  const range = auditedMemoryRangeMiB(Number(memory));
  if (inventory.stable.some((gpu) => gpu.memoryTotalMiB < range.minimum || gpu.memoryTotalMiB > range.maximum)) {
    return 'GPU_MEMORY_MISMATCH';
  }
  return null;
}

export class NodeEnrollmentStore {
  constructor(
    private readonly database: Database,
    private readonly fingerprintPepper: string,
    private readonly claimTokenPepper: string,
    private readonly claimTokenEncryptionKey: string,
    private readonly platformPolicyVersion = 'gpu-dedicated-v1',
    private readonly supportedAgentVersions: readonly string[] = ['1.0.0'],
  ) {}

  async issueClaim(input: Readonly<{
    deploymentId: string; claimId: string; assetId: string; subjectId: string; userId: string;
    claimToken: string; challenge: string; expiresAt: Date; gpuFingerprintKeyVersion: 1;
    clientRequestId: string; requestPayloadDigest: string;
  }>): Promise<ClaimIssueResult> {
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`node-claim:${input.userId}:${input.clientRequestId}`]);
      const replay = await client.query<{
        claim_id: string; deployment_id: string; claim_generation: number; challenge: string; expires_at: Date;
        request_payload_digest: string; deployment_generation: number; expected_policy_digest: string;
        token_ciphertext: string; token_nonce: string; token_key_version: number;
        subject_id: string;
      }>(`SELECT c.id AS claim_id,c.deployment_id,c.generation AS claim_generation,c.challenge,c.expires_at,
            c.request_payload_digest,c.token_ciphertext,c.token_nonce,c.token_key_version,
            d.generation AS deployment_generation,d.expected_policy_digest,s.subject_id
          FROM compute_node_claims c JOIN asset_deployments d ON d.id=c.deployment_id
          JOIN supplier_profiles s ON s.id=d.supplier_id
          WHERE c.issued_by_user_id=$1 AND c.client_request_id=$2
          FOR UPDATE OF c,d`, [input.userId, input.clientRequestId]);
      const previous = replay.rows[0];
      if (previous) {
        if (previous.subject_id !== input.subjectId) return { status: 'idempotency_conflict' };
        if (previous.request_payload_digest !== input.requestPayloadDigest) return { status: 'idempotency_conflict' };
        if (previous.token_key_version !== 1) return { status: 'claim_recovery_failed' };
        try {
          const claimToken = decryptClaimToken(previous.token_ciphertext, previous.token_nonce,
            this.claimTokenEncryptionKey, { claimId: previous.claim_id, deploymentId: previous.deployment_id,
              clientRequestId: input.clientRequestId });
          return { status: 'replayed', deploymentId: previous.deployment_id,
            deploymentGeneration: previous.deployment_generation, claimId: previous.claim_id,
            claimGeneration: previous.claim_generation, claimToken, challenge: previous.challenge,
            expectedPolicyDigest: previous.expected_policy_digest, expiresAt: new Date(previous.expires_at) };
        } catch { return { status: 'claim_recovery_failed' }; }
      }

      const eligible = await client.query<{
        asset_id: string; supplier_id: string; resource_id: string; product_code: string;
        specifications: Record<string, unknown>; capacity_unit: string; verification_digest: string;
      }>(`SELECT a.id AS asset_id,a.supplier_id,r.id AS resource_id,r.product_code,r.specifications,
            r.capacity_unit,r.verification_digest
          FROM compute_assets a JOIN supplier_profiles s ON s.id=a.supplier_id
          JOIN compute_resources r ON r.asset_id=a.id AND r.supplier_id=a.supplier_id
          WHERE a.id=$1 AND s.subject_id=$2 AND s.status='approved'
            AND a.lifecycle_status='active' AND r.status='verified' AND r.verification_digest IS NOT NULL
          FOR UPDATE OF a,r,s`, [input.assetId, input.subjectId]);
      const asset = eligible.rows[0];
      if (!asset) return { status: 'not_eligible' };
      const expectedPolicyDigest = deriveExpectedPolicyDigest({
        resourceId: asset.resource_id, productCode: asset.product_code, specifications: asset.specifications,
        capacityUnit: asset.capacity_unit, verificationDigest: asset.verification_digest,
        platformPolicyVersion: this.platformPolicyVersion,
      });

      const current = await client.query<DeploymentRow>(
        `SELECT d.*,r.verification_digest FROM asset_deployments d
         JOIN compute_resources r ON r.id=d.resource_id
         WHERE d.asset_id=$1 AND d.status<>'revoked' FOR UPDATE OF d`, [input.assetId],
      );
      let deployment = current.rows[0];
      if (deployment?.status === 'node_bound') return { status: 'already_bound' };
      if (!deployment) {
        const generation = await client.query<{ next: number }>(
          `SELECT COALESCE(max(generation),0)+1 AS next FROM asset_deployments WHERE asset_id=$1`, [input.assetId],
        );
        const created = await client.query<DeploymentRow>(
          `INSERT INTO asset_deployments(id,asset_id,supplier_id,resource_id,generation,status,
             expected_policy_digest,gpu_fingerprint_key_version,created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,'claim_issued',$6,1,$7)
           RETURNING *,NULL::text AS verification_digest`,
          [input.deploymentId, asset.asset_id, asset.supplier_id, asset.resource_id, generation.rows[0]!.next,
            expectedPolicyDigest, input.userId],
        );
        deployment = created.rows[0]!;
      } else if (deployment.expected_policy_digest !== expectedPolicyDigest) {
        return { status: 'not_eligible' };
      }

      await client.query(
        `UPDATE compute_node_claims SET status='revoked',revoked_at=now()
         WHERE deployment_id=$1 AND status='issued'`, [deployment.id],
      );
      const generation = await client.query<{ next: number }>(
        `SELECT COALESCE(max(generation),0)+1 AS next FROM compute_node_claims WHERE deployment_id=$1`, [deployment.id],
      );
      const tokenHash = claimTokenHash(input.claimId, input.claimToken, this.claimTokenPepper);
      const tokenEnvelope = encryptClaimToken(input.claimToken, this.claimTokenEncryptionKey,
        { claimId: input.claimId, deploymentId: deployment.id, clientRequestId: input.clientRequestId });
      await client.query(
        `INSERT INTO compute_node_claims(id,deployment_id,generation,token_hash,token_ciphertext,token_nonce,token_key_version,
           challenge,expires_at,
           issued_by_user_id,client_request_id,request_payload_digest)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11)`,
        [input.claimId, deployment.id, generation.rows[0]!.next, tokenHash, tokenEnvelope.ciphertext,
          tokenEnvelope.nonce, input.challenge, input.expiresAt, input.userId, input.clientRequestId,
          input.requestPayloadDigest],
      );
      await client.query(`UPDATE asset_deployments SET blocker_code=NULL,version=version+1 WHERE id=$1`, [deployment.id]);
      return { status: 'issued', deploymentId: deployment.id, deploymentGeneration: deployment.generation,
        claimId: input.claimId, claimGeneration: generation.rows[0]!.next, claimToken: input.claimToken,
        challenge: input.challenge,
        expectedPolicyDigest, expiresAt: input.expiresAt };
    });
  }

  async consumeClaim(input: Readonly<{
    claimId: string; claimToken: string; publicKey: string; observedAt: string; agentVersion: string;
    inventory: readonly RawGpuInventory[]; inventoryDigest: string; runtimeDigest: string;
    policyDigest: string; signature: string; now: Date;
  }>): Promise<ClaimConsumeResult> {
    if (!UUID.test(input.claimId)) return { status: 'invalid' };
    return this.database.transaction(async (client) => {
      const result = await client.query<ClaimDeploymentRow>(
        `SELECT c.id AS claim_id,c.deployment_id,c.generation AS claim_generation,c.token_hash,c.challenge,
           c.status AS claim_status,c.expires_at,c.request_payload_digest,c.consumed_payload_digest,
           c.consumed_node_id,c.consumed_binding_id,d.asset_id,d.supplier_id,d.resource_id,
           d.generation AS deployment_generation,d.status AS deployment_status,d.expected_policy_digest,
           d.gpu_fingerprint_key_version,r.verification_digest,r.product_code,r.specifications
         FROM compute_node_claims c JOIN asset_deployments d ON d.id=c.deployment_id
         JOIN compute_resources r ON r.id=d.resource_id AND r.asset_id=d.asset_id AND r.supplier_id=d.supplier_id
         WHERE c.id=$1 FOR UPDATE OF c,d`, [input.claimId.toLowerCase()]);
      const row = result.rows[0];
      let presentedHash: string;
      try { presentedHash = claimTokenHash(input.claimId, input.claimToken, this.claimTokenPepper); }
      catch { return { status: 'invalid' }; }
      if (!row || !constantTimeHashEqual(row.token_hash, presentedHash)) return { status: 'invalid' };

      let inventory;
      try { inventory = normalizeInventory(input.inventory); } catch { return { status: 'inventory_mismatch' }; }
      if (inventory.inventoryDigest !== input.inventoryDigest || inventory.runtimeDigest !== input.runtimeDigest) {
        return { status: 'inventory_mismatch' };
      }
      let publicKey: string; let canonical: string;
      try {
        publicKey = normalizeNodePublicKey(input.publicKey);
        canonical = canonicalClaimProof({ claimId: row.claim_id, challenge: row.challenge, publicKey,
          observedAt: input.observedAt, inventoryDigest: inventory.inventoryDigest,
          runtimeDigest: inventory.runtimeDigest, policyDigest: input.policyDigest, agentVersion: input.agentVersion });
      } catch { return { status: 'invalid' }; }
      const payloadDigest = protocolPayloadDigest(canonical);
      if (!verifyNodeProof(publicKey, canonical, input.signature)) return { status: 'invalid' };
      if (row.claim_status === 'consumed') return row.consumed_payload_digest === payloadDigest
        && row.consumed_node_id && row.consumed_binding_id
        ? { status: 'replayed', nodeId: row.consumed_node_id, bindingId: row.consumed_binding_id,
          deploymentId: row.deployment_id }
        : { status: 'conflict' };
      if (row.claim_status !== 'issued' || row.deployment_status !== 'claim_issued') return { status: 'conflict' };
      const observedAt = new Date(input.observedAt);
      if (!validHeartbeatTime(observedAt, input.now) || new Date(row.expires_at) <= input.now) {
        await this.block(client, row.deployment_id, new Date(row.expires_at) <= input.now ? 'CLAIM_EXPIRED' : 'CLOCK_INVALID');
        return { status: 'expired' };
      }
      if (row.expected_policy_digest !== input.policyDigest) {
        await this.block(client, row.deployment_id, 'POLICY_MISMATCH'); return { status: 'policy_mismatch' };
      }
      if (!this.supportedAgentVersions.includes(input.agentVersion)) {
        await this.block(client, row.deployment_id, 'AGENT_VERSION_MISMATCH'); return { status: 'policy_mismatch' };
      }
      const inventoryMismatch = inventoryMismatchForResource(inventory, row.product_code, row.specifications);
      if (inventoryMismatch) {
        await this.block(client, row.deployment_id, inventoryMismatch); return { status: 'inventory_mismatch' };
      }

      const nodeId = randomUUID(); const bindingId = randomUUID();
      const keyFingerprint = nodeKeyFingerprint(publicKey);
      await client.query('SAVEPOINT node_claim_bind');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO compute_nodes(id,supplier_id,provider_key,node_public_key,node_key_fingerprint,inventory_digest,status,
           deployment_id,expected_policy_digest,runtime_digest,expected_runtime_digest,expected_agent_version,agent_version)
         VALUES ($1,$2,'sidecar-v1',$3,$4,$5,'checking',$6,$7,$8,$8,$9,$9)
         ON CONFLICT DO NOTHING RETURNING id`,
        [nodeId, row.supplier_id, publicKey, keyFingerprint, inventory.inventoryDigest, row.deployment_id,
          row.expected_policy_digest, inventory.runtimeDigest, input.agentVersion],
      );
      if (!inserted.rows[0]) {
        await client.query('ROLLBACK TO SAVEPOINT node_claim_bind');
        await this.block(client, row.deployment_id, 'CLAIM_CONFLICT'); return { status: 'key_conflict' };
      }
      const fingerprints = inventory.stable.map((gpu) => gpuUuidFingerprint(
        gpu.uuid, this.fingerprintPepper, row.gpu_fingerprint_key_version,
      ));
      const gpuRows = await client.query<{ ordinal: number }>(
        `INSERT INTO compute_node_gpus(node_id,ordinal,fingerprint_key_version,gpu_uuid_fingerprint)
         SELECT $1,ordinality-1,1,fingerprint FROM unnest($2::text[]) WITH ORDINALITY AS gpu(fingerprint,ordinality)
         ON CONFLICT DO NOTHING RETURNING ordinal`, [nodeId, fingerprints],
      );
      if (gpuRows.rows.length !== fingerprints.length) {
        await client.query('ROLLBACK TO SAVEPOINT node_claim_bind');
        await this.block(client, row.deployment_id, 'GPU_ALREADY_CLAIMED'); return { status: 'gpu_conflict' };
      }
      const bindingGeneration = await client.query<{ next: number }>(
        `SELECT COALESCE(max(generation),0)+1 AS next FROM compute_resource_bindings WHERE resource_id=$1`, [row.resource_id],
      );
      await client.query(
        `INSERT INTO compute_resource_bindings(id,resource_id,node_id,provider_key,status,generation,
           resource_verification_digest,policy_digest,attested_policy_digest,inventory_digest,gpu_set_digest)
         VALUES ($1,$2,$3,'sidecar-v1','checking',$4,$5,$6,NULL,$7,$8)`,
        [bindingId, row.resource_id, nodeId, bindingGeneration.rows[0]!.next, row.verification_digest,
          row.expected_policy_digest, inventory.inventoryDigest, inventory.gpuSetDigest],
      );
      await client.query(
        `UPDATE asset_deployments SET status='node_bound',node_id=$2,bound_at=$3,blocker_code=NULL,version=version+1 WHERE id=$1`,
        [row.deployment_id, nodeId, input.now],
      );
      await client.query(
        `UPDATE compute_node_claims SET status='consumed',consumed_payload_digest=$2,consumed_node_id=$3,
           consumed_binding_id=$4,consumed_at=$5 WHERE id=$1`,
        [row.claim_id, payloadDigest, nodeId, bindingId, input.now],
      );
      await client.query('RELEASE SAVEPOINT node_claim_bind');
      return { status: 'bound', nodeId, bindingId, deploymentId: row.deployment_id };
    });
  }

  async revokeDeployment(input: Readonly<{ subjectId: string; assetId: string; deploymentId: string; now: Date }>) {
    return this.database.transaction(async (client) => {
      const lockedResource = await client.query<{ resource_id: string }>(
        `SELECT r.id AS resource_id FROM compute_resources r JOIN compute_assets a ON a.id=r.asset_id
         JOIN supplier_profiles s ON s.id=a.supplier_id
         WHERE a.id=$1 AND s.subject_id=$2 FOR UPDATE OF r`, [input.assetId, input.subjectId]);
      if (!lockedResource.rows[0]) return { status: 'not_found' as const };
      const result = await client.query<{ id: string; node_id: string | null; resource_id: string; status: string }>(
        `SELECT d.id,d.node_id,d.resource_id,d.status FROM asset_deployments d JOIN supplier_profiles s ON s.id=d.supplier_id
         WHERE d.asset_id=$1 AND s.subject_id=$2 AND d.id=$3 FOR UPDATE OF d`,
        [input.assetId, input.subjectId, input.deploymentId],
      );
      const deployment = result.rows[0];
      if (!deployment) return { status: 'not_found' as const };
      if (deployment.status === 'revoked') return { status: 'already_revoked' as const };
      const obligations = await client.query(`SELECT 1 WHERE EXISTS (
          SELECT 1 FROM credit_market_listings l WHERE l.resource_id=$1
            AND l.status IN ('active','paused') AND l.expires_at>now()
        ) OR EXISTS (
          SELECT 1 FROM compute_fulfillments f WHERE f.resource_id=$1
            AND f.status IN ('pending','provisioning','ready','running','stopping')
        ) OR EXISTS (
          SELECT 1 FROM kai_credit_orders o JOIN credit_market_listings l ON l.id=o.listing_id
          WHERE l.resource_id=$1 AND o.status IN ('reserved','confirmed','provisioning','ready','in_service',
            'acceptance_pending','release_pending','refund_pending','disputed')
        )`, [deployment.resource_id]);
      if (obligations.rows[0]) return { status: 'obligations_active' as const };
      await client.query(`UPDATE compute_node_claims SET status='revoked',revoked_at=$2
        WHERE deployment_id=$1 AND status='issued'`, [deployment.id, input.now]);
      if (deployment.node_id) {
        await client.query(`UPDATE asset_deployments SET status='revoked',revoked_at=$2,version=version+1 WHERE id=$1`,
          [deployment.id, input.now]);
        await client.query(`UPDATE compute_resource_bindings SET status='revoked'
          WHERE node_id=$1 AND status<>'revoked'`, [deployment.node_id]);
        await client.query(`UPDATE compute_nodes SET status='revoked',version=version+1 WHERE id=$1`, [deployment.node_id]);
        await client.query(`UPDATE compute_node_gpus SET released_at=$2 WHERE node_id=$1 AND released_at IS NULL`,
          [deployment.node_id, input.now]);
      } else {
        await client.query(`UPDATE asset_deployments SET status='revoked',revoked_at=$2,version=version+1 WHERE id=$1`,
          [deployment.id, input.now]);
      }
      return { status: 'revoked' as const };
    });
  }

  async recordHeartbeat(input: Readonly<{
    nodeId: string; bootId: string; sequence: string; observedAt: string; agentVersion: string;
    inventory: readonly RawGpuInventory[]; inventoryDigest: string; runtimeDigest: string;
    policyDigest: string; signature: string; now: Date;
  }>): Promise<HeartbeatResult> {
    if (!UUID.test(input.nodeId)) return { status: 'not_found' };
    if (!UUID.test(input.bootId)) return { status: 'boot_replay' };
    return this.database.transaction(async (client) => {
      const nodeId = input.nodeId.toLowerCase(); const bootId = input.bootId.toLowerCase();
      const result = await client.query<{
        id: string; node_public_key: string; inventory_digest: string; expected_policy_digest: string;
        expected_runtime_digest: string; expected_agent_version: string;
        status: string; deployment_id: string; deployment_status: string; heartbeat_boot_id: string | null;
        heartbeat_sequence: string | null; heartbeat_payload_digest: string | null; heartbeat_observed_at: Date | null;
        last_heartbeat_at: Date | null; binding_id: string; binding_status: string;
      }>(`SELECT n.id,n.node_public_key,n.inventory_digest,n.expected_policy_digest,n.expected_runtime_digest,
           n.expected_agent_version,n.status,n.deployment_id,
           n.heartbeat_boot_id,n.heartbeat_sequence::text,n.heartbeat_payload_digest,n.heartbeat_observed_at,
           n.last_heartbeat_at,d.status AS deployment_status,b.id AS binding_id,b.status AS binding_status
         FROM compute_nodes n JOIN asset_deployments d ON d.id=n.deployment_id AND d.node_id=n.id
         JOIN compute_resource_bindings b ON b.node_id=n.id AND b.status<>'revoked'
         WHERE n.id=$1 FOR UPDATE OF n,d,b`, [nodeId]);
      const row = result.rows[0];
      if (!row) return { status: 'not_found' };
      if (row.status === 'revoked' || row.deployment_status !== 'node_bound') return { status: 'revoked' };
      let canonical: string;
      try { canonical = canonicalHeartbeatProof({ nodeId, bootId, sequence: input.sequence, observedAt: input.observedAt,
        inventoryDigest: input.inventoryDigest, runtimeDigest: input.runtimeDigest,
        policyDigest: input.policyDigest, agentVersion: input.agentVersion }); }
      catch { return { status: 'sequence_conflict' }; }
      if (!verifyNodeProof(row.node_public_key, canonical, input.signature)) return { status: 'signature_invalid' };
      const observedAt = new Date(input.observedAt);
      if (!validHeartbeatTime(observedAt, input.now)) return { status: 'clock_invalid' };
      const payloadDigest = protocolPayloadDigest(canonical); const sequence = BigInt(input.sequence);
      const replayReadiness = () => row.status === 'ready' && row.binding_status === 'ready' && row.last_heartbeat_at
        && new Date(row.last_heartbeat_at).getTime() > input.now.getTime() - 120_000
        ? 'ready' as const : row.status === 'checking' || row.binding_status === 'checking' ? 'checking' as const : 'offline' as const;

      if (row.heartbeat_boot_id?.toLowerCase() === bootId) {
        const previous = BigInt(row.heartbeat_sequence ?? '0');
        if (sequence === previous) return row.heartbeat_payload_digest === payloadDigest
          ? { status: 'replayed', readiness: replayReadiness(), nodeId, observedAt, sequence: input.sequence }
          : { status: 'sequence_conflict' };
        if (sequence < previous || (row.heartbeat_observed_at && observedAt <= new Date(row.heartbeat_observed_at))) {
          return { status: 'sequence_conflict' };
        }
        const updated = await client.query(
          `UPDATE compute_node_boots SET last_observed_at=$3,last_sequence=$4,last_payload_digest=$5,last_signature=$6
           WHERE node_id=$1 AND boot_id=$2`, [nodeId, bootId, observedAt, input.sequence, payloadDigest, input.signature],
        );
        if (updated.rowCount !== 1) return { status: 'boot_replay' };
      } else {
        if (sequence !== 1n || (row.heartbeat_observed_at && observedAt <= new Date(row.heartbeat_observed_at))) {
          return { status: 'boot_replay' };
        }
        const seen = await client.query(`SELECT 1 FROM compute_node_boots WHERE node_id=$1 AND boot_id=$2`, [nodeId, bootId]);
        if (seen.rows[0]) return { status: 'boot_replay' };
        await client.query(`INSERT INTO compute_node_boots(node_id,boot_id,first_observed_at,last_observed_at,last_sequence,
          last_payload_digest,last_signature) VALUES ($1,$2,$3,$3,1,$4,$5)`,
        [nodeId, bootId, observedAt, payloadDigest, input.signature]);
      }
      const consumeRejectedEvidence = async (blocker: string) => {
        await client.query(`UPDATE compute_nodes SET status='checking',last_heartbeat_at=$2,heartbeat_observed_at=$3,
          heartbeat_boot_id=$4,heartbeat_sequence=$5,heartbeat_payload_digest=$6,heartbeat_signature=$7,
          runtime_digest=$8,agent_version=$9,version=version+1 WHERE id=$1`,
        [nodeId, input.now, observedAt, bootId, input.sequence, payloadDigest, input.signature,
          input.runtimeDigest, input.agentVersion]);
        await this.failEvidenceCheck(client, row.deployment_id, row.id, row.binding_id, blocker);
      };
      let inventory;
      try { inventory = normalizeInventory(input.inventory); }
      catch { await consumeRejectedEvidence('INVENTORY_INVALID'); return { status: 'inventory_mismatch' }; }
      if (inventory.inventoryDigest !== input.inventoryDigest || inventory.runtimeDigest !== input.runtimeDigest
        || inventory.inventoryDigest !== row.inventory_digest) {
        await consumeRejectedEvidence('INVENTORY_MISMATCH'); return { status: 'inventory_mismatch' };
      }
      if (input.policyDigest !== row.expected_policy_digest) {
        await consumeRejectedEvidence('POLICY_MISMATCH'); return { status: 'policy_mismatch' };
      }
      if (input.runtimeDigest !== row.expected_runtime_digest) {
        await consumeRejectedEvidence('RUNTIME_MISMATCH'); return { status: 'runtime_mismatch' };
      }
      if (input.agentVersion !== row.expected_agent_version || !this.supportedAgentVersions.includes(input.agentVersion)) {
        await consumeRejectedEvidence('AGENT_VERSION_MISMATCH'); return { status: 'agent_version_mismatch' };
      }
      await client.query(`UPDATE asset_deployments SET blocker_code=NULL,version=version+1 WHERE id=$1`, [row.deployment_id]);
      await client.query(`UPDATE compute_nodes SET status='ready',last_heartbeat_at=$2,heartbeat_observed_at=$3,
          heartbeat_boot_id=$4,heartbeat_sequence=$5,heartbeat_payload_digest=$6,heartbeat_signature=$7,
          attested_policy_digest=$8,runtime_digest=$9,attested_runtime_digest=$9,agent_version=$10,
          version=version+1 WHERE id=$1`,
      [nodeId, input.now, observedAt, bootId, input.sequence, payloadDigest, input.signature,
        input.policyDigest, inventory.runtimeDigest, input.agentVersion]);
      await client.query(`UPDATE compute_resource_bindings SET status='ready',attested_policy_digest=$2,inventory_digest=$3,
          confirmed_at=COALESCE(confirmed_at,$4) WHERE id=$1`,
      [row.binding_id, input.policyDigest, inventory.inventoryDigest, input.now]);
      return { status: 'accepted', readiness: 'ready', nodeId, observedAt, sequence: input.sequence };
    });
  }

  private block(client: PoolClient, deploymentId: string, blocker: string) {
    return client.query(`UPDATE asset_deployments SET blocker_code=$2,version=version+1 WHERE id=$1`, [deploymentId, blocker]);
  }

  private async failEvidenceCheck(client: PoolClient, deploymentId: string, nodeId: string, bindingId: string, blocker: string) {
    await client.query(`UPDATE compute_nodes SET status='checking',version=version+1 WHERE id=$1 AND status<>'revoked'`, [nodeId]);
    await client.query(`UPDATE compute_resource_bindings SET status='checking' WHERE id=$1 AND status<>'revoked'`, [bindingId]);
    await this.block(client, deploymentId, blocker);
  }
}
