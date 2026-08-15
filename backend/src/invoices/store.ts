import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { InvoiceDocumentUpload, InvoiceRecord, InvoiceStatus, InvoiceType } from './types.js';

type InvoiceRow = QueryResultRow & {
  id: string; order_id: string; order_number: string; user_id: string; invoice_type: InvoiceType;
  invoice_title_ciphertext: string; tax_id_ciphertext: string | null; email_ciphertext: string;
  amount_cents: string; currency: 'CNY'; status: InvoiceStatus; failure_reason: string | null;
  invoice_code: string | null; invoice_number: string | null; document_object_key: string | null;
  document_sha256_digest: string | null; document_size_bytes: string | null;
  red_invoice_code: string | null; red_invoice_number: string | null; red_document_object_key: string | null;
  red_document_sha256_digest: string | null; red_document_size_bytes: string | null; red_issued_at: Date | null;
  issued_at: Date | null; created_at: Date; updated_at: Date;
};

type UploadRow = QueryResultRow & {
  id: string; invoice_id: string; kind: 'blue' | 'red'; object_key: string; mime_type: 'application/pdf';
  size_bytes: string; sha256_digest: string; status: InvoiceDocumentUpload['status']; expires_at: Date;
};

const invoiceColumns = `i.id, i.order_id, o.order_number, i.user_id, i.invoice_type,
  i.invoice_title_ciphertext, i.tax_id_ciphertext, i.email_ciphertext, i.amount_cents::text,
  o.currency, i.status, i.failure_reason, i.invoice_code, i.invoice_number, i.document_object_key,
  i.document_sha256_digest, i.document_size_bytes::text, i.red_invoice_code, i.red_invoice_number,
  i.red_document_object_key, i.red_document_sha256_digest, i.red_document_size_bytes::text,
  i.red_issued_at, i.issued_at, i.created_at, i.updated_at`;

function mapInvoice(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id, orderId: row.order_id, orderNumber: row.order_number, userId: row.user_id,
    invoiceType: row.invoice_type, titleCiphertext: row.invoice_title_ciphertext,
    taxIdCiphertext: row.tax_id_ciphertext, emailCiphertext: row.email_ciphertext,
    amountCents: Number(row.amount_cents), currency: row.currency, status: row.status,
    failureReason: row.failure_reason, invoiceCode: row.invoice_code, invoiceNumber: row.invoice_number,
    documentObjectKey: row.document_object_key, documentSha256Digest: row.document_sha256_digest,
    documentSizeBytes: row.document_size_bytes === null ? null : Number(row.document_size_bytes),
    redInvoiceCode: row.red_invoice_code, redInvoiceNumber: row.red_invoice_number,
    redDocumentObjectKey: row.red_document_object_key,
    redDocumentSha256Digest: row.red_document_sha256_digest,
    redDocumentSizeBytes: row.red_document_size_bytes === null ? null : Number(row.red_document_size_bytes),
    redIssuedAt: row.red_issued_at ? new Date(row.red_issued_at) : null,
    issuedAt: row.issued_at ? new Date(row.issued_at) : null,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

function mapUpload(row: UploadRow): InvoiceDocumentUpload {
  return {
    id: row.id, invoiceId: row.invoice_id, kind: row.kind, objectKey: row.object_key,
    mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), sha256Digest: row.sha256_digest,
    status: row.status, expiresAt: new Date(row.expires_at),
  };
}

export type RequestInvoiceResult =
  | Readonly<{ status: 'created' | 'replayed'; invoice: InvoiceRecord }>
  | Readonly<{ status: 'idempotency_conflict' }>
  | Readonly<{ status: 'order_not_found' }>
  | Readonly<{ status: 'order_not_invoiceable' }>
  | Readonly<{ status: 'invoice_exists' }>;

