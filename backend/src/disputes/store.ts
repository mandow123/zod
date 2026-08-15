import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { DisputeCategory, DisputeRecord, DisputeStatus, EvidenceRecord, EvidenceStatus } from './types.js';

type DisputeRow = QueryResultRow & {
  id: string; order_id: string; order_number: string; buyer_id: string; supplier_user_id: string;
  opened_by: string; category: DisputeCategory; reason: string; status: DisputeStatus;
  resolution: string | null; resolution_refund_id: string | null; created_at: Date; updated_at: Date;
  evidence_deadline: Date; buyer_evidence_completed_at: Date | null; supplier_evidence_completed_at: Date | null;
};

type EvidenceRow = QueryResultRow & {
  id: string; dispute_id: string; submitted_by: string; object_key: string; file_name: string; mime_type: string;
  size_bytes: string; sha256_digest: string; status: EvidenceStatus; scan_result: string | null;
  created_at: Date; uploaded_at: Date | null; verified_at: Date | null;
};

const disputeColumns = `d.id, d.order_id, o.order_number, o.buyer_id, s.user_id AS supplier_user_id,
  d.opened_by, d.category, d.reason, d.status, d.resolution, d.resolution_refund_id,
  d.evidence_deadline, d.buyer_evidence_completed_at, d.supplier_evidence_completed_at, d.created_at, d.updated_at`;
const evidenceColumns = `id, dispute_id, submitted_by, object_key, file_name, mime_type, size_bytes::text,
  sha256_digest, status, scan_result, created_at, uploaded_at, verified_at`;

function mapDispute(row: DisputeRow): DisputeRecord {
  return {
    id: row.id, orderId: row.order_id, orderNumber: row.order_number, buyerId: row.buyer_id,
    supplierUserId: row.supplier_user_id, openedBy: row.opened_by, category: row.category,
    reason: row.reason, status: row.status, resolution: row.resolution,
    resolutionRefundId: row.resolution_refund_id, evidenceDeadline: new Date(row.evidence_deadline),
    buyerEvidenceCompletedAt: row.buyer_evidence_completed_at ? new Date(row.buyer_evidence_completed_at) : null,
    supplierEvidenceCompletedAt: row.supplier_evidence_completed_at ? new Date(row.supplier_evidence_completed_at) : null,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

function mapEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id, disputeId: row.dispute_id, submittedBy: row.submitted_by, objectKey: row.object_key,
    fileName: row.file_name, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes),
    sha256Digest: row.sha256_digest, status: row.status, scanResult: row.scan_result,
    createdAt: new Date(row.created_at), uploadedAt: row.uploaded_at ? new Date(row.uploaded_at) : null,
    verifiedAt: row.verified_at ? new Date(row.verified_at) : null,
  };
}

export type OpenDisputeResult =
  | Readonly<{ status: 'created' | 'replayed'; dispute: DisputeRecord }>
  | Readonly<{ status: 'idempotency_conflict' }>
  | Readonly<{ status: 'order_not_found' }>
  | Readonly<{ status: 'order_not_disputable' }>
  | Readonly<{ status: 'active_dispute_exists' }>;

export type ResolveDisputeResult =
  | Readonly<{ status: 'resolved'; dispute: DisputeRecord }>
  | Readonly<{ status: 'invalid_state' }>
  | Readonly<{ status: 'evidence_pending' }>
  | Readonly<{ status: 'evidence_window_open' }>
  | Readonly<{ status: 'refund_unavailable' }>
  | Readonly<{ status: 'refund_amount_invalid' }>;

