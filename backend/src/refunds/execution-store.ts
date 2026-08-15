import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { PaymentProviderName, VerifiedRefundEvent } from '../payment/types.js';

export type RefundExecutionRecord = Readonly<{
  id: string;
  orderId: string;
  userId: string;
  paymentIntentId: string;
  provider: PaymentProviderName;
  providerReference: string;
  providerRefundId: string | null;
  amountCents: number;
  originalAmountCents: number;
  currency: 'CNY';
  reason: string;
  status: string;
}>;

type ExecutionRow = QueryResultRow & {
  id: string; order_id: string; requested_by: string; payment_intent_id: string;
  provider: PaymentProviderName; provider_reference: string; provider_refund_id: string | null;
  amount_cents: string; original_amount_cents: string; currency: 'CNY'; reason: string; status: string;
};

type LockedRefundRow = ExecutionRow & {
  order_number: string; order_status: string; order_total_cents: string; listing_id: string; quantity: string;
  order_status_before_refund: string | null; payment_status: string; idempotency_key: string | null;
};

export type RefundEventApplyResult = 'succeeded' | 'pending' | 'failed' | 'duplicate' | 'unknown_reference' | 'amount_mismatch';

type RefundLedgerEvent = Readonly<{
  provider: PaymentProviderName;
  eventId: string;
  refundId: string | null;
  providerRefundId: string;
  status: 'pending' | 'succeeded' | 'failed';
  amountCents: number;
  currency: string;
  payloadDigest: string;
  normalizedPayload: Record<string, unknown>;
}>;

export interface RefundExecutionStore {
  getExecution(refundId: string): Promise<RefundExecutionRecord | null>;
  markProviderPending(refundId: string, providerRefundId: string): Promise<void>;
  complete(input: Readonly<{
    refundId: string; providerRefundId: string; eventId: string; payloadDigest: string; now: Date;
  }>): Promise<boolean>;
  fail(refundId: string, errorCode: string, now: Date): Promise<void>;
  applyVerifiedEvent(event: VerifiedRefundEvent, now: Date): Promise<RefundEventApplyResult>;
}

export class PostgresRefundExecutionStore implements RefundExecutionStore {
  constructor(private readonly database: Database) {}

  async getExecution(refundId: string) {
    const result = await this.database.query<ExecutionRow>(
      `SELECT r.id, r.order_id, r.requested_by, r.payment_intent_id, p.provider, p.provider_reference,
         r.provider_refund_id, r.amount_cents::text, p.amount_cents::text AS original_amount_cents,
         p.currency, r.reason, r.status
       FROM refunds r JOIN payment_intents p ON p.id = r.payment_intent_id WHERE r.id = $1`, [refundId],
    );
    return result.rows[0] ? this.mapExecution(result.rows[0]) : null;
  }

  async markProviderPending(refundId: string, providerRefundId: string) {
    await this.database.query(
      `UPDATE refunds SET provider_refund_id = $2 WHERE id = $1 AND status = 'provider_pending'`,
      [refundId, providerRefundId],
    );
  }

  async complete(input: { refundId: string; providerRefundId: string; eventId: string; payloadDigest: string; now: Date }) {
    return this.database.transaction(async (client) => {
      const current = await this.lockRefund(client, input.refundId);
      if (!current) return false;
      const inserted = await this.insertEvent(client, {
        provider: current.provider, eventId: input.eventId, refundId: current.id,
        providerRefundId: input.providerRefundId, status: 'succeeded', amountCents: Number(current.amount_cents),
        currency: current.currency, payloadDigest: input.payloadDigest, normalizedPayload: { source: 'provider_api' },
      }, null, input.now);
      if (!inserted) return current.status === 'succeeded';
      await this.completeLocked(client, current, input.providerRefundId, input.now);
      return true;
    });
  }

  async fail(refundId: string, errorCode: string, now: Date) {
    await this.database.transaction(async (client) => {
      const current = await this.lockRefund(client, refundId);
      if (!current || current.status !== 'provider_pending') return;
      await client.query(`UPDATE refunds SET status = 'failed', review_reason = $2 WHERE id = $1`, [refundId, `渠道处理失败：${errorCode}`]);
      await client.query(`UPDATE payment_intents SET status = 'succeeded' WHERE id = $1 AND status = 'refunding'`, [current.payment_intent_id]);
      if (current.order_status === 'refund_pending' && !current.idempotency_key?.startsWith('auto:')) {
        await client.query(`UPDATE orders SET status = $2 WHERE id = $1`, [current.order_id, current.order_status_before_refund ?? 'paid']);
      }
      await this.notify(client, current.requested_by, '退款处理异常', `订单 ${current.order_number} 的退款未完成，客服将继续跟进。`, {
        orderId: current.order_id, refundId: current.id,
      });
      await this.enqueue(client, 'refund.review_required', 'REFUND', current.id, { refundId: current.id, errorCode, failedAt: now.toISOString() });
    });
  }

