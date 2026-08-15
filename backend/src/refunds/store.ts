import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { RefundRecord, RefundStatus } from './types.js';

type RefundRow = QueryResultRow & {
  id: string; order_id: string; order_number: string; requested_by: string; payment_intent_id: string;
  amount_cents: string; currency: 'CNY'; reason: string; review_reason: string | null; status: RefundStatus; provider_refund_id: string | null;
  decided_at: Date | null; created_at: Date; updated_at: Date;
};

const refundColumns = `r.id, r.order_id, o.order_number, r.requested_by, r.payment_intent_id,
  r.amount_cents::text, o.currency, r.reason, r.review_reason, r.status, r.provider_refund_id,
  r.decided_at, r.created_at, r.updated_at`;

function mapRefund(row: RefundRow): RefundRecord {
  return {
    id: row.id, orderId: row.order_id, orderNumber: row.order_number, requestedBy: row.requested_by,
    paymentIntentId: row.payment_intent_id, amountCents: Number(row.amount_cents), currency: row.currency,
    reason: row.reason, reviewReason: row.review_reason, status: row.status, providerRefundId: row.provider_refund_id,
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

export type RequestRefundResult =
  | Readonly<{ status: 'created' | 'replayed'; refund: RefundRecord }>
  | Readonly<{ status: 'idempotency_conflict' }>
  | Readonly<{ status: 'order_not_found' }>
  | Readonly<{ status: 'order_not_refundable' }>
  | Readonly<{ status: 'active_refund_exists' }>
  | Readonly<{ status: 'amount_exceeds_available' }>;

export interface RefundStore {
  request(input: Readonly<{
    id: string; userId: string; orderId: string; amountCents?: number; reason: string;
    idempotencyKey: string; payloadDigest: string;
  }>): Promise<RequestRefundResult>;
  list(userId: string): Promise<RefundRecord[]>;
  listForReview(status: RefundStatus | undefined, limit: number): Promise<RefundRecord[]>;
  get(userId: string, refundId: string, operator: boolean): Promise<RefundRecord | null>;
  cancel(userId: string, refundId: string): Promise<RefundRecord | null>;
  review(input: Readonly<{ refundId: string; operatorId: string; approved: boolean; reason?: string }>): Promise<RefundRecord | null>;
}

export class PostgresRefundStore implements RefundStore {
  constructor(private readonly database: Database) {}

  async request(input: {
    id: string; userId: string; orderId: string; amountCents?: number; reason: string;
    idempotencyKey: string; payloadDigest: string;
  }): Promise<RequestRefundResult> {
    return this.database.transaction(async (client) => {
      const previous = await client.query<RefundRow & { payload_digest: string | null }>(
        `SELECT ${refundColumns}, r.payload_digest FROM refunds r JOIN orders o ON o.id = r.order_id
         WHERE r.requested_by = $1 AND r.idempotency_key = $2 FOR UPDATE OF r`,
        [input.userId, input.idempotencyKey],
      );
      if (previous.rows[0]) {
        return previous.rows[0].payload_digest === input.payloadDigest
          ? { status: 'replayed', refund: mapRefund(previous.rows[0]) }
          : { status: 'idempotency_conflict' };
      }

      const orderResult = await client.query<{
        id: string; order_number: string; status: string; total_cents: string; currency: 'CNY';
      }>(
        `SELECT id, order_number, status, total_cents::text, currency FROM orders
         WHERE id = $1 AND buyer_id = $2 FOR UPDATE`, [input.orderId, input.userId],
      );
      const order = orderResult.rows[0];
      if (!order) return { status: 'order_not_found' };
      if (!['paid', 'delivery_pending', 'delivering', 'acceptance_pending', 'accepted', 'closed'].includes(order.status)) {
        return { status: 'order_not_refundable' };
      }
      const paymentResult = await client.query<{ id: string }>(
        `SELECT id FROM payment_intents WHERE order_id = $1 AND status = 'succeeded'
         ORDER BY succeeded_at LIMIT 1`, [order.id],
      );
      const payment = paymentResult.rows[0];
      if (!payment) return { status: 'order_not_refundable' };
      const active = await client.query(
        `SELECT id FROM refunds WHERE payment_intent_id = $1 AND status IN ('requested', 'reviewing', 'approved', 'provider_pending') LIMIT 1`,
        [payment.id],
      );
      if (active.rowCount) return { status: 'active_refund_exists' };
      const refundedResult = await client.query<{ total: string }>(
        `SELECT COALESCE(sum(amount_cents), 0)::text AS total FROM refunds
         WHERE order_id = $1 AND status = 'succeeded'`, [order.id],
      );
      const available = Number(order.total_cents) - Number(refundedResult.rows[0]?.total ?? 0);
      const amountCents = input.amountCents ?? available;
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > available) {
        return { status: 'amount_exceeds_available' };
      }
      const result = await client.query<RefundRow>(
        `INSERT INTO refunds(id, order_id, requested_by, payment_intent_id, amount_cents, reason, status,
           idempotency_key, payload_digest, order_status_before_refund)
         VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9)
         RETURNING id, order_id, $10::text AS order_number, requested_by, payment_intent_id,
           amount_cents::text, $11::text AS currency, reason, review_reason, status, provider_refund_id,
           decided_at, created_at, updated_at`,
        [input.id, order.id, input.userId, payment.id, amountCents, input.reason, input.idempotencyKey,
          input.payloadDigest, order.status, order.order_number, order.currency],
      );
      const refund = mapRefund(result.rows[0]!);
      await this.notify(client, input.userId, '退款申请已提交', `订单 ${order.order_number} 的退款申请已进入审核。`, { orderId: order.id, refundId: refund.id });
      await this.enqueue(client, 'refund.requested', 'REFUND', refund.id, { refundId: refund.id, orderId: order.id });
      return { status: 'created', refund };
    });
  }

  async list(userId: string) {
    const result = await this.database.query<RefundRow>(
      `SELECT ${refundColumns} FROM refunds r JOIN orders o ON o.id = r.order_id
       WHERE r.requested_by = $1 ORDER BY r.created_at DESC, r.id DESC`, [userId],
    );
    return result.rows.map(mapRefund);
  }

  async listForReview(status: RefundStatus | undefined, limit: number) {
    const result = await this.database.query<RefundRow>(
      `SELECT ${refundColumns} FROM refunds r JOIN orders o ON o.id = r.order_id
       WHERE ($1::text IS NULL OR r.status = $1)
       ORDER BY CASE r.status WHEN 'requested' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
         r.created_at, r.id LIMIT $2`,
      [status ?? null, limit],
    );
    return result.rows.map(mapRefund);
  }

  async get(userId: string, refundId: string, operator: boolean) {
    const result = await this.database.query<RefundRow>(
      `SELECT ${refundColumns} FROM refunds r JOIN orders o ON o.id = r.order_id
       WHERE r.id = $1 AND ($3::boolean OR r.requested_by = $2)`, [refundId, userId, operator],
    );
    return result.rows[0] ? mapRefund(result.rows[0]) : null;
  }

  async cancel(userId: string, refundId: string) {
    const result = await this.database.query<RefundRow>(
      `UPDATE refunds r SET status = 'cancelled', decided_at = now()
       FROM orders o WHERE r.id = $1 AND r.requested_by = $2 AND r.status = 'requested' AND o.id = r.order_id
       RETURNING ${refundColumns}`,
      [refundId, userId],
    );
    return result.rows[0] ? mapRefund(result.rows[0]) : null;
  }

  async review(input: { refundId: string; operatorId: string; approved: boolean; reason?: string }) {
    return this.database.transaction(async (client) => {
      const currentResult = await client.query<RefundRow & { order_status_before_refund: string }>(
        `SELECT ${refundColumns}, r.order_status_before_refund FROM refunds r JOIN orders o ON o.id = r.order_id
         WHERE r.id = $1 FOR UPDATE OF r, o`, [input.refundId],
      );
      const current = currentResult.rows[0];
      if (!current || !['requested', 'reviewing'].includes(current.status)) return null;
      const nextStatus = input.approved ? 'provider_pending' : 'rejected';
      const result = await client.query<RefundRow>(
        `UPDATE refunds r SET status = $2, decided_by = $3, decided_at = now(), review_reason = $4
         FROM orders o WHERE r.id = $1 AND o.id = r.order_id
         RETURNING ${refundColumns}`,
        [input.refundId, nextStatus, input.operatorId, input.reason ?? null],
      );
      const refund = mapRefund(result.rows[0]!);
      if (input.approved) {
        await client.query(`UPDATE orders SET status = 'refund_pending' WHERE id = $1`, [refund.orderId]);
        await this.enqueue(client, 'refund.execute', 'REFUND', refund.id, { refundId: refund.id, orderId: refund.orderId });
        await this.notify(client, refund.requestedBy, '退款审核通过', `订单 ${refund.orderNumber} 已进入原路退款处理。`, { orderId: refund.orderId, refundId: refund.id });
      } else {
        await this.notify(client, refund.requestedBy, '退款审核结果', `订单 ${refund.orderNumber} 的退款申请未通过审核。`, { orderId: refund.orderId, refundId: refund.id });
      }
      return refund;
    });
  }

  private async notify(client: PoolClient, userId: string, title: string, body: string, data: Record<string, unknown>) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO notifications(id, user_id, category, title, body, data) VALUES ($1, $2, 'payment', $3, $4, $5::jsonb)`,
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
