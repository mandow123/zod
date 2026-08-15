import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AccountStore } from '../src/account/store.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { RefundService } from '../src/refunds/service.js';
import { PostgresRefundStore } from '../src/refunds/store.js';
import { PostgresRefundExecutionStore } from '../src/refunds/execution-store.js';

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

describe('refund application and review ledger', () => {
  it('is idempotent, enforces ownership and amount, and queues only approved refunds', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of [
      '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
      '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
      '0007_refund_execution.sql',
    ]) {
      await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    }
    const database = adapter(pglite);
    const buyerId = randomUUID();
    const otherUserId = randomUUID();
    const supplierUserId = randomUUID();
    const operatorId = randomUUID();
    const supplierId = randomUUID();
    const resourceId = randomUUID();
    const listingId = randomUUID();
    const orderId = randomUUID();
    const paymentIntentId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
       ($1, 'buyer', '买家', 'member'), ($2, 'other', '其他用户', 'member'),
       ($3, 'supplier', '供应商', 'supplier'), ($4, 'operator', '运营', 'operator')`,
      [buyerId, otherUserId, supplierUserId, operatorId],
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
       VALUES ($1, $2, $3, 'H100', '上海', 10, 1, 'GPU时', 12800, 1, 'active', now() - interval '1 day', now() + interval '1 day', '{}')`,
      [listingId, resourceId, supplierId],
    );
    await database.query(
      `INSERT INTO orders(id, order_number, buyer_id, supplier_id, listing_id, status, quantity, capacity_unit,
         unit_price_cents, subtotal_cents, total_cents, listing_snapshot, reservation_expires_at, paid_at)
       VALUES ($1, 'CP-REFUND-01', $2, $3, $4, 'paid', 1, 'GPU时', 12800, 12800, 12800, '{}', now() + interval '1 day', now())`,
      [orderId, buyerId, supplierId, listingId],
    );
    await database.query(
      `INSERT INTO payment_intents(id, order_id, provider, provider_reference, provider_payment_id, channel, status,
         amount_cents, expires_at, succeeded_at)
       VALUES ($1, $2, 'wechat', 'KP-REFUND-01', 'WX-PAID-01', 'app', 'succeeded', 12800, now() + interval '1 day', now())`,
      [paymentIntentId, orderId],
    );
    await database.query(
      `INSERT INTO capacity_reservations(id, order_id, listing_id, buyer_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, $4, 1, 'active', now() + interval '1 day')`,
      [randomUUID(), orderId, listingId, buyerId],
    );

    const audits: string[] = [];
    const accountStore = { recordAudit: async (input: { action: string }) => { audits.push(input.action); } } as unknown as AccountStore;
    const config = loadConfig({
      NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://api.cloudpay.kai.com', DATABASE_URL: 'postgresql://test/cloudpay',
      ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32),
      AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'e'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    });
    const service = new RefundService(new PostgresRefundStore(database), accountStore, config);
    const buyer: AccountPrincipal = { userId: buyerId, sessionId: randomUUID(), role: 'member' };
    const other: AccountPrincipal = { userId: otherUserId, sessionId: randomUUID(), role: 'member' };
    const operator: AccountPrincipal = { userId: operatorId, sessionId: randomUUID(), role: 'operator' };
    const context = { requestId: 'refund-test', ip: '203.0.113.30' };

    const first = await service.request(buyer, {
      orderId, amountCents: 5000, reason: '实际交付资源与挂牌规格不一致', idempotencyKey: 'refund-request-000001',
    }, context);
    const replay = await service.request(buyer, {
      orderId, amountCents: 5000, reason: '实际交付资源与挂牌规格不一致', idempotencyKey: 'refund-request-000001',
    }, context);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.refund.id).toBe(first.refund.id);
    await expect(service.request(buyer, {
      orderId, amountCents: 6000, reason: '实际交付资源与挂牌规格不一致', idempotencyKey: 'refund-request-000001',
    }, context)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(await service.list(other)).toEqual([]);
    await expect(service.get(other, first.refund.id)).rejects.toMatchObject({ code: 'REFUND_NOT_FOUND' });
    await service.cancel(buyer, first.refund.id, context);

    await expect(service.request(buyer, {
      orderId, amountCents: 20000, reason: '申请金额超过实际支付金额用于验证', idempotencyKey: 'refund-request-000002',
    }, context)).rejects.toMatchObject({ code: 'REFUND_AMOUNT_INVALID' });
    const second = await service.request(buyer, {
      orderId, amountCents: 5000, reason: '服务中断时间超过承诺可用性标准', idempotencyKey: 'refund-request-000003',
    }, context);
    await expect(service.review(buyer, { refundId: second.refund.id, approved: true }, context))
      .rejects.toMatchObject({ code: 'OPERATOR_REQUIRED' });
    const queue = await service.reviewQueue(operator, 'requested');
    expect(queue.map((item) => item.id)).toEqual([second.refund.id]);
    const approved = await service.review(operator, { refundId: second.refund.id, approved: true }, context);
    expect(approved.status).toBe('provider_pending');
    expect((await database.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0]?.status).toBe('refund_pending');
    expect((await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbox_events WHERE topic = 'refund.execute' AND aggregate_id = $1`, [second.refund.id])).rows[0]?.count).toBe('1');
    const executions = new PostgresRefundExecutionStore(database);
    expect(await executions.complete({
      refundId: second.refund.id, providerRefundId: 'WX-REFUND-PARTIAL', eventId: 'EV-REFUND-PARTIAL',
      payloadDigest: 'digest-partial', now: new Date(),
    })).toBe(true);
    expect((await database.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0]?.status).toBe('paid');
    expect((await database.query<{ status: string }>('SELECT status FROM payment_intents WHERE id = $1', [paymentIntentId])).rows[0]?.status).toBe('succeeded');

    const final = await service.request(buyer, {
      orderId, amountCents: 7800, reason: '剩余服务未继续交付申请退回全部余额', idempotencyKey: 'refund-request-000004',
    }, context);
    await service.review(operator, { refundId: final.refund.id, approved: true }, context);
    await executions.complete({
      refundId: final.refund.id, providerRefundId: 'WX-REFUND-FINAL', eventId: 'EV-REFUND-FINAL',
      payloadDigest: 'digest-final', now: new Date(),
    });
    expect((await database.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0]?.status).toBe('refunded');
    expect((await database.query<{ status: string }>('SELECT status FROM payment_intents WHERE id = $1', [paymentIntentId])).rows[0]?.status).toBe('refunded');
    expect((await database.query<{ capacity_reserved: string }>('SELECT capacity_reserved::text FROM market_listings WHERE id = $1', [listingId])).rows[0]?.capacity_reserved).toBe('0.000000');
    expect((await database.query<{ status: string }>('SELECT status FROM capacity_reservations WHERE order_id = $1', [orderId])).rows[0]?.status).toBe('released');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM refund_events WHERE refund_id IN ($1, $2)', [second.refund.id, final.refund.id])).rows[0]?.count).toBe('2');
    expect(audits).toEqual([
      'REFUND_REQUESTED', 'REFUND_CANCELLED', 'REFUND_REQUESTED', 'REFUND_APPROVED',
      'REFUND_REQUESTED', 'REFUND_APPROVED',
    ]);
    await database.close();
  });
});