export type StartInvoiceResult =
  | Readonly<{ status: 'started'; invoice: InvoiceRecord }>
  | Readonly<{ status: 'invalid_state' }>
  | Readonly<{ status: 'order_incomplete' }>
  | Readonly<{ status: 'transaction_unsettled' }>;

export interface InvoiceStore {
  request(input: Readonly<{
    id: string; userId: string; orderId: string; invoiceType: InvoiceType; titleCiphertext: string;
    taxIdCiphertext: string | null; emailCiphertext: string; emailLookupHash: string;
    idempotencyKey: string; payloadDigest: string;
  }>): Promise<RequestInvoiceResult>;
  list(userId: string, operator: boolean, status?: InvoiceStatus): Promise<InvoiceRecord[]>;
  get(userId: string, invoiceId: string, operator: boolean): Promise<InvoiceRecord | null>;
  cancel(userId: string, invoiceId: string): Promise<InvoiceRecord | null>;
  start(invoiceId: string, operatorId: string): Promise<StartInvoiceResult>;
  markFailed(invoiceId: string, operatorId: string, reason: string): Promise<InvoiceRecord | null>;
  createDocumentUpload(input: Readonly<{
    id: string; invoiceId: string; operatorId: string; kind: 'blue' | 'red'; objectKey: string;
    sizeBytes: number; sha256Digest: string; expiresAt: Date;
  }>): Promise<InvoiceDocumentUpload | null>;
  getDocumentUpload(invoiceId: string, uploadId: string): Promise<InvoiceDocumentUpload | null>;
  rejectDocumentUpload(invoiceId: string, uploadId: string): Promise<boolean>;
  issue(input: Readonly<{
    invoiceId: string; uploadId: string; operatorId: string; invoiceCode: string; invoiceNumber: string;
    objectKey: string; documentSha256Digest: string; documentSizeBytes: number; issuedAt: Date;
  }>): Promise<InvoiceRecord | null>;
  issueRed(input: Readonly<{
    invoiceId: string; uploadId: string; operatorId: string; invoiceCode: string; invoiceNumber: string;
    objectKey: string; documentSha256Digest: string; documentSizeBytes: number; issuedAt: Date;
  }>): Promise<InvoiceRecord | null>;
}

export class PostgresInvoiceStore implements InvoiceStore {
  constructor(private readonly database: Database) {}

