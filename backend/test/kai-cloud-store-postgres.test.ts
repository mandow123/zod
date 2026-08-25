import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { KaiCloudVerificationStore } from '../src/kai-cloud/store.js';
import { PostgresMarketStore } from '../src/market/store.js';

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0,
    command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) =>
      pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(
      async (transaction: Transaction) => work({
        query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)),
      } as unknown as PoolClient),
    ),
    close: () => pglite.close(),
  } as unknown as Database;
}

async function migrateAll(pglite: PGlite) {
  for (const name of (await readdir(new URL('../migrations', import.meta.url)))
    .filter((value) => value.endsWith('.sql')).sort()) {
    await pglite.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
}

async function provider(database: Database, suffix: string) {
  const userId = randomUUID(); const subjectId = randomUUID();
  await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES ($1,$2,$3,'supplier')`,
    [userId, `kai-cloud-phone-${suffix}`, `资源方${suffix}`]);
  await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES ($1,'personal',$2,$3)`,
    [subjectId, `资源方${suffix}`, userId]);
  await database.query(`INSERT INTO subject_memberships(subject_id,user_id,role) VALUES ($1,$2,'owner')`, [subjectId, userId]);
  await database.query(`INSERT INTO supplier_profiles(id,created_by_user_id,subject_id,legal_name,credit_code,contact_name,status)
    VALUES ($1,$2,$1,$3,$4,'凯','approved')`,
  [subjectId, userId, `凯云验证${suffix}`, `91310101MA1KC${suffix.padStart(5, '0')}`]);
  return { userId, subjectId };
}

describe('KAI Cloud verification PostgreSQL store', () => {
  it('isolates provider subjects and rejects stale webhook versions while preserving replay results',
    { timeout: 30_000 }, async () => {
      const pglite = new PGlite(); await migrateAll(pglite); const database = adapter(pglite);
      try {
        const owner = await provider(database, '301'); const outsider = await provider(database, '302');
        const assetId = randomUUID(); const resourceId = randomUUID();
        const market = new PostgresMarketStore(database);
        await market.createResource({ id: resourceId, assetId, subjectId: owner.subjectId,
          requestedByUserId: owner.userId, kind: 'gpu', productCode: 'H100-SXM-80G', region: '华东-上海',
          specifications: { gpuCount: 8 }, capacityTotal: '8', capacityUnit: 'GPU时',
          assetFingerprint: `sha256:${'3'.repeat(64)}`, assetIdentityKind: 'hardware_serial',
          clientRequestId: 'kai-cloud-store-resource-001', payloadDigest: 'kai-cloud-store-resource-digest' });

        const store = new KaiCloudVerificationStore(database);
        expect(await store.asset(outsider.subjectId, assetId)).toBeNull();
        expect(await store.find(outsider.subjectId, assetId)).toBeNull();
        expect(await store.asset(owner.subjectId, assetId)).toMatchObject({ resourceId, productCode: 'H100-SXM-80G' });

        const now = new Date('2026-08-20T01:00:00.000Z');
        const initial = await store.save({ subjectId: owner.subjectId, assetId,
          startIdempotencyKey: 'kai-cloud-start-0001', requestPayloadDigest: `sha256:${'4'.repeat(64)}`,
          verification: { id: 'verification_store_1', version: 2, status: 'running',
            updatedAt: now.toISOString(), failure: null }, source: 'api', now });
        expect(initial).toMatchObject({ subjectId: owner.subjectId, upstreamVersion: 2, status: 'running' });

        const stale = await store.applyWebhook({ deliveryId: 'delivery-stale-0001',
          eventType: 'resource.verification.updated', payloadDigest: `sha256:${'5'.repeat(64)}`,
          verification: { id: 'verification_store_1', version: 1, status: 'failed',
            updatedAt: new Date(now.getTime() - 1_000).toISOString(), failure: { code: 'STALE', message: 'stale' } }, now });
        expect(stale).toBe('stale');
        expect(await store.find(owner.subjectId, assetId)).toMatchObject({ upstreamVersion: 2, status: 'running' });

        const updateInput = { deliveryId: 'delivery-update-0001', eventType: 'resource.verification.updated',
          payloadDigest: `sha256:${'6'.repeat(64)}`, verification: { id: 'verification_store_1', version: 3,
            status: 'passed' as const, updatedAt: new Date(now.getTime() + 1_000).toISOString(), failure: null }, now };
        expect(await store.applyWebhook(updateInput)).toMatchObject({ status: 'updated',
          verification: { upstreamVersion: 3, status: 'passed' } });
        expect(await store.applyWebhook(updateInput)).toBe('replayed');
        expect(await store.applyWebhook({ ...updateInput, payloadDigest: `sha256:${'7'.repeat(64)}` }))
          .toBe('delivery_conflict');
      } finally { await database.close(); }
    });
});
