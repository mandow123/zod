import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AccountStore } from '../src/account/store.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import type { MalwareScanner } from '../src/evidence/scanner.js';
import { InvoiceService } from '../src/invoices/service.js';
import { PostgresInvoiceStore } from '../src/invoices/store.js';
import { PostgresRefundExecutionStore } from '../src/refunds/execution-store.js';
import type { PrivateObjectStore, StoredObjectMetadata } from '../src/storage/object-store.js';

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

class FakeObjects implements PrivateObjectStore {
  bytes = new Uint8Array();
  metadata: StoredObjectMetadata | null = null;
  latestKey = '';
  deleted: string[] = [];

  async createUploadGrant(input: { objectKey: string; expiresAt: Date }) {
    this.latestKey = input.objectKey;
    return { url: `https://storage.test/upload/${input.objectKey}`, method: 'PUT' as const, expiresAt: input.expiresAt, headers: { 'x-test': 'signed' } };
  }
  async head() {
    if (!this.metadata) throw new Error('missing object');
    return this.metadata;
  }
  async createDownloadUrl(objectKey: string) { return `https://storage.test/download/${objectKey}`; }
  async readBytes() { return this.bytes; }
  async delete(objectKey: string) { this.deleted.push(objectKey); }

  setPdf(content: string) {
    this.bytes = Buffer.from(`%PDF-1.7\n${content}\n%%EOF`);
    const digest = createHash('sha256').update(this.bytes).digest('hex');
    this.metadata = {
      sizeBytes: this.bytes.byteLength, mimeType: 'application/pdf', metadataSha256: digest,
      sha256Base64: Buffer.from(digest, 'hex').toString('base64'),
    };
    return `sha256:${digest}`;
  }
}