export interface DisputeStore {
  open(input: Readonly<{
    id: string; userId: string; orderId: string; category: DisputeCategory; reason: string; evidenceDeadline: Date;
    idempotencyKey: string; payloadDigest: string;
  }>): Promise<OpenDisputeResult>;
  list(userId: string, operator: boolean): Promise<DisputeRecord[]>;
  get(userId: string, disputeId: string, operator: boolean): Promise<DisputeRecord | null>;
  createEvidence(input: Readonly<{
    id: string; disputeId: string; userId: string; operator: boolean; objectKey: string; fileName: string;
    mimeType: string; sizeBytes: number; sha256Digest: string; retentionUntil: Date; now: Date;
  }>): Promise<EvidenceRecord | null>;
  getEvidence(userId: string, disputeId: string, evidenceId: string, operator: boolean): Promise<EvidenceRecord | null>;
  listEvidence(userId: string, disputeId: string, operator: boolean): Promise<EvidenceRecord[] | null>;
  markEvidenceUploaded(evidenceId: string, uploadedAt: Date): Promise<EvidenceRecord | null>;
  discardEvidence(userId: string, disputeId: string, evidenceId: string): Promise<EvidenceRecord | null>;
  completeEvidenceSubmission(userId: string, disputeId: string, completedAt: Date): Promise<DisputeRecord | null>;
  close(userId: string, disputeId: string): Promise<DisputeRecord | null>;
  resolve(input: Readonly<{
    disputeId: string; operatorId: string; outcome: 'buyer' | 'supplier'; resolution: string;
    refundId: string; refundAmountCents?: number; payloadDigest: string; now: Date;
  }>): Promise<ResolveDisputeResult>;
}

export class PostgresDisputeStore implements DisputeStore {
  constructor(private readonly database: Database) {}

  async open(input: {
    id: string; userId: string; orderId: string; category: DisputeCategory; reason: string; evidenceDeadline: Date;
    idempotencyKey: string; payloadDigest: string;
  }): Promise<OpenDisputeResult> {
    return this.database.transaction(async (client) => {
      const previous = await client.query<DisputeRow & { payload_digest: string | null }>(
        `SELECT ${disputeColumns}, d.payload_digest FROM disputes d JOIN orders o ON o.id = d.order_id
         JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE d.opened_by = $1 AND d.idempotency_key = $2 FOR UPDATE OF d`, [input.userId, input.idempotencyKey],
      );
      if (previous.rows[0]) return previous.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', dispute: mapDispute(previous.rows[0]) }
        : { status: 'idempotency_conflict' };
      const orderResult = await client.query<{
        id: string; order_number: string; buyer_id: string; supplier_id: string; supplier_user_id: string; status: string;
      }>(
        `SELECT o.id, o.order_number, o.buyer_id, o.supplier_id, s.user_id AS supplier_user_id, o.status
         FROM orders o JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE o.id = $1 AND ($2 = o.buyer_id OR $2 = s.user_id) FOR UPDATE OF o`, [input.orderId, input.userId],
      );
      const order = orderResult.rows[0];
      if (!order) return { status: 'order_not_found' };
      const active = await client.query(
        `SELECT id FROM disputes WHERE order_id = $1 AND status IN ('open', 'evidence_pending', 'reviewing') LIMIT 1`, [order.id],
      );
      if (active.rowCount) return { status: 'active_dispute_exists' };
      if (!['paid', 'delivery_pending', 'delivering', 'acceptance_pending', 'accepted', 'closed'].includes(order.status)) {
        return { status: 'order_not_disputable' };
      }
      const result = await client.query<DisputeRow>(
        `INSERT INTO disputes(id, order_id, opened_by, category, reason, status, order_status_before_dispute,
           evidence_deadline, idempotency_key, payload_digest)
         VALUES ($1, $2, $3, $4, $5, 'evidence_pending', $6, $10, $11, $12)
         RETURNING id, order_id, $7::text AS order_number, $8::uuid AS buyer_id, $9::uuid AS supplier_user_id,
           opened_by, category, reason, status, resolution, resolution_refund_id, evidence_deadline,
           buyer_evidence_completed_at, supplier_evidence_completed_at, created_at, updated_at`,
        [input.id, order.id, input.userId, input.category, input.reason, order.status,
          order.order_number, order.buyer_id, order.supplier_user_id, input.evidenceDeadline,
          input.idempotencyKey, input.payloadDigest],
      );
      await client.query(`UPDATE orders SET status = 'disputed' WHERE id = $1`, [order.id]);
      await this.event(client, input.id, input.userId, 'DISPUTE_OPENED', null, 'evidence_pending', { category: input.category });
      const counterpart = input.userId === order.buyer_id ? order.supplier_user_id : order.buyer_id;
      await this.notify(client, counterpart, '订单争议已开启', `订单 ${order.order_number} 出现新的争议，请及时提交证据。`, { orderId: order.id, disputeId: input.id });
      await this.enqueue(client, 'dispute.opened', 'DISPUTE', input.id, { disputeId: input.id, orderId: order.id });
      return { status: 'created', dispute: mapDispute(result.rows[0]!) };
    });
  }

