import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';

export type RefundOutboxJob = Readonly<{
  id: string;
  topic: 'refund.execute' | 'refund.reconcile';
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}>;

type JobRow = QueryResultRow & {
  id: string; topic: RefundOutboxJob['topic']; aggregate_id: string; payload: Record<string, unknown>; attempts: number; created_at: Date;
};

export interface RefundOutboxStore {
  claim(now: Date, staleBefore: Date, limit: number): Promise<RefundOutboxJob[]>;
  complete(jobId: string, now: Date): Promise<void>;
  reschedule(jobId: string, topic: RefundOutboxJob['topic'], availableAt: Date): Promise<void>;
  fail(jobId: string, errorCode: string, availableAt: Date, maxAttempts: number): Promise<Readonly<{ deadLettered: boolean; attempts: number }>>;
}

export class PostgresRefundOutboxStore implements RefundOutboxStore {
  constructor(private readonly database: Database) {}

  async claim(now: Date, staleBefore: Date, limit: number) {
    return this.database.transaction(async (client) => {
      const result = await client.query<JobRow>(
        `WITH candidates AS (
           SELECT id FROM outbox_events
           WHERE topic IN ('refund.execute', 'refund.reconcile') AND processed_at IS NULL
             AND dead_lettered_at IS NULL AND available_at <= $1
             AND (locked_at IS NULL OR locked_at < $2)
           ORDER BY available_at, created_at LIMIT $3 FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events o SET locked_at = $1 FROM candidates c WHERE o.id = c.id
         RETURNING o.id, o.topic, o.aggregate_id, o.payload, o.attempts, o.created_at`,
        [now, staleBefore, limit],
      );
      return result.rows.map((row) => ({
        id: row.id, topic: row.topic, aggregateId: row.aggregate_id, payload: row.payload,
        attempts: row.attempts, createdAt: new Date(row.created_at),
      }));
    });
  }

  async complete(jobId: string, now: Date) {
    await this.database.query(
      `UPDATE outbox_events SET processed_at = $2, locked_at = NULL, last_error = NULL WHERE id = $1`, [jobId, now],
    );
  }

  async reschedule(jobId: string, topic: RefundOutboxJob['topic'], availableAt: Date) {
    await this.database.query(
      `UPDATE outbox_events SET topic = $2, available_at = $3, locked_at = NULL, last_error = NULL WHERE id = $1`,
      [jobId, topic, availableAt],
    );
  }

  async fail(jobId: string, errorCode: string, availableAt: Date, maxAttempts: number) {
    const result = await this.database.query<{ attempts: number; dead_lettered_at: Date | null }>(
      `UPDATE outbox_events SET attempts = attempts + 1, last_error = $2,
         available_at = $3, locked_at = NULL,
         dead_lettered_at = CASE WHEN attempts + 1 >= $4 THEN now() ELSE NULL END
       WHERE id = $1 RETURNING attempts, dead_lettered_at`,
      [jobId, errorCode.slice(0, 300), availableAt, maxAttempts],
    );
    return {
      attempts: result.rows[0]?.attempts ?? maxAttempts,
      deadLettered: Boolean(result.rows[0]?.dead_lettered_at),
    };
  }
}
