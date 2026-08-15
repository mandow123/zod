import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type {
  PaymentChannel, PaymentEventResult, PaymentIntentRecord, PaymentProviderName, VerifiedPaymentEvent,
} from './types.js';

type PaymentRow = QueryResultRow & {
  id: string;
  order_id: string;
  order_number: string;
  buyer_id: string;
  provider: PaymentProviderName;
  provider_reference: string;
  provider_payment_id: string | null;
  channel: PaymentChannel;
  status: PaymentIntentRecord['status'];
  amount_cents: string;
  currency: 'CNY';
  checkout_url: string | null;
  expires_at: Date;
  reconciliation_attempts: number;
  last_reconciled_at: Date | null;
  reconciliation_dead_lettered_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type OrderPaymentRow = QueryResultRow & {
  id: string;
  order_number: string;
  buyer_id: string;
  status: string;
  total_cents: string;
  currency: 'CNY';
  reservation_expires_at: Date;
  reservation_status: string | null;
};

const paymentColumns = `p.id, p.order_id, o.order_number, o.buyer_id, p.provider, p.provider_reference,
  p.provider_payment_id, p.channel, p.status, p.amount_cents::text, p.currency, p.checkout_url,
  p.expires_at, p.reconciliation_attempts, p.last_reconciled_at, p.reconciliation_dead_lettered_at,
  p.created_at, p.updated_at`;

function mapPayment(row: PaymentRow): PaymentIntentRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    buyerId: row.buyer_id,
    provider: row.provider,
    providerReference: row.provider_reference,
    providerPaymentId: row.provider_payment_id,
    channel: row.channel,
    status: row.status,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    checkoutPayload: row.checkout_url,
    expiresAt: new Date(row.expires_at),
    reconciliationAttempts: row.reconciliation_attempts,
    lastReconciledAt: row.last_reconciled_at ? new Date(row.last_reconciled_at) : null,
    reconciliationDeadLetteredAt: row.reconciliation_dead_lettered_at ? new Date(row.reconciliation_dead_lettered_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export type PreparePaymentResult =
  | Readonly<{ status: 'ready'; intent: PaymentIntentRecord }>
  | Readonly<{ status: 'order_not_found' }>
  | Readonly<{ status: 'order_not_payable' }>
  | Readonly<{ status: 'reservation_expired' }>;

export interface PaymentStore {
  prepareIntent(input: Readonly<{
    id: string;
    providerReference: string;
    buyerId: string;
    orderId: string;
    provider: PaymentProviderName;
    channel: PaymentChannel;
    now: Date;
  }>): Promise<PreparePaymentResult>;
  saveCheckout(intentId: string, checkout: Readonly<{ providerPaymentId: string; checkoutPayload: string }>): Promise<PaymentIntentRecord | null>;
  failCheckout(intentId: string): Promise<void>;
  getForBuyer(buyerId: string, orderId: string): Promise<PaymentIntentRecord | null>;
  applyVerifiedEvent(event: VerifiedPaymentEvent, now: Date): Promise<PaymentEventResult>;
}

export class PostgresPaymentStore implements PaymentStore {
  constructor(private readonly database: Database) {}

  async prepareIntent(input: {
    id: string; providerReference: string; buyerId: string; orderId: string;
    provider: PaymentProviderName; channel: PaymentChannel; now: Date;
  }): Promise<PreparePaymentResult> {
    return this.database.transaction(async (client) => {
      const orderResult = await client.query<OrderPaymentRow>(
        `SELECT o.id, o.order_number, o.buyer_id, o.status, o.total_cents::text, o.currency,
           o.reservation_expires_at, r.status AS reservation_status
         FROM orders o LEFT JOIN capacity_reservations r ON r.order_id = o.id
         WHERE o.id = $1 AND o.buyer_id = $2 FOR UPDATE OF o`,
        [input.orderId, input.buyerId],
      );
      const order = orderResult.rows[0];
      if (!order) return { status: 'order_not_found' };
      if (order.status !== 'payment_pending') return { status: 'order_not_payable' };
      if (order.reservation_status !== 'active' || new Date(order.reservation_expires_at) <= input.now) {
        return { status: 'reservation_expired' };
      }

      await client.query(
        `UPDATE payment_intents SET status = 'cancelled'
         WHERE order_id = $1 AND provider <> $2 AND status IN ('created', 'pending')`,
        [input.orderId, input.provider],
      );
      const currentResult = await client.query<PaymentRow>(
        `SELECT ${paymentColumns} FROM payment_intents p JOIN orders o ON o.id = p.order_id
         WHERE p.order_id = $1 AND p.provider = $2 FOR UPDATE OF p`,
        [input.orderId, input.provider],
      );
      const current = currentResult.rows[0];
      if (current && ['created', 'pending'].includes(current.status) && current.channel === input.channel) {
        return { status: 'ready', intent: mapPayment(current) };
      }
      if (current && ['refunding', 'refunded', 'succeeded'].includes(current.status)) {
        return { status: 'order_not_payable' };
      }

      const result = current
        ? await client.query<PaymentRow>(
          `UPDATE payment_intents SET channel = $2, status = 'created', provider_payment_id = NULL,
             checkout_url = NULL, expires_at = $3, reconciliation_attempts = 0,
             next_reconcile_at = $6, reconciliation_locked_at = NULL, last_reconciled_at = NULL,
             last_provider_status = NULL, last_reconciliation_error = NULL, reconciliation_dead_lettered_at = NULL
           WHERE id = $1
           RETURNING id, order_id, $4::text AS order_number, $5::uuid AS buyer_id, provider, provider_reference,
             provider_payment_id, channel, status, amount_cents::text, currency, checkout_url, expires_at,
             reconciliation_attempts, last_reconciled_at, reconciliation_dead_lettered_at, created_at, updated_at`,
          [current.id, input.channel, order.reservation_expires_at, order.order_number, order.buyer_id, input.now],
        )
        : await client.query<PaymentRow>(
          `INSERT INTO payment_intents(id, order_id, provider, provider_reference, channel, status,
             amount_cents, currency, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'created', $6, $7, $8)
           RETURNING id, order_id, $9::text AS order_number, $10::uuid AS buyer_id, provider, provider_reference,
             provider_payment_id, channel, status, amount_cents::text, currency, checkout_url, expires_at,
             reconciliation_attempts, last_reconciled_at, reconciliation_dead_lettered_at, created_at, updated_at`,
          [input.id, order.id, input.provider, input.providerReference, input.channel, order.total_cents,
            order.currency, order.reservation_expires_at, order.order_number, order.buyer_id],
        );
      return { status: 'ready', intent: mapPayment(result.rows[0]!) };
    });
  }

  async saveCheckout(intentId: string, checkout: { providerPaymentId: string; checkoutPayload: string }) {
    const result = await this.database.query<PaymentRow>(
      `UPDATE payment_intents p SET provider_payment_id = $2, checkout_url = $3, status = 'pending',
         next_reconcile_at = now(), reconciliation_locked_at = NULL
       FROM orders o WHERE p.id = $1 AND o.id = p.order_id AND p.status = 'created'
       RETURNING ${paymentColumns}`,
      [intentId, checkout.providerPaymentId, checkout.checkoutPayload],
    );
    return result.rows[0] ? mapPayment(result.rows[0]) : null;
  }

  async failCheckout(intentId: string) {
    await this.database.query(
      `UPDATE payment_intents SET status = 'failed' WHERE id = $1 AND status = 'created'`,
      [intentId],
    );
  }

  async getForBuyer(buyerId: string, orderId: string) {
    const result = await this.database.query<PaymentRow>(
      `SELECT ${paymentColumns} FROM payment_intents p JOIN orders o ON o.id = p.order_id
       WHERE p.order_id = $1 AND o.buyer_id = $2
       ORDER BY CASE p.status WHEN 'succeeded' THEN 0 WHEN 'pending' THEN 1 WHEN 'created' THEN 2 ELSE 3 END,
         p.updated_at DESC LIMIT 1`,
      [orderId, buyerId],
    );
    return result.rows[0] ? mapPayment(result.rows[0]) : null;
  }

  async applyVerifiedEvent(event: VerifiedPaymentEvent, now: Date): Promise<PaymentEventResult> {
    return this.database.transaction(async (client) => {
      const paymentResult = await client.query<PaymentRow & { order_status: string; reservation_status: string | null; listing_id: string; quantity: string }>(
        `SELECT ${paymentColumns}, o.status AS order_status, r.status AS reservation_status,
           o.listing_id, o.quantity::text
         FROM payment_intents p JOIN orders o ON o.id = p.order_id
         LEFT JOIN capacity_reservations r ON r.order_id = o.id
         WHERE p.provider = $1 AND p.provider_reference = $2
         FOR UPDATE OF p, o`,
        [event.provider, event.providerReference],
      );
      const payment = paymentResult.rows[0];
      if (!payment) {
        const inserted = await this.insertEvent(client, event, null, 'unknown_provider_reference', now);
        if (inserted) await this.enqueue(client, 'payment.review_required', 'PAYMENT_EVENT', event.eventId, {
          reason: 'unknown_provider_reference', provider: event.provider, eventId: event.eventId,
        });
        return inserted ? 'unknown_reference' : 'duplicate';
      }

      const mismatch = Number(payment.amount_cents) !== event.amountCents || payment.currency !== event.currency;
      if (mismatch) {
        const inserted = await this.insertEvent(client, event, payment.id, 'amount_or_currency_mismatch', now);
        if (inserted) await this.enqueue(client, 'payment.review_required', 'PAYMENT_INTENT', payment.id, {
          reason: 'amount_or_currency_mismatch', paymentIntentId: payment.id, provider: event.provider,
        });
        return inserted ? 'amount_mismatch' : 'duplicate';
      }

      if (event.status === 'failed') {
        const inserted = await this.insertEvent(client, event, payment.id, null, now);
        if (!inserted) return 'duplicate';
        await client.query(
          `UPDATE payment_intents SET status = 'failed' WHERE id = $1 AND status IN ('created', 'pending')`,
          [payment.id],
        );
        return 'failed';
      }

      if (payment.status === 'succeeded') {
        const inserted = await this.insertEvent(client, event, payment.id, null, now);
        return inserted ? 'succeeded' : 'duplicate';
      }

      const validReservation = payment.order_status === 'payment_pending'
        && payment.reservation_status === 'active'
        && new Date(payment.expires_at) > now;
      if (!validReservation) {
        const inserted = await this.insertEvent(client, event, payment.id, 'refund_required', now);
        if (!inserted) return 'duplicate';
        await client.query(`UPDATE payment_intents SET status = 'refunding' WHERE id = $1`, [payment.id]);
        const refundId = randomUUID();
        await client.query(
          `INSERT INTO refunds(id, order_id, requested_by, payment_intent_id, amount_cents, reason, status,
             idempotency_key, payload_digest, order_status_before_refund)
           VALUES ($1, $2, $3, $4, $5, $6, 'provider_pending', $7, $8, $9)`,
          [refundId, payment.order_id, payment.buyer_id, payment.id, event.amountCents,
            '支付在订单关闭后到账，系统已自动发起原路退款。', `auto:${event.providerTransactionId}`,
            event.payloadDigest, payment.order_status],
        );
        if (payment.order_status === 'payment_pending') {
          await this.releaseExpiredReservation(client, payment.order_id, payment.listing_id, payment.quantity, now);
          await client.query(`UPDATE orders SET status = 'refund_pending' WHERE id = $1`, [payment.order_id]);
        }
        await this.notify(client, payment.buyer_id, 'payment', '付款将在原路退回', '订单付款到达时支付窗口已关闭，我们已自动发起退款。', {
          orderId: payment.order_id, paymentIntentId: payment.id, refundId,
        });
        await this.enqueue(client, 'payment.refund_required', 'PAYMENT_INTENT', payment.id, {
          paymentIntentId: payment.id, refundId, orderId: payment.order_id, provider: event.provider,
          providerTransactionId: event.providerTransactionId, amountCents: event.amountCents,
        });
        await this.enqueue(client, 'refund.execute', 'REFUND', refundId, { refundId, orderId: payment.order_id });
        return 'refund_required';
      }

      const inserted = await this.insertEvent(client, event, payment.id, null, now);
      if (!inserted) return 'duplicate';
      await client.query(
        `UPDATE payment_intents SET status = 'succeeded', succeeded_at = $2, provider_payment_id = COALESCE(provider_payment_id, $3)
         WHERE id = $1`,
        [payment.id, now, event.providerTransactionId],
      );
      await client.query(
        `UPDATE payment_intents SET status = 'cancelled'
         WHERE order_id = $1 AND id <> $2 AND status IN ('created', 'pending')`,
        [payment.order_id, payment.id],
      );
      await client.query(`UPDATE orders SET status = 'paid', paid_at = $2 WHERE id = $1`, [payment.order_id, now]);
      await client.query(
        `INSERT INTO order_events(id, order_id, actor_id, event_type, from_status, to_status, payload)
         VALUES ($1, $2, NULL, 'PAYMENT_CONFIRMED', 'payment_pending', 'paid', $3::jsonb)`,
        [randomUUID(), payment.order_id, JSON.stringify({ paymentIntentId: payment.id, provider: event.provider })],
      );
      await this.notify(client, payment.buyer_id, 'payment', '支付成功', `订单 ${payment.order_number} 已付款，供应商将开始交付。`, {
        orderId: payment.order_id, paymentIntentId: payment.id,
      });
      await this.enqueue(client, 'payment.confirmed', 'ORDER', payment.order_id, {
        orderId: payment.order_id, paymentIntentId: payment.id,
      });
      await client.query(
        `INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id, payload_digest, metadata)
         VALUES ($1, NULL, 'provider', 'PAYMENT_CONFIRMED', 'PAYMENT_INTENT', $2, $3, $4::jsonb)`,
        [randomUUID(), payment.id, event.payloadDigest, JSON.stringify({ provider: event.provider, eventId: event.eventId })],
      );
      return 'succeeded';
    });
  }

  private async insertEvent(
    client: PoolClient, event: VerifiedPaymentEvent, intentId: string | null, processingError: string | null, now: Date,
  ) {
    const result = await client.query(
      `INSERT INTO payment_events(id, provider, provider_event_id, payment_intent_id, signature_valid,
         payload_digest, normalized_payload, provider_transaction_id, processed_at, processing_error)
       VALUES ($1, $2, $3, $4, true, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT DO NOTHING RETURNING id`,
      [randomUUID(), event.provider, event.eventId, intentId, event.payloadDigest,
        JSON.stringify(event.normalizedPayload), event.providerTransactionId, now, processingError],
    );
    return Boolean(result.rowCount);
  }

  private async releaseExpiredReservation(
    client: PoolClient, orderId: string, listingId: string, quantity: string, now: Date,
  ) {
    const released = await client.query(
      `UPDATE capacity_reservations SET status = 'expired', released_at = $2, release_reason = 'payment_arrived_after_expiry'
       WHERE order_id = $1 AND status = 'active' RETURNING id`,
      [orderId, now],
    );
    if (released.rowCount) {
      await client.query(`UPDATE market_listings SET capacity_reserved = capacity_reserved - $2 WHERE id = $1`, [listingId, quantity]);
    }
  }

  private notify(
    client: PoolClient, userId: string, category: string, title: string, body: string, data: Record<string, unknown>,
  ) {
    const notificationId = randomUUID();
    return client.query(
      `INSERT INTO notifications(id, user_id, category, title, body, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [notificationId, userId, category, title, body, JSON.stringify(data)],
    ).then(() => this.enqueue(client, 'notification.created', 'NOTIFICATION', notificationId, { notificationId, userId }));
  }

  private enqueue(
    client: PoolClient, topic: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>,
  ) {
    return client.query(
      `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [randomUUID(), topic, aggregateType, aggregateId, JSON.stringify(payload)],
    ).then(() => undefined);
  }
}
