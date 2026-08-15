import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { canonicalClaimProof, canonicalHeartbeatProof, normalizeInventory, type RawGpuInventory } from '../src/node-enrollment/protocol.js';
import { NodeEnrollmentStore } from '../src/node-enrollment/store.js';

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => work({
      query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)),
    } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

async function migrateAll(pglite: PGlite) {
  for (const name of (await readdir(new URL('../migrations', import.meta.url))).filter((name) => name.endsWith('.sql')).sort()) {
    await pglite.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
}

async function fixture(database: Database) {
  const userId = randomUUID(); const subjectId = randomUUID(); const supplierId = randomUUID();
  await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES ($1,'node-owner','节点资源方','supplier')`, [userId]);
  await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES ($1,'personal','节点资源方',$2)`,
    [subjectId, userId]);
  await database.query(`INSERT INTO subject_memberships(subject_id,user_id,role) VALUES ($1,$2,'owner')`, [subjectId, userId]);
  await database.query(`INSERT INTO supplier_profiles(id,created_by_user_id,subject_id,legal_name,credit_code,contact_name,status)
    VALUES ($1,$2,$3,'凯云节点资源','91310101MA1NODE001','凯','approved')`, [supplierId, userId, subjectId]);
  const createResource = async (suffix: string) => {
    const assetId = randomUUID(); const resourceId = randomUUID();
    await database.query(`INSERT INTO compute_assets(id,supplier_id,lifecycle_status,asset_identity_kind,asset_fingerprint)
      VALUES ($1,$2,'active','hardware_serial',$3)`, [assetId, supplierId, `node-hardware-asset-${suffix}`]);
    await database.query(`INSERT INTO compute_resources(id,supplier_id,asset_id,kind,product_code,region,specifications,
      capacity_total,capacity_unit,status,verification_digest) VALUES ($1,$2,$3,'gpu','H100-SXM-80G','华东-上海',$4,2,'GPU时',
      'verified',$5)`, [resourceId, supplierId, assetId, { gpuCount: 2, memoryGiBPerGpu: 80 }, `sha256:${suffix.repeat(64)}`]);
    return { assetId, resourceId };
  };
  return { userId, subjectId, supplierId, first: await createResource('a'), second: await createResource('b'),
    third: await createResource('c'), fourth: await createResource('d'), fifth: await createResource('e') };
}

const vector = JSON.parse(await readFile(new URL('../../test/fixtures/node-protocol-v1.json', import.meta.url), 'utf8'));
const privateKey = createPrivateKey({ key: vector.privateJwk, format: 'jwk' });
const signature = (canonical: string) => `ed25519:${sign(null, Buffer.from(canonical), privateKey).toString('base64')}`;

