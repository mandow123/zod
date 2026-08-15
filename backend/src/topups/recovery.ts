import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { PaymentProvider } from '../payment/providers.js';
import type { PaymentProviderName } from '../payment/types.js';
import type { CreditTopupStore } from './store.js';

type JobRow = QueryResultRow & {
  id: string; subject_id: string; created_by_user_id: string; provider: PaymentProviderName; provider_reference: string;
  amount_cents: string; currency: 'CNY'; expires_at: Date; created_at: Date; reconciliation_attempts: number;
};
export type TopupRecoveryJob = Readonly<{
  id: string; subjectId: string; userId: string; provider: PaymentProviderName; providerReference: string;
  amountCents: number; currency: 'CNY'; expiresAt: Date; createdAt: Date; attempts: number;
}>;

export interface TopupRecoveryStore {
  claim(now: Date, staleBefore: Date, limit: number): Promise<TopupRecoveryJob[]>;
  complete(id: string, now: Date, status: string): Promise<void>;
  reschedule(id: string, now: Date, next: Date, status: string): Promise<void>;
  fail(job: TopupRecoveryJob, now: Date, next: Date, code: string, dead: boolean): Promise<void>;
}

export class PostgresTopupRecoveryStore implements TopupRecoveryStore {
  constructor(private readonly database: Database) {}
  async claim(now: Date, staleBefore: Date, limit: number) {
    const result = await this.database.query<JobRow>(
      `WITH candidates AS (
         SELECT id FROM kai_credit_topups WHERE status = 'pending' AND reconciliation_dead_lettered_at IS NULL
           AND next_reconcile_at <= $1 AND (reconciliation_locked_at IS NULL OR reconciliation_locked_at < $2)
         ORDER BY next_reconcile_at, created_at LIMIT $3 FOR UPDATE SKIP LOCKED
       ) UPDATE kai_credit_topups t SET reconciliation_locked_at = $1 FROM candidates c WHERE t.id = c.id
       RETURNING t.id, t.subject_id, t.created_by_user_id, t.provider, t.provider_reference, t.amount_cents::text,
         t.currency, t.expires_at, t.created_at, t.reconciliation_attempts`, [now, staleBefore, limit],
    );
    return result.rows.map((row) => ({
      id: row.id, subjectId: row.subject_id, userId: row.created_by_user_id, provider: row.provider,
      providerReference: row.provider_reference, amountCents: Number(row.amount_cents), currency: row.currency,
      expiresAt: new Date(row.expires_at), createdAt: new Date(row.created_at), attempts: row.reconciliation_attempts,
    }));
  }
  async complete(id: string, now: Date, status: string) {
    await this.database.query(`UPDATE kai_credit_topups SET reconciliation_locked_at = NULL, last_reconciled_at = $2,
      last_provider_status = $3, last_reconciliation_error = NULL WHERE id = $1`, [id, now, status.slice(0, 80)]);
  }
  async reschedule(id: string, now: Date, next: Date, status: string) {
    await this.database.query(`UPDATE kai_credit_topups SET reconciliation_locked_at = NULL, last_reconciled_at = $2,
      next_reconcile_at = $3, last_provider_status = $4, last_reconciliation_error = NULL,
      reconciliation_attempts = reconciliation_attempts + 1 WHERE id = $1 AND status = 'pending'`, [id, now, next, status.slice(0, 80)]);
  }
  async fail(job: TopupRecoveryJob, now: Date, next: Date, code: string, dead: boolean) {
    await this.database.transaction(async (client) => {
      const updated = await client.query<{ id: string }>(`UPDATE kai_credit_topups SET reconciliation_locked_at = NULL,
        last_reconciled_at = $2, next_reconcile_at = $3, last_reconciliation_error = $4,
        reconciliation_attempts = reconciliation_attempts + 1,
        reconciliation_dead_lettered_at = CASE WHEN $5 THEN $2 ELSE NULL END
        WHERE id = $1 AND status = 'pending' RETURNING id`, [job.id, now, next, code.slice(0, 300), dead]);
      if (!dead || !updated.rows[0]) return;
      const notificationId = randomUUID();
      await client.query(`INSERT INTO notifications(id, user_id, category, title, body, data)
        VALUES ($1, $2, 'payment', '充值结果需要核对', '如已扣款，请勿重复充值。我们会继续核对渠道记录。', $3::jsonb)`,
      [notificationId, job.userId, JSON.stringify({ topupId: job.id, subjectId: job.subjectId })]);
    });
  }
}

type Logger = Readonly<{ info(fields: Record<string, unknown>, message: string): void; error(fields: Record<string, unknown>, message: string): void }>;

export class TopupRecoveryWorker {
  private timer: NodeJS.Timeout | null = null; private running: Promise<void> | null = null; private stopping = false;
  constructor(
    private readonly recovery: TopupRecoveryStore, private readonly topups: CreditTopupStore,
    private readonly providers: ReadonlyMap<PaymentProviderName, PaymentProvider>, private readonly logger: Logger,
    private readonly intervalMs = 15_000, private readonly now: () => Date = () => new Date(),
  ) {}
  start() { if (!this.timer && !this.stopping) { void this.run(); this.timer = setInterval(() => void this.run(), this.intervalMs); this.timer.unref(); } }
  async stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.running; }
  async tick() { await this.run(); }
  private async run() {
    if (this.running || this.stopping) return this.running ?? Promise.resolve();
    this.running = this.process().catch((error: unknown) => this.logger.error({ error: this.code(error) }, 'topup recovery batch failed'))
      .finally(() => { this.running = null; });
    return this.running;
  }
  private async process() {
    const now = this.now(); const jobs = await this.recovery.claim(now, new Date(now.getTime() - 120_000), 50);
    for (const job of jobs) {
      const provider = this.providers.get(job.provider);
      try {
        if (!provider?.queryPayment) throw new Error('TOPUP_QUERY_UNSUPPORTED');
        const result = await provider.queryPayment({ providerReference: job.providerReference, expectedAmountCents: job.amountCents, currency: job.currency });
        if (result.status === 'settled') {
          await this.topups.applyVerifiedEvent(result.event, now);
          await this.recovery.complete(job.id, now, String(result.event.normalizedPayload.tradeStatus ?? result.event.normalizedPayload.tradeState ?? result.event.status));
          continue;
        }
        const dead = now.getTime() - job.createdAt.getTime() >= 48 * 60 * 60_000 || job.attempts + 1 >= 48;
        if (dead) await this.recovery.fail(job, now, now, `TOPUP_STATUS_${result.providerStatus}`, true);
        else await this.recovery.reschedule(job.id, now, new Date(now.getTime() + Math.min(300_000, 20_000 * 2 ** Math.min(job.attempts, 4))), result.providerStatus);
      } catch (error) {
        const dead = now.getTime() - job.createdAt.getTime() >= 48 * 60 * 60_000 || job.attempts + 1 >= 24;
        await this.recovery.fail(job, now, new Date(now.getTime() + Math.min(900_000, 30_000 * 2 ** Math.min(job.attempts, 5))), this.code(error), dead);
      }
    }
    if (jobs.length) this.logger.info({ reconciled: jobs.length }, 'topup recovery batch completed');
  }
  private code(error: unknown) { return error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message.slice(0, 200) : 'TOPUP_RECOVERY_UNKNOWN'; }
}

