import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresAdminP0Store } from '../src/admin/p0-store.js';
import type { Database } from '../src/database.js';

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0,
    command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite, captured: string[]): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => {
      captured.push(text);
      return pgResult(await pglite.query<Row>(text, values));
    },
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) =>
      pglite.transaction(async (transaction: Transaction) => work({
        query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)),
      } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

async function migrateAll(pglite: PGlite) {
  const migrations = (await readdir(new URL('../migrations', import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  expect(migrations[0]).toBe('0001_cloudpay_ledger.sql');
  expect(migrations).toContain('0060_admin_identity_rbac_sessions.sql');
  for (const name of migrations) {
    await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  }
}

async function seedP0Rows(pglite: PGlite) {
  await pglite.exec('SET session_replication_role = replica');
  try {
    await pglite.exec(`
      INSERT INTO kai_credit_orders(id,order_number,buyer_subject_id,supplier_subject_id,created_by_user_id,
        listing_id,client_request_id,payload_digest,status,quantity,capacity_unit,unit_credit_micros,
        total_credit_micros,listing_snapshot,reservation_expires_at,closed_at,created_at,updated_at)
      VALUES
        ('10000000-0000-4000-8000-000000000002','COMPUTE-P0-0002',
          '11000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001',
          '13000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001',
          'compute-p0-request-0002','sha256:compute-p0-payload-0002','reserved',1,'GPU_HOUR',10000,10000,
          '{"email":"secret-compute@example.test"}'::jsonb,'2026-08-20T00:00:00Z',NULL,
          '2026-08-19T05:00:00Z','2026-08-19T05:30:00Z'),
        ('10000000-0000-4000-8000-000000000001','COMPUTE-P0-0001',
          '11000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001',
          '13000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001',
          'compute-p0-request-0001','sha256:compute-p0-payload-0001','cancelled',1,'GPU_HOUR',10000,10000,
          '{"phone":"secret-compute-phone"}'::jsonb,'2026-08-20T00:00:00Z','2026-08-19T04:30:00Z',
          '2026-08-19T04:00:00Z','2026-08-19T04:30:00Z');

      INSERT INTO physical_device_orders(id,order_number,buyer_subject_id,supplier_subject_id,created_by_user_id,
        product_id,client_request_id,payload_digest,shipping_address_reference,status,quantity,unit_credit_micros,
        gross_credit_micros,reservation_transaction_id,resolution_transaction_id,reservation_expires_at,resolved_at,
        campaign_key,campaign_version,created_at,updated_at)
      VALUES
        ('20000000-0000-4000-8000-000000000002','DEVICE-P0-0002',
          '21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001',
          '23000000-0000-4000-8000-000000000001','24000000-0000-4000-8000-000000000001',
          'device-p0-request-0002','sha256:device-p0-payload-0002','secret-address-reference-0002',
          'reserved',1,10000,10000,'25000000-0000-4000-8000-000000000002',NULL,'2026-08-20T00:00:00Z',NULL,
          'device-campaign-p0','device-template-p0','2026-08-19T05:00:00Z','2026-08-19T05:30:00Z'),
        ('20000000-0000-4000-8000-000000000001','DEVICE-P0-0001',
          '21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001',
          '23000000-0000-4000-8000-000000000001','24000000-0000-4000-8000-000000000001',
          'device-p0-request-0001','sha256:device-p0-payload-0001','secret-address-reference-0001',
          'cancelled',1,10000,10000,'25000000-0000-4000-8000-000000000001',
          '26000000-0000-4000-8000-000000000001','2026-08-20T00:00:00Z','2026-08-19T04:30:00Z',
          'device-campaign-p0','device-template-p0','2026-08-19T04:00:00Z','2026-08-19T04:30:00Z');

      INSERT INTO kai_credit_payout_requests(id,payout_number,subject_id,requested_by_user_id,client_request_id,
        payload_digest,status,credit_micros,conversion_cny_micros_per_credit,cny_micros,payment_amount_cents,
        available_before_micros,available_after_micros,frozen_before_micros,frozen_after_micros,payout_account_id,
        freeze_transaction_id,resolution_transaction_id,recipient_reference,resolution_reason,
        resolution_available_before_micros,resolution_available_after_micros,
        resolution_frozen_before_micros,resolution_frozen_after_micros,resolved_at,created_at,updated_at)
      VALUES
        ('30000000-0000-4000-8000-000000000002','PAYOUT-P0-0002',
          '31000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000001',
          'payout-p0-request-0002','sha256:payout-p0-payload-0002','submitted',10000,1002000,10020,1,
          20000,10000,0,10000,'33000000-0000-4000-8000-000000000002',
          '34000000-0000-4000-8000-000000000002',NULL,'secret-bank-reference-0002',NULL,NULL,NULL,NULL,NULL,NULL,
          '2026-08-19T05:00:00Z','2026-08-19T05:30:00Z'),
        ('30000000-0000-4000-8000-000000000001','PAYOUT-P0-0001',
          '31000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000001',
          'payout-p0-request-0001','sha256:payout-p0-payload-0001','rejected',10000,1002000,10020,1,
          20000,10000,0,10000,'33000000-0000-4000-8000-000000000001',
          '34000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',
          'secret-bank-reference-0001','P0_TEST',10000,20000,10000,0,'2026-08-19T04:30:00Z',
          '2026-08-19T04:00:00Z','2026-08-19T04:30:00Z');

      INSERT INTO kai_credit_topups(id,subject_id,created_by_user_id,client_request_id,payload_digest,provider,
        channel,provider_reference,amount_cents,currency,credit_micros,conversion_cny_micros_per_credit,status,
        checkout_payload,expires_at,created_at,updated_at)
      VALUES
        ('40000000-0000-4000-8000-000000000002','41000000-0000-4000-8000-000000000001',
          '42000000-0000-4000-8000-000000000001','topup-p0-request-0002','sha256:topup-p0-payload-0002',
          'alipay','app','secret-provider-reference-0002',100,'CNY',10000,1002000,'manual_review',
          'secret-checkout-payload-0002','2026-08-20T00:00:00Z','2026-08-19T05:00:00Z','2026-08-19T05:30:00Z'),
        ('40000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001',
          '42000000-0000-4000-8000-000000000001','topup-p0-request-0001','sha256:topup-p0-payload-0001',
          'wechat','app','secret-provider-reference-0001',100,'CNY',10000,1002000,'failed',
          NULL,'2026-08-20T00:00:00Z','2026-08-19T04:00:00Z','2026-08-19T04:30:00Z');
    `);
  } finally {
    await pglite.exec('SET session_replication_role = origin');
  }
}

describe('PostgresAdminP0Store complete migration compatibility', () => {
  it('executes overview, first-page and keyset SQL against the complete real schema without projecting PII',
    { timeout: 180_000 }, async () => {
      const pglite = new PGlite();
      await migrateAll(pglite);
      await seedP0Rows(pglite);
      const captured: string[] = [];
      const database = adapter(pglite, captured);
      const store = new PostgresAdminP0Store(database);
      try {
        await expect(store.overview()).resolves.toEqual({
          computeOrders: { total: 2, active: 1 },
          deviceOrders: { total: 2, active: 1 },
          payouts: { total: 2, pending: 1 },
          topups: { total: 2, attentionRequired: 1 },
        });

        const compute = await store.listComputeCreditOrders({ limit: 10, cursor: null });
        const devices = await store.listDeviceOrders({ limit: 10, cursor: null });
        const payouts = await store.listPayouts({ limit: 10, cursor: null });
        const topups = await store.listTopups({ limit: 10, cursor: null });
        expect(compute.map((row) => row.id)).toEqual([
          '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
        ]);
        expect(devices.map((row) => row.id)).toEqual([
          '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001',
        ]);
        expect(payouts.map((row) => row.id)).toEqual([
          '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001',
        ]);
        expect(topups.map((row) => row.id)).toEqual([
          '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001',
        ]);

        const keysetResults = await Promise.all([
          store.listComputeCreditOrders({ limit: 10, cursor: { createdAt: compute[0]!.createdAt, id: compute[0]!.id } }),
          store.listDeviceOrders({ limit: 10, cursor: { createdAt: devices[0]!.createdAt, id: devices[0]!.id } }),
          store.listPayouts({ limit: 10, cursor: { createdAt: payouts[0]!.createdAt, id: payouts[0]!.id } }),
          store.listTopups({ limit: 10, cursor: { createdAt: topups[0]!.createdAt, id: topups[0]!.id } }),
        ]);
        expect(keysetResults.map((rows) => rows.map((row) => row.id))).toEqual([
          ['10000000-0000-4000-8000-000000000001'],
          ['20000000-0000-4000-8000-000000000001'],
          ['30000000-0000-4000-8000-000000000001'],
          ['40000000-0000-4000-8000-000000000001'],
        ]);

        const serialized = JSON.stringify({ compute, devices, payouts, topups, keysetResults });
        expect(serialized).not.toContain('secret-');
        expect(serialized).not.toMatch(/subjectId|userId|shippingAddress|tracking|recipientReference|providerReference/iu);
        expect(captured).toHaveLength(9);
        expect(captured.slice(5).every((sql) => sql.includes('id < $2::uuid'))).toBe(true);
        expect(captured.join('\n')).not.toMatch(
          /subject_id|user_id|listing_snapshot|shipping_address|tracking_|recipient_reference|company_payment|payout_account|provider_reference|payment_id|transaction_id|checkout_payload/iu,
        );
      } finally {
        await database.close();
      }
    });
});