  async request(input: {
    id: string; userId: string; orderId: string; invoiceType: InvoiceType; titleCiphertext: string;
    taxIdCiphertext: string | null; emailCiphertext: string; emailLookupHash: string;
    idempotencyKey: string; payloadDigest: string;
  }): Promise<RequestInvoiceResult> {
    try {
      return await this.database.transaction(async (client) => {
      const previous = await client.query<InvoiceRow & { payload_digest: string | null }>(
        `SELECT ${invoiceColumns}, i.payload_digest FROM invoices i JOIN orders o ON o.id = i.order_id
         WHERE i.user_id = $1 AND i.idempotency_key = $2 FOR UPDATE OF i`, [input.userId, input.idempotencyKey],
      );
      if (previous.rows[0]) return previous.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', invoice: mapInvoice(previous.rows[0]) }
        : { status: 'idempotency_conflict' };
      const orderResult = await client.query<{ id: string; order_number: string; status: string; total_cents: string; currency: 'CNY' }>(
        `SELECT id, order_number, status, total_cents::text, currency FROM orders WHERE id = $1 AND buyer_id = $2 FOR UPDATE`,
        [input.orderId, input.userId],
      );
      const order = orderResult.rows[0];
      if (!order) return { status: 'order_not_found' };
      if (!['paid', 'delivery_pending', 'delivering', 'acceptance_pending', 'accepted', 'closed'].includes(order.status)) {
        return { status: 'order_not_invoiceable' };
      }
      const existing = await client.query(
        `SELECT id FROM invoices WHERE order_id = $1 AND user_id = $2
         AND status IN ('requested', 'processing', 'issued', 'red_pending')`, [order.id, input.userId],
      );
      if (existing.rowCount) return { status: 'invoice_exists' };
      const refunded = await client.query<{ total: string }>(
        `SELECT COALESCE(sum(amount_cents), 0)::text AS total FROM refunds WHERE order_id = $1 AND status = 'succeeded'`, [order.id],
      );
      const amount = Number(order.total_cents) - Number(refunded.rows[0]?.total ?? 0);
      if (amount <= 0) return { status: 'order_not_invoiceable' };
      const result = await client.query<InvoiceRow>(
        `INSERT INTO invoices(id, order_id, user_id, invoice_type, invoice_title_ciphertext,
           tax_id_ciphertext, email_ciphertext, email_lookup_hash, amount_cents, status, idempotency_key, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'requested', $10, $11)
         RETURNING id, order_id, $12::text AS order_number, user_id, invoice_type, invoice_title_ciphertext,
           tax_id_ciphertext, email_ciphertext, amount_cents::text, $13::text AS currency, status, failure_reason,
           invoice_code, invoice_number, document_object_key, document_sha256_digest, document_size_bytes::text,
           red_invoice_code, red_invoice_number, red_document_object_key, red_document_sha256_digest,
           red_document_size_bytes::text, red_issued_at,
           issued_at, created_at, updated_at`,
        [input.id, order.id, input.userId, input.invoiceType, input.titleCiphertext, input.taxIdCiphertext,
          input.emailCiphertext, input.emailLookupHash, amount, input.idempotencyKey, input.payloadDigest,
          order.order_number, order.currency],
      );
      const invoice = mapInvoice(result.rows[0]!);
      await this.event(client, invoice.id, input.userId, 'INVOICE_REQUESTED', null, 'requested', {});
      await this.notify(client, input.userId, '发票申请已提交', `订单 ${order.order_number} 的发票申请已保存，交易完成后进入开具。`, { invoiceId: invoice.id, orderId: order.id });
      await this.enqueue(client, 'invoice.requested', 'INVOICE', invoice.id, { invoiceId: invoice.id, orderId: order.id });
      return { status: 'created', invoice };
      });
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      const previous = await this.database.query<InvoiceRow & { payload_digest: string | null }>(
        `SELECT ${invoiceColumns}, i.payload_digest FROM invoices i JOIN orders o ON o.id = i.order_id
         WHERE i.user_id = $1 AND i.idempotency_key = $2`, [input.userId, input.idempotencyKey],
      );
      if (previous.rows[0]) return previous.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', invoice: mapInvoice(previous.rows[0]) }
        : { status: 'idempotency_conflict' };
      const active = await this.database.query(
        `SELECT id FROM invoices WHERE order_id = $1 AND user_id = $2
         AND status IN ('requested', 'processing', 'issued', 'red_pending')`, [input.orderId, input.userId],
      );
      if (active.rowCount) return { status: 'invoice_exists' };
      throw error;
    }
  }

  async list(userId: string, operator: boolean, status?: InvoiceStatus) {
    const result = await this.database.query<InvoiceRow>(
      `SELECT ${invoiceColumns} FROM invoices i JOIN orders o ON o.id = i.order_id
       WHERE ($2::boolean OR i.user_id = $1) AND ($3::text IS NULL OR i.status = $3)
       ORDER BY CASE i.status WHEN 'requested' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END, i.created_at DESC`,
      [userId, operator, status ?? null],
    );
    return result.rows.map(mapInvoice);
  }

  async get(userId: string, invoiceId: string, operator: boolean) {
    const result = await this.database.query<InvoiceRow>(
      `SELECT ${invoiceColumns} FROM invoices i JOIN orders o ON o.id = i.order_id
       WHERE i.id = $1 AND ($3::boolean OR i.user_id = $2)`, [invoiceId, userId, operator],
    );
    return result.rows[0] ? mapInvoice(result.rows[0]) : null;
  }

