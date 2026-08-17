import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresMarketStore } from '../src/market/store.js';

function pgResult<T>(result: Results<T>) {
  return {
    ...result,
    rowCount: result.rows.length || result.affectedRows || 0,
    command: '', oid: 0, rowAsArray: false,
  };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => {
      const client = {
        query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)),
      } as unknown as PoolClient;
      return work(client);
    }),
    close: () => pglite.close(),
  } as unknown as Database;
}

async function migrate(pglite: PGlite) {
    for (const name of ['0001_cloudpay_ledger.sql', '0003_market_reservations.sql', '0012_mobile_publish.sql', '0015_credit_listing_audits.sql', '0016_trading_subjects.sql', '0017_offer_wizard_drafts.sql', '0018_resource_identity.sql', '0019_resource_resubmissions.sql', '0020_resource_verification_evidence.sql', '0039_compute_node_readiness.sql', '0041_compute_assets.sql']) {
    const path = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
    await pglite.exec(await readFile(path, 'utf8'));
  }
}

describe('PostgreSQL native publish workflow', () => {
  it('persists isolated demands and the supplier verification-to-listing path', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    await migrate(pglite);
    const database = adapter(pglite);
    const store = new PostgresMarketStore(database);
    const buyerId = randomUUID();
    const otherBuyerId = randomUUID();
    const supplierUserId = randomUUID();
    const operatorId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
       ($1, 'buyer-phone', '买家', 'member'), ($2, 'other-phone', '其他买家', 'member'),
       ($3, 'supplier-phone', '供应商', 'supplier'), ($4, 'operator-phone', '运营', 'operator')`,
      [buyerId, otherBuyerId, supplierUserId, operatorId],
    );

    const now = new Date('2026-08-12T08:00:00.000Z');
    const demand = await store.createDemand({
      id: randomUUID(), buyerId, kind: 'gpu', title: '训练 70B 模型', productHint: 'H100 80G',
      region: '华东-上海', quantity: '128', capacityUnit: 'GPU时',
      desiredStartAt: new Date(now.getTime() + 86_400_000), deadlineAt: new Date(now.getTime() + 14 * 86_400_000),
      description: '需要高速互联，并提供可核验的交付记录。',
    });
    expect((await store.listDemands(buyerId)).map((item) => item.id)).toEqual([demand.id]);
    expect(await store.listDemands(otherBuyerId)).toEqual([]);
    expect((await store.cancelDemand(otherBuyerId, demand.id))).toBeNull();
    expect((await store.cancelDemand(buyerId, demand.id))?.status).toBe('cancelled');

    const subjectId = randomUUID();
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '供应商', $2)`, [subjectId, supplierUserId]);
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [subjectId, supplierUserId]);
    const profile = await store.submitSupplier({
      subjectId, userId: supplierUserId, legalName: '凯云算力有限公司', creditCode: '91310101MA1ABCDEF0', contactName: '凯',
    });
    expect((await store.reviewSupplier({ supplierId: profile.id, reviewerId: operatorId, approved: true }))?.status).toBe('approved');
    const resource = await store.createResource({
      id: randomUUID(), assetId: randomUUID(), subjectId, requestedByUserId: supplierUserId, kind: 'gpu', productCode: 'H100-SXM-80G', region: '华东-上海',
      specifications: { interconnect: 'NVLink' }, capacityTotal: '100', capacityUnit: 'GPU时',
      assetFingerprint: 'fingerprint-publish-001', assetIdentityKind: 'hardware_serial', clientRequestId: 'resource-publish-000001', payloadDigest: 'payload-a',
    });
    expect(resource?.status).toBe('created');
    if (!resource || !('resource' in resource)) throw new Error('resource was not created');
    await database.query(`UPDATE resource_verification_runs SET status = 'running', materials_submitted_at = now() WHERE resource_id = $1`, [resource.resource.id]);
    const verified = await store.completeResourceVerification({
      resourceId: resource.resource.id, reviewerId: operatorId, passed: true,
      evidenceDigest: `sha256:${'a'.repeat(64)}`, checks: { connectivity: true },
    });
    expect(verified?.status).toBe('verified');

    const nodeId = randomUUID();
    await database.query(`INSERT INTO compute_nodes(id, supplier_id, node_public_key, node_key_fingerprint,
        inventory_digest, status, last_heartbeat_at, heartbeat_boot_id, heartbeat_sequence,
        heartbeat_payload_digest, heartbeat_signature)
      VALUES ($1,$2,$3,$4,$5,'ready',now(),$6,1,$7,$8)`,
    [nodeId, profile.id, `ed25519:${'A'.repeat(44)}`, `sha256:${'b'.repeat(64)}`,
      `sha256:${'c'.repeat(64)}`, randomUUID(), `sha256:${'d'.repeat(64)}`, `ed25519:${'B'.repeat(88)}`]);
    await database.query(`INSERT INTO compute_resource_bindings(id, resource_id, node_id, status,
        resource_verification_digest, policy_digest, attested_policy_digest, inventory_digest, gpu_set_digest, confirmed_at)
      VALUES ($1,$2,$3,'ready',$4,$5,$5,$6,$7,now())`,
    [randomUUID(), resource.resource.id, nodeId, `sha256:${'a'.repeat(64)}`, `sha256:${'e'.repeat(64)}`,
      `sha256:${'c'.repeat(64)}`, `sha256:${'f'.repeat(64)}`]);

    const listing = await store.createListing({
      id: randomUUID(), subjectId, publishedByUserId: supplierUserId, resourceId: resource.resource.id, capacityTotal: '50',
      unitPriceCents: 1250, minimumQuantity: '1', startsAt: now,
      expiresAt: new Date(now.getTime() + 30 * 86_400_000), sla: { availability: '99.9%' },
    });
    expect(listing?.availableQuantity).toBe('50.000000');
    expect((await store.listSupplierResources(subjectId))[0]?.status).toBe('verified');
    expect((await store.listSupplierListings(subjectId))[0]).toMatchObject({
      resourceId: resource.resource.id, totalQuantity: '50.000000', unitPriceCents: 1250, status: 'active',
    });
    await database.close();
  });

  it('shows the latest failure and safely creates exactly one new review round', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite); const store = new PostgresMarketStore(database);
    const supplierUserId = randomUUID(); const otherUserId = randomUUID(); const operatorId = randomUUID(); const subjectId = randomUUID(); const otherSubjectId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
       ($1, 'supplier-resubmit', '资源方', 'supplier'), ($2, 'other-resubmit', '其他资源方', 'supplier'), ($3, 'operator-resubmit', '运营', 'operator')`,
      [supplierUserId, otherUserId, operatorId],
    );
    await database.query(
      `INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES
       ($1, 'personal', '资源方', $2), ($3, 'personal', '其他资源方', $4)`, [subjectId, supplierUserId, otherSubjectId, otherUserId],
    );
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`, [subjectId, supplierUserId, otherSubjectId, otherUserId]);
    const profile = await store.submitSupplier({ subjectId, userId: supplierUserId, legalName: '凯云资源有限公司', creditCode: '91310101MA1RETRY01', contactName: '凯' });
    await store.reviewSupplier({ supplierId: profile.id, reviewerId: operatorId, approved: true });
    const created = await store.createResource({
      id: randomUUID(), assetId: randomUUID(), subjectId, requestedByUserId: supplierUserId, kind: 'gpu', productCode: 'H100-80G', region: '上海',
      specifications: {}, capacityTotal: '16', capacityUnit: 'GPU时', assetFingerprint: 'resubmit-fingerprint',
      assetIdentityKind: 'hardware_serial', clientRequestId: 'resource-resubmit-create01', payloadDigest: 'payload-resubmit',
    });
    if (!created || !('resource' in created)) throw new Error('resource not created');
    await database.query(`UPDATE resource_verification_runs SET status = 'running', materials_submitted_at = now() WHERE resource_id = $1`, [created.resource.id]);
    await store.completeResourceVerification({
      resourceId: created.resource.id, reviewerId: operatorId, passed: false,
      evidenceDigest: `sha256:${'b'.repeat(64)}`, checks: { inventory: false }, failureReason: '设备序列号照片不清楚，请重新上传。',
    });
    expect((await store.listSupplierResources(subjectId))[0]).toMatchObject({
      status: 'rejected', verification: { status: 'failed', failureReason: '设备序列号照片不清楚，请重新上传。' },
    });
    expect(await store.resubmitResourceVerification({
      id: randomUUID(), resourceId: created.resource.id, subjectId: otherSubjectId,
      requestedByUserId: otherUserId, clientRequestId: 'resource-resubmit-other01',
    })).toEqual({ status: 'not_found' });
    const input = { id: randomUUID(), resourceId: created.resource.id, subjectId, requestedByUserId: supplierUserId, clientRequestId: 'resource-resubmit-request1' };
    const resubmitted = await store.resubmitResourceVerification(input);
    expect(resubmitted).toMatchObject({
      status: 'created',
      resource: {
        status: 'pending_verification',
        verification: { status: 'pending', failureReason: '设备序列号照片不清楚，请重新上传。' },
      },
    });
    expect(await store.resubmitResourceVerification({ ...input, id: randomUUID() })).toMatchObject({ status: 'replayed', resource: { id: created.resource.id } });
    expect((await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM resource_verification_runs WHERE resource_id = $1`, [created.resource.id])).rows[0]?.count).toBe('2');
    await database.close();
  });
});
