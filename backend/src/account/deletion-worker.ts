import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { secretHash } from './crypto.js';
import { deletionBlockersQuery, deletionLegalHoldReason } from './deletion-policy.js';
import type { RuntimeConfig } from '../config.js';
import type { Database } from '../database.js';
import type { WorkerLogger } from '../refunds/processor.js';

type DeletionRow = QueryResultRow & {
  id: string;
  user_id: string;
  phone_lookup_hash: string | null;
};

export type DeletionBatchResult = Readonly<{ completed: number; held: number }>;

export interface AccountDeletionStore {
  processDue(now: Date, limit: number): Promise<DeletionBatchResult>;
}

export class PostgresAccountDeletionStore implements AccountDeletionStore {
  private readonly auditPepper: string;

  constructor(private readonly database: Database, config: RuntimeConfig) {
    if (!config.AUDIT_PEPPER) throw new Error('AUDIT_PEPPER is required.');
    this.auditPepper = config.AUDIT_PEPPER;
  }

  async processDue(now: Date, limit: number) {
    return this.database.transaction(async (client) => {
      const due = await client.query<DeletionRow>(
        `SELECT d.id, d.user_id, u.phone_lookup_hash
         FROM account_deletion_requests d JOIN users u ON u.id = d.user_id
         WHERE d.status IN ('cooling_off', 'blocked_by_legal_hold')
           AND d.cooling_off_until <= $1 AND u.status = 'deletion_pending'
         ORDER BY d.cooling_off_until, d.requested_at
         LIMIT $2 FOR UPDATE OF d SKIP LOCKED`,
        [now, limit],
      );
      let completed = 0;
      let held = 0;
      for (const request of due.rows) {
        const blockers = await client.query<{ blocked: boolean }>(deletionBlockersQuery, [request.user_id]);
        if (blockers.rows[0]?.blocked) {
          await client.query(
            `UPDATE account_deletion_requests SET status = 'blocked_by_legal_hold', legal_hold_reason = $2
             WHERE id = $1`, [request.id, deletionLegalHoldReason],
          );
          held += 1;
          continue;
        }
        await this.anonymize(client, request, now);
        completed += 1;
      }
      return { completed, held };
    });
  }

  private async anonymize(client: PoolClient, request: DeletionRow, now: Date) {
    await client.query(`UPDATE account_deletion_requests SET status = 'processing' WHERE id = $1`, [request.id]);
    await client.query(
      `UPDATE mobile_sessions SET revoked_at = COALESCE(revoked_at, $2), revocation_reason = 'account_anonymized'
       WHERE user_id = $1`, [request.user_id, now],
    );
    await client.query(
      `UPDATE session_refresh_tokens SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2)
       WHERE session_id IN (SELECT id FROM mobile_sessions WHERE user_id = $1) AND status = 'current'`,
      [request.user_id, now],
    );
    await client.query(
      `UPDATE device_installations SET user_id = NULL, device_id = 'anonymized:' || id::text,
         push_enabled = false, push_token_ciphertext = NULL, push_token_lookup_hash = NULL,
         last_push_error = NULL, disabled_at = $2 WHERE user_id = $1`,
      [request.user_id, now],
    );
    await client.query(`DELETE FROM notifications WHERE user_id = $1`, [request.user_id]);
    if (request.phone_lookup_hash) {
      await client.query(`DELETE FROM otp_challenges WHERE destination_hash = $1`, [request.phone_lookup_hash]);
    }
    await client.query(
      `UPDATE compute_demands SET status = 'closed', title = '已关闭需求', product_hint = '已匿名化',
         description = '账户注销，需求已关闭。' WHERE buyer_id = $1 AND status IN ('open', 'matched')`,
      [request.user_id],
    );
    await client.query(
      `UPDATE supplier_profiles s SET legal_name = '已注销主体', credit_code = 'anonymized:' || s.id::text,
         contact_name = '已匿名化' FROM subject_memberships m
       WHERE m.subject_id = s.subject_id AND m.user_id = $1 AND m.status = 'active'
         AND s.status IN ('draft', 'rejected')`,
      [request.user_id],
    );
    await client.query(`UPDATE idempotency_records SET actor_id = NULL WHERE actor_id = $1`, [request.user_id]);
    await client.query(
      `UPDATE users SET phone_ciphertext = 'anonymized:' || id::text, phone_lookup_hash = NULL,
         email_ciphertext = NULL, email_lookup_hash = NULL, display_name = '已注销用户', role = 'member',
         status = 'anonymized', phone_verified_at = NULL, email_verified_at = NULL WHERE id = $1`,
      [request.user_id],
    );
    await client.query(
      `UPDATE account_deletion_requests SET status = 'completed', completed_at = $2, legal_hold_reason = NULL
       WHERE id = $1`, [request.id, now],
    );
    await client.query(
      `INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id,
         request_id, payload_digest, metadata, created_at)
       VALUES ($1, $2, 'system', 'ACCOUNT_ANONYMIZED', 'USER', $6, 'account-deletion-worker', $3, $4::jsonb, $5)`,
      [randomUUID(), request.user_id,
        secretHash(JSON.stringify({ deletionRequestId: request.id }), this.auditPepper),
        JSON.stringify({ deletionRequestId: request.id }), now, request.user_id],
    );
  }
}

export class AccountDeletionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly store: AccountDeletionStore,
    private readonly logger: WorkerLogger,
    private readonly pollMilliseconds = 60_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMilliseconds);
    this.timer.unref();
    void this.tick();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.store.processDue(this.now(), 50);
      if (result.completed || result.held) this.logger.info(result, 'account deletion batch processed');
    } catch (error) {
      this.logger.error({ err: error }, 'account deletion worker failed');
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}
