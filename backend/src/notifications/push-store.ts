import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';

export type PushOutboxJob = Readonly<{
  id: string;
  topic: 'notification.created' | 'push.receipt';
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}>;

export type PushNotificationTarget = Readonly<{
  notificationId: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  installations: readonly Readonly<{ id: string; tokenCiphertext: string }>[];
}>;

export type TicketResult = Readonly<{
  installationId: string;
  status: 'accepted' | 'failed' | 'invalid_device';
  ticketId?: string;
  errorCode?: string;
}>;

export type ReceiptResult = Readonly<{
  installationId: string;
  ticketId: string;
  status: 'delivered' | 'failed' | 'invalid_device';
  errorCode?: string;
}>;

type JobRow = QueryResultRow & {
  id: string; topic: PushOutboxJob['topic']; aggregate_id: string; payload: Record<string, unknown>; attempts: number; created_at: Date;
};

export interface PushOutboxStore {
  claim(now: Date, staleBefore: Date, limit: number): Promise<PushOutboxJob[]>;
  loadNotification(notificationId: string): Promise<PushNotificationTarget | null>;
  recordTickets(job: PushOutboxJob, results: readonly TicketResult[], now: Date, receiptAt: Date): Promise<void>;
  recordReceipts(job: PushOutboxJob, results: readonly ReceiptResult[], now: Date): Promise<void>;
  complete(jobId: string, now: Date): Promise<void>;
  fail(jobId: string, errorCode: string, availableAt: Date, maxAttempts: number): Promise<Readonly<{ deadLettered: boolean; attempts: number }>>;
}

export class PostgresPushOutboxStore implements PushOutboxStore {
  constructor(private readonly database: Database) {}

  async claim(now: Date, staleBefore: Date, limit: number) {
    return this.database.transaction(async (client) => {
      const result = await client.query<JobRow>(
        `WITH candidates AS (
           SELECT id FROM outbox_events
           WHERE topic IN ('notification.created', 'push.receipt') AND processed_at IS NULL
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

  async loadNotification(notificationId: string) {
    const notification = await this.database.query<{
      id: string; title: string; body: string; data: Record<string, unknown>; user_id: string;
    }>(`SELECT id, title, body, data, user_id FROM notifications WHERE id = $1`, [notificationId]);
    const row = notification.rows[0];
    if (!row) return null;
    const installations = await this.database.query<{ id: string; push_token_ciphertext: string }>(
      `SELECT id, push_token_ciphertext FROM device_installations
       WHERE user_id = $1 AND push_enabled = true AND push_token_ciphertext IS NOT NULL AND disabled_at IS NULL
       ORDER BY created_at LIMIT 100`, [row.user_id],
    );
    return {
      notificationId: row.id, title: row.title, body: row.body, data: row.data,
      installations: installations.rows.map((item) => ({ id: item.id, tokenCiphertext: item.push_token_ciphertext })),
    };
  }

  async recordTickets(job: PushOutboxJob, results: readonly TicketResult[], now: Date, receiptAt: Date) {
    await this.database.transaction(async (client) => {
      const accepted: Array<{ installationId: string; ticketId: string }> = [];
      for (const result of results) {
        const status = result.status === 'accepted' ? 'ticket_ok' : result.status;
        await client.query(
          `INSERT INTO push_deliveries(id, notification_id, installation_id, status, expo_ticket_id, error_code, receipt_check_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (notification_id, installation_id) DO UPDATE SET status = EXCLUDED.status,
             expo_ticket_id = EXCLUDED.expo_ticket_id, error_code = EXCLUDED.error_code,
             receipt_check_after = EXCLUDED.receipt_check_after, receipt_checked_at = NULL`,
          [randomUUID(), job.aggregateId, result.installationId, status, result.ticketId ?? null,
            result.errorCode?.slice(0, 200) ?? null, result.ticketId ? receiptAt : null],
        );
        if (result.status === 'accepted' && result.ticketId) {
          accepted.push({ installationId: result.installationId, ticketId: result.ticketId });
          await client.query(
            `UPDATE device_installations SET push_failure_count = 0, last_push_error = NULL WHERE id = $1`,
            [result.installationId],
          );
        } else {
          await this.recordInstallationFailure(client, result.installationId, result.errorCode ?? 'PUSH_TICKET_FAILED', result.status === 'invalid_device', now);
        }
      }
      if (accepted.length) {
        await client.query(
          `UPDATE outbox_events SET topic = 'push.receipt', payload = $2::jsonb, attempts = 0,
             available_at = $3, locked_at = NULL, last_error = NULL WHERE id = $1`,
          [job.id, JSON.stringify({ notificationId: job.aggregateId, receipts: accepted }), receiptAt],
        );
      } else {
        await client.query(
          `UPDATE outbox_events SET processed_at = $2, locked_at = NULL, last_error = NULL WHERE id = $1`, [job.id, now],
        );
      }
    });
  }

  async recordReceipts(job: PushOutboxJob, results: readonly ReceiptResult[], now: Date) {
    await this.database.transaction(async (client) => {
      for (const result of results) {
        await client.query(
          `UPDATE push_deliveries SET status = $3, error_code = $4, receipt_checked_at = $5
           WHERE notification_id = $1 AND installation_id = $2 AND expo_ticket_id = $6`,
          [job.aggregateId, result.installationId, result.status, result.errorCode?.slice(0, 200) ?? null, now, result.ticketId],
        );
        if (result.status === 'delivered') {
          await client.query(
            `UPDATE device_installations SET push_failure_count = 0, last_push_error = NULL WHERE id = $1`,
            [result.installationId],
          );
        } else {
          await this.recordInstallationFailure(client, result.installationId, result.errorCode ?? 'PUSH_RECEIPT_FAILED', result.status === 'invalid_device', now);
        }
      }
      await client.query(
        `UPDATE outbox_events SET processed_at = $2, locked_at = NULL, last_error = NULL WHERE id = $1`, [job.id, now],
      );
    });
  }

  async complete(jobId: string, now: Date) {
    await this.database.query(
      `UPDATE outbox_events SET processed_at = $2, locked_at = NULL, last_error = NULL WHERE id = $1`, [jobId, now],
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
    return { attempts: result.rows[0]?.attempts ?? maxAttempts, deadLettered: Boolean(result.rows[0]?.dead_lettered_at) };
  }

  private async recordInstallationFailure(
    client: Parameters<Parameters<Database['transaction']>[0]>[0], installationId: string,
    errorCode: string, disable: boolean, now: Date,
  ) {
    await client.query(
      `UPDATE device_installations SET push_failure_count = push_failure_count + 1,
         last_push_error = $2,
         push_enabled = CASE WHEN $3 THEN false ELSE push_enabled END,
         push_token_ciphertext = CASE WHEN $3 THEN NULL ELSE push_token_ciphertext END,
         push_token_lookup_hash = CASE WHEN $3 THEN NULL ELSE push_token_lookup_hash END,
         disabled_at = CASE WHEN $3 THEN $4 ELSE disabled_at END
       WHERE id = $1`,
      [installationId, errorCode.slice(0, 200), disable, now],
    );
  }
}
