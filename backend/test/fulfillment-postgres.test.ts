import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresCreditLedgerStore } from '../src/credits/store.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../src/credits/types.js';
import { PostgresCreditOrderStore } from '../src/credit-orders/store.js';
import { PostgresFulfillmentStore } from '../src/fulfillment/store.js';

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}
function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (tx: Transaction) =>
      work({ query: async (text: string, values?: unknown[]) => pgResult(await tx.query(text, values)) } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

async function fixture(autoConfirmCompute = false) {
  const pglite = new PGlite();
  for (const name of (await readdir(new URL('../migrations', import.meta.url))).filter((name) => name.endsWith('.sql')).sort()) {
    await pglite.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const database = adapter(pglite);
  const buyerUserId = randomUUID(); const supplierUserId = randomUUID();
  const reviewerOne = randomUUID(); const reviewerTwo = randomUUID();
  const buyerSubjectId = randomUUID(); const supplierSubjectId = randomUUID();
  const resourceId = randomUUID(); const offerId = randomUUID(); const listingId = randomUUID();
  const resourceAuditId = randomUUID(); const priceAuditId = randomUUID();
  await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES
    ($1,'buyer','买方','member'),($2,'supplier','提供方','supplier'),
    ($3,'reviewer1','资源审核','operator'),($4,'reviewer2','价格审核','operator')`,
  [buyerUserId, supplierUserId, reviewerOne, reviewerTwo]);
  await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES
    ($1,'personal','买方',$2),($3,'personal','提供方',$4)`, [buyerSubjectId, buyerUserId, supplierSubjectId, supplierUserId]);
  await database.query(`INSERT INTO subject_memberships(subject_id,user_id,role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
    [buyerSubjectId, buyerUserId, supplierSubjectId, supplierUserId]);
  await database.query(`INSERT INTO supplier_profiles(id,created_by_user_id,subject_id,legal_name,credit_code,contact_name,status)
    VALUES ($1,$2,$1,'凯云算力','91310101MA1FULFIL1','凯','approved')`, [supplierSubjectId, supplierUserId]);
  await database.query(`INSERT INTO compute_assets(id,supplier_id,management_mode,lifecycle_status,asset_identity_kind,asset_fingerprint)
    VALUES ($1,$2,'self_managed','active','legacy_resource_id',$3)`,
  [resourceId, supplierSubjectId, `legacy-resource:${resourceId}`]);
  await database.query(`INSERT INTO compute_resources(id,supplier_id,asset_id,kind,product_code,region,specifications,
    capacity_total,capacity_unit,status,verification_digest,verified_at) VALUES
    ($1,$2,$1,'gpu','H100-SXM5-98G','华东-上海','{"gpuCount":8}',10,'GPU时','verified',$3,now())`,
  [resourceId, supplierSubjectId, `sha256:${'a'.repeat(64)}`]);
  const nodeId = '80000000-0000-4000-8000-000000000002';
  const bindingId = '80000000-0000-4000-8000-000000000001'; const policyDigest = `sha256:${'e'.repeat(64)}`;
  const deploymentId = randomUUID(); const runtimeDigest = `sha256:${'9'.repeat(64)}`; const bootId = randomUUID();
  const heartbeatDigest = `sha256:${'d'.repeat(64)}`; const heartbeatSignature = `ed25519:${'B'.repeat(88)}`;
  await database.query(`INSERT INTO asset_deployments(id,asset_id,supplier_id,resource_id,generation,status,
    expected_policy_digest,gpu_fingerprint_key_version,created_by_user_id)
    VALUES ($1,$2,$3,$2,1,'claim_issued',$4,1,$5)`,
  [deploymentId, resourceId, supplierSubjectId, policyDigest, supplierUserId]);
  await database.query(`INSERT INTO compute_nodes(id,supplier_id,node_public_key,node_key_fingerprint,
      inventory_digest,status,deployment_id,expected_policy_digest,expected_runtime_digest,expected_agent_version,
      runtime_digest,agent_version)
    VALUES ($1,$2,$3,$4,$5,'checking',$6,$7,$8,'1.0.0',$8,'1.0.0')`,
  [nodeId, supplierSubjectId, `ed25519:${'A'.repeat(44)}`, `sha256:${'b'.repeat(64)}`,
    `sha256:${'c'.repeat(64)}`, deploymentId, policyDigest, runtimeDigest]);
  await database.query(`INSERT INTO compute_resource_bindings(id,resource_id,node_id,status,resource_verification_digest,
      policy_digest,attested_policy_digest,inventory_digest,gpu_set_digest,confirmed_at)
    VALUES ($1,$2,$3,'checking',$4,$5,NULL,$6,$7,NULL)`,
  [bindingId, resourceId, nodeId, `sha256:${'a'.repeat(64)}`, policyDigest,
    `sha256:${'c'.repeat(64)}`, `sha256:${'f'.repeat(64)}`]);
  await database.query(`INSERT INTO compute_node_gpus(node_id,ordinal,fingerprint_key_version,gpu_uuid_fingerprint)
    SELECT $1,ordinality-1,1,fingerprint FROM unnest($2::text[]) WITH ORDINALITY AS gpu(fingerprint,ordinality)`,
  [nodeId, Array.from({ length: 8 }, (_, index) => (index + 1).toString(16).repeat(64))]);
  await database.query(`UPDATE asset_deployments SET status='node_bound',node_id=$2,bound_at=now() WHERE id=$1`,
    [deploymentId, nodeId]);
  await database.query(`INSERT INTO compute_node_boots(node_id,boot_id,first_observed_at,last_observed_at,last_sequence,
    last_payload_digest,last_signature) VALUES ($1,$2,now(),now(),1,$3,$4)`,
  [nodeId, bootId, heartbeatDigest, heartbeatSignature]);
  await database.query(`UPDATE compute_nodes SET status='ready',last_heartbeat_at=now(),heartbeat_observed_at=now(),
    heartbeat_boot_id=$2,heartbeat_sequence=1,heartbeat_payload_digest=$3,heartbeat_signature=$4,
    attested_policy_digest=$5,attested_runtime_digest=$6 WHERE id=$1`,
  [nodeId, bootId, heartbeatDigest, heartbeatSignature, policyDigest, runtimeDigest]);
  await database.query(`UPDATE compute_resource_bindings SET status='ready',attested_policy_digest=policy_digest,confirmed_at=now()
    WHERE id=$1`, [bindingId]);
  const validUntil = new Date(Date.now() + 30 * 86_400_000);
  await database.query(`INSERT INTO offer_templates(id,supplier_id,resource_id,client_request_id,payload_digest,
    submission_version,title,service_mode,native_unit,minimum_quantity,suggested_price_cny_micros,status,
    approved_reference_cny_micros,approved_unit_credit_micros,conversion_cny_micros_per_credit,audit_valid_until,
    submitted_at,approved_at) VALUES ($1,$2,$3,'fulfill-offer-request-01','fulfill-offer-digest',1,'H100 算力',
    'dedicated','GPU时',1,31200000,'approved',31200000,31137725,1002000,$4,now(),now())`,
  [offerId, supplierSubjectId, resourceId, validUntil]);
  for (const [id, kind] of [[resourceAuditId, 'resource'], [priceAuditId, 'price']] as const) {
    await database.query(`INSERT INTO offer_audit_versions(id,offer_id,submission_version,kind,status,
      reviewer_id,decision_reason,evidence_summary,evidence_digest,decision_digest,approved_reference_cny_micros,
      conversion_cny_micros_per_credit,approved_unit_credit_micros,valid_until,decided_at) VALUES
      ($1,$2,1,$3,'approved',$4,'通过','实测通过',$5,$6,CASE WHEN $3='price' THEN 31200000 END,
       CASE WHEN $3='price' THEN 1002000 END,CASE WHEN $3='price' THEN 31137725 END,$7,now())`,
    [id, offerId, kind, kind === 'price' ? reviewerTwo : reviewerOne,
      `sha256:${kind === 'price' ? 'b'.repeat(64) : 'c'.repeat(64)}`, `${kind}-decision`, validUntil]);
  }
  await database.query(`INSERT INTO credit_market_listings(id,offer_id,resource_id,supplier_id,client_request_id,
    payload_digest,resource_audit_id,price_audit_id,capacity_total,capacity_unit,minimum_quantity,unit_credit_micros,
    reference_cny_micros,conversion_cny_micros_per_credit,starts_at,expires_at,audit_snapshot,published_by)
    VALUES ($1,$2,$3,$4,'fulfill-listing-req1','fulfill-listing-digest',$5,$6,10,'GPU时',1,31137725,
      31200000,1002000,now()-interval '1 minute',now()+interval '7 days',$7::jsonb,$8)`,
  [listingId, offerId, resourceId, supplierSubjectId, resourceAuditId, priceAuditId,
    JSON.stringify({ resourceAuditId, priceAuditId }), supplierUserId]);
  const ledger = new PostgresCreditLedgerStore(database);
  const buyerAccounts = await ledger.ensureSubjectAccounts(buyerSubjectId);
  const buyerAvailable = buyerAccounts.find((account) => account.kind === 'available')!.accountId;
  await ledger.post({
    id: randomUUID(), idempotencyOwner: 'platform:test', scope: 'TEST_FULFILLMENT_FUND',
    idempotencyKey: `fund-${randomUUID()}`, payloadDigest: `sha256:${'f'.repeat(64)}`,
    referenceType: 'adjustment', description: '测试入账', entries: [
      { accountId: buyerAvailable, amountMicros: 100_000_000n, memo: '测试发行' },
      { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: -100_000_000n, memo: '测试发行' },
    ],
  });
  const orders = new PostgresCreditOrderStore(database);
  const reservationInput = {
    id: randomUUID(), orderNumber: `KC20260814${randomUUID().slice(0, 12).replaceAll('-', '').toUpperCase()}`,
    buyerSubjectId, userId: buyerUserId, listingId, quantity: '1.000000', quantityScaled: 1_000_000n,
    clientRequestId: `order-${randomUUID()}`, payloadDigest: `sha512:${'o'.repeat(64)}`,
    expiresAt: new Date(Date.now() + 1_800_000), now: new Date(), requestId: randomUUID(), ipHash: `sha512:${'i'.repeat(64)}`,
    computeFulfillmentAvailable: true, autoConfirmCompute, nodeAcceleratorCountFallback: 1,
  };
  const created = await orders.createReservation(reservationInput);
  if (created.status !== 'created') throw new Error(`order fixture failed: ${created.status}`);
  if (!autoConfirmCompute) {
    await orders.confirm({
      subjectId: supplierSubjectId, userId: supplierUserId, orderId: created.order.id,
      clientRequestId: `confirm-${randomUUID()}`, payloadDigest: `sha512:${'c'.repeat(64)}`,
      requestId: randomUUID(), ipHash: `sha512:${'i'.repeat(64)}`, now: new Date(),
    });
  }
  return { database, buyerUserId, supplierUserId, operatorUserId: reviewerOne, buyerSubjectId, supplierSubjectId,
    resourceId, listingId, orderId: created.order.id, reservationInput, orders, ledger, buyerAvailable,
    bindingId, nodeId, policyDigest,
    store: new PostgresFulfillmentStore(database) };
}

async function createAutoConfirmedOrder(f: Awaited<ReturnType<typeof fixture>>, sequence: number) {
  return f.orders.createReservation({
    id: randomUUID(), orderNumber: `KC20260816${randomUUID().slice(0, 12).replaceAll('-', '').toUpperCase()}`,
    buyerSubjectId: f.buyerSubjectId, userId: f.buyerUserId, listingId: f.listingId,
    quantity: '1.000000', quantityScaled: 1_000_000n,
    clientRequestId: `auto-slot-order-${sequence}-${randomUUID()}`,
    payloadDigest: `sha512:${String.fromCharCode(97 + sequence).repeat(64)}`,
    expiresAt: new Date(Date.now() + 1_800_000), now: new Date(), requestId: randomUUID(),
    ipHash: `sha512:${'i'.repeat(64)}`, computeFulfillmentAvailable: true,
    autoConfirmCompute: true, nodeAcceleratorCountFallback: 1,
  });
}

async function balances(database: Database, subjectId: string) {
  const result = await database.query<{ account_kind: string; amount: string }>(`SELECT a.account_kind,
    COALESCE(sum(e.amount_micros) FILTER (WHERE t.status='posted'),0)::text AS amount
    FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id=a.id
    LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id WHERE a.subject_id=$1
    GROUP BY a.id,a.account_kind`, [subjectId]);
  return Object.fromEntries(result.rows.map((row) => [row.account_kind, BigInt(row.amount)]));
}

function attestation(fulfillmentId: string, orderId: string, resourceId: string, observedAt: Date,
  hardExpiresAt: Date, heartbeatId: string) {
  return { nonce: fulfillmentId, orderId, resourceId,
    bindingId: '80000000-0000-4000-8000-000000000001', bindingGeneration: 1,
    policyDigest: `sha256:${'e'.repeat(64)}`, nodeId: '80000000-0000-4000-8000-000000000002',
    capacityUnit: 'GPU时',
    allocatedGpuUuids: ['GPU-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'], hardExpiresAt: hardExpiresAt.toISOString(),
    hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
    bootId: '90000000-0000-4000-8000-000000000001', eventSequence: 1, observedAt: observedAt.toISOString(), heartbeatId,
    acceleratorModel: 'NVIDIA H100 SXM5', nodeAcceleratorCount: 8, allocatedAcceleratorCount: 1,
    driverVersion: '580.173.02', memoryTotalMiB: 98_000, migMode: 'Disabled' as const,
    computeMode: 'Default' as const, evidenceDigest: `sha256:${'d'.repeat(64)}`,
    signature: `hmac-sha256:${'e'.repeat(64)}` };
}

async function stopAndOpenIssue(f: Awaited<ReturnType<typeof fixture>>) {
  const started = await f.store.beginProvision({ orderId: f.orderId, userId: null, providerKey: 'sidecar-v1', now: new Date() });
  if (!started.record) throw new Error('fulfillment missing');
  const now = new Date();
  const hardExpiresAt = new Date(now.getTime() + 3_600_000);
  await f.store.markReady({ fulfillmentId: started.record.id, providerLeaseId: `provider-${randomUUID()}`,
    connection: { protocol: 'ssh', host: 'h100.internal', port: 22,
      hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
      knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`, displayName: 'H100 工作区' },
    attestation: attestation(started.record.id, f.orderId, started.record.resourceId, now, hardExpiresAt,
      `heartbeat-${randomUUID()}`), hardExpiresAt, now });
  await f.store.beginStop({ buyerSubjectId: f.buyerSubjectId, orderId: f.orderId, now });
  await f.store.completeStop({ fulfillmentId: started.record.id, consumedCapacityMicros: 600_000n,
    evidenceDigest: `sha256:${'e'.repeat(64)}`, stoppedAt: now, now });
  await f.store.reportIssue({ buyerSubjectId: f.buyerSubjectId, userId: f.buyerUserId, orderId: f.orderId,
    kind: 'metering', descriptionCiphertext: 'encrypted-description',
    descriptionDigest: `sha512:${'f'.repeat(64)}`, now });
}

