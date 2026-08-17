import { createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresMarketStore } from '../src/market/store.js';
import { canonicalClaimProof, canonicalHeartbeatProof, normalizeInventory, type RawGpuInventory } from '../src/node-enrollment/protocol.js';
import { NodeEnrollmentStore } from '../src/node-enrollment/store.js';
import { PostgresSettlementFeeStore } from '../src/settlement-fees/store.js';

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

async function provider(database: Database, suffix: string) {
  const userId = randomUUID(); const subjectId = randomUUID();
  await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES ($1,$2,$3,'supplier')`,
    [userId, `phone-${suffix}`, `资源方${suffix}`]);
  await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES ($1,'personal',$2,$3)`,
    [subjectId, `资源方${suffix}`, userId]);
  await database.query(`INSERT INTO subject_memberships(subject_id,user_id,role) VALUES ($1,$2,'owner')`, [subjectId, userId]);
  await database.query(`INSERT INTO supplier_profiles(id,created_by_user_id,subject_id,legal_name,credit_code,contact_name,status)
    VALUES ($1,$2,$1,$3,$4,'凯','approved')`,
  [subjectId, userId, `凯云资源${suffix}`, `91310101MA1AS${suffix.padStart(5, '0')}`]);
  return { userId, subjectId };
}

