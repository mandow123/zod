import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { OperationsService } from '../src/operations/service.js';
import { PostgresOperationsStore } from '../src/operations/store.js';

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

describe('protected operational monitoring', () => {
  it('counts stuck workflows without exposing customer records and exports authenticated metrics', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of [
      '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
      '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
      '0007_refund_execution.sql', '0008_dispute_evidence.sql', '0009_invoice_workflow.sql',
      '0010_payment_recovery.sql',
      '0011_backup_audit.sql',
    ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    const database = adapter(pglite);
    const capturedAt = new Date('2026-08-12T01:00:00.000Z');
    const old = new Date(capturedAt.getTime() - 25 * 60 * 60_000);
    const buyerId = randomUUID(); const supplierUserId = randomUUID(); const supplierId = randomUUID();
    const resourceId = randomUUID(); const listingId = randomUUID(); const orderId = randomUUID();
    const paymentId = randomUUID(); const refundId = randomUUID(); const disputeId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name) VALUES ($1, 'buyer-secret', '买家'), ($2, 'supplier-secret', '供应商')`,
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
       VALUES ($1, $2, $3, 'H100', '上海', 10, 1, 'GPU时', 12800, 1, 'active', $4, $5, '{}')`,
      [listingId, resourceId, supplierId, new Date(old.getTime() - 86_400_000), new Date(capturedAt.getTime() + 86_400_000)],
    );
    await database.query(
      `INSERT INTO orders(id, order_number, buyer_id, supplier_id, listing_id, status, quantity, capacity_unit,
         unit_price_cents, subtotal_cents, total_cents, listing_snapshot, reservation_expires_at, updated_at)
       VALUES ($1, 'CP-OPS-01', $2, $3, $4, 'acceptance_pending', 1, 'GPU时', 12800, 12800, 12800, '{}', $5, $6)`,
      [orderId, buyerId, supplierId, listingId, old, old],
    );
    await database.query(
      `INSERT INTO capacity_reservations(id, order_id, listing_id, buyer_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, $4, 1, 'active', $5)`, [randomUUID(), orderId, listingId, buyerId, old],
    );
    await database.query(
      `INSERT INTO payment_intents(id, order_id, provider, provider_reference, channel, status, amount_cents,
         expires_at, reconciliation_dead_lettered_at)
       VALUES ($1, $2, 'wechat', 'KP-OPS-01', 'app', 'pending', 12800, $3, $4)`,
      [paymentId, orderId, old, new Date(capturedAt.getTime() - 60_000)],
    );
    await database.query(
      `INSERT INTO refunds(id, order_id, requested_by, payment_intent_id, amount_cents, reason, status, updated_at)
       VALUES ($1, $2, $3, $4, 1000, '服务异常申请部分退款', 'provider_pending', $5)`,
      [refundId, orderId, buyerId, paymentId, old],
    );
    await database.query(
      `INSERT INTO disputes(id, order_id, opened_by, category, reason, status, evidence_deadline)
       VALUES ($1, $2, $3, 'service_unavailable', '服务持续不可用需要审核处理', 'evidence_pending', $4)`,
      [disputeId, orderId, buyerId, old],
    );
    await database.query(
      `INSERT INTO dispute_evidence(id, dispute_id, submitted_by, object_key, file_name, mime_type, size_bytes,
         sha256_digest, status, uploaded_at, retention_until)
       VALUES ($1, $2, $3, 'quarantine/ops/evidence.pdf', 'evidence.pdf', 'application/pdf', 100,
         $4, 'scan_failed', $5, $6)`,
      [randomUUID(), disputeId, buyerId, `sha256:${'a'.repeat(64)}`, old, new Date(capturedAt.getTime() + 86_400_000)],
    );
    await database.query(
      `INSERT INTO invoices(id, order_id, user_id, invoice_type, invoice_title_ciphertext, email_ciphertext,
         amount_cents, status, processing_started_at)
       VALUES ($1, $2, $3, 'personal', 'encrypted-title', 'encrypted-email', 11800, 'processing', $4)`,
      [randomUUID(), orderId, buyerId, old],
    );
    await database.query(
      `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload, available_at, created_at)
       VALUES ($1, 'test.pending', 'ORDER', $2, '{}', $3, $3),
              ($4, 'test.dead', 'ORDER', $5, '{}', $6, $6)`,
      [randomUUID(), orderId, old, randomUUID(), orderId, old],
    );
    await database.query(`UPDATE outbox_events SET dead_lettered_at = $2 WHERE topic = 'test.dead' AND aggregate_id = $1`, [orderId, old]);
    await database.query(
      `INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id, payload_digest, created_at)
       VALUES ($1, $2, 'user', 'OPS_TEST', 'ORDER', $3, 'digest', $4)`,
      [randomUUID(), buyerId, orderId, new Date(capturedAt.getTime() - 60_000)],
    );

    const token = 'metrics-token-'.padEnd(48, 'x');
    const config = loadConfig({ NODE_ENV: 'test', METRICS_BEARER_TOKEN: token });
    const service = new OperationsService(new PostgresOperationsStore(database), config, () => capturedAt);
    const operator: AccountPrincipal = { userId: randomUUID(), sessionId: randomUUID(), role: 'operator' };
    const summary = await service.summary(operator);
    expect(summary).toMatchObject({
      status: 'critical', counts: {
        paymentPending: 1, paymentOverdue: 1, paymentDeadLetters: 1,
        refundProviderPendingStale: 1, outboxPending: 1, outboxDeadLetters: 1,
        evidenceScanFailed: 1, disputesReadyForReview: 1, deliveryStale: 1,
        reservationOverdue: 1, invoiceProcessingStale: 1, auditEvents24h: 1,
      },
    });
    await expect(service.summary({ ...operator, role: 'member' })).rejects.toMatchObject({ code: 'OPERATOR_REQUIRED' });

    const app = await buildApp({ config, database, operationsService: service, logger: false });
    const denied = await app.inject({ method: 'GET', url: '/internal/metrics' });
    expect(denied.statusCode).toBe(401);
    const response = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('cloudpay_operational_items{kind="payment_dead_letters"} 1');
    expect(response.body).toContain('cloudpay_operational_health 0');
    expect(response.body).not.toContain('buyer-secret');
    await app.close();
    await database.close();
  });
});
