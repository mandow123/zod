import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AccountStore } from '../src/account/store.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { DisputeService } from '../src/disputes/service.js';
import { PostgresDisputeStore } from '../src/disputes/store.js';
import type { PrivateObjectStore, StoredObjectMetadata } from '../src/storage/object-store.js';
import { EvidenceScanStore, EvidenceScanWorker } from '../src/evidence/worker.js';
import type { MalwareScanner } from '../src/evidence/scanner.js';

function result<T>(value: Results<T>) {
  return { ...value, rowCount: value.rows.length || value.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}
function adapter(pglite: PGlite) {
  return {
    health: async () => true,
    query: async (text: string, values?: unknown[]) => result(await pglite.query(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => work({
      query: async (text: string, values?: unknown[]) => result(await transaction.query(text, values)),
    } as unknown as PoolClient)), close: () => pglite.close(),
  } as unknown as Database;
}

class FakeObjects implements PrivateObjectStore {
  uploadedKeys: string[] = [];
  deletedKeys: string[] = [];
  bytes = new Uint8Array();
  metadata: StoredObjectMetadata | null = null;
  async createUploadGrant(input: { objectKey: string; expiresAt: Date }) {
    this.uploadedKeys.push(input.objectKey);
    return { url: `https://storage.test/upload/${input.objectKey}`, method: 'PUT' as const, expiresAt: input.expiresAt, headers: { 'x-test': 'signed' } };
  }
  async head() {
    if (!this.metadata) throw new Error('missing object');
    return this.metadata;
  }
  async createDownloadUrl(objectKey: string) { return `https://storage.test/download/${objectKey}`; }
  async readBytes() { return this.bytes; }
  async delete(objectKey: string) { this.deletedKeys.push(objectKey); }
}

describe('dispute and quarantined evidence ledger', () => {
  it('isolates participants, validates uploads, waits for scanning, and creates a reviewed refund', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of [
      '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
      '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
      '0007_refund_execution.sql', '0008_dispute_evidence.sql',
    ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    const database = adapter(pglite);
    const buyerId = randomUUID(); const supplierUserId = randomUUID(); const outsiderId = randomUUID(); const operatorId = randomUUID();
    const supplierId = randomUUID(); const resourceId = randomUUID(); const listingId = randomUUID(); const orderId = randomUUID(); const paymentId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
       ($1, 'buyer', '买家', 'member'), ($2, 'supplier', '供应商', 'supplier'),
       ($3, 'outsider', '无关用户', 'member'), ($4, 'operator', '运营', 'operator')`,
      [buyerId, supplierUserId, outsiderId, operatorId],
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
       VALUES ($1, 'CP-DISPUTE-01', $2, $3, $4, 'paid', 1, 'GPU时', 12800, 12800, 12800, '{}', now() + interval '1 day', now())`,
      [orderId, buyerId, supplierId, listingId],
    );
    await database.query(
      `INSERT INTO payment_intents(id, order_id, provider, provider_reference, provider_payment_id, channel, status,
         amount_cents, expires_at, succeeded_at)
       VALUES ($1, $2, 'wechat', 'KP-DISPUTE-01', 'WX-DISPUTE-01', 'app', 'succeeded', 12800, now() + interval '1 day', now())`,
      [paymentId, orderId],
    );

    const objects = new FakeObjects();
    const audits: string[] = [];
    const accounts = { recordAudit: async (input: { action: string }) => { audits.push(input.action); } } as unknown as AccountStore;
    const config = loadConfig({
      NODE_ENV: 'test', ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32),
      AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'e'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
    });
    const service = new DisputeService(new PostgresDisputeStore(database), accounts, objects, config, () => new Date('2026-08-11T15:00:00.000Z'));
    const buyer: AccountPrincipal = { userId: buyerId, sessionId: randomUUID(), role: 'member' };
    const supplier: AccountPrincipal = { userId: supplierUserId, sessionId: randomUUID(), role: 'supplier' };
    const outsider: AccountPrincipal = { userId: outsiderId, sessionId: randomUUID(), role: 'member' };
    const operator: AccountPrincipal = { userId: operatorId, sessionId: randomUUID(), role: 'operator' };
    const context = { requestId: 'dispute-test', ip: '203.0.113.40' };

    const opened = await service.open(buyer, {
      orderId, category: 'spec_mismatch', reason: '实际交付资源与挂牌规格明显不一致', idempotencyKey: 'dispute-open-000001',
    }, context);
    const dispute = opened.dispute;
    const replay = await service.open(buyer, {
      orderId, category: 'spec_mismatch', reason: '实际交付资源与挂牌规格明显不一致', idempotencyKey: 'dispute-open-000001',
    }, context);
    expect(replay).toMatchObject({ replayed: true, dispute: { id: dispute.id } });
    expect(dispute.openedByCurrentUser).toBe(true);
    expect((await database.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0]?.status).toBe('disputed');
    await expect(service.open(supplier, {
      orderId, category: 'other', reason: '尝试重复开启同一订单争议流程', idempotencyKey: 'dispute-open-000002',
    }, context))
      .rejects.toMatchObject({ code: 'DISPUTE_ALREADY_ACTIVE' });
    expect(await service.list(outsider)).toEqual([]);
    await expect(service.detail(outsider, dispute.id)).rejects.toMatchObject({ code: 'DISPUTE_NOT_FOUND' });
    await expect(service.detail(supplier, dispute.id)).resolves.toMatchObject({ id: dispute.id });

    const abandoned = await service.createEvidenceUpload(buyer, {
      disputeId: dispute.id, mimeType: 'text/plain', sizeBytes: 12, sha256Digest: `sha256:${'f'.repeat(64)}`,
    }, context);
    await expect(service.discardEvidence(outsider, dispute.id, abandoned.evidence.id, context))
      .rejects.toMatchObject({ code: 'EVIDENCE_NOT_DISCARDABLE' });
    await expect(service.discardEvidence(buyer, dispute.id, abandoned.evidence.id, context))
      .resolves.toMatchObject({ id: abandoned.evidence.id, status: 'deleted' });
    expect(objects.deletedKeys.some((key) => key.includes(abandoned.evidence.id))).toBe(true);
    await expect(service.detail(buyer, dispute.id)).resolves.not.toMatchObject({
      evidence: expect.arrayContaining([expect.objectContaining({ id: abandoned.evidence.id })]),
    });

    objects.bytes = Buffer.from('%PDF-1.7\nclean evidence file');
    const digestHex = createHash('sha256').update(objects.bytes).digest('hex');
    const upload = await service.createEvidenceUpload(buyer, {
      disputeId: dispute.id, mimeType: 'application/pdf', sizeBytes: objects.bytes.byteLength, sha256Digest: `sha256:${digestHex}`,
    }, context);
    expect(upload.upload.url).toContain('/quarantine/disputes/');
    expect(upload.evidence.fileName).toMatch(/^证据-[a-f0-9]{8}\.pdf$/u);
    objects.metadata = {
      sizeBytes: objects.bytes.byteLength, mimeType: 'application/pdf', metadataSha256: digestHex,
      sha256Base64: Buffer.from(digestHex, 'hex').toString('base64'),
    };
    const pending = await service.completeEvidenceUpload(buyer, dispute.id, upload.evidence.id, context);
    expect(pending.status).toBe('pending_scan');
    await expect(service.evidenceDownload(buyer, dispute.id, upload.evidence.id)).rejects.toMatchObject({ code: 'EVIDENCE_NOT_VERIFIED' });
    await expect(service.resolve(operator, {
      disputeId: dispute.id, outcome: 'buyer', resolution: '根据双方材料支持买家部分退款请求', refundAmountCents: 5000,
    }, context)).rejects.toMatchObject({ code: 'DISPUTE_EVIDENCE_PENDING' });

    const cleanScanner: MalwareScanner = { scan: async () => ({ clean: true, signature: null }) };
    const workerLogs: unknown[] = [];
    const logger = { info: (fields: unknown) => { workerLogs.push(fields); }, error: (fields: unknown) => { workerLogs.push(fields); } };
    const scanWorker = new EvidenceScanWorker(
      new EvidenceScanStore(database), objects, cleanScanner, logger, 60_000, () => new Date('2099-08-12T15:00:00.000Z'),
    );
    await scanWorker.tick();
    expect(workerLogs).toEqual([]);
    expect((await database.query<{ status: string }>('SELECT status FROM dispute_evidence WHERE id = $1', [upload.evidence.id])).rows[0]?.status).toBe('verified');
    await expect(service.evidenceDownload(supplier, dispute.id, upload.evidence.id)).resolves.toMatchObject({ url: expect.stringContaining('/download/quarantine/') });

    objects.bytes = Buffer.from('%PDF-1.7\nmalicious test evidence');
    const infectedDigest = createHash('sha256').update(objects.bytes).digest('hex');
    const infectedUpload = await service.createEvidenceUpload(supplier, {
      disputeId: dispute.id, mimeType: 'application/pdf', sizeBytes: objects.bytes.byteLength,
      sha256Digest: `sha256:${infectedDigest}`,
    }, context);
    objects.metadata = {
      sizeBytes: objects.bytes.byteLength, mimeType: 'application/pdf', metadataSha256: infectedDigest,
      sha256Base64: Buffer.from(infectedDigest, 'hex').toString('base64'),
    };
    await service.completeEvidenceUpload(supplier, dispute.id, infectedUpload.evidence.id, context);
    const infectedScanner: MalwareScanner = { scan: async () => ({ clean: false, signature: 'Eicar-Test-Signature' }) };
    const infectedWorker = new EvidenceScanWorker(
      new EvidenceScanStore(database), objects, infectedScanner, logger, 60_000, () => new Date('2099-08-12T16:00:00.000Z'),
    );
    await infectedWorker.tick();
    expect((await database.query<{ status: string }>('SELECT status FROM dispute_evidence WHERE id = $1', [infectedUpload.evidence.id])).rows[0]?.status).toBe('rejected');
    expect(objects.deletedKeys).toContain(objects.uploadedKeys.at(-1));
    await expect(service.evidenceDownload(supplier, dispute.id, infectedUpload.evidence.id)).rejects.toMatchObject({ code: 'EVIDENCE_NOT_VERIFIED' });
    await expect(service.resolve(operator, {
      disputeId: dispute.id, outcome: 'buyer', resolution: '根据双方材料支持买家部分退款请求', refundAmountCents: 5000,
    }, context)).rejects.toMatchObject({ code: 'DISPUTE_EVIDENCE_WINDOW_OPEN' });
    await service.completeEvidenceSubmission(buyer, dispute.id, context);
    await service.completeEvidenceSubmission(supplier, dispute.id, context);
    await expect(service.createEvidenceUpload(buyer, {
      disputeId: dispute.id, mimeType: 'application/pdf', sizeBytes: objects.bytes.byteLength,
      sha256Digest: `sha256:${infectedDigest}`,
    }, context)).rejects.toMatchObject({ code: 'EVIDENCE_UPLOAD_NOT_ALLOWED' });
    const resolved = await service.resolve(operator, {
      disputeId: dispute.id, outcome: 'buyer', resolution: '根据双方材料支持买家部分退款请求', refundAmountCents: 5000,
    }, context);
    expect(resolved.status).toBe('resolved_buyer');
    expect(resolved.resolutionRefundId).toBeTypeOf('string');
    expect((await database.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0]?.status).toBe('refund_pending');
    expect((await database.query<{ status: string }>('SELECT status FROM refunds WHERE id = $1', [resolved.resolutionRefundId])).rows[0]?.status).toBe('provider_pending');
    expect((await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbox_events WHERE topic = 'refund.execute' AND aggregate_id = $1`, [resolved.resolutionRefundId])).rows[0]?.count).toBe('1');
    expect(audits).toEqual([
      'DISPUTE_OPENED', 'EVIDENCE_UPLOAD_CREATED', 'EVIDENCE_DISCARDED', 'EVIDENCE_UPLOAD_CREATED', 'EVIDENCE_UPLOADED',
      'EVIDENCE_UPLOAD_CREATED', 'EVIDENCE_UPLOADED', 'EVIDENCE_SUBMISSION_COMPLETED',
      'EVIDENCE_SUBMISSION_COMPLETED', 'DISPUTE_RESOLVED',
    ]);
    await database.close();
  });
});
