import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { MarketStore } from '../market/store.js';
import type { PaymentProvider } from './providers.js';
import type { PaymentStore } from './store.js';
import type { PaymentProviderName } from './types.js';

export type PaymentRecoveryJob = Readonly<{
  id: string;
  provider: PaymentProviderName;
  providerReference: string;
  amountCents: number;
  currency: 'CNY';
  expiresAt: Date;
  createdAt: Date;
  attempts: number;
}>;

type RecoveryRow = QueryResultRow & {
  id: string; provider: PaymentProviderName; provider_reference: string; amount_cents: string;
  currency: 'CNY'; expires_at: Date; created_at: Date; reconciliation_attempts: number;
};

export interface PaymentRecoveryStore {
  claim(now: Date, staleBefore: Date, limit: number): Promise<PaymentRecoveryJob[]>;
  complete(jobId: string, now: Date, providerStatus: string): Promise<void>;
  reschedule(jobId: string, now: Date, nextAt: Date, providerStatus: string): Promise<void>;
  fail(jobId: string, now: Date, nextAt: Date, errorCode: string, deadLetter: boolean): Promise<void>;
}

export class PostgresPaymentRecoveryStore implements PaymentRecoveryStore {
  constructor(private readonly database: Database) {}

  async claim(now: Date, staleBefore: Date, limit: number) {
    const result = await this.database.query<RecoveryRow>(
      `WITH candidates AS (
         SELECT id FROM payment_intents
         WHERE status = 'pending' AND reconciliation_dead_lettered_at IS NULL
           AND next_reconcile_at <= $1::timestamptz
           AND (reconciliation_locked_at IS NULL OR reconciliation_locked_at < $2::timestamptz)
         ORDER BY next_reconcile_at, created_at LIMIT $3::integer FOR UPDATE SKIP LOCKED
       )
       UPDATE payment_intents p SET reconciliation_locked_at = $1::timestamptz
       FROM candidates c WHERE p.id = c.id
       RETURNING p.id, p.provider, p.provider_reference, p.amount_cents::text, p.currency,
         p.expires_at, p.created_at, p.reconciliation_attempts`,
      [now, staleBefore, limit],
    );
    return result.rows.map((row) => ({
      id: row.id, provider: row.provider, providerReference: row.provider_reference,
      amountCents: Number(row.amount_cents), currency: row.currency,
      expiresAt: new Date(row.expires_at), createdAt: new Date(row.created_at), attempts: row.reconciliation_attempts,
    }));
  }

  async complete(jobId: string, now: Date, providerStatus: string) {
    await this.database.query(
      `UPDATE payment_intents SET reconciliation_locked_at = NULL, last_reconciled_at = $2::timestamptz,
         last_provider_status = $3::text, last_reconciliation_error = NULL
       WHERE id = $1`, [jobId, now, providerStatus.slice(0, 80)],
    );
  }

  async reschedule(jobId: string, now: Date, nextAt: Date, providerStatus: string) {
    await this.database.query(
      `UPDATE payment_intents SET reconciliation_locked_at = NULL, last_reconciled_at = $2::timestamptz,
         last_provider_status = $4::text, last_reconciliation_error = NULL,
         reconciliation_attempts = reconciliation_attempts + 1, next_reconcile_at = $3::timestamptz
       WHERE id = $1 AND status = 'pending'`, [jobId, now, nextAt, providerStatus.slice(0, 80)],
    );
  }

