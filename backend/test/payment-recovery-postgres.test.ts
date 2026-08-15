import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresMarketStore } from '../src/market/store.js';
import type { CheckoutRequest, PaymentProvider } from '../src/payment/providers.js';
import { PaymentRecoveryWorker, PostgresPaymentRecoveryStore } from '../src/payment/recovery.js';
import { PostgresPaymentStore } from '../src/payment/store.js';
import type { PaymentQueryResult } from '../src/payment/types.js';

function result<T>(value: Results<T>) {
  return { ...value, rowCount: value.rows.length || value.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite) {
  return {
    health: async () => true,
    query: async (text: string, values?: unknown[]) => result(await pglite.query(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => work({
      query: async (text: string, values?: unknown[]) => result(await transaction.query(text, values)),
    } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

class RecoveryProvider implements PaymentProvider {
  readonly name = 'wechat' as const;
  calls = new Map<string, number>();
  async createCheckout(_input: CheckoutRequest) { return { providerPaymentId: 'unused', checkoutPayload: 'unused' }; }
  async queryPayment(input: { providerReference: string; expectedAmountCents: number; currency: 'CNY' }): Promise<PaymentQueryResult> {
    const calls = (this.calls.get(input.providerReference) ?? 0) + 1;
    this.calls.set(input.providerReference, calls);
    if (input.providerReference === 'KP-DEAD') throw new Error('PROVIDER_TIMEOUT');
    if (input.providerReference === 'KP-LATE' && calls === 1) {
      return { status: 'pending', providerStatus: 'USERPAYING', payloadDigest: 'pending-digest' };
    }
    return {
      status: 'settled', event: {
        provider: 'wechat', eventId: `query:${input.providerReference}:SUCCESS:TX-${input.providerReference}`,
        providerReference: input.providerReference, providerTransactionId: `TX-${input.providerReference}`,
        status: 'succeeded', amountCents: input.expectedAmountCents, currency: input.currency,
        payloadDigest: 'verified-query-digest', normalizedPayload: { source: 'active_query', tradeState: 'SUCCESS' },
      },
    };
  }
}

describe('payment recovery worker', () => {
  it('actively confirms interrupted payments, releases expired reservations, refunds late success, and dead-letters uncertainty', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of [
      '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
      '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
      '0007_refund_execution.sql', '0008_dispute_evidence.sql', '0009_invoice_workflow.sql',
      '0010_payment_recovery.sql',
    ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    const database = adapter(pglite);
    const buyerId = randomUUID(); const supplierUserId = randomUUID(); const supplierId = randomUUID();
    const resourceId = randomUUID(); const listingId = randomUUID();
    const onTimeOrderId = randomUUID(); const lateOrderId = randomUUID(); const deadOrderId = randomUUID();
    const onTimePaymentId = randomUUID(); const latePaymentId = randomUUID(); const deadPaymentId = randomUUID();
    const now = new Date('2026-08-12T00:00:00.000Z');
    const future = new Date(now.getTime() + 10 * 60_000);
    const past = new Date(now.getTime() - 60_000);
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name) VALUES ($1, 'buyer', '买家'), ($2, 'supplier', '供应商')`,
      [buyerId, supplierUserId],
    );
    await database.query(
      `INSERT INTO supplier_profiles(id, user_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, '凯云算力有限公司', '91310101MA1ABCDEF0', '负责人', 'approved')`, [supplierId, supplierUserId],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status)
       VALUES ($1, $2, 'gpu', 'H100', '上海', '{}', 10, 'GPU时', 'verified')`, [resourceId, supplierId],
    );
    await database.query(
      `INSERT INTO market_listings(id, resource_id, supplier_id, product_code, region, capacity_total, capacity_reserved,
         capacity_unit, unit_price_cents, minimum_quantity, status, starts_at, expires_at, sla)
       VALUES ($1, $2, $3, 'H100', '上海', 10, 3, 'GPU时', 12800, 1, 'active', $4, $5, '{}')`,
      [listingId, resourceId, supplierId, new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000)],
    );
    for (const [orderId, number, expiresAt] of [
      [onTimeOrderId, 'CP-RECOVER', future], [lateOrderId, 'CP-LATE-RECOVER', past], [deadOrderId, 'CP-DEAD-RECOVER', past],
    ] as const) {
      await database.query(
        `INSERT INTO orders(id, order_number, buyer_id, supplier_id, listing_id, status, quantity, capacity_unit,
           unit_price_cents, subtotal_cents, total_cents, listing_snapshot, reservation_expires_at)
         VALUES ($1, $2, $3, $4, $5, 'payment_pending', 1, 'GPU时', 12800, 12800, 12800, '{}', $6)`,
        [orderId, number, buyerId, supplierId, listingId, expiresAt],
      );
      await database.query(
        `INSERT INTO capacity_reservations(id, order_id, listing_id, buyer_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, $4, 1, 'active', $5)`, [randomUUID(), orderId, listingId, buyerId, expiresAt],
      );
    }
    for (const [paymentId, orderId, reference, expiresAt, attempts] of [
      [onTimePaymentId, onTimeOrderId, 'KP-RECOVER', future, 0],
      [latePaymentId, lateOrderId, 'KP-LATE', past, 0],
      [deadPaymentId, deadOrderId, 'KP-DEAD', past, 23],
    ] as const) {
      await database.query(
        `INSERT INTO payment_intents(id, order_id, provider, provider_reference, channel, status, amount_cents,
           expires_at, reconciliation_attempts, next_reconcile_at)
         VALUES ($1, $2, 'wechat', $3, 'app', 'pending', 12800, $4, $5, $6)`,
        [paymentId, orderId, reference, expiresAt, attempts, now],
      );
    }

    const provider = new RecoveryProvider();
    const logs: unknown[] = [];
    let clock = now;
    const worker = new PaymentRecoveryWorker(
      new PostgresPaymentRecoveryStore(database), new PostgresPaymentStore(database), new PostgresMarketStore(database),
      new Map([['wechat', provider]]),
      { info: (fields) => { logs.push(fields); }, error: (fields) => { logs.push(fields); } },
      60_000, () => clock,
    );
    await worker.tick();

    expect((await database.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [onTimeOrderId])).rows[0]?.status).toBe('paid');
    expect((await database.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [lateOrderId])).rows[0]?.status).toBe('cancelled');
    expect((await database.query<{ status: string }>('SELECT status FROM capacity_reservations WHERE order_id = $1', [lateOrderId])).rows[0]?.status).toBe('expired');
    expect((await database.query<{ value: string }>('SELECT capacity_reserved::text AS value FROM market_listings WHERE id = $1', [listingId])).rows[0]?.value).toBe('1.000000');
    expect((await database.query<{ reconciliation_dead_lettered_at: Date | null }>(
      'SELECT reconciliation_dead_lettered_at FROM payment_intents WHERE id = $1', [deadPaymentId],
    )).rows[0]?.reconciliation_dead_lettered_at).not.toBeNull();
    expect((await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events WHERE topic = 'payment.reconciliation_dead_letter'`,
    )).rows[0]?.count).toBe('1');

    clock = new Date(now.getTime() + 6 * 60_000);
    await worker.tick();
    expect((await database.query<{ status: string }>('SELECT status FROM payment_intents WHERE id = $1', [latePaymentId])).rows[0]?.status).toBe('refunding');
    expect((await database.query<{ status: string }>('SELECT status FROM refunds WHERE payment_intent_id = $1', [latePaymentId])).rows[0]?.status).toBe('provider_pending');
    expect((await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events WHERE topic = 'refund.execute'`,
    )).rows[0]?.count).toBe('1');
    expect(logs.length).toBeGreaterThan(0);
    await database.close();
  });
});