  async applyVerifiedEvent(event: VerifiedRefundEvent, now: Date): Promise<RefundEventApplyResult> {
    return this.database.transaction(async (client) => {
      const current = await this.lockRefund(client, event.refundReference);
      if (!current) {
        const inserted = await this.insertEvent(client, { ...event, refundId: null }, 'unknown_refund_reference', now);
        if (inserted) await this.enqueue(client, 'refund.review_required', 'REFUND_EVENT', event.eventId, { reason: 'unknown_refund_reference', eventId: event.eventId });
        return inserted ? 'unknown_reference' : 'duplicate';
      }
      const mismatch = Number(current.amount_cents) !== event.amountCents
        || Number(current.original_amount_cents) !== event.originalAmountCents
        || current.currency !== event.currency;
      if (mismatch) {
        const inserted = await this.insertEvent(client, { ...event, refundId: current.id }, 'amount_or_currency_mismatch', now);
        if (inserted) await this.enqueue(client, 'refund.review_required', 'REFUND', current.id, { reason: 'amount_or_currency_mismatch', refundId: current.id });
        return inserted ? 'amount_mismatch' : 'duplicate';
      }
      const inserted = await this.insertEvent(client, { ...event, refundId: current.id }, null, now);
      if (!inserted) return 'duplicate';
      if (event.status === 'succeeded') await this.completeLocked(client, current, event.providerRefundId, now);
      else if (event.status === 'pending') await client.query(`UPDATE refunds SET provider_refund_id = $2 WHERE id = $1`, [current.id, event.providerRefundId]);
      else await this.failLocked(client, current, 'provider_reported_failed', now);
      return event.status;
    });
  }

  private async lockRefund(client: PoolClient, refundId: string) {
    const result = await client.query<LockedRefundRow>(
      `SELECT r.id, r.order_id, r.requested_by, r.payment_intent_id, p.provider, p.provider_reference,
         r.provider_refund_id, r.amount_cents::text, p.amount_cents::text AS original_amount_cents,
         p.currency, r.reason, r.status, o.order_number, o.status AS order_status,
         o.total_cents::text AS order_total_cents, o.listing_id, o.quantity::text,
         r.order_status_before_refund, p.status AS payment_status, r.idempotency_key
       FROM refunds r JOIN payment_intents p ON p.id = r.payment_intent_id
       JOIN orders o ON o.id = r.order_id WHERE r.id = $1 FOR UPDATE OF r, p, o`, [refundId],
    );
    return result.rows[0] ?? null;
  }

  private async completeLocked(client: PoolClient, current: LockedRefundRow, providerRefundId: string, now: Date) {
    if (current.status === 'succeeded') return;
    if (current.status !== 'provider_pending') throw new Error(`refund ${current.id} is not provider_pending`);
    await client.query(
      `UPDATE refunds SET status = 'succeeded', provider_refund_id = $2 WHERE id = $1`, [current.id, providerRefundId],
    );
    const paymentRefunded = await client.query<{ total: string }>(
      `SELECT COALESCE(sum(amount_cents), 0)::text AS total FROM refunds
       WHERE payment_intent_id = $1 AND status = 'succeeded'`, [current.payment_intent_id],
    );
    if (Number(paymentRefunded.rows[0]?.total ?? 0) >= Number(current.original_amount_cents)) {
      await client.query(`UPDATE payment_intents SET status = 'refunded' WHERE id = $1`, [current.payment_intent_id]);
    }
    if (current.order_status === 'refund_pending') {
      const orderRefunded = await client.query<{ total: string }>(
        `SELECT COALESCE(sum(amount_cents), 0)::text AS total FROM refunds WHERE order_id = $1 AND status = 'succeeded'`,
        [current.order_id],
      );
      const fullyRefunded = Number(orderRefunded.rows[0]?.total ?? 0) >= Number(current.order_total_cents);
      const nextStatus = fullyRefunded ? 'refunded' : (current.order_status_before_refund ?? 'paid');
      await client.query(`UPDATE orders SET status = $2 WHERE id = $1`, [current.order_id, nextStatus]);
      if (fullyRefunded) {
        const released = await client.query(
          `UPDATE capacity_reservations SET status = 'released', released_at = $2, release_reason = 'refund_succeeded'
           WHERE order_id = $1 AND status = 'active' RETURNING id`, [current.order_id, now],
        );
        if (released.rowCount) await client.query(
          `UPDATE market_listings SET capacity_reserved = capacity_reserved - $2 WHERE id = $1`, [current.listing_id, current.quantity],
        );
        await client.query(
          `UPDATE delivery_tasks SET status = 'cancelled' WHERE order_id = $1 AND status NOT IN ('completed', 'cancelled')`, [current.order_id],
        );
      }
      await client.query(
        `INSERT INTO order_events(id, order_id, actor_id, event_type, from_status, to_status, payload)
         VALUES ($1, $2, NULL, 'REFUND_SUCCEEDED', 'refund_pending', $3, $4::jsonb)`,
        [randomUUID(), current.order_id, nextStatus, JSON.stringify({ refundId: current.id, amountCents: Number(current.amount_cents) })],
      );
    }
    await this.reconcileInvoiceAfterRefund(client, current, now);
    await this.notify(client, current.requested_by, '退款成功', `订单 ${current.order_number} 的退款已原路退回。`, {
      orderId: current.order_id, refundId: current.id, amountCents: Number(current.amount_cents),
    });
    await this.enqueue(client, 'refund.succeeded', 'REFUND', current.id, { refundId: current.id, orderId: current.order_id });
  }

