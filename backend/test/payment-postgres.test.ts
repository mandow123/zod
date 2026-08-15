import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresPaymentStore } from '../src/payment/store.js';
import type { VerifiedPaymentEvent } from '../src/payment/types.js';

function pgResult<T>(result: Results<T>) {
  return {
    ...result,
    rowCount: result.rows.length || result.affectedRows || 0,
    command: '', oid: 0, rowAsArray: false,
  };
}

function databaseAdapter(pglite: PGlite): Database {
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
  for (const name of [
    '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
    '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
    '0007_refund_execution.sql', '0008_dispute_evidence.sql', '0009_invoice_workflow.sql',
    '0010_payment_recovery.sql',
  ]) {
    const path = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
    await pglite.exec(await readFile(path, 'utf8'));
  }
}

function event(input: Partial<VerifiedPaymentEvent> & Pick<VerifiedPaymentEvent, 'providerReference' | 'eventId' | 'providerTransactionId'>): VerifiedPaymentEvent {
  return {
    provider: 'wechat', status: 'succeeded', amountCents: 12800, currency: 'CNY',
    payloadDigest: `sha256:${'a'.repeat(64)}`, normalizedPayload: { tradeState: 'SUCCESS' }, ...input,
  };
}

describe('PostgreSQL payment ledger transaction', () => {
  it('moves a valid order once, isolates amount mismatch, and refunds a late callback', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    await migrate(pglite);
    const database = databaseAdapter(pglite);
    const store = new PostgresPaymentStore(database);
    const buyerId = randomUUID();
    const supplierUserId = randomUUID();
    const supplierId = randomUUID();
    const resourceId = randomUUID();
    const listingId = randomUUID();
    const validOrderId = randomUUID();
    const mismatchOrderId = randomUUID();
    const lateOrderId = randomUUID();
    const current = new Date('2026-08-11T15:00:00.000Z');
    const future = new Date(current.getTime() + 15 * 60_000);
    const past = new Date(current.getTime() - 60_000);

    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name) VALUES ($1, 'cipher-buyer', '买家'), ($2, 'cipher-supplier', '供应商')`,
      [buyerId, supplierUserId],
    );
    await database.query(
      `INSERT INTO supplier_profiles(id, user_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, '凯云算力有限公司', '91310101MA1ABCDEF0', '负责人', 'approved')`,
      [supplierId, supplierUserId],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $2, 'gpu', 'H100', '上海', '{}', 10, 'GPU时', 'verified')`,
      [resourceId, supplierId],
    );
    await database.query(
      `INSERT INTO market_listings(id, resource_id, supplier_id, product_code, region, capacity_total, capacity_reserved,
         capacity_unit, unit_price_cents, minimum_quantity, status, starts_at, expires_at, sla)
       VALUES ($1, $2, $3, 'H100', '上海', 10, 3, 'GPU时', 12800, 1, 'active', $4, $5, '{}')`,
      [listingId, resourceId, supplierId, new Date(current.getTime() - 86_400_000), new Date(current.getTime() + 86_400_000)],
    );
    for (const [id, number, expiresAt] of [
      [validOrderId, 'CP-VALID', future], [mismatchOrderId, 'CP-MISMATCH', future], [lateOrderId, 'CP-LATE', past],
    ] as const) {
      await database.query(
        `INSERT INTO orders(id, order_number, buyer_id, supplier_id, listing_id, status, quantity, capacity_unit,
           unit_price_cents, subtotal_cents, fee_cents, total_cents, listing_snapshot, reservation_expires_at)
         VALUES ($1, $2, $3, $4, $5, 'payment_pending', 1, 'GPU时', 12800, 12800, 0, 12800, '{}', $6)`,
        [id, number, buyerId, supplierId, listingId, expiresAt],
      );
      await database.query(
        `INSERT INTO capacity_reservations(id, order_id, listing_id, buyer_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, $4, 1, 'active', $5)`,
        [randomUUID(), id, listingId, buyerId, expiresAt],
      );
    }

    const prepared = await store.prepareIntent({
      id: randomUUID(), providerReference: 'KP-VALID', buyerId, orderId: validOrderId,
      provider: 'wechat', channel: 'app', now: current,
    });
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') throw new Error('payment was not prepared');
    await store.saveCheckout(prepared.intent.id, { providerPaymentId: 'prepay-valid', checkoutPayload: 'signed-payload' });
    const successEvent = event({ providerReference: 'KP-VALID', eventId: 'EV-VALID', providerTransactionId: 'TX-VALID' });
    expect(await store.applyVerifiedEvent(successEvent, current)).toBe('succeeded');
    expect(await store.applyVerifiedEvent(successEvent, current)).toBe('duplicate');
    expect((await database.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [validOrderId])).rows[0]?.status).toBe('paid');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM payment_events')).rows[0]?.count).toBe('1');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM notifications WHERE user_id = $1', [buyerId])).rows[0]?.count).toBe('1');

    const mismatchPrepared = await store.prepareIntent({
      id: randomUUID(), providerReference: 'KP-MISMATCH', buyerId, orderId: mismatchOrderId,
      provider: 'wechat', channel: 'app', now: current,
    });
    expect(mismatchPrepared.status).toBe('ready');
    expect(await store.applyVerifiedEvent(event({
      providerReference: 'KP-MISMATCH', eventId: 'EV-MISMATCH', providerTransactionId: 'TX-MISMATCH', amountCents: 1,
    }), current)).toBe('amount_mismatch');
    expect((await database.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [mismatchOrderId])).rows[0]?.status).toBe('payment_pending');

    const lateIntentId = randomUUID();
    await database.query(
      `INSERT INTO payment_intents(id, order_id, provider, provider_reference, channel, status, amount_cents, expires_at)
       VALUES ($1, $2, 'wechat', 'KP-LATE', 'app', 'pending', 12800, $3)`,
      [lateIntentId, lateOrderId, past],
    );
    expect(await store.applyVerifiedEvent(event({
      providerReference: 'KP-LATE', eventId: 'EV-LATE', providerTransactionId: 'TX-LATE',
    }), current)).toBe('refund_required');
    expect((await database.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [lateOrderId])).rows[0]?.status).toBe('refund_pending');
    expect((await database.query<{ status: string }>('SELECT status FROM payment_intents WHERE id = $1', [lateIntentId])).rows[0]?.status).toBe('refunding');
    expect((await database.query<{ status: string }>('SELECT status FROM refunds WHERE payment_intent_id = $1', [lateIntentId])).rows[0]?.status).toBe('provider_pending');
    expect((await database.query<{ capacity_reserved: string }>('SELECT capacity_reserved::text FROM market_listings WHERE id = $1', [listingId])).rows[0]?.capacity_reserved).toBe('2.000000');
    expect((await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbox_events WHERE topic = 'payment.refund_required'`)).rows[0]?.count).toBe('1');
    await database.close();
  });
});