describe('compute fulfillment postgres lifecycle', () => {
  it('recovers a confirmed secured order that was committed before fulfillment creation',
    { timeout: 30_000 }, async () => {
      const f = await fixture(true);
      expect((await f.orders.getForSubject(f.buyerSubjectId, f.orderId))?.status).toBe('confirmed');
      expect(await f.store.listProvisioning(20)).toContainEqual({ orderId: f.orderId });
      expect(await f.database.query(`SELECT id FROM compute_fulfillments WHERE order_id=$1`, [f.orderId]))
        .toMatchObject({ rowCount: 0 });
      await f.database.close();
    });

  it('replays the same auto-confirmed purchase after the response is lost without a second freeze',
    { timeout: 30_000 }, async () => {
      const f = await fixture(true);
      const replay = await f.orders.createReservation({ ...f.reservationInput, id: randomUUID(),
        orderNumber: `KC20260816${randomUUID().slice(0, 12).replaceAll('-', '').toUpperCase()}` });
      expect(replay).toMatchObject({ status: 'replayed', order: { id: f.orderId, status: 'confirmed' } });
      expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({
        available: 68_862_275n, reserved: 31_137_725n,
      });
      expect((await f.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM kai_credit_orders`))
        .rows[0]?.count).toBe('1');
      await f.database.close();
    });

  it('expires stalled provisioning and atomically returns the buyer cards and listing capacity',
    { timeout: 30_000 }, async () => {
      const f = await fixture();
      const now = new Date();
      await f.database.query(`UPDATE compute_nodes SET last_heartbeat_at=$2 WHERE id=$1`, [f.nodeId, now]);
      const started = await f.store.beginProvision({ orderId: f.orderId, userId: null,
        providerKey: 'sidecar-v1', now, nodeAcceleratorCountFallback: 8 });
      expect(started.status).toBe('started');
      if (!started.record) throw new Error('fulfillment missing');
      expect(await f.store.listExpiredProvisioning(new Date(now.getTime() + 299_999), 20)).toHaveLength(0);
      expect(await f.store.listExpiredProvisioning(new Date(now.getTime() + 300_000), 20))
        .toContainEqual(expect.objectContaining({ id: started.record.id, status: 'provisioning' }));
      await f.store.markFailed({ fulfillmentId: started.record.id, code: 'COMPUTE_PROVISION_TIMEOUT',
        retryable: false, now: new Date(now.getTime() + 300_000) });
      expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 100_000_000n, reserved: 0n });
      expect((await f.database.query<{ status: string }>(`SELECT status FROM kai_credit_orders WHERE id=$1`,
        [f.orderId])).rows[0]?.status).toBe('refunded');
      expect((await f.database.query<{ capacity_reserved: string }>(
        `SELECT capacity_reserved::text FROM credit_market_listings WHERE id=$1`, [f.listingId])).rows[0])
        .toEqual({ capacity_reserved: '0.000000' });
      await f.database.close();
    });

  it('refunds an explicitly failed ready lease exactly once across concurrent reconciliation retries',
    { timeout: 30_000 }, async () => {
      const f = await fixture();
      const started = await f.store.beginProvision({ orderId: f.orderId, userId: null,
        providerKey: 'sidecar-v1', now: new Date(), nodeAcceleratorCountFallback: 8 });
      if (!started.record) throw new Error('fulfillment missing');
      const readyAt = new Date(); const hardExpiresAt = new Date(readyAt.getTime() + 3_600_000);
      await f.store.markReady({ fulfillmentId: started.record.id, providerLeaseId: 'provider-ready-health-failed',
        connection: { protocol: 'ssh', host: 'h100.internal', port: 22,
          hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
          knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`, displayName: 'H100 工作区' },
        attestation: attestation(started.record.id, f.orderId, started.record.resourceId, readyAt, hardExpiresAt,
          'heartbeat-ready-health-failed'), hardExpiresAt, now: readyAt });
      const failures = await Promise.all([
        f.store.markFailed({ fulfillmentId: started.record.id,
          code: 'PROVIDER_ACCESS_TARGET_UNAVAILABLE_BEFORE_START', retryable: false, now: new Date() }),
        f.store.markFailed({ fulfillmentId: started.record.id,
          code: 'PROVIDER_ACCESS_TARGET_UNAVAILABLE_BEFORE_START', retryable: false, now: new Date() }),
      ]);
      expect(failures.every((record) => record.status === 'failed')).toBe(true);
      expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 100_000_000n, reserved: 0n });
      const releases = await f.database.query<{ count: string }>(`SELECT count(*)::text AS count
        FROM kai_credit_transactions WHERE scope='COMPUTE_PROVISION_FAILURE_RELEASE' AND reference_id=$1`, [f.orderId]);
      expect(releases.rows[0]?.count).toBe('1');
      expect((await f.database.query<{ capacity_reserved: string }>(
        `SELECT capacity_reserved::text FROM credit_market_listings WHERE id=$1`, [f.listingId])).rows[0])
        .toEqual({ capacity_reserved: '0.000000' });
      await f.database.close();
    });

  it('serializes first access against a ready-health failure without ever granting access and refunding together',
    { timeout: 30_000 }, async () => {
      const f = await fixture();
      const started = await f.store.beginProvision({ orderId: f.orderId, userId: null,
        providerKey: 'sidecar-v1', now: new Date(), nodeAcceleratorCountFallback: 8 });
      if (!started.record) throw new Error('fulfillment missing');
      const readyAt = new Date(); const hardExpiresAt = new Date(readyAt.getTime() + 3_600_000);
      await f.store.markReady({ fulfillmentId: started.record.id, providerLeaseId: 'provider-ready-access-race',
        connection: { protocol: 'ssh', host: 'h100.internal', port: 22,
          hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
          knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`, displayName: 'H100 工作区' },
        attestation: attestation(started.record.id, f.orderId, started.record.resourceId, readyAt, hardExpiresAt,
          'heartbeat-ready-access-race'), hardExpiresAt, now: readyAt });
      await Promise.allSettled([
        f.store.recordAccess({ fulfillmentId: started.record.id, sessionId: randomUUID(),
          ticketDigest: `sha512:${'t'.repeat(64)}`, expiresAt: new Date(Date.now() + 300_000), now: new Date() }),
        f.store.markFailed({ fulfillmentId: started.record.id,
          code: 'PROVIDER_ACCESS_TARGET_UNAVAILABLE_BEFORE_START', retryable: false, now: new Date() }),
      ]);
      const final = await f.store.getForSubject(f.buyerSubjectId, f.orderId);
      const sessions = await f.database.query<{ count: string }>(`SELECT count(*)::text AS count
        FROM compute_access_sessions WHERE fulfillment_id=$1`, [started.record.id]);
      const buyerBalances = await balances(f.database, f.buyerSubjectId);
      if (final.record?.status === 'running') {
        expect(sessions.rows[0]?.count).toBe('1');
        expect(buyerBalances).toMatchObject({ available: 68_862_275n, reserved: 31_137_725n });
      } else {
        expect(final.record?.status).toBe('failed');
        expect(sessions.rows[0]?.count).toBe('0');
        expect(buyerBalances).toMatchObject({ available: 100_000_000n, reserved: 0n });
      }
      await f.database.close();
    });

  it('admits eight single-GPU purchases and rejects the ninth before creating an order or freezing cards',
    { timeout: 30_000 }, async () => {
      const f = await fixture(true);
      await f.ledger.post({
        id: randomUUID(), idempotencyOwner: 'platform:test', scope: 'TEST_FULFILLMENT_SLOT_FUND',
        idempotencyKey: `slot-fund-${randomUUID()}`, payloadDigest: `sha256:${'s'.repeat(64)}`,
        referenceType: 'adjustment', description: '八卡席位测试入账', entries: [
          { accountId: f.buyerAvailable, amountMicros: 300_000_000n, memo: '测试发行' },
          { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: -300_000_000n, memo: '测试发行' },
        ],
      });
      for (let sequence = 1; sequence < 8; sequence += 1) {
        expect(await createAutoConfirmedOrder(f, sequence)).toMatchObject({
          status: 'created', order: { status: 'confirmed' },
        });
      }
      expect(await createAutoConfirmedOrder(f, 8)).toEqual({ status: 'listing_unavailable' });
      expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({
        available: 150_898_200n, reserved: 249_101_800n,
      });
      expect((await f.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM kai_credit_orders`))
        .rows[0]?.count).toBe('8');
      expect((await f.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM compute_fulfillments`))
        .rows[0]?.count).toBe('0');
      await f.database.close();
    });

  it('authorizes provider, meters 0.6/1, refunds 0.4, replays acceptance, and settles only captured credits',
    { timeout: 30_000 }, async () => {
      const f = await fixture();
      expect(await f.store.beginProvision({ orderId: f.orderId, userId: f.supplierUserId,
        supplierSubjectId: f.buyerSubjectId, providerKey: 'sidecar-v1', now: new Date() })).toEqual({ status: 'not_found' });
      const started = await f.store.beginProvision({ orderId: f.orderId, userId: f.supplierUserId,
        supplierSubjectId: f.supplierSubjectId, providerKey: 'sidecar-v1', now: new Date() });
      expect(started.status).toBe('started');
      if (!started.record) throw new Error('fulfillment missing');
      const readyAt = new Date(); const hardExpiresAt = new Date(readyAt.getTime() + 450_000);
      await f.store.markReady({
        fulfillmentId: started.record.id, providerLeaseId: 'provider-lease-0001',
        connection: { protocol: 'ssh', host: 'h100.internal', port: 22,
          hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
          knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`, displayName: 'H100 工作区' },
        attestation: attestation(started.record.id, f.orderId, started.record.resourceId, readyAt, hardExpiresAt,
          'heartbeat-0001'), hardExpiresAt, now: readyAt,
      });
      const accessCandidate = await f.store.beginAccess({ buyerSubjectId: f.buyerSubjectId,
        orderId: f.orderId, now: new Date() });
      expect(accessCandidate?.status).toBe('ready');
      const running = await f.store.recordAccess({ fulfillmentId: started.record.id, sessionId: randomUUID(),
        ticketDigest: `sha512:${'t'.repeat(64)}`, expiresAt: new Date(Date.now() + 300_000), now: new Date() });
      expect(running?.status).toBe('running');
      await f.store.beginStop({ buyerSubjectId: f.buyerSubjectId, orderId: f.orderId, now: new Date() });
      await f.store.completeStop({ fulfillmentId: started.record.id, consumedCapacityMicros: 600_000n,
        evidenceDigest: `sha256:${'e'.repeat(64)}`, stoppedAt: new Date(), now: new Date() });
      const before = await f.store.getForSubject(f.buyerSubjectId, f.orderId);
      expect(before.usage).toMatchObject({ consumedCapacityMicros: 600_000n, consumedCreditMicros: 18_682_635n,
        remainingCreditMicros: 12_455_090n, acceptedAt: null });
      const accepted = await f.store.accept({ buyerSubjectId: f.buyerSubjectId, userId: f.buyerUserId, actor: 'buyer',
        orderId: f.orderId, now: new Date() });
      expect(accepted).toMatchObject({ capturedCreditMicros: 18_682_635n, refundedCreditMicros: 12_455_090n });
      expect(await f.store.accept({ buyerSubjectId: f.buyerSubjectId, userId: f.buyerUserId, actor: 'buyer',
        orderId: f.orderId, now: new Date() })).toMatchObject({ capturedCreditMicros: 18_682_635n,
        refundedCreditMicros: 12_455_090n });
      expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 81_317_365n, reserved: 0n });
      expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 18_682_635n });
      const listing = await f.database.query<{ capacity_reserved: string; capacity_sold: string }>(
        `SELECT capacity_reserved::text,capacity_sold::text FROM credit_market_listings WHERE id=$1`, [f.listingId],
      );
      expect(listing.rows[0]).toEqual({ capacity_reserved: '0.000000', capacity_sold: '0.600000' });
      expect(await f.store.settleDue(new Date(Date.now() + 8 * 86_400_000), 20)).toBe(1);
      expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
        supplier_earnings_available: 18_682_635n, supplier_receivable: 0n });
      const order = await f.database.query<{ status: string }>(`SELECT status FROM kai_credit_orders WHERE id=$1`, [f.orderId]);
      expect(order.rows[0]?.status).toBe('closed');
      await f.database.close();
    });

  it('claims hard-expired leases once and keeps stopping leases retryable', { timeout: 30_000 }, async () => {
    const f = await fixture();
    const started = await f.store.beginProvision({ orderId: f.orderId, userId: null, providerKey: 'sidecar-v1', now: new Date() });
    if (!started.record) throw new Error('fulfillment missing');
    const now = new Date();
    const hardExpiresAt = new Date(now.getTime() - 1);
    await f.store.markReady({ fulfillmentId: started.record.id, providerLeaseId: 'provider-lease-expiry',
      connection: { protocol: 'ssh', host: 'h100.internal', port: 22,
        hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
        knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`, displayName: 'H100 工作区' },
      attestation: attestation(started.record.id, f.orderId, started.record.resourceId, now, hardExpiresAt,
        'heartbeat-expiry'), hardExpiresAt, now });
    expect((await f.store.claimExpired(now, 20))[0]?.status).toBe('stopping');
    expect((await f.store.claimExpired(new Date(now.getTime() + 1_000), 20))[0]?.status).toBe('stopping');
    expect(await f.store.beginAccess({ buyerSubjectId: f.buyerSubjectId, orderId: f.orderId, now })).toBeNull();
    await f.store.completeStop({ fulfillmentId: started.record.id, consumedCapacityMicros: 600_000n,
      evidenceDigest: `sha256:${'e'.repeat(64)}`, stoppedAt: now, now });
    expect(await f.store.reportIssue({ buyerSubjectId: f.buyerSubjectId, userId: f.buyerUserId,
      orderId: f.orderId, kind: 'metering', descriptionCiphertext: 'encrypted-description',
      descriptionDigest: `sha512:${'f'.repeat(64)}`, now })).toMatchObject({ status: 'open' });
    const disputed = await f.store.getForSubject(f.buyerSubjectId, f.orderId);
    expect(disputed.usage).toMatchObject({ issueOpen: true, orderStatus: 'disputed' });
    expect(await f.store.accept({ buyerSubjectId: f.buyerSubjectId, userId: f.buyerUserId, actor: 'buyer',
      orderId: f.orderId, now })).toBeNull();
    await f.database.close();
  });

  it('auto accepts signed metering after 24h, replays safely, and an issue at 23:59 blocks it',
    { timeout: 30_000 }, async () => {
      const automatic = await fixture();
      const started = await automatic.store.beginProvision({ orderId: automatic.orderId, userId: null,
        providerKey: 'sidecar-v1', now: new Date() });
      if (!started.record) throw new Error('fulfillment missing');
      const readyAt = new Date(); const stoppedAt = new Date(readyAt.getTime() + 60_000);
      await automatic.database.query(`UPDATE compute_nodes SET last_heartbeat_at=$2 WHERE id=$1`, [automatic.nodeId, readyAt]);
      await automatic.store.markReady({ fulfillmentId: started.record.id, providerLeaseId: 'provider-auto-accept',
        connection: { protocol: 'ssh', host: 'h100.internal', port: 22,
          hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
          knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`, displayName: 'H100 工作区' },
        attestation: attestation(started.record.id, automatic.orderId, started.record.resourceId, readyAt,
          new Date(stoppedAt.getTime() + 60_000), 'heartbeat-auto'),
        hardExpiresAt: new Date(stoppedAt.getTime() + 60_000), now: readyAt });
      await automatic.store.beginStop({ buyerSubjectId: automatic.buyerSubjectId, orderId: automatic.orderId, now: stoppedAt });
      await automatic.store.completeStop({ fulfillmentId: started.record.id, consumedCapacityMicros: 600_000n,
        evidenceDigest: `sha256:${'e'.repeat(64)}`, stoppedAt, now: stoppedAt });
      expect(await automatic.store.autoAcceptDue(new Date(stoppedAt.getTime() + 24 * 3_600_000), 20)).toBe(1);
      expect(await automatic.store.autoAcceptDue(new Date(stoppedAt.getTime() + 25 * 3_600_000), 20)).toBe(0);
      const accepted = await automatic.database.query<{ accepted_actor: string; accepted_by_user_id: string | null }>(
        `SELECT accepted_actor,accepted_by_user_id FROM compute_fulfillment_acceptances WHERE order_id=$1`, [automatic.orderId]);
      expect(accepted.rows[0]).toEqual({ accepted_actor: 'system', accepted_by_user_id: null });
      await automatic.database.close();

      const disputed = await fixture();
      const disputedStart = await disputed.store.beginProvision({ orderId: disputed.orderId, userId: null,
        providerKey: 'sidecar-v1', now: new Date() });
      if (!disputedStart.record) throw new Error('fulfillment missing');
      await disputed.database.query(`UPDATE compute_nodes SET last_heartbeat_at=$2 WHERE id=$1`, [disputed.nodeId, readyAt]);
      await disputed.store.markReady({ fulfillmentId: disputedStart.record.id, providerLeaseId: 'provider-dispute-window',
        connection: { protocol: 'ssh', host: 'h100.internal', port: 22,
          hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
          knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`, displayName: 'H100 工作区' },
        attestation: attestation(disputedStart.record.id, disputed.orderId, disputedStart.record.resourceId, readyAt,
          new Date(stoppedAt.getTime() + 60_000), 'heartbeat-dispute-window'),
        hardExpiresAt: new Date(stoppedAt.getTime() + 60_000), now: readyAt });
      await disputed.store.beginStop({ buyerSubjectId: disputed.buyerSubjectId, orderId: disputed.orderId, now: stoppedAt });
      await disputed.store.completeStop({ fulfillmentId: disputedStart.record.id, consumedCapacityMicros: 600_000n,
        evidenceDigest: `sha256:${'e'.repeat(64)}`, stoppedAt, now: stoppedAt });
      const issueAt = new Date(stoppedAt.getTime() + 24 * 3_600_000 - 60_000);
      expect(await disputed.store.reportIssue({ buyerSubjectId: disputed.buyerSubjectId, userId: disputed.buyerUserId,
        orderId: disputed.orderId, kind: 'metering', descriptionCiphertext: 'encrypted-description',
        descriptionDigest: `sha512:${'f'.repeat(64)}`, now: issueAt })).toMatchObject({ status: 'open' });
      expect(await disputed.store.autoAcceptDue(new Date(stoppedAt.getTime() + 25 * 3_600_000), 20)).toBe(0);
      await disputed.database.close();
    });

  it('adjudicates full, partial, and rejected remedies idempotently without exceeding metered credits',
    { timeout: 30_000 }, async () => {
      const cases = [
        { outcome: 'full_refund' as const, remedy: null, provider: 0n, buyer: 31_137_725n, orderStatus: 'refunded' },
        { outcome: 'partial_refund' as const, remedy: 6_000_000n, provider: 12_682_635n,
          buyer: 18_455_090n, orderStatus: 'accepted' },
        { outcome: 'reject_refund' as const, remedy: null, provider: 18_682_635n,
          buyer: 12_455_090n, orderStatus: 'accepted' },
      ];
      for (const expected of cases) {
        const f = await fixture(); await stopAndOpenIssue(f);
        const key = `decision-${randomUUID()}`;
        const input = { operatorId: f.operatorUserId, orderId: f.orderId, clientRequestId: key,
          payloadDigest: `sha512:${expected.outcome}:${'p'.repeat(48)}`, outcome: expected.outcome,
          remedyRefundCreditMicros: expected.remedy, reasonCiphertext: 'encrypted-reason',
          reasonDigest: `sha512:${'r'.repeat(64)}`, now: new Date() };
        if (expected.outcome === 'partial_refund') {
          expect(await f.store.decideIssue({ ...input, remedyRefundCreditMicros: 20_000_000n,
            payloadDigest: `sha512:${'z'.repeat(64)}` })).toEqual({ status: 'refund_exceeds_metered' });
        }
        const decided = await f.store.decideIssue(input);
        expect(decided).toMatchObject({ status: 'decided', issue: { status: 'resolved', outcome: expected.outcome,
          providerCreditMicros: expected.provider, buyerRefundCreditMicros: expected.buyer } });
        expect(await f.store.decideIssue(input)).toMatchObject({ status: 'replayed', issue: { outcome: expected.outcome } });
        expect(await f.store.decideIssue({ ...input, payloadDigest: `sha512:${'x'.repeat(64)}` })).toEqual({ status: 'conflict' });
        expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 68_862_275n + expected.buyer, reserved: 0n });
        expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: expected.provider });
        const order = await f.database.query<{ status: string }>(`SELECT status FROM kai_credit_orders WHERE id=$1`, [f.orderId]);
        expect(order.rows[0]?.status).toBe(expected.orderStatus);
        const listing = await f.database.query<{ capacity_reserved: string; capacity_sold: string }>(
          `SELECT capacity_reserved::text,capacity_sold::text FROM credit_market_listings WHERE id=$1`, [f.listingId]);
        expect(listing.rows[0]).toEqual({ capacity_reserved: '0.000000', capacity_sold: '0.600000' });
        if (expected.outcome === 'full_refund') {
          expect(await new PostgresCreditOrderStore(f.database).expireReservations(new Date(Date.now() + 86_400_000), 20)).toBe(0);
          const unchanged = await f.database.query<{ capacity_reserved: string; capacity_sold: string }>(
            `SELECT capacity_reserved::text,capacity_sold::text FROM credit_market_listings WHERE id=$1`, [f.listingId]);
          expect(unchanged.rows[0]).toEqual({ capacity_reserved: '0.000000', capacity_sold: '0.600000' });
        }
        if (expected.provider > 0n) {
          expect(await f.store.settleDue(new Date(Date.now() + 8 * 86_400_000), 20)).toBe(1);
          expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_earnings_available: expected.provider,
            supplier_receivable: 0n });
        }
        await f.database.close();
      }
    });
});