  async fail(jobId: string, now: Date, nextAt: Date, errorCode: string, deadLetter: boolean) {
    await this.database.transaction(async (client) => {
      const current = await client.query<{ order_id: string; buyer_id: string }>(
        `SELECT p.order_id, o.buyer_id FROM payment_intents p JOIN orders o ON o.id = p.order_id
         WHERE p.id = $1 AND p.status = 'pending' FOR UPDATE OF p`, [jobId],
      );
      const payment = current.rows[0];
      if (payment) await client.query(
        `UPDATE payment_intents SET reconciliation_locked_at = NULL, last_reconciled_at = $2::timestamptz,
           last_reconciliation_error = $4::text, reconciliation_attempts = reconciliation_attempts + 1,
           next_reconcile_at = $3::timestamptz,
           reconciliation_dead_lettered_at = CASE WHEN $5::boolean THEN $2::timestamptz ELSE NULL::timestamptz END
         WHERE id = $1`, [jobId, now, nextAt, errorCode.slice(0, 300), deadLetter],
      );
      if (!payment || !deadLetter) return;
      const notificationId = randomUUID();
      await client.query(
        `INSERT INTO notifications(id, user_id, category, title, body, data)
         VALUES ($1, $2, 'payment', '支付状态需要人工确认', '支付渠道持续无法返回最终状态；如已扣款请勿重复支付，客服将继续核对。', $3::jsonb)`,
        [notificationId, payment.buyer_id, JSON.stringify({ orderId: payment.order_id, paymentIntentId: jobId })],
      );
      await client.query(
        `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
         VALUES ($1, 'notification.created', 'NOTIFICATION', $2, $3::jsonb),
                ($4, 'payment.reconciliation_dead_letter', 'PAYMENT_INTENT', $5, $6::jsonb)`,
        [randomUUID(), notificationId, JSON.stringify({ notificationId, userId: payment.buyer_id }),
          randomUUID(), jobId, JSON.stringify({ paymentIntentId: jobId, orderId: payment.order_id, errorCode })],
      );
    });
  }
}

export type RecoveryLogger = Readonly<{
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}>;

export class PaymentRecoveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly recovery: PaymentRecoveryStore,
    private readonly payments: PaymentStore,
    private readonly market: Pick<MarketStore, 'expireReservations'>,
    private readonly providers: ReadonlyMap<PaymentProviderName, PaymentProvider>,
    private readonly logger: RecoveryLogger,
    private readonly intervalMs = 15_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start() {
    if (this.timer || this.stopping) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  async tick() { await this.run(); }

  private async run() {
    if (this.running || this.stopping) return this.running ?? Promise.resolve();
    this.running = this.processBatch().catch((error: unknown) => {
      this.logger.error({ error: this.errorCode(error), detail: error instanceof Error ? error.message.slice(0, 300) : null }, 'payment recovery batch failed');
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async processBatch() {
    const now = this.now();
    const jobs = await this.recovery.claim(now, new Date(now.getTime() - 2 * 60_000), 50);
    for (const job of jobs) await this.process(job, now);
    let expired: number;
    try {
      expired = await this.market.expireReservations(now, 100);
    } catch (error) {
      this.logger.error({
        stage: 'expire_reservations', error: this.errorCode(error),
        detail: error instanceof Error ? error.message.slice(0, 300) : null,
      }, 'reservation expiry failed');
      throw error;
    }
    if (jobs.length || expired) this.logger.info({ reconciled: jobs.length, expiredReservations: expired }, 'payment recovery batch completed');
  }

  private async process(job: PaymentRecoveryJob, now: Date) {
    const provider = this.providers.get(job.provider);
    try {
      if (!provider?.queryPayment) throw new Error('PAYMENT_QUERY_UNSUPPORTED');
      const result = await provider.queryPayment({
        providerReference: job.providerReference, expectedAmountCents: job.amountCents, currency: job.currency,
      });
      if (result.status === 'settled') {
        await this.payments.applyVerifiedEvent(result.event, now);
        await this.recovery.complete(job.id, now, result.event.normalizedPayload.tradeStatus as string
          ?? result.event.normalizedPayload.tradeState as string ?? result.event.status);
        return;
      }
      const delay = now < job.expiresAt ? 20_000 : Math.min(5 * 60_000, 30_000 * 2 ** Math.min(job.attempts, 4));
      const dead = now.getTime() - job.createdAt.getTime() >= 48 * 60 * 60_000 || job.attempts + 1 >= 48;
      if (dead) await this.recovery.fail(job.id, now, now, `PAYMENT_STATUS_${result.providerStatus}`, true);
      else await this.recovery.reschedule(job.id, now, new Date(now.getTime() + delay), result.providerStatus);
    } catch (error) {
      const code = this.errorCode(error);
      const dead = now.getTime() - job.createdAt.getTime() >= 48 * 60 * 60_000 || job.attempts + 1 >= 24;
      const delay = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(job.attempts, 5));
      await this.recovery.fail(job.id, now, new Date(now.getTime() + delay), code, dead);
      this.logger.error({
        paymentIntentId: job.id, provider: job.provider, error: code,
        detail: error instanceof Error ? error.message.slice(0, 300) : null, deadLettered: dead,
      }, 'payment reconciliation failed');
    }
  }

  private errorCode(error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
    if (error instanceof Error) return error.message.slice(0, 200);
    return 'PAYMENT_RECOVERY_UNKNOWN_ERROR';
  }
}