describe('node enrollment persistence', () => {
  it('recovers the exact claim token and rejects idempotency/key-envelope conflicts', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrateAll(pglite); const database = adapter(pglite);
    const owner = await fixture(database); const key = Buffer.alloc(32, 9).toString('base64');
    await expect(database.query(`INSERT INTO compute_nodes(id,supplier_id,node_public_key,node_key_fingerprint,
      inventory_digest,status,last_heartbeat_at,heartbeat_boot_id,heartbeat_sequence,heartbeat_payload_digest,heartbeat_signature,
      expected_policy_digest,attested_policy_digest,runtime_digest,expected_runtime_digest,attested_runtime_digest,
      expected_agent_version,agent_version) VALUES ($1,$2,$3,$4,$5,'ready',now(),$6,1,$7,$8,$9,$9,$10,$10,$10,'1.0.0','1.0.0')`,
    [randomUUID(), owner.supplierId, `ed25519:${'E'.repeat(44)}`, `sha256:${'1'.repeat(64)}`,
      `sha256:${'2'.repeat(64)}`, randomUUID(), `sha256:${'3'.repeat(64)}`, `ed25519:${'F'.repeat(88)}`,
      `sha256:${'4'.repeat(64)}`, `sha256:${'5'.repeat(64)}`])).rejects.toThrow();
    const store = new NodeEnrollmentStore(database, 'gpu-pepper-012345678901234567890123',
      'claim-pepper-012345678901234567890', key);
    const base = { deploymentId: randomUUID(), claimId: randomUUID(), assetId: owner.first.assetId,
      subjectId: owner.subjectId, userId: owner.userId, claimToken: 'A'.repeat(43),
      challenge: 'challenge_0123456789ABCDEFGHijklmn', expiresAt: new Date(Date.now() + 600_000),
      gpuFingerprintKeyVersion: 1 as const, clientRequestId: 'node-claim-request-0001', requestPayloadDigest: 'node-claim-payload-0001' };
    const concurrent = await Promise.all([store.issueClaim(base), store.issueClaim({ ...base, deploymentId: randomUUID(),
      claimId: randomUUID(), claimToken: 'B'.repeat(43) })]);
    expect(concurrent.map((result) => result.status).sort()).toEqual(['issued', 'replayed']);
    expect(concurrent.every((result) => !('claimToken' in result) || result.claimToken === base.claimToken)).toBe(true);
    const issued = concurrent.find((result) => result.status === 'issued')!;
    if (!('deploymentId' in issued)) throw new Error(issued.status);
    expect(await store.issueClaim({ ...base, subjectId: randomUUID(), deploymentId: randomUUID(), claimId: randomUUID() }))
      .toEqual({ status: 'idempotency_conflict' });
    expect(await store.issueClaim({ ...base, deploymentId: randomUUID(), claimId: randomUUID(),
      clientRequestId: 'node-claim-request-xsub', assetId: owner.first.assetId, subjectId: randomUUID() }))
      .toEqual({ status: 'not_eligible' });
    const replay = await store.issueClaim({ ...base, deploymentId: randomUUID(), claimId: randomUUID(), claimToken: 'B'.repeat(43) });
    expect(replay).toMatchObject({ status: 'replayed', claimToken: base.claimToken });
    expect(await store.issueClaim({ ...base, requestPayloadDigest: 'node-claim-payload-conflict' }))
      .toEqual({ status: 'idempotency_conflict' });
    const wrongKey = new NodeEnrollmentStore(database, 'gpu-pepper-012345678901234567890123',
      'claim-pepper-012345678901234567890', Buffer.alloc(32, 8).toString('base64'));
    expect(await wrongKey.issueClaim(base)).toEqual({ status: 'claim_recovery_failed' });
    await expect(database.query(`UPDATE compute_node_claims SET token_key_version=2 WHERE id=$1`, [base.claimId])).rejects.toThrow();
    await expect(store.issueClaim({ ...base, assetId: owner.second.assetId, deploymentId: randomUUID(), claimId: randomUUID(),
      clientRequestId: 'node-claim-too-long-0001', requestPayloadDigest: 'node-claim-too-long-payload',
      expiresAt: new Date(Date.now() + 31 * 60_000) })).rejects.toThrow();
    expect(await store.revokeDeployment({ subjectId: randomUUID(), assetId: owner.first.assetId,
      deploymentId: issued.deploymentId, now: new Date() }))
      .toEqual({ status: 'not_found' });
    await database.close();
  });

  it('requires a signed heartbeat before ready and releases stable node identity only after revoke', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrateAll(pglite); const database = adapter(pglite); const owner = await fixture(database);
    const store = new NodeEnrollmentStore(database, 'gpu-pepper-012345678901234567890123',
      'claim-pepper-012345678901234567890', Buffer.alloc(32, 9).toString('base64'));
    const now = new Date(); const inventory = normalizeInventory(vector.rawInventory as RawGpuInventory[]);
    const issue = async (assetId: string, suffix: string) => store.issueClaim({ deploymentId: randomUUID(), claimId: randomUUID(),
      assetId, subjectId: owner.subjectId, userId: owner.userId, claimToken: suffix.repeat(43),
      challenge: `challenge_0123456789ABCDEFGHijkl${suffix}`, expiresAt: new Date(now.getTime() + 600_000),
      gpuFingerprintKeyVersion: 1, clientRequestId: `node-claim-request-000${suffix}`, requestPayloadDigest: `node-payload-000${suffix}` });
    const bind = async (claim: Extract<Awaited<ReturnType<typeof issue>>, { status: 'issued' | 'replayed' }>) => {
      const fields = { claimId: claim.claimId, challenge: claim.challenge, publicKey: vector.publicKey,
        observedAt: now.toISOString(), inventoryDigest: inventory.inventoryDigest, runtimeDigest: inventory.runtimeDigest,
        policyDigest: claim.expectedPolicyDigest, agentVersion: '1.0.0' };
      return store.consumeClaim({ ...fields, claimToken: claim.claimToken, inventory: vector.rawInventory,
        signature: signature(canonicalClaimProof(fields)), now });
    };
    const first = await issue(owner.first.assetId, 'C'); if (!('claimToken' in first)) throw new Error(first.status);
    const firstBinding = await bind(first); expect(firstBinding.status).toBe('bound');
    if (!('nodeId' in firstBinding)) throw new Error(firstBinding.status);
    await expect(database.query(`UPDATE compute_nodes SET status='revoked' WHERE id=$1`, [firstBinding.nodeId])).rejects.toThrow();
    await expect(database.query(`UPDATE compute_node_gpus SET released_at=now() WHERE node_id=$1`, [firstBinding.nodeId])).rejects.toThrow();
    await expect(database.query(`UPDATE compute_nodes SET status='ready',last_heartbeat_at=now(),heartbeat_observed_at=now(),
      heartbeat_boot_id=$2,heartbeat_sequence=1,heartbeat_payload_digest=$3,heartbeat_signature=$4,
      attested_policy_digest=expected_policy_digest,attested_runtime_digest=expected_runtime_digest WHERE id=$1`,
    [firstBinding.nodeId, randomUUID(), `sha256:${'7'.repeat(64)}`, `ed25519:${'C'.repeat(88)}`])).rejects.toThrow();
    expect(await bind(first)).toEqual({ status: 'replayed', nodeId: firstBinding.nodeId,
      bindingId: firstBinding.bindingId, deploymentId: firstBinding.deploymentId });
    expect((await database.query(`SELECT d.status,n.status AS node_status,b.status AS binding_status,
      b.attested_policy_digest,v.status AS readiness FROM asset_deployments d JOIN compute_nodes n ON n.id=d.node_id
      JOIN compute_resource_bindings b ON b.node_id=n.id JOIN compute_resource_delivery_readiness v ON v.resource_id=b.resource_id
      WHERE d.id=$1`, [first.deploymentId])).rows[0]).toMatchObject({
      status: 'node_bound', node_status: 'checking', binding_status: 'checking', attested_policy_digest: null, readiness: 'checking',
    });

    const heartbeatFields = { nodeId: firstBinding.nodeId, bootId: randomUUID(), sequence: '1',
      observedAt: new Date(now.getTime() + 1_000).toISOString(), inventoryDigest: inventory.inventoryDigest,
      runtimeDigest: inventory.runtimeDigest, policyDigest: first.expectedPolicyDigest, agentVersion: '1.0.0' };
    const firstHeartbeat = { ...heartbeatFields, inventory: vector.rawInventory,
      signature: signature(canonicalHeartbeatProof(heartbeatFields)), now: new Date(now.getTime() + 1_000) };
    expect(await store.recordHeartbeat(firstHeartbeat))
      .toMatchObject({ status: 'accepted', readiness: 'ready' });
    expect(await store.recordHeartbeat(firstHeartbeat)).toMatchObject({ status: 'replayed', readiness: 'ready' });
    const changedSameSequence = { ...heartbeatFields, observedAt: new Date(now.getTime() + 2_000).toISOString() };
    expect(await store.recordHeartbeat({ ...changedSameSequence, inventory: vector.rawInventory,
      signature: signature(canonicalHeartbeatProof(changedSameSequence)), now: new Date(now.getTime() + 2_000) }))
      .toEqual({ status: 'sequence_conflict' });
    const wrongNodeProof = { ...heartbeatFields, nodeId: randomUUID(), sequence: '2',
      observedAt: new Date(now.getTime() + 2_000).toISOString() };
    expect(await store.recordHeartbeat({ ...heartbeatFields, sequence: '2', observedAt: wrongNodeProof.observedAt,
      inventory: vector.rawInventory, signature: signature(canonicalHeartbeatProof(wrongNodeProof)),
      now: new Date(now.getTime() + 2_000) })).toEqual({ status: 'signature_invalid' });
    const future = { ...heartbeatFields, sequence: '2', observedAt: new Date(now.getTime() + 3_600_000).toISOString() };
    expect(await store.recordHeartbeat({ ...future, inventory: vector.rawInventory,
      signature: signature(canonicalHeartbeatProof(future)), now: new Date(now.getTime() + 2_000) }))
      .toEqual({ status: 'clock_invalid' });
    const nextBoot = { ...heartbeatFields, bootId: randomUUID(), sequence: '1',
      observedAt: new Date(now.getTime() + 3_000).toISOString() };
    expect(await store.recordHeartbeat({ ...nextBoot, inventory: vector.rawInventory,
      signature: signature(canonicalHeartbeatProof(nextBoot)), now: new Date(now.getTime() + 3_000) }))
      .toMatchObject({ status: 'accepted' });
    const oldBoot = { ...heartbeatFields, sequence: '2', observedAt: new Date(now.getTime() + 4_000).toISOString() };
    expect(await store.recordHeartbeat({ ...oldBoot, inventory: vector.rawInventory,
      signature: signature(canonicalHeartbeatProof(oldBoot)), now: new Date(now.getTime() + 4_000) }))
      .toEqual({ status: 'boot_replay' });
    expect(await store.recordHeartbeat({ ...firstHeartbeat, nodeId: 'bad-id' })).toEqual({ status: 'not_found' });
    expect((await database.query(`SELECT b.attested_policy_digest,v.status AS readiness FROM compute_resource_bindings b
      JOIN compute_resource_delivery_readiness v ON v.resource_id=b.resource_id WHERE b.node_id=$1`, [firstBinding.nodeId])).rows[0])
      .toMatchObject({ attested_policy_digest: first.expectedPolicyDigest, readiness: 'ready' });
    await expect(database.query(`UPDATE compute_nodes SET attested_runtime_digest=NULL WHERE id=$1`, [firstBinding.nodeId])).rejects.toThrow();

    const noGpuDeployment = randomUUID(); const noGpuNode = randomUUID(); const noGpuBinding = randomUUID();
    const noGpuPolicy = `sha256:${'4'.repeat(64)}`; const noGpuRuntime = `sha256:${'5'.repeat(64)}`;
    const noGpuBoot = randomUUID(); const noGpuPayload = `sha256:${'6'.repeat(64)}`; const noGpuSignature = `ed25519:${'D'.repeat(88)}`;
    await database.query(`INSERT INTO asset_deployments(id,asset_id,supplier_id,resource_id,generation,status,
      expected_policy_digest,gpu_fingerprint_key_version,created_by_user_id)
      VALUES ($1,$2,$3,$4,1,'claim_issued',$5,1,$6)`,
    [noGpuDeployment, owner.fifth.assetId, owner.supplierId, owner.fifth.resourceId, noGpuPolicy, owner.userId]);
    await database.query(`INSERT INTO compute_nodes(id,supplier_id,node_public_key,node_key_fingerprint,inventory_digest,status,
      deployment_id,expected_policy_digest,attested_policy_digest,runtime_digest,expected_runtime_digest,attested_runtime_digest,
      expected_agent_version,agent_version) VALUES ($1,$2,$3,$4,$5,'checking',$6,$7,$7,$8,$8,$8,'1.0.0','1.0.0')`,
    [noGpuNode, owner.supplierId, `ed25519:${'C'.repeat(44)}`, `sha256:${'7'.repeat(64)}`,
      `sha256:${'8'.repeat(64)}`, noGpuDeployment, noGpuPolicy, noGpuRuntime]);
    await database.query(`INSERT INTO compute_resource_bindings(id,resource_id,node_id,status,resource_verification_digest,
      policy_digest,attested_policy_digest,inventory_digest,gpu_set_digest)
      VALUES ($1,$2,$3,'checking',$4,$5,NULL,$6,$7)`,
    [noGpuBinding, owner.fifth.resourceId, noGpuNode, `sha256:${'e'.repeat(64)}`, noGpuPolicy,
      `sha256:${'8'.repeat(64)}`, `sha256:${'3'.repeat(64)}`]);
    await database.query(`UPDATE asset_deployments SET status='node_bound',node_id=$2,bound_at=now() WHERE id=$1`,
      [noGpuDeployment, noGpuNode]);
    await database.query(`INSERT INTO compute_node_boots(node_id,boot_id,first_observed_at,last_observed_at,last_sequence,
      last_payload_digest,last_signature) VALUES ($1,$2,now(),now(),1,$3,$4)`,
    [noGpuNode, noGpuBoot, noGpuPayload, noGpuSignature]);
    await expect(database.query(`UPDATE compute_nodes SET status='ready',last_heartbeat_at=now(),heartbeat_observed_at=now(),
      heartbeat_boot_id=$2,heartbeat_sequence=1,heartbeat_payload_digest=$3,heartbeat_signature=$4 WHERE id=$1`,
    [noGpuNode, noGpuBoot, noGpuPayload, noGpuSignature])).rejects.toThrow();

    const forged = { ...nextBoot, sequence: '2', observedAt: new Date(now.getTime() + 5_000).toISOString() };
    expect(await store.recordHeartbeat({ ...forged, inventory: vector.rawInventory,
      signature: vector.claim.signature, now: new Date(now.getTime() + 5_000) })).toEqual({ status: 'signature_invalid' });
    expect((await database.query<{ status: string }>(`SELECT status FROM compute_nodes WHERE id=$1`, [firstBinding.nodeId])).rows[0]?.status)
      .toBe('ready');
    const drifted = { ...forged, policyDigest: `sha256:${'f'.repeat(64)}` };
    expect(await store.recordHeartbeat({ ...drifted, inventory: vector.rawInventory,
      signature: signature(canonicalHeartbeatProof(drifted)), now: new Date(now.getTime() + 5_000) }))
      .toEqual({ status: 'policy_mismatch' });
    expect(await store.recordHeartbeat({ ...drifted, inventory: vector.rawInventory,
      signature: signature(canonicalHeartbeatProof(drifted)), now: new Date(now.getTime() + 5_000) }))
      .toMatchObject({ status: 'replayed', readiness: 'checking' });
    expect((await database.query<{ status: string }>(`SELECT status FROM compute_nodes WHERE id=$1`, [firstBinding.nodeId])).rows[0]?.status)
      .toBe('checking');
    const recovered = { ...forged, sequence: '3', observedAt: new Date(now.getTime() + 6_000).toISOString() };
    expect(await store.recordHeartbeat({ ...recovered, inventory: vector.rawInventory,
      signature: signature(canonicalHeartbeatProof(recovered)), now: new Date(now.getTime() + 6_000) }))
      .toMatchObject({ status: 'accepted', readiness: 'ready' });
    const runtimeRaw = (vector.rawInventory as RawGpuInventory[]).map((gpu) => ({ ...gpu, driverVersion: '581.0' }));
    const runtimeChanged = normalizeInventory(runtimeRaw); const runtimeDrift = { ...recovered, sequence: '4',
      observedAt: new Date(now.getTime() + 7_000).toISOString(), runtimeDigest: runtimeChanged.runtimeDigest };
    expect(await store.recordHeartbeat({ ...runtimeDrift, inventory: runtimeRaw,
      signature: signature(canonicalHeartbeatProof(runtimeDrift)), now: new Date(now.getTime() + 7_000) }))
      .toEqual({ status: 'runtime_mismatch' });
    const afterRuntime = { ...recovered, sequence: '5', observedAt: new Date(now.getTime() + 8_000).toISOString() };
    expect(await store.recordHeartbeat({ ...afterRuntime, inventory: vector.rawInventory,
      signature: signature(canonicalHeartbeatProof(afterRuntime)), now: new Date(now.getTime() + 8_000) }))
      .toMatchObject({ status: 'accepted' });
    const agentDrift = { ...afterRuntime, sequence: '6', observedAt: new Date(now.getTime() + 9_000).toISOString(),
      agentVersion: '2.0.0' };
    expect(await store.recordHeartbeat({ ...agentDrift, inventory: vector.rawInventory,
      signature: signature(canonicalHeartbeatProof(agentDrift)), now: new Date(now.getTime() + 9_000) }))
      .toEqual({ status: 'agent_version_mismatch' });

    const second = await issue(owner.second.assetId, 'D'); if (!('claimToken' in second)) throw new Error(second.status);
    expect(await bind(second)).toEqual({ status: 'key_conflict' });
    const third = await issue(owner.third.assetId, 'E'); if (!('claimToken' in third)) throw new Error(third.status);
    const alternateRaw = (vector.rawInventory as RawGpuInventory[]).map((gpu) => ({ ...gpu, model: 'NVIDIA H100 SXM5 80GB HBM3' }));
    const alternateInventory = normalizeInventory(alternateRaw);
    const thirdFields = { claimId: third.claimId, challenge: third.challenge, observedAt: now.toISOString(),
      inventoryDigest: alternateInventory.inventoryDigest, runtimeDigest: alternateInventory.runtimeDigest,
      policyDigest: third.expectedPolicyDigest, agentVersion: '1.0.0' };
    expect(await store.consumeClaim({ ...thirdFields, publicKey: vector.publicKey, claimToken: 'Z'.repeat(43),
      inventory: alternateRaw, signature: signature(canonicalClaimProof({ ...thirdFields, publicKey: vector.publicKey })), now }))
      .toEqual({ status: 'invalid' });
    expect((await database.query<{ status: string }>(`SELECT status FROM compute_node_claims WHERE id=$1`, [third.claimId])).rows[0]?.status)
      .toBe('issued');
    const alternate = generateKeyPairSync('ed25519'); const alternateJwk = createPublicKey(alternate.privateKey).export({ format: 'jwk' });
    const alternatePublic = `ed25519:${Buffer.from(alternateJwk.x!, 'base64url').toString('base64')}`;
    const alternateCanonical = canonicalClaimProof({ ...thirdFields, publicKey: alternatePublic });
    expect(await store.consumeClaim({ ...thirdFields, publicKey: alternatePublic, claimToken: third.claimToken,
      inventory: alternateRaw, signature: `ed25519:${sign(null, Buffer.from(alternateCanonical), alternate.privateKey).toString('base64')}`, now }))
      .toEqual({ status: 'gpu_conflict' });

    const fourth = await issue(owner.fourth.assetId, 'F'); if (!('claimToken' in fourth)) throw new Error(fourth.status);
    const expiredNow = new Date(fourth.expiresAt.getTime() + 1_000); const expiredFields = {
      claimId: fourth.claimId, challenge: fourth.challenge, publicKey: vector.publicKey, observedAt: expiredNow.toISOString(),
      inventoryDigest: inventory.inventoryDigest, runtimeDigest: inventory.runtimeDigest,
      policyDigest: fourth.expectedPolicyDigest, agentVersion: '1.0.0' };
    expect(await store.consumeClaim({ ...expiredFields, claimToken: fourth.claimToken, inventory: vector.rawInventory,
      signature: signature(canonicalClaimProof(expiredFields)), now: expiredNow })).toEqual({ status: 'expired' });
    expect((await database.query<{ status: string }>(`SELECT status FROM compute_node_claims WHERE id=$1`, [fourth.claimId])).rows[0]?.status)
      .toBe('issued');

    const offerId = randomUUID(); const resourceAuditId = randomUUID(); const priceAuditId = randomUUID();
    await database.query(`INSERT INTO offer_templates(id,supplier_id,resource_id,client_request_id,payload_digest,submission_version,
      title,service_mode,native_unit,minimum_quantity,suggested_price_cny_micros,status,approved_reference_cny_micros,
      approved_unit_credit_micros,conversion_cny_micros_per_credit,audit_valid_until,submitted_at,approved_at)
      VALUES ($1,$2,$3,'node-offer-request-0001','node-offer-payload',1,'H100 节点','dedicated','GPU时',1,1002000,
      'approved',1002000,1000000,1002000,now()+interval '1 day',now(),now())`,
    [offerId, owner.supplierId, owner.first.resourceId]);
    for (const [id, kind] of [[resourceAuditId, 'resource'], [priceAuditId, 'price']] as const) {
      await database.query(`INSERT INTO offer_audit_versions(id,offer_id,submission_version,kind,status,reviewer_id,
        decision_reason,evidence_summary,evidence_digest,decision_digest,approved_reference_cny_micros,
        conversion_cny_micros_per_credit,approved_unit_credit_micros,valid_until,decided_at)
        VALUES ($1,$2,1,$3,'approved',$4,'通过','节点证据一致',$5,$6,1002000,1002000,1000000,
        now()+interval '1 day',now())`, [id, offerId, kind, owner.userId, `sha256:${kind[0]!.repeat(64)}`, `decision-${kind}`]);
    }
    const listingId = randomUUID();
    await database.query(`INSERT INTO credit_market_listings(id,offer_id,resource_id,supplier_id,client_request_id,payload_digest,
      resource_audit_id,price_audit_id,capacity_total,capacity_unit,minimum_quantity,unit_credit_micros,
      reference_cny_micros,conversion_cny_micros_per_credit,status,starts_at,expires_at,audit_snapshot,published_by)
      VALUES ($1,$2,$3,$4,'node-listing-request-0001','node-listing-payload',$5,$6,2,'GPU时',1,1000000,
      1002000,1002000,'active',now()-interval '1 minute',now()+interval '1 day','{}',$7)`,
    [listingId, offerId, owner.first.resourceId, owner.supplierId, resourceAuditId, priceAuditId, owner.userId]);
    expect(await store.revokeDeployment({ subjectId: owner.subjectId, assetId: owner.first.assetId,
      deploymentId: first.deploymentId,
      now: new Date(now.getTime() + 2_000) })).toEqual({ status: 'obligations_active' });
    await database.query(`UPDATE credit_market_listings SET status='withdrawn' WHERE id=$1`, [listingId]);
    expect(await store.revokeDeployment({ subjectId: owner.subjectId, assetId: owner.first.assetId,
      deploymentId: first.deploymentId,
      now: new Date(now.getTime() + 2_000) })).toEqual({ status: 'revoked' });
    expect(await store.revokeDeployment({ subjectId: owner.subjectId, assetId: owner.first.assetId,
      deploymentId: first.deploymentId,
      now: new Date(now.getTime() + 2_001) })).toEqual({ status: 'already_revoked' });
    const replacement = await issue(owner.first.assetId, 'G'); if (!('claimToken' in replacement)) throw new Error(replacement.status);
    const concurrent = await Promise.all([bind(replacement), bind(replacement)]);
    expect(concurrent.map((result) => result.status).sort()).toEqual(['bound', 'replayed']);
    const generations = await database.query<{ generation: number; status: string }>(
      `SELECT generation,status FROM compute_resource_bindings WHERE resource_id=$1 ORDER BY generation`, [owner.first.resourceId]);
    expect(generations.rows).toEqual([{ generation: 1, status: 'revoked' }, { generation: 2, status: 'checking' }]);
    expect(await store.revokeDeployment({ subjectId: owner.subjectId, assetId: owner.first.assetId,
      deploymentId: first.deploymentId, now: new Date(now.getTime() + 4_000) }))
      .toEqual({ status: 'already_revoked' });
    expect((await database.query<{ status: string }>(`SELECT status FROM asset_deployments WHERE id=$1`,
      [replacement.deploymentId])).rows[0]?.status).toBe('node_bound');
    expect(await store.revokeDeployment({ subjectId: owner.subjectId, assetId: owner.first.assetId,
      deploymentId: randomUUID(), now: new Date(now.getTime() + 4_001) })).toEqual({ status: 'not_found' });

    const buyerUserId = randomUUID(); const buyerSubjectId = randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES ($1,'node-buyer','节点买方','member')`, [buyerUserId]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES ($1,'personal','节点买方',$2)`,
      [buyerSubjectId, buyerUserId]);
    await database.query(`INSERT INTO subject_memberships(subject_id,user_id,role) VALUES ($1,$2,'owner')`, [buyerSubjectId, buyerUserId]);
    const orderId = randomUUID();
    await database.query(`INSERT INTO kai_credit_orders(id,order_number,buyer_subject_id,supplier_subject_id,created_by_user_id,
      listing_id,client_request_id,payload_digest,status,quantity,capacity_unit,unit_credit_micros,total_credit_micros,
      listing_snapshot,reservation_expires_at,confirmed_at,confirmed_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,'node-order-request-0001','node-order-payload-0001','confirmed',1,'GPU时',1000000,
      1000000,'{}',now()+interval '30 minutes',now(),$7)`,
    [orderId, `KC${randomUUID().replaceAll('-', '').slice(0, 20)}`, buyerSubjectId, owner.subjectId, buyerUserId, listingId, owner.userId]);
    expect(await store.revokeDeployment({ subjectId: owner.subjectId, assetId: owner.first.assetId,
      deploymentId: replacement.deploymentId,
      now: new Date(now.getTime() + 6_000) })).toEqual({ status: 'obligations_active' });
    await database.query(`INSERT INTO compute_fulfillments(id,order_id,buyer_subject_id,supplier_subject_id,resource_id,
      provider_key,status,allocated_accelerator_count,resource_slot_limit,provisioning_deadline_at)
      VALUES ($1,$2,$3,$4,$5,'sidecar-v1','pending',1,2,now()+interval '5 minutes')`,
    [randomUUID(), orderId, buyerSubjectId, owner.subjectId, owner.second.resourceId]);
    expect(await store.revokeDeployment({ subjectId: owner.subjectId, assetId: owner.second.assetId,
      deploymentId: second.deploymentId,
      now: new Date(now.getTime() + 6_000) })).toEqual({ status: 'obligations_active' });
    await database.close();
  });
});