  async cancel(userId: string, invoiceId: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query<InvoiceRow>(
        `UPDATE invoices i SET status = 'cancelled' FROM orders o
         WHERE i.id = $1 AND i.user_id = $2 AND i.status = 'requested' AND o.id = i.order_id
         RETURNING ${invoiceColumns}`, [invoiceId, userId],
      );
      const invoice = result.rows[0] ? mapInvoice(result.rows[0]) : null;
      if (!invoice) return null;
      await this.event(client, invoice.id, userId, 'INVOICE_CANCELLED', 'requested', 'cancelled', {});
      return invoice;
    });
  }

  async start(invoiceId: string, operatorId: string): Promise<StartInvoiceResult> {
    return this.database.transaction(async (client) => {
      const current = await client.query<InvoiceRow & { order_status: string; order_total_cents: string }>(
        `SELECT ${invoiceColumns}, o.status AS order_status, o.total_cents::text AS order_total_cents
         FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.id = $1 FOR UPDATE OF i, o`, [invoiceId],
      );
      const invoice = current.rows[0];
      if (!invoice || invoice.status !== 'requested') return { status: 'invalid_state' };
      if (!['accepted', 'closed'].includes(invoice.order_status)) return { status: 'order_incomplete' };
      const unsettled = await client.query(
        `SELECT 1 FROM refunds WHERE order_id = $1 AND status IN ('requested', 'reviewing', 'approved', 'provider_pending')
         UNION ALL SELECT 1 FROM disputes WHERE order_id = $1 AND status IN ('open', 'evidence_pending', 'reviewing') LIMIT 1`,
        [invoice.order_id],
      );
      if (unsettled.rowCount) return { status: 'transaction_unsettled' };
      const refunded = await client.query<{ total: string }>(
        `SELECT COALESCE(sum(amount_cents), 0)::text AS total FROM refunds WHERE order_id = $1 AND status = 'succeeded'`, [invoice.order_id],
      );
      const amount = Number(invoice.order_total_cents) - Number(refunded.rows[0]?.total ?? 0);
      if (amount <= 0) return { status: 'transaction_unsettled' };
      const result = await client.query<InvoiceRow>(
        `UPDATE invoices i SET status = 'processing', amount_cents = $2, processed_by = $3,
           processing_started_at = now(), failure_reason = NULL FROM orders o
         WHERE i.id = $1 AND o.id = i.order_id RETURNING ${invoiceColumns}`,
        [invoiceId, amount, operatorId],
      );
      await this.event(client, invoiceId, operatorId, 'INVOICE_PROCESSING_STARTED', 'requested', 'processing', { amountCents: amount });
      return { status: 'started', invoice: mapInvoice(result.rows[0]!) };
    });
  }

  async markFailed(invoiceId: string, operatorId: string, reason: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query<InvoiceRow>(
        `UPDATE invoices i SET status = 'failed', failure_reason = $3, processed_by = $2 FROM orders o
         WHERE i.id = $1 AND i.status = 'processing' AND o.id = i.order_id RETURNING ${invoiceColumns}`,
        [invoiceId, operatorId, reason],
      );
      const invoice = result.rows[0] ? mapInvoice(result.rows[0]) : null;
      if (!invoice) return null;
      await this.event(client, invoiceId, operatorId, 'INVOICE_FAILED', 'processing', 'failed', {});
      await this.notify(client, invoice.userId, '发票开具需要处理', `订单 ${invoice.orderNumber} 的发票暂未开具成功，请联系支持人员。`, { invoiceId, orderId: invoice.orderId });
      return invoice;
    });
  }

  async createDocumentUpload(input: {
    id: string; invoiceId: string; operatorId: string; kind: 'blue' | 'red'; objectKey: string;
    sizeBytes: number; sha256Digest: string; expiresAt: Date;
  }) {
    return this.database.transaction(async (client) => {
      const expected = input.kind === 'blue' ? 'processing' : 'red_pending';
      const invoice = await client.query<{ id: string }>(
        `SELECT id FROM invoices WHERE id = $1 AND status = $2 FOR UPDATE`, [input.invoiceId, expected],
      );
      if (!invoice.rows[0]) return null;
      const result = await client.query<UploadRow>(
        `INSERT INTO invoice_document_uploads(id, invoice_id, kind, object_key, mime_type, size_bytes,
           sha256_digest, created_by, expires_at)
         VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6, $7, $8)
         RETURNING id, invoice_id, kind, object_key, mime_type, size_bytes::text, sha256_digest, status, expires_at`,
        [input.id, input.invoiceId, input.kind, input.objectKey, input.sizeBytes, input.sha256Digest,
          input.operatorId, input.expiresAt],
      );
      return mapUpload(result.rows[0]!);
    });
  }

  async getDocumentUpload(invoiceId: string, uploadId: string) {
    const result = await this.database.query<UploadRow>(
      `SELECT id, invoice_id, kind, object_key, mime_type, size_bytes::text, sha256_digest, status, expires_at
       FROM invoice_document_uploads WHERE id = $1 AND invoice_id = $2`, [uploadId, invoiceId],
    );
    return result.rows[0] ? mapUpload(result.rows[0]) : null;
  }

  async rejectDocumentUpload(invoiceId: string, uploadId: string) {
    const result = await this.database.query(
      `UPDATE invoice_document_uploads SET status = 'rejected'
       WHERE id = $1 AND invoice_id = $2 AND status = 'pending_upload' RETURNING id`, [uploadId, invoiceId],
    );
    return Boolean(result.rowCount);
  }

  async issue(input: {
    invoiceId: string; uploadId: string; operatorId: string; invoiceCode: string; invoiceNumber: string;
    objectKey: string; documentSha256Digest: string; documentSizeBytes: number; issuedAt: Date;
  }) {
    return this.database.transaction(async (client) => {
      const upload = await client.query<UploadRow>(
        `SELECT id, invoice_id, kind, object_key, mime_type, size_bytes::text, sha256_digest, status, expires_at
         FROM invoice_document_uploads WHERE id = $1 AND invoice_id = $2 AND kind = 'blue'
           AND status = 'pending_upload' FOR UPDATE`, [input.uploadId, input.invoiceId],
      );
      const currentUpload = upload.rows[0];
      if (!currentUpload || currentUpload.object_key !== input.objectKey
        || currentUpload.sha256_digest !== input.documentSha256Digest
        || Number(currentUpload.size_bytes) !== input.documentSizeBytes) return null;
      const result = await client.query<InvoiceRow>(
        `UPDATE invoices i SET status = 'issued', invoice_code = $3, invoice_number = $4,
           document_object_key = $5, document_sha256_digest = $6, document_size_bytes = $7,
           issued_at = $8, processed_by = $2, failure_reason = NULL FROM orders o
         WHERE i.id = $1 AND i.status = 'processing' AND o.id = i.order_id RETURNING ${invoiceColumns}`,
        [input.invoiceId, input.operatorId, input.invoiceCode, input.invoiceNumber, input.objectKey,
          input.documentSha256Digest, input.documentSizeBytes, input.issuedAt],
      );
      const invoice = result.rows[0] ? mapInvoice(result.rows[0]) : null;
      if (!invoice) return null;
      await client.query(
        `UPDATE invoice_document_uploads SET status = 'verified', verified_at = $2 WHERE id = $1`,
        [input.uploadId, input.issuedAt],
      );
      await this.event(client, invoice.id, input.operatorId, 'INVOICE_ISSUED', 'processing', 'issued', { documentSha256Digest: input.documentSha256Digest });
      await this.notify(client, invoice.userId, '电子发票已开具', `订单 ${invoice.orderNumber} 的电子发票已经可以下载。`, { invoiceId: invoice.id, orderId: invoice.orderId });
      await this.enqueue(client, 'invoice.issued', 'INVOICE', invoice.id, { invoiceId: invoice.id, orderId: invoice.orderId });
      return invoice;
    });
  }

  async issueRed(input: {
    invoiceId: string; uploadId: string; operatorId: string; invoiceCode: string; invoiceNumber: string;
    objectKey: string; documentSha256Digest: string; documentSizeBytes: number; issuedAt: Date;
  }) {
    return this.database.transaction(async (client) => {
      const upload = await client.query<UploadRow>(
        `SELECT id, invoice_id, kind, object_key, mime_type, size_bytes::text, sha256_digest, status, expires_at
         FROM invoice_document_uploads WHERE id = $1 AND invoice_id = $2 AND kind = 'red'
           AND status = 'pending_upload' FOR UPDATE`, [input.uploadId, input.invoiceId],
      );
      const currentUpload = upload.rows[0];
      if (!currentUpload || currentUpload.object_key !== input.objectKey
        || currentUpload.sha256_digest !== input.documentSha256Digest
        || Number(currentUpload.size_bytes) !== input.documentSizeBytes) return null;
      const result = await client.query<InvoiceRow>(
        `UPDATE invoices i SET status = 'red_issued', red_invoice_code = $3, red_invoice_number = $4,
           red_document_object_key = $5, red_document_sha256_digest = $6, red_document_size_bytes = $7,
           red_issued_at = $8, processed_by = $2, failure_reason = NULL FROM orders o
         WHERE i.id = $1 AND i.status = 'red_pending' AND o.id = i.order_id RETURNING ${invoiceColumns}`,
        [input.invoiceId, input.operatorId, input.invoiceCode, input.invoiceNumber, input.objectKey,
          input.documentSha256Digest, input.documentSizeBytes, input.issuedAt],
      );
      const invoice = result.rows[0] ? mapInvoice(result.rows[0]) : null;
      if (!invoice) return null;
      await client.query(
        `UPDATE invoice_document_uploads SET status = 'verified', verified_at = $2 WHERE id = $1`,
        [input.uploadId, input.issuedAt],
      );
      await this.event(client, invoice.id, input.operatorId, 'INVOICE_RED_ISSUED', 'red_pending', 'red_issued', {
        documentSha256Digest: input.documentSha256Digest,
      });
      await this.notify(client, invoice.userId, '发票红冲已完成', `订单 ${invoice.orderNumber} 的红字发票已经可以下载。`, {
        invoiceId: invoice.id, orderId: invoice.orderId,
      });
      await this.enqueue(client, 'invoice.red_issued', 'INVOICE', invoice.id, { invoiceId: invoice.id, orderId: invoice.orderId });
      return invoice;
    });
  }

  private event(client: PoolClient, invoiceId: string, actorId: string | null, type: string, from: string | null, to: string, payload: Record<string, unknown>) {
    return client.query(
      `INSERT INTO invoice_events(id, invoice_id, actor_id, event_type, from_status, to_status, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [randomUUID(), invoiceId, actorId, type, from, to, JSON.stringify(payload)],
    ).then(() => undefined);
  }

  private async notify(client: PoolClient, userId: string, title: string, body: string, data: Record<string, unknown>) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO notifications(id, user_id, category, title, body, data) VALUES ($1, $2, 'account', $3, $4, $5::jsonb)`,
      [id, userId, title, body, JSON.stringify(data)],
    );
    await this.enqueue(client, 'notification.created', 'NOTIFICATION', id, { notificationId: id, userId });
  }

  private enqueue(client: PoolClient, topic: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>) {
    return client.query(
      `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [randomUUID(), topic, aggregateType, aggregateId, JSON.stringify(payload)],
    ).then(() => undefined);
  }
}
