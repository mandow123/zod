import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresMarketStore } from '../src/market/store.js';

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

async function migrate(pglite: PGlite) {
  for (const name of [
    '0001_cloudpay_ledger.sql', '0003_market_reservations.sql', '0012_mobile_publish.sql',
    '0015_credit_listing_audits.sql', '0016_trading_subjects.sql', '0017_offer_wizard_drafts.sql', '0018_resource_identity.sql', '0019_resource_resubmissions.sql',
    '0041_compute_assets.sql',
  ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
}

async function provider(database: Database, suffix: string) {
  const userId = randomUUID(); const subjectId = randomUUID();
  await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES ($1, $2, $3, 'supplier')`, [userId, `phone-${suffix}`, `资源方${suffix}`]);
  await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', $2, $3)`, [subjectId, `资源方${suffix}`, userId]);
  await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [subjectId, userId]);
  await database.query(
    `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
     VALUES ($1, $2, $1, $3, $4, '凯', 'approved')`, [subjectId, userId, `凯云${suffix}`, `91310101MA1ABC${suffix.padStart(3, '0')}`],
  );
  return { userId, subjectId };
}

function input(providerValue: Awaited<ReturnType<typeof provider>>, overrides: Partial<Parameters<PostgresMarketStore['createResource']>[0]> = {}) {
  return {
    id: randomUUID(), assetId: randomUUID(), subjectId: providerValue.subjectId, requestedByUserId: providerValue.userId, kind: 'gpu' as const,
    productCode: 'H100-SXM-80G', region: '华东-上海', specifications: { memory: '80GB' }, capacityTotal: '10',
    capacityUnit: 'GPU时', assetFingerprint: 'fingerprint-global-001', assetIdentityKind: 'hardware_serial' as const,
    clientRequestId: 'resource-create-0000001', payloadDigest: 'payload-a', ...overrides,
  };
}

describe('private resource identity', () => {
  it('replays retries, restores same-subject duplicates, and creates only one verification run', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite); const store = new PostgresMarketStore(database);
    const owner = await provider(database, '001'); const firstInput = input(owner);
    const first = await store.createResource(firstInput); expect(first?.status).toBe('created');
    const replay = await store.createResource({ ...firstInput, id: randomUUID() }); expect(replay?.status).toBe('replayed');
    expect(await store.createResource({ ...firstInput, id: randomUUID(), payloadDigest: 'different' })).toEqual({ status: 'idempotency_conflict' });
    const existing = await store.createResource(input(owner, { clientRequestId: 'resource-create-0000002', payloadDigest: 'payload-b' }));
    expect(existing?.status).toBe('existing');
    expect('resource' in first! && 'resource' in existing! ? existing.resource.id : null).toBe('resource' in first! ? first.resource.id : null);
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM resource_verification_runs')).rows[0]?.count).toBe('1');
    await database.close();
  });

  it('blocks globally unique hardware identity across subjects without exposing the owner', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite); const store = new PostgresMarketStore(database);
    const first = await provider(database, '001'); const second = await provider(database, '002');
    expect((await store.createResource(input(first)))?.status).toBe('created');
    expect(await store.createResource(input(second, { clientRequestId: 'resource-create-0000002' }))).toEqual({ status: 'identity_claimed' });
    await database.close();
  });

  it('scopes enterprise-internal identifiers to each supplier', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite); const store = new PostgresMarketStore(database);
    const first = await provider(database, '001'); const second = await provider(database, '002');
    expect((await store.createResource(input(first, { assetIdentityKind: 'internal_asset_id', assetFingerprint: 'fingerprint-first-internal' })))?.status).toBe('created');
    expect((await store.createResource(input(second, {
      assetIdentityKind: 'internal_asset_id', assetFingerprint: 'fingerprint-second-internal', clientRequestId: 'resource-create-0000002',
    })))?.status).toBe('created');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM compute_resources')).rows[0]?.count).toBe('2');
    await database.close();
  });
});
