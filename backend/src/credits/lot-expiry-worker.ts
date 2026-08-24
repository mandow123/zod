import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from './types.js';

type ExpiringLotRow = QueryResultRow & {
  id: string;
  subject_id: string;
  source_topup_id: string;
  available_micros: string;
};

type Logger = Readonly<{
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}>;

export class PostgresCreditLotExpiryStore {
  constructor(private readonly database: Database) {}

  sweep(now: Date, limit: number) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('QIXIANG_LOT_EXPIRY_INPUT_INVALID');
    }
    return this.database.transaction(async (client) => {
      const lots = await client.query<ExpiringLotRow>(`SELECT id,subject_id,source_topup_id,available_micros::text
        FROM kai_credit_lots WHERE expires_at<=$1 AND available_micros>0
        ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit]);
      for (const lot of lots.rows) {
        const amount = BigInt(lot.available_micros);
        const available = await client.query<{ id: string }>(`SELECT id FROM kai_credit_accounts
          WHERE subject_id=$1 AND account_kind='available' AND status='active' FOR UPDATE`, [lot.subject_id]);
        const issuance = await client.query<{ id: string }>(`SELECT id FROM kai_credit_accounts
          WHERE id=$1 AND owner_kind='platform' AND account_kind='platform_issuance' AND status='active' FOR UPDATE`,
        [KAI_CREDIT_PLATFORM_ACCOUNTS.issuance]);
        if (!available.rows[0] || !issuance.rows[0]) throw new Error('QIXIANG_LOT_EXPIRY_ACCOUNTS_UNAVAILABLE');
        const transactionId = randomUUID();
        const owner = `subject:${lot.subject_id}`;
        const key = `qixiang-lot-expire:${lot.id}`;
        const digest = createHash('sha256').update(`${key}:${amount}:${now.toISOString()}`).digest('hex');
        await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,
          payload_digest,reference_type,reference_id,description,status)
          VALUES($1,$2,'QIXIANG_LOT_EXPIRE',$3,$4,'adjustment',$5,'七相卡时到期核销','pending')`,
        [transactionId, owner, key, digest, lot.id]);
        await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
          ($1,$2,$3,$4,'到期卡时扣减'),($5,$2,$6,$7,'到期卡时核销')`,
        [randomUUID(), transactionId, available.rows[0].id, (-amount).toString(), randomUUID(),
          issuance.rows[0].id, amount.toString()]);
        await client.query(`UPDATE kai_credit_lots SET available_micros=available_micros-$2,
          expired_micros=expired_micros+$2 WHERE id=$1`, [lot.id, amount.toString()]);
        await client.query(`INSERT INTO kai_credit_lot_movements(id,lot_id,allocation_id,ledger_transaction_id,
          kind,amount_micros,from_bucket,to_bucket,idempotency_owner,scope,idempotency_key,payload_digest,occurred_at)
          VALUES($1,$2,NULL,$3,'expire',$4,'available','expired',$5,'QIXIANG_LOT_EXPIRE',$6,$7,$8)`,
        [randomUUID(), lot.id, transactionId, amount.toString(), owner, key, digest, now]);
        await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2
          WHERE id=$1 AND status='pending'`, [transactionId, now]);
        await client.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,payload)
          VALUES($1,'qixiang.credit_lot.expired','QIXIANG_CREDIT_LOT',$2,$3::jsonb)`,
        [randomUUID(), lot.id, JSON.stringify({ lotId: lot.id, subjectId: lot.subject_id,
          sourceTopupId: lot.source_topup_id, expiredMicros: amount.toString() })]);
      }
      return lots.rows.length;
    });
  }
}

export class CreditLotExpiryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private readonly startedAt: Date;
  private lastAttemptAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private consecutiveFailures = 0;
  constructor(private readonly store: PostgresCreditLotExpiryStore, private readonly logger: Logger,
    private readonly intervalMs = 60_000, private readonly now: () => Date = () => new Date()) {
    this.startedAt = this.now();
  }
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
  async tick(limit = 100) { return this.store.sweep(this.now(), limit); }
  async runOnce(){await this.run();}
  health(at = this.now()) {
    const graceMs = Math.max(this.intervalMs * 2, 120_000);
    const recentSuccess = this.lastSuccessAt !== null && at.getTime() - this.lastSuccessAt.getTime() <= graceMs;
    const starting = this.lastSuccessAt === null && at.getTime() - this.startedAt.getTime() <= graceMs;
    return { ready: !this.stopping && this.consecutiveFailures < 3 && (recentSuccess || starting),
      consecutiveFailures: this.consecutiveFailures,lastAttemptAt:this.lastAttemptAt?.toISOString()??null,
      lastSuccessAt:this.lastSuccessAt?.toISOString()??null } as const;
  }
  private run() {
    if (this.running || this.stopping) return this.running ?? Promise.resolve();
    this.lastAttemptAt=this.now();
    this.running = this.tick().then((processed) => {
      this.lastSuccessAt=this.now();this.consecutiveFailures=0;
      if (processed) this.logger.info({ processed }, 'qixiang credit lot expiry batch completed');
    }).catch((error: unknown) => {this.consecutiveFailures+=1;this.logger.error({
      error: error instanceof Error ? error.message.slice(0, 100) : 'QIXIANG_LOT_EXPIRY_UNKNOWN',
      consecutiveFailures:this.consecutiveFailures,
    }, 'qixiang credit lot expiry batch failed');}).finally(() => { this.running = null; });
    return this.running;
  }
}