  private async reconcileInvoiceAfterRefund(client: PoolClient, current: LockedRefundRow, now: Date) {
    const refunded = await client.query<{ total: string }>(
      `SELECT COALESCE(sum(amount_cents), 0)::text AS total FROM refunds WHERE order_id = $1 AND status = 'succeeded'`,
      [current.order_id],
    );
    const netAmount = Math.max(0, Number(current.order_total_cents) - Number(refunded.rows[0]?.total ?? 0));
    const invoiceResult = await client.query<{ id: string; user_id: string; status: string }>(
      `SELECT id, user_id, status FROM invoices WHERE order_id = $1
       AND status IN ('requested', 'processing', 'issued', 'red_pending') FOR UPDATE`, [current.order_id],
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice || invoice.status === 'red_pending') return;
    const nextStatus = invoice.status === 'issued' ? 'red_pending' : netAmount > 0 ? 'requested' : 'cancelled';
    await client.query(
      `UPDATE invoices SET status = $2, amount_cents = CASE WHEN $3 > 0 THEN $3 ELSE amount_cents END,
         failure_reason = CASE WHEN $2 = 'cancelled' THEN '订单已全额退款' ELSE NULL END
       WHERE id = $1`, [invoice.id, nextStatus, netAmount],
    );
    await client.query(
      `INSERT INTO invoice_events(id, invoice_id, actor_id, event_type, from_status, to_status, payload, created_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, $7)`,
      [randomUUID(), invoice.id, invoice.status === 'issued' ? 'INVOICE_RED_REQUIRED' : 'INVOICE_RECALCULATED_AFTER_REFUND',
        invoice.status, nextStatus, JSON.stringify({ refundId: current.id, netAmountCents: netAmount }), now],
    );
    const title = nextStatus === 'red_pending' ? '发票需要红冲' : nextStatus === 'cancelled' ? '发票申请已取消' : '发票金额已更新';
    const body = nextStatus === 'red_pending'
      ? `订单 ${current.order_number} 已退款，原电子发票将进入红冲处理。`
      : nextStatus === 'cancelled'
        ? `订单 ${current.order_number} 已全额退款，未开具的发票申请已自动取消。`
        : `订单 ${current.order_number} 发生退款，发票金额已按实付金额更新。`;
    await this.notify(client, invoice.user_id, title, body, { orderId: current.order_id, invoiceId: invoice.id });
    if (nextStatus === 'red_pending') {
      await this.enqueue(client, 'invoice.red_required', 'INVOICE', invoice.id, { invoiceId: invoice.id, orderId: current.order_id });
    }
  }

  private async failLocked(client: PoolClient, current: LockedRefundRow, errorCode: string, now: Date) {
    if (current.status !== 'provider_pending') return;
    await client.query(`UPDATE refunds SET status = 'failed', review_reason = $2 WHERE id = $1`, [current.id, `渠道处理失败：${errorCode}`]);
    await client.query(`UPDATE payment_intents SET status = 'succeeded' WHERE id = $1 AND status = 'refunding'`, [current.payment_intent_id]);
    if (current.order_status === 'refund_pending' && !current.idempotency_key?.startsWith('auto:')) {
      await client.query(`UPDATE orders SET status = $2 WHERE id = $1`, [current.order_id, current.order_status_before_refund ?? 'paid']);
    }
    await this.notify(client, current.requested_by, '退款处理异常', `订单 ${current.order_number} 的退款未完成，客服将继续跟进。`, { orderId: current.order_id, refundId: current.id });
    await this.enqueue(client, 'refund.review_required', 'REFUND', current.id, { refundId: current.id, errorCode, failedAt: now.toISOString() });
  }

  private async insertEvent(
    client: PoolClient,
    event: RefundLedgerEvent,
    processingError: string | null,
    now: Date,
  ) {
    const result = await client.query(
      `INSERT INTO refund_events(id, provider, provider_event_id, refund_id, provider_refund_id, status,
         amount_cents, currency, signature_valid, payload_digest, normalized_payload, processing_error, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10::jsonb, $11, $12)
       ON CONFLICT DO NOTHING RETURNING id`,
      [randomUUID(), event.provider, event.eventId, event.refundId, event.providerRefundId, event.status,
        event.amountCents, event.currency, event.payloadDigest, JSON.stringify(event.normalizedPayload), processingError, now],
    );
    return Boolean(result.rowCount);
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

  private mapExecution(row: ExecutionRow): RefundExecutionRecord {
    return {
      id: row.id, orderId: row.order_id, userId: row.requested_by, paymentIntentId: row.payment_intent_id,
      provider: row.provider, providerReference: row.provider_reference, providerRefundId: row.provider_refund_id,
      amountCents: Number(row.amount_cents), originalAmountCents: Number(row.original_amount_cents),
      currency: row.currency, reason: row.reason, status: row.status,
    };
  }
}