describe('provider asset foundation', () => {
  it('backfills every existing resource without inventing hosted custody', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of ['0001_cloudpay_ledger.sql', '0018_resource_identity.sql']) {
      await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    }
    const database = adapter(pglite); const userId = randomUUID(); const supplierId = randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES ($1,'asset-backfill','资源方','supplier')`, [userId]);
    await database.query(`INSERT INTO supplier_profiles(id,user_id,legal_name,credit_code,contact_name,status)
      VALUES ($1,$2,'凯云资产','91310101MA1ASSET001','凯','approved')`, [supplierId, userId]);
    const activeId = randomUUID(); const draftId = randomUUID();
    await database.query(`INSERT INTO compute_resources(id,supplier_id,kind,product_code,region,specifications,capacity_total,capacity_unit,status,
      asset_fingerprint,asset_identity_kind,client_request_id,payload_digest)
      VALUES ($1,$3,'gpu','H100-A','上海','{}',8,'GPU时','verified',$4,'hardware_serial','asset-backfill-request-01','digest-a'),
             ($2,$3,'gpu','H100-B','上海','{}',8,'GPU时','draft',NULL,NULL,NULL,NULL)`,
    [activeId, draftId, supplierId, `sha256:${'a'.repeat(64)}`]);
    await pglite.exec(await readFile(fileURLToPath(new URL('../migrations/0041_compute_assets.sql', import.meta.url)), 'utf8'));

    const rows = await database.query<{ id: string; management_mode: string; lifecycle_status: string; asset_id: string }>(
      `SELECT a.id,a.management_mode,a.lifecycle_status,r.asset_id FROM compute_assets a JOIN compute_resources r ON r.asset_id=a.id ORDER BY r.product_code`,
    );
    expect(rows.rows).toEqual([
      { id: activeId, management_mode: 'self_managed', lifecycle_status: 'active', asset_id: activeId },
      { id: draftId, management_mode: 'self_managed', lifecycle_status: 'registered', asset_id: draftId },
    ]);
    await database.close();
  });

  it('creates and links one asset atomically across retries', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrateAll(pglite); const database = adapter(pglite);
    const owner = await provider(database, '101'); const store = new PostgresMarketStore(database);
    const input = {
      id: randomUUID(), assetId: randomUUID(), subjectId: owner.subjectId, requestedByUserId: owner.userId,
      kind: 'gpu' as const, productCode: 'H100-SXM-98G', region: '华东-上海', specifications: { gpuCount: 8 },
      capacityTotal: '8', capacityUnit: 'GPU时', assetFingerprint: `sha256:${'1'.repeat(64)}`,
      assetIdentityKind: 'hardware_serial' as const, clientRequestId: 'asset-create-request-001', payloadDigest: 'asset-create-digest-a',
    };
    expect((await store.createResource(input))?.status).toBe('created');
    expect((await store.createResource({ ...input, id: randomUUID(), assetId: randomUUID() }))?.status).toBe('replayed');
    const linked = await database.query<{ asset_id: string; management_mode: string; lifecycle_status: string }>(
      `SELECT r.asset_id,a.management_mode,a.lifecycle_status FROM compute_resources r JOIN compute_assets a ON a.id=r.asset_id WHERE r.id=$1`, [input.id],
    );
    expect(linked.rows).toEqual([{ asset_id: input.assetId, management_mode: 'self_managed', lifecycle_status: 'registered' }]);
    expect((await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM compute_assets`)).rows[0]?.count).toBe('1');
    await database.close();
  });

  it('derives only evidence-backed statuses and isolates every read by provider subject', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrateAll(pglite); const database = adapter(pglite);
    const owner = await provider(database, '201'); const outsider = await provider(database, '202');
    const reviewerId = randomUUID(); const feeApprover = randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES
      ($1,'asset-reviewer','审核员','operator'),($2,'asset-fee-approver','费用复核','operator')`, [reviewerId, feeApprover]);
    const feeSchedules = new PostgresSettlementFeeStore(database); const scheduleId = randomUUID(); const feeNow = new Date();
    await feeSchedules.createDraftSchedule({ id: scheduleId, version: 'provider-assets-fee-v1', operatorId: reviewerId,
      now: feeNow, requestId: 'provider-assets-fee-draft-01', payloadDigest: `sha256:${'6'.repeat(64)}`, tiers: [
        { ordinal: 0, lowerBoundMicros: 0n, upperBoundMicros: 100_000_000_000n, rateBps: 100 },
        { ordinal: 1, lowerBoundMicros: 100_000_000_000n, upperBoundMicros: 1_000_000_000_000n, rateBps: 80 },
        { ordinal: 2, lowerBoundMicros: 1_000_000_000_000n, upperBoundMicros: 10_000_000_000_000n, rateBps: 50 },
        { ordinal: 3, lowerBoundMicros: 10_000_000_000_000n, upperBoundMicros: null, rateBps: 20 },
      ] });
    await feeSchedules.activateSchedule({ scheduleId, operatorId: feeApprover, now: new Date(feeNow.getTime() + 1),
      requestId: 'provider-assets-fee-approve-01', payloadDigest: `sha256:${'7'.repeat(64)}` });
    const store = new PostgresMarketStore(database);

    const create = async (productCode: string, fingerprint: string) => {
      const created = await store.createResource({
        id: randomUUID(), assetId: randomUUID(), subjectId: owner.subjectId, requestedByUserId: owner.userId,
        kind: 'gpu', productCode, region: '华东-上海', specifications: { gpuCount: 8, memoryGiBPerGpu: 98 },
        capacityTotal: '8', capacityUnit: 'GPU时', assetFingerprint: `sha256:${fingerprint.repeat(64)}`,
        assetIdentityKind: 'hardware_serial', clientRequestId: `asset-state-${productCode.toLowerCase()}-001`, payloadDigest: `digest-${productCode}`,
      });
      if (!created || !('resource' in created)) throw new Error('resource missing');
      const asset = await database.query<{ asset_id: string }>(`SELECT asset_id FROM compute_resources WHERE id=$1`, [created.resource.id]);
      return { resourceId: created.resource.id, assetId: asset.rows[0]!.asset_id };
    };
    const verify = async (resourceId: string, digestCharacter: string) => {
      await database.query(`UPDATE resource_verification_runs SET status='running' WHERE resource_id=$1`, [resourceId]);
      const verified = await store.completeResourceVerification({
        resourceId, reviewerId, passed: true, evidenceDigest: `sha256:${digestCharacter.repeat(64)}`,
        checks: { ownership: true, configuration: true, availability: true },
      });
      expect(verified?.status).toBe('verified');
    };
    const enrollment = new NodeEnrollmentStore(database, 'provider-gpu-pepper-0123456789012345',
      'provider-claim-pepper-0123456789012', Buffer.alloc(32, 6).toString('base64'));
    const bind = async (resourceId: string, digestCharacter: string, nodeStatus: 'ready' | 'offline') => {
      const resource = await database.query<{ asset_id: string }>(`SELECT asset_id FROM compute_resources WHERE id=$1`, [resourceId]);
      const claim = await enrollment.issueClaim({ deploymentId: randomUUID(), claimId: randomUUID(),
        assetId: resource.rows[0]!.asset_id, subjectId: owner.subjectId, userId: owner.userId,
        claimToken: digestCharacter.repeat(43), challenge: `provider_claim_challenge_00000000000${digestCharacter}`,
        expiresAt: new Date(Date.now() + 600_000), gpuFingerprintKeyVersion: 1,
        clientRequestId: `provider-node-claim-000${digestCharacter}`, requestPayloadDigest: `provider-node-payload-000${digestCharacter}` });
      if (!('claimToken' in claim)) throw new Error(claim.status);
      const key = generateKeyPairSync('ed25519'); const jwk = createPublicKey(key.privateKey).export({ format: 'jwk' });
      const publicKey = `ed25519:${Buffer.from(jwk.x!, 'base64url').toString('base64')}`;
      const uuid = `GPU-${digestCharacter.repeat(8)}-${digestCharacter.repeat(4)}-${digestCharacter.repeat(4)}-${digestCharacter.repeat(4)}-${digestCharacter.repeat(12)}`;
      const raw: RawGpuInventory[] = Array.from({ length: 8 }, (_, ordinal) => ({
        uuid: `${uuid.slice(0, -1)}${ordinal}`, model: 'NVIDIA H100 SXM5 98GB', memoryTotalMiB: 97_871,
        driverVersion: '580.173.02', cudaVersion: '13.0', migMode: 'Disabled', computeMode: 'Default',
      }));
      const inventory = normalizeInventory(raw); const now = new Date();
      const claimFields = { claimId: claim.claimId, challenge: claim.challenge, publicKey, observedAt: now.toISOString(),
        inventoryDigest: inventory.inventoryDigest, runtimeDigest: inventory.runtimeDigest,
        policyDigest: claim.expectedPolicyDigest, agentVersion: '1.0.0' };
      const consumed = await enrollment.consumeClaim({ ...claimFields, claimToken: claim.claimToken, inventory: raw,
        signature: `ed25519:${sign(null, Buffer.from(canonicalClaimProof(claimFields)), key.privateKey).toString('base64')}`, now });
      if (!('nodeId' in consumed)) throw new Error(consumed.status);
      const heartbeatFields = { nodeId: consumed.nodeId, bootId: randomUUID(), sequence: '1',
        observedAt: new Date(now.getTime() + 1).toISOString(), inventoryDigest: inventory.inventoryDigest,
        runtimeDigest: inventory.runtimeDigest, policyDigest: claim.expectedPolicyDigest, agentVersion: '1.0.0' };
      const heartbeat = await enrollment.recordHeartbeat({ ...heartbeatFields, inventory: raw,
        signature: `ed25519:${sign(null, Buffer.from(canonicalHeartbeatProof(heartbeatFields)), key.privateKey).toString('base64')}`,
        now: new Date(now.getTime() + 1) });
      if (heartbeat.status !== 'accepted') throw new Error(heartbeat.status);
      if (nodeStatus === 'offline') {
        await database.query(`UPDATE compute_nodes SET status='offline' WHERE id=$1`, [consumed.nodeId]);
        await database.query(`UPDATE compute_resource_bindings SET status='offline' WHERE node_id=$1`, [consumed.nodeId]);
      }
    };
    const list = async (resourceId: string, suffix: string, valid = true) => {
      const offerId = randomUUID(); const resourceAuditId = randomUUID(); const priceAuditId = randomUUID();
      const validUntil = new Date(Date.now() + (valid ? 7 * 86_400_000 : -86_400_000));
      await database.query(`INSERT INTO offer_templates(id,supplier_id,resource_id,client_request_id,payload_digest,submission_version,title,
        service_mode,native_unit,minimum_quantity,suggested_price_cny_micros,status,approved_reference_cny_micros,
        approved_unit_credit_micros,conversion_cny_micros_per_credit,audit_valid_until,submitted_at,approved_at)
        VALUES ($1,$2,$3,$4,$5,1,$6,'dedicated','GPU时',1,1002000,'approved',1002000,1000000,1002000,$7,now(),now())`,
      [offerId, owner.subjectId, resourceId, `asset-offer-request-${suffix}`, `asset-offer-digest-${suffix}`, `H100 ${suffix}`, validUntil]);
      for (const audit of [{ id: resourceAuditId, kind: 'resource' }, { id: priceAuditId, kind: 'price' }]) {
        await database.query(`INSERT INTO offer_audit_versions(id,offer_id,submission_version,kind,status,reviewer_id,decision_reason,
          evidence_summary,evidence_digest,decision_digest,approved_reference_cny_micros,conversion_cny_micros_per_credit,
          approved_unit_credit_micros,valid_until,decided_at)
          VALUES ($1,$2,1,$3,'approved',$4,'通过','证据一致',$5,$6,
            CASE WHEN $3='price' THEN 1002000 ELSE NULL END,CASE WHEN $3='price' THEN 1002000 ELSE NULL END,
            CASE WHEN $3='price' THEN 1000000 ELSE NULL END,$7,now())`,
        [audit.id, offerId, audit.kind, reviewerId, `sha256:${suffix.repeat(64).slice(0, 64)}`, `decision-${suffix}-${audit.kind}`, validUntil]);
      }
      const listingId = randomUUID();
      await database.query(`INSERT INTO credit_market_listings(id,offer_id,resource_id,supplier_id,client_request_id,payload_digest,
        resource_audit_id,price_audit_id,capacity_total,capacity_unit,minimum_quantity,unit_credit_micros,
        reference_cny_micros,conversion_cny_micros_per_credit,starts_at,expires_at,audit_snapshot,published_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,8,'GPU时',1,1000000,1002000,1002000,now()-interval '1 minute',
          now()+interval '1 day','{}',$9)`,
      [listingId, offerId, resourceId, owner.subjectId, `asset-listing-request-${suffix}`, `asset-listing-digest-${suffix}`,
        resourceAuditId, priceAuditId, owner.userId]);
      return { listingId, priceAuditId };
    };

    const pending = await create('H100-PENDING', '1');
    const unbound = await create('H100-UNBOUND', '8'); await verify(unbound.resourceId, '8');
    const standby = await create('H100-STANDBY', '2'); await verify(standby.resourceId, '2'); await bind(standby.resourceId, '2', 'ready');
    const operating = await create('H100-OPERATING', '3'); await verify(operating.resourceId, '3'); await bind(operating.resourceId, '3', 'ready');
    const operatingListing = await list(operating.resourceId, '3');
    const issue = await create('H100-ISSUE', '4'); await verify(issue.resourceId, '4'); await bind(issue.resourceId, '4', 'offline'); await list(issue.resourceId, '4');
    const expiredAudit = await create('H100-EXPIRED-AUDIT', '5'); await verify(expiredAudit.resourceId, '5');
    await bind(expiredAudit.resourceId, '5', 'ready'); const expiredAuditListing = await list(expiredAudit.resourceId, '5', false);
    const transition = await create('H100-TRANSITION', '6'); await verify(transition.resourceId, '6'); await bind(transition.resourceId, '6', 'ready');
    const transitionListing = await list(transition.resourceId, '6');
    const buyerUserId = randomUUID(); const buyerSubjectId = randomUUID(); const orderId = randomUUID(); const fulfillmentId = randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES ($1,'asset-buyer','买方','member')`, [buyerUserId]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES ($1,'personal','买方',$2)`, [buyerSubjectId, buyerUserId]);
    await database.query(`INSERT INTO subject_memberships(subject_id,user_id,role) VALUES ($1,$2,'owner')`, [buyerSubjectId, buyerUserId]);
    await database.query(`INSERT INTO kai_credit_orders(id,order_number,buyer_subject_id,supplier_subject_id,created_by_user_id,
      listing_id,client_request_id,payload_digest,status,quantity,capacity_unit,unit_credit_micros,total_credit_micros,
      listing_snapshot,reservation_expires_at,confirmed_at,confirmed_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,'asset-transition-order-01','asset-transition-digest','confirmed',1,'GPU时',1000000,1000000,'{}',
        now()+interval '30 minutes',now(),$7)`,
    [orderId, `KC${randomUUID().replaceAll('-', '').slice(0, 20)}`, buyerSubjectId, owner.subjectId, buyerUserId, transitionListing.listingId, owner.userId]);
    await database.query(`INSERT INTO compute_fulfillments(id,order_id,buyer_subject_id,supplier_subject_id,resource_id,provider_key,status,
      allocated_accelerator_count,resource_slot_limit,provisioning_deadline_at)
      VALUES ($1,$2,$3,$4,$5,'sidecar-v1','pending',1,8,now()+interval '5 minutes')`,
    [fulfillmentId, orderId, buyerSubjectId, owner.subjectId, transition.resourceId]);
    await database.query(`UPDATE credit_market_listings SET status='paused' WHERE id=$1`, [transitionListing.listingId]);
    const scheduled = await create('H100-SCHEDULED', '7'); await verify(scheduled.resourceId, '7'); await bind(scheduled.resourceId, '7', 'ready');
    const scheduledListing = await list(scheduled.resourceId, '7');
    await database.query(`UPDATE credit_market_listings SET starts_at=now()+interval '1 day',expires_at=now()+interval '2 days' WHERE id=$1`,
      [scheduledListing.listingId]);
    await database.query(`UPDATE compute_assets SET management_mode='platform_hosted',renewed_at=now() WHERE id=$1`, [standby.assetId]);
    const closed = await create('H100-CLOSED', '9');
    await database.query(`UPDATE compute_assets SET lifecycle_status='retired',closed_at=now() WHERE id=$1`, [closed.assetId]);
    const repurchased = await create('H100-REPURCHASED', 'a');
    await database.query(`UPDATE compute_assets SET lifecycle_status='retired',closed_at=now(),repurchased_at=now() WHERE id=$1`, [repurchased.assetId]);

    const assets = await store.listProviderAssets(owner.subjectId);
    expect(Object.fromEntries(assets.map((asset) => [asset.productCode, asset.status]))).toEqual({
      'H100-PENDING': 'pending_connection', 'H100-STANDBY': 'standby',
      'H100-UNBOUND': 'pending_connection',
      'H100-OPERATING': 'operating', 'H100-ISSUE': 'operating_issue', 'H100-EXPIRED-AUDIT': 'standby',
      'H100-TRANSITION': 'standby', 'H100-SCHEDULED': 'standby',
      'H100-CLOSED': 'pending_connection', 'H100-REPURCHASED': 'pending_connection',
    });
    expect(assets.find((asset) => asset.id === pending.assetId)).toMatchObject({
      managementMode: 'self_managed', lifecycle: 'registered', statusLabel: '待补充材料', attention: { severity: 'warning' },
      nodeAction: null,
    });
    expect(assets.find((asset) => asset.id === unbound.assetId)).toMatchObject({
      nodeEnrollment: { deploymentId: null, generation: null, status: 'unbound' },
      nodeAction: { key: 'issue_node_claim', label: '接入节点', deploymentId: null },
    });
    expect(assets.find((asset) => asset.id === standby.assetId)).toMatchObject({
      managementMode: 'platform_hosted', views: expect.arrayContaining(['hosted', 'renewed']),
      lifecycleFacts: { renewedAt: expect.any(Date), repurchasedAt: null, closedAt: null },
      nodeEnrollment: { deploymentId: expect.any(String), generation: 1, status: 'ready' },
      nodeAction: { key: 'revoke_node_enrollment', label: '断开节点', deploymentId: expect.any(String) },
    });
    const pendingClaim = await enrollment.issueClaim({ deploymentId: randomUUID(), claimId: randomUUID(),
      assetId: unbound.assetId, subjectId: owner.subjectId, userId: owner.userId, claimToken: 'z'.repeat(43),
      challenge: 'provider_claim_challenge_unbound_0001', expiresAt: new Date(Date.now() + 600_000),
      gpuFingerprintKeyVersion: 1, clientRequestId: 'provider-node-claim-unbound-001',
      requestPayloadDigest: 'provider-node-payload-unbound-001' });
    if (!('deploymentId' in pendingClaim)) throw new Error(pendingClaim.status);
    expect(await store.getProviderAsset(owner.subjectId, unbound.assetId)).toMatchObject({
      nodeEnrollment: { deploymentId: pendingClaim.deploymentId, generation: 1, status: 'claim_issued' },
      nodeAction: { key: 'issue_node_claim', label: '继续接入', deploymentId: pendingClaim.deploymentId },
    });
    expect(assets.find((asset) => asset.id === standby.assetId)?.nextAction).toMatchObject({ key: 'create_offer', entityId: standby.resourceId });
    expect(assets.find((asset) => asset.id === operating.assetId)?.nextAction).toMatchObject({ key: 'manage_listing', entityId: operatingListing.listingId });
    expect(assets.find((asset) => asset.id === issue.assetId)).toMatchObject({ lifecycle: 'active', attention: { severity: 'critical' } });
    expect(assets.find((asset) => asset.id === transition.assetId)).toMatchObject({
      statusLabel: '部署中', statusDetail: '已确认订单正在等待平台开通。', views: expect.arrayContaining(['deploying']),
      attention: { title: '订单等待开通', severity: 'info' },
      nextAction: { key: 'view_fulfillment', route: 'provider_order', entityId: orderId, target: 'fulfillment' },
    });
    expect(assets.find((asset) => asset.id === closed.assetId)).toMatchObject({
      lifecycle: 'retired', statusLabel: '设备关闭', views: ['closed'],
      lifecycleFacts: { renewedAt: null, repurchasedAt: null, closedAt: expect.any(Date) }, nodeAction: null,
    });
    expect(assets.find((asset) => asset.id === repurchased.assetId)).toMatchObject({
      lifecycle: 'retired', statusLabel: '已回购', views: ['repurchased', 'closed'],
      lifecycleFacts: { renewedAt: null, repurchasedAt: expect.any(Date), closedAt: expect.any(Date) }, nodeAction: null,
    });
    expect(assets.find((asset) => asset.id === scheduled.assetId)?.nextAction).toMatchObject({
      key: 'manage_listing', label: '查看待生效挂牌', entityId: scheduledListing.listingId,
    });
    expect(await store.listProviderAssets(outsider.subjectId)).toEqual([]);
    expect(await store.getProviderAsset(outsider.subjectId, operating.assetId)).toBeNull();
    expect((await store.getProviderAsset(owner.subjectId, operating.assetId))?.resourceId).toBe(operating.resourceId);

    expect((await store.getProviderAsset(owner.subjectId, expiredAudit.assetId))?.status).toBe('standby');
    expect((await store.getProviderAsset(owner.subjectId, expiredAudit.assetId))?.nextAction).toMatchObject({
      key: 'manage_listing', entityId: expiredAuditListing.listingId,
    });
    await database.query(`UPDATE credit_market_listings SET status='expired' WHERE id=$1`, [expiredAuditListing.listingId]);
    expect((await store.getProviderAsset(owner.subjectId, expiredAudit.assetId))?.nextAction).toMatchObject({
      key: 'reaudit_expired_offer', route: 'provider_offer_review', target: 'offer_review',
    });
    await database.query(`UPDATE credit_market_listings SET status='paused',starts_at=now()-interval '1 minute' WHERE id=$1`,
      [scheduledListing.listingId]);
    expect((await store.getProviderAsset(owner.subjectId, scheduled.assetId))?.nextAction).toMatchObject({
      key: 'manage_listing', label: '管理暂停挂牌', entityId: scheduledListing.listingId,
    });
    await database.query(`UPDATE credit_market_listings SET status='sold_out' WHERE id=$1`, [scheduledListing.listingId]);
    expect((await store.getProviderAsset(owner.subjectId, scheduled.assetId))?.nextAction).toMatchObject({
      key: 'manage_listing', label: '查看已售罄挂牌', entityId: scheduledListing.listingId,
    });
    await database.query(`UPDATE compute_fulfillments SET status='provisioning',provisioning_at=now() WHERE id=$1`, [fulfillmentId]);
    expect(await store.getProviderAsset(owner.subjectId, transition.assetId)).toMatchObject({
      status: 'standby', statusLabel: '部署中', statusDetail: '已成交订单正在自动开通。', views: expect.arrayContaining(['deploying']),
      attention: { title: '订单正在开通' },
    });
    await database.query(`UPDATE compute_fulfillments SET status='stopping',provider_lease_id=$2,connection='{}',
      attestation_digest=$3,stopping_at=now() WHERE id=$1`,
    [fulfillmentId, `kai:${fulfillmentId}`, `sha256:${'f'.repeat(64)}`]);
    expect(await store.getProviderAsset(owner.subjectId, transition.assetId)).toMatchObject({
      status: 'standby', statusDetail: '订单已停止新访问，正在安全收回算力环境。', attention: { title: '订单正在清理' },
    });
    await database.close();
  });
});