  async list(userId: string, operator: boolean) {
    const result = await this.database.query<DisputeRow>(
      `SELECT ${disputeColumns} FROM disputes d JOIN orders o ON o.id = d.order_id
       JOIN supplier_profiles s ON s.id = o.supplier_id
       WHERE $2::boolean OR o.buyer_id = $1 OR s.user_id = $1
       ORDER BY CASE d.status WHEN 'evidence_pending' THEN 0 WHEN 'reviewing' THEN 1 WHEN 'open' THEN 2 ELSE 3 END,
         d.created_at DESC`, [userId, operator],
    );
    return result.rows.map(mapDispute);
  }

  async get(userId: string, disputeId: string, operator: boolean) {
    const result = await this.database.query<DisputeRow>(
      `SELECT ${disputeColumns} FROM disputes d JOIN orders o ON o.id = d.order_id
       JOIN supplier_profiles s ON s.id = o.supplier_id
       WHERE d.id = $1 AND ($3::boolean OR o.buyer_id = $2 OR s.user_id = $2)`, [disputeId, userId, operator],
    );
    return result.rows[0] ? mapDispute(result.rows[0]) : null;
  }

  async createEvidence(input: {
    id: string; disputeId: string; userId: string; operator: boolean; objectKey: string; fileName: string;
    mimeType: string; sizeBytes: number; sha256Digest: string; retentionUntil: Date; now: Date;
  }) {
    return this.database.transaction(async (client) => {
      const access = await client.query<{
        buyer_id: string; supplier_user_id: string; evidence_deadline: Date;
        buyer_evidence_completed_at: Date | null; supplier_evidence_completed_at: Date | null;
      }>(
        `SELECT o.buyer_id, s.user_id AS supplier_user_id, d.evidence_deadline,
           d.buyer_evidence_completed_at, d.supplier_evidence_completed_at
         FROM disputes d JOIN orders o ON o.id = d.order_id
         JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE d.id = $1 AND d.status IN ('open', 'evidence_pending', 'reviewing')
           AND ($3::boolean OR o.buyer_id = $2 OR s.user_id = $2) FOR UPDATE OF d`,
        [input.disputeId, input.userId, input.operator],
      );
      const authorized = access.rows[0];
      if (!authorized) return null;
      const completed = authorized.buyer_id === input.userId
        ? authorized.buyer_evidence_completed_at
        : authorized.supplier_evidence_completed_at;
      if (!input.operator && (completed || authorized.evidence_deadline <= input.now)) return null;
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM dispute_evidence WHERE dispute_id = $1 AND status <> 'deleted'`, [input.disputeId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= 20) return null;
      const result = await client.query<EvidenceRow>(
        `INSERT INTO dispute_evidence(id, dispute_id, submitted_by, object_key, file_name, mime_type,
           size_bytes, sha256_digest, status, retention_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_upload', $9)
         RETURNING ${evidenceColumns}`,
        [input.id, input.disputeId, input.userId, input.objectKey, input.fileName, input.mimeType,
          input.sizeBytes, input.sha256Digest, input.retentionUntil],
      );
      await this.event(client, input.disputeId, input.userId, 'EVIDENCE_UPLOAD_CREATED', null, 'pending_upload', { evidenceId: input.id });
      return mapEvidence(result.rows[0]!);
    });
  }

  async getEvidence(userId: string, disputeId: string, evidenceId: string, operator: boolean) {
    const result = await this.database.query<EvidenceRow>(
      `SELECT e.${evidenceColumns.replaceAll(', ', ', e.')} FROM dispute_evidence e
       JOIN disputes d ON d.id = e.dispute_id JOIN orders o ON o.id = d.order_id
       JOIN supplier_profiles s ON s.id = o.supplier_id
       WHERE e.id = $1 AND e.dispute_id = $2 AND ($4::boolean OR o.buyer_id = $3 OR s.user_id = $3)`,
      [evidenceId, disputeId, userId, operator],
    );
    return result.rows[0] ? mapEvidence(result.rows[0]) : null;
  }

  async listEvidence(userId: string, disputeId: string, operator: boolean) {
    const access = await this.get(userId, disputeId, operator);
    if (!access) return null;
    const result = await this.database.query<EvidenceRow>(
      `SELECT ${evidenceColumns} FROM dispute_evidence WHERE dispute_id = $1 AND status <> 'deleted' ORDER BY created_at, id`,
      [disputeId],
    );
    return result.rows.map(mapEvidence);
  }

  async markEvidenceUploaded(evidenceId: string, uploadedAt: Date) {
    return this.database.transaction(async (client) => {
      const result = await client.query<EvidenceRow>(
        `UPDATE dispute_evidence SET status = 'pending_scan', uploaded_at = $2
         WHERE id = $1 AND status = 'pending_upload' RETURNING ${evidenceColumns}`,
        [evidenceId, uploadedAt],
      );
      const evidence = result.rows[0] ? mapEvidence(result.rows[0]) : null;
      if (!evidence) return null;
      await this.event(client, evidence.disputeId, evidence.submittedBy, 'EVIDENCE_UPLOADED', 'pending_upload', 'pending_scan', { evidenceId });
      await this.enqueue(client, 'evidence.scan', 'DISPUTE_EVIDENCE', evidenceId, { evidenceId, disputeId: evidence.disputeId });
      return evidence;
    });
  }

  async discardEvidence(userId: string, disputeId: string, evidenceId: string) {
    const result = await this.database.query<EvidenceRow>(
      `UPDATE dispute_evidence SET status = 'deleted', scan_result = 'discarded_by_submitter'
       WHERE id = $1 AND dispute_id = $2 AND submitted_by = $3
         AND status IN ('pending_upload', 'scan_failed', 'rejected')
       RETURNING ${evidenceColumns}`,
      [evidenceId, disputeId, userId],
    );
    return result.rows[0] ? mapEvidence(result.rows[0]) : null;
  }

  async completeEvidenceSubmission(userId: string, disputeId: string, completedAt: Date) {
    return this.database.transaction(async (client) => {
      const current = await client.query<DisputeRow>(
        `SELECT ${disputeColumns} FROM disputes d JOIN orders o ON o.id = d.order_id
         JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE d.id = $1 AND d.status IN ('open', 'evidence_pending', 'reviewing')
           AND (o.buyer_id = $2 OR s.user_id = $2) FOR UPDATE OF d`, [disputeId, userId],
      );
      const dispute = current.rows[0];
      if (!dispute) return null;
      const buyer = dispute.buyer_id === userId;
      await client.query(
        `UPDATE disputes SET
           buyer_evidence_completed_at = CASE WHEN $2 THEN COALESCE(buyer_evidence_completed_at, $3) ELSE buyer_evidence_completed_at END,
           supplier_evidence_completed_at = CASE WHEN $2 THEN supplier_evidence_completed_at ELSE COALESCE(supplier_evidence_completed_at, $3) END
         WHERE id = $1`, [disputeId, buyer, completedAt],
      );
      await this.event(client, disputeId, userId, 'EVIDENCE_SUBMISSION_COMPLETED', dispute.status, dispute.status, { party: buyer ? 'buyer' : 'supplier' });
      const refreshed = await client.query<DisputeRow>(
        `SELECT ${disputeColumns} FROM disputes d JOIN orders o ON o.id = d.order_id
         JOIN supplier_profiles s ON s.id = o.supplier_id WHERE d.id = $1`, [disputeId],
      );
      return mapDispute(refreshed.rows[0]!);
    });
  }

  async close(userId: string, disputeId: string) {
    return this.database.transaction(async (client) => {
      const current = await client.query<DisputeRow & { order_status_before_dispute: string }>(
        `SELECT ${disputeColumns}, d.order_status_before_dispute FROM disputes d JOIN orders o ON o.id = d.order_id
         JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE d.id = $1 AND d.opened_by = $2 AND d.status IN ('open', 'evidence_pending') FOR UPDATE OF d, o`,
        [disputeId, userId],
      );
      const dispute = current.rows[0];
      if (!dispute) return null;
      await client.query(`UPDATE disputes SET status = 'closed', resolution = '发起方主动关闭争议。' WHERE id = $1`, [disputeId]);
      await client.query(`UPDATE orders SET status = $2 WHERE id = $1 AND status = 'disputed'`, [dispute.order_id, dispute.order_status_before_dispute]);
      await this.event(client, disputeId, userId, 'DISPUTE_CLOSED', dispute.status, 'closed', {});
      const refreshed = await client.query<DisputeRow>(
        `SELECT ${disputeColumns} FROM disputes d JOIN orders o ON o.id = d.order_id JOIN supplier_profiles s ON s.id = o.supplier_id WHERE d.id = $1`, [disputeId],
      );
      return mapDispute(refreshed.rows[0]!);
    });
  }

  async resolve(input: {
    disputeId: string; operatorId: string; outcome: 'buyer' | 'supplier'; resolution: string;
    refundId: string; refundAmountCents?: number; payloadDigest: string; now: Date;
  }): Promise<ResolveDisputeResult> {
    return this.database.transaction(async (client) => {
      const currentResult = await client.query<DisputeRow & {
        order_status_before_dispute: string; order_total_cents: string; currency: 'CNY';
      }>(
        `SELECT ${disputeColumns}, d.order_status_before_dispute, o.total_cents::text AS order_total_cents, o.currency
         FROM disputes d JOIN orders o ON o.id = d.order_id JOIN supplier_profiles s ON s.id = o.supplier_id
         WHERE d.id = $1 FOR UPDATE OF d, o`, [input.disputeId],
      );
      const current = currentResult.rows[0];
      if (!current || !['open', 'evidence_pending', 'reviewing'].includes(current.status)) return { status: 'invalid_state' };
      const pendingEvidence = await client.query(
        `SELECT id FROM dispute_evidence WHERE dispute_id = $1 AND status IN ('pending_upload', 'pending_scan', 'scan_failed') LIMIT 1`, [current.id],
      );
      if (pendingEvidence.rowCount) return { status: 'evidence_pending' };
      if (current.evidence_deadline > input.now && (!current.buyer_evidence_completed_at || !current.supplier_evidence_completed_at)) {
        return { status: 'evidence_window_open' };
      }
      let refundId: string | null = null;
      if (input.outcome === 'buyer') {
        const payment = await client.query<{ id: string; amount_cents: string }>(
          `SELECT id, amount_cents::text FROM payment_intents WHERE order_id = $1 AND status = 'succeeded' ORDER BY succeeded_at LIMIT 1`,
          [current.order_id],
        );
        if (!payment.rows[0]) return { status: 'refund_unavailable' };
        const activeRefund = await client.query(
          `SELECT id FROM refunds WHERE payment_intent_id = $1 AND status IN ('requested', 'reviewing', 'approved', 'provider_pending') LIMIT 1`,
          [payment.rows[0].id],
        );
        if (activeRefund.rowCount) return { status: 'refund_unavailable' };
        const previous = await client.query<{ total: string }>(
          `SELECT COALESCE(sum(amount_cents), 0)::text AS total FROM refunds WHERE order_id = $1 AND status = 'succeeded'`, [current.order_id],
        );
        const available = Number(current.order_total_cents) - Number(previous.rows[0]?.total ?? 0);
        const amount = input.refundAmountCents ?? available;
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > available) return { status: 'refund_amount_invalid' };
        refundId = input.refundId;
        await client.query(
          `INSERT INTO refunds(id, order_id, requested_by, payment_intent_id, amount_cents, reason, status,
             idempotency_key, payload_digest, order_status_before_refund, decided_by, decided_at, review_reason)
           VALUES ($1, $2, $3, $4, $5, $6, 'provider_pending', $7, $8, $9, $10, now(), $11)`,
          [refundId, current.order_id, current.buyer_id, payment.rows[0].id, amount,
            `争议裁定退款：${input.resolution}`.slice(0, 1000), `dispute:${current.id}`, input.payloadDigest,
            current.order_status_before_dispute, input.operatorId, input.resolution],
        );
        await client.query(`UPDATE orders SET status = 'refund_pending' WHERE id = $1`, [current.order_id]);
        await this.enqueue(client, 'refund.execute', 'REFUND', refundId, { refundId, orderId: current.order_id, disputeId: current.id });
      } else {
        await client.query(`UPDATE orders SET status = $2 WHERE id = $1 AND status = 'disputed'`, [current.order_id, current.order_status_before_dispute]);
      }
      const nextStatus = input.outcome === 'buyer' ? 'resolved_buyer' : 'resolved_supplier';
      await client.query(
        `UPDATE disputes SET status = $2, resolution = $3, resolution_refund_id = $4,
           resolved_by = $5, resolved_at = now() WHERE id = $1`,
        [current.id, nextStatus, input.resolution, refundId, input.operatorId],
      );
      await this.event(client, current.id, input.operatorId, 'DISPUTE_RESOLVED', current.status, nextStatus, { outcome: input.outcome, refundId });
      await this.notify(client, current.buyer_id, '争议处理完成', `订单 ${current.order_number} 的争议已有处理结果。`, { disputeId: current.id, orderId: current.order_id, outcome: input.outcome });
      await this.notify(client, current.supplier_user_id, '争议处理完成', `订单 ${current.order_number} 的争议已有处理结果。`, { disputeId: current.id, orderId: current.order_id, outcome: input.outcome });
      const refreshed = await client.query<DisputeRow>(
        `SELECT ${disputeColumns} FROM disputes d JOIN orders o ON o.id = d.order_id JOIN supplier_profiles s ON s.id = o.supplier_id WHERE d.id = $1`, [current.id],
      );
      return { status: 'resolved', dispute: mapDispute(refreshed.rows[0]!) };
    });
  }

  private event(
    client: PoolClient, disputeId: string, actorId: string | null, eventType: string,
    fromStatus: string | null, toStatus: string, payload: Record<string, unknown>,
  ) {
    return client.query(
      `INSERT INTO dispute_events(id, dispute_id, actor_id, event_type, from_status, to_status, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [randomUUID(), disputeId, actorId, eventType, fromStatus, toStatus, JSON.stringify(payload)],
    ).then(() => undefined);
  }

  private async notify(client: PoolClient, userId: string, title: string, body: string, data: Record<string, unknown>) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO notifications(id, user_id, category, title, body, data) VALUES ($1, $2, 'order', $3, $4, $5::jsonb)`,
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