describe('invoice privacy, document issuance, and refund red-letter workflow', () => {
  it('keeps PII encrypted and only exposes scanned private PDFs through valid invoice states', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of [
      '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
      '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
      '0007_refund_execution.sql', '0008_dispute_evidence.sql', '0009_invoice_workflow.sql',
    ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    const database = adapter(pglite);
    const buyerId = randomUUID(); const outsiderId = randomUUID(); const operatorId = randomUUID();
    const supplierUserId = randomUUID(); const supplierId = randomUUID(); const resourceId = randomUUID();
    const listingId = randomUUID(); const orderId = randomUUID(); const paymentId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
       ($1, 'buyer', '买家', 'member'), ($2, 'outsider', '无关用户', 'member'),
       ($3, 'operator', '运营', 'operator'), ($4, 'supplier', '供应商', 'supplier')`,
      [buyerId, outsiderId, operatorId, supplierUserId],
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
       VALUES ($1, 'CP-INVOICE-01', $2, $3, $4, 'paid', 1, 'GPU时', 12800, 12800, 12800, '{}', now() + interval '1 day', now())`,
      [orderId, buyerId, supplierId, listingId],
    );
    await database.query(
      `INSERT INTO payment_intents(id, order_id, provider, provider_reference, provider_payment_id, channel, status,
         amount_cents, expires_at, succeeded_at)
       VALUES ($1, $2, 'wechat', 'KP-INVOICE-01', 'WX-INVOICE-01', 'app', 'succeeded', 12800, now() + interval '1 day', now())`,
      [paymentId, orderId],
    );

    const objects = new FakeObjects();
    const audits: string[] = [];
    const accountStore = { recordAudit: async (input: { action: string }) => { audits.push(input.action); } } as unknown as AccountStore;
    const config = loadConfig({
      NODE_ENV: 'test', ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32),
      AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'e'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
    });
    const cleanScanner: MalwareScanner = { scan: async () => ({ clean: true, signature: null }) };
    const store = new PostgresInvoiceStore(database);
    const service = new InvoiceService(store, accountStore, objects, cleanScanner, config, () => new Date('2026-08-11T16:00:00.000Z'));
    const buyer: AccountPrincipal = { userId: buyerId, sessionId: randomUUID(), role: 'member' };
    const outsider: AccountPrincipal = { userId: outsiderId, sessionId: randomUUID(), role: 'member' };
    const operator: AccountPrincipal = { userId: operatorId, sessionId: randomUUID(), role: 'operator' };
    const context = { requestId: 'invoice-test', ip: '203.0.113.41' };

    const requested = await service.request(buyer, {
      orderId, invoiceType: 'business', title: '凯云采购有限公司', taxId: '91310101MA1ABCDEF0',
      email: 'finance@example.com', idempotencyKey: 'invoice-request-000001',
    }, context);
    const replayed = await service.request(buyer, {
      orderId, invoiceType: 'business', title: '凯云采购有限公司', taxId: '91310101MA1ABCDEF0',
      email: 'finance@example.com', idempotencyKey: 'invoice-request-000001',
    }, context);
    expect(replayed).toMatchObject({ replayed: true, invoice: { id: requested.invoice.id } });
    const persisted = (await database.query<{ invoice_title_ciphertext: string; tax_id_ciphertext: string; email_ciphertext: string }>(
      `SELECT invoice_title_ciphertext, tax_id_ciphertext, email_ciphertext FROM invoices WHERE id = $1`, [requested.invoice.id],
    )).rows[0]!;
    expect(JSON.stringify(persisted)).not.toContain('凯云采购有限公司');
    expect(JSON.stringify(persisted)).not.toContain('91310101MA1ABCDEF0');
    expect(JSON.stringify(persisted)).not.toContain('finance@example.com');
    expect(await service.list(outsider)).toEqual([]);
    await expect(service.detail(outsider, requested.invoice.id)).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    await expect(service.start(operator, requested.invoice.id, context)).rejects.toMatchObject({ code: 'INVOICE_ORDER_INCOMPLETE' });

    await database.query(`UPDATE orders SET status = 'accepted', accepted_at = now() WHERE id = $1`, [orderId]);
    const processing = await service.start(operator, requested.invoice.id, context);
    expect(processing).toMatchObject({ status: 'processing', amountCents: 12800, title: null });
    await expect(service.issuanceData(buyer, requested.invoice.id, context)).rejects.toMatchObject({ code: 'OPERATOR_REQUIRED' });
    await expect(service.issuanceData(operator, requested.invoice.id, context)).resolves.toMatchObject({
      title: '凯云采购有限公司', taxId: '91310101MA1ABCDEF0', email: 'finance@example.com', amountCents: 12800,
    });

    const blueDigest = objects.setPdf('clean blue invoice');
    const blueUpload = await service.createDocumentUpload(operator, {
      invoiceId: requested.invoice.id, kind: 'blue', sizeBytes: objects.bytes.byteLength, sha256Digest: blueDigest,
    }, context);
    const issued = await service.completeDocument(operator, {
      invoiceId: requested.invoice.id, uploadId: blueUpload.uploadId, invoiceCode: 'BLUE2026', invoiceNumber: '000001',
    }, context);
    expect(issued).toMatchObject({ status: 'issued', blueDocumentAvailable: true });
    await expect(service.download(buyer, requested.invoice.id, 'blue')).resolves.toMatchObject({ url: expect.stringContaining('/download/quarantine/invoices/') });
    await expect(service.download(outsider, requested.invoice.id, 'blue')).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });

    const refundId = randomUUID();
    await database.query(`UPDATE orders SET status = 'refund_pending' WHERE id = $1`, [orderId]);
    await database.query(
      `INSERT INTO refunds(id, order_id, requested_by, payment_intent_id, amount_cents, reason, status,
         idempotency_key, payload_digest, order_status_before_refund)
       VALUES ($1, $2, $3, $4, 5000, '部分资源未按约定交付', 'provider_pending', 'invoice-refund-0001', 'digest', 'accepted')`,
      [refundId, orderId, buyerId, paymentId],
    );
    const refunds = new PostgresRefundExecutionStore(database);
    expect(await refunds.complete({
      refundId, providerRefundId: 'WX-REFUND-01', eventId: 'WX-REFUND-EVENT-01', payloadDigest: 'provider-digest',
      now: new Date('2026-08-11T17:00:00.000Z'),
    })).toBe(true);
    expect((await service.detail(buyer, requested.invoice.id)).status).toBe('red_pending');
    expect((await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events WHERE topic = 'invoice.red_required' AND aggregate_id = $1`, [requested.invoice.id],
    )).rows[0]?.count).toBe('1');

    const redDigest = objects.setPdf('clean red-letter invoice');
    const redUpload = await service.createDocumentUpload(operator, {
      invoiceId: requested.invoice.id, kind: 'red', sizeBytes: objects.bytes.byteLength, sha256Digest: redDigest,
    }, context);
    const redIssued = await service.completeDocument(operator, {
      invoiceId: requested.invoice.id, uploadId: redUpload.uploadId, invoiceCode: 'RED2026', invoiceNumber: '000001-R',
    }, context);
    expect(redIssued).toMatchObject({ status: 'red_issued', redDocumentAvailable: true });
    await expect(service.download(buyer, requested.invoice.id, 'red')).resolves.toMatchObject({ url: expect.stringContaining('/download/quarantine/invoices/') });

    const replacement = await service.request(buyer, {
      orderId, invoiceType: 'personal', title: '个人', email: 'buyer@example.com', idempotencyKey: 'invoice-request-000002',
    }, context);
    expect(replacement.invoice).toMatchObject({ amountCents: 7800, status: 'requested' });
    await service.start(operator, replacement.invoice.id, context);
    const infectedDigest = objects.setPdf('infected invoice');
    const infectedUpload = await service.createDocumentUpload(operator, {
      invoiceId: replacement.invoice.id, kind: 'blue', sizeBytes: objects.bytes.byteLength, sha256Digest: infectedDigest,
    }, context);
    const infectedService = new InvoiceService(
      store, accountStore, objects, { scan: async () => ({ clean: false, signature: 'Eicar-Test-Signature' }) }, config,
      () => new Date('2026-08-11T18:00:00.000Z'),
    );
    await expect(infectedService.completeDocument(operator, {
      invoiceId: replacement.invoice.id, uploadId: infectedUpload.uploadId, invoiceCode: 'BLUE2026', invoiceNumber: '000002',
    }, context)).rejects.toMatchObject({ code: 'INVOICE_DOCUMENT_REJECTED' });
    expect((await service.detail(buyer, replacement.invoice.id)).status).toBe('failed');
    expect(objects.deleted).toContain(objects.latestKey);
    expect(audits).toContain('INVOICE_PII_ACCESSED');
    expect(audits).toContain('INVOICE_RED_ISSUED');
    await database.close();
  });
});
