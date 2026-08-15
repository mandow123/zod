import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../credits/types.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import type { ProviderCheckout } from '../payment/types.js';
import type { CreditTopupRecord, TopupEventResult, VerifiedTopupEvent } from './types.js';

type TopupRow = QueryResultRow & {
  id: string; subject_id: string; created_by_user_id: string; provider: CreditTopupRecord['provider'];
  provider_reference: string; provider_payment_id: string | null; provider_transaction_id: string | null;
  channel: CreditTopupRecord['channel']; status: CreditTopupRecord['status']; amount_cents: string; currency: 'CNY';
  credit_micros: string; conversion_cny_micros_per_credit: string; checkout_payload: string | null;
  expires_at: Date; succeeded_at: Date | null; reconciliation_attempts: number;
  last_reconciled_at: Date | null; reconciliation_dead_lettered_at: Date | null; created_at: Date; updated_at: Date;
};

const topupColumns = `id, subject_id, created_by_user_id, provider, provider_reference, provider_payment_id,
  provider_transaction_id, channel, status, amount_cents::text, currency, credit_micros::text,
  conversion_cny_micros_per_credit::text, checkout_payload, expires_at, succeeded_at,
  reconciliation_attempts, last_reconciled_at, reconciliation_dead_lettered_at, created_at, updated_at`;

function mapTopup(row: TopupRow): CreditTopupRecord {
  return {
    id: row.id, subjectId: row.subject_id, createdByUserId: row.created_by_user_id, provider: row.provider,
    providerReference: row.provider_reference, providerPaymentId: row.provider_payment_id,
    providerTransactionId: row.provider_transaction_id, channel: row.channel, status: row.status,
    amountCents: Number(row.amount_cents), currency: row.currency, creditMicros: BigInt(row.credit_micros),
    conversionCnyMicrosPerCredit: BigInt(row.conversion_cny_micros_per_credit), checkoutPayload: row.checkout_payload,
    expiresAt: new Date(row.expires_at), succeededAt: row.succeeded_at ? new Date(row.succeeded_at) : null,
    reconciliationAttempts: row.reconciliation_attempts,
    lastReconciledAt: row.last_reconciled_at ? new Date(row.last_reconciled_at) : null,
    reconciliationDeadLetteredAt: row.reconciliation_dead_lettered_at ? new Date(row.reconciliation_dead_lettered_at) : null,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

export type PrepareTopupResult =
  | Readonly<{ status: 'created' | 'replayed'; topup: CreditTopupRecord }>
  | Readonly<{ status: 'conflict' }>;

export interface CreditTopupStore {
  prepare(input: Readonly<{
    id: string; subjectId: string; userId: string; provider: CreditTopupRecord['provider'];
    providerReference: string; channel: CreditTopupRecord['channel']; amountCents: number; creditMicros: bigint;
    conversionCnyMicrosPerCredit: bigint; clientRequestId: string; payloadDigest: string; expiresAt: Date;
  }>): Promise<PrepareTopupResult>;
  saveCheckout(topupId: string, checkout: ProviderCheckout): Promise<CreditTopupRecord | null>;
  failCheckout(topupId: string): Promise<void>;
  get(subjectId: string, topupId: string): Promise<CreditTopupRecord | null>;
  list(subjectId: string, limit: number): Promise<CreditTopupRecord[]>;
  applyVerifiedEvent(event: VerifiedTopupEvent, now: Date): Promise<TopupEventResult>;
}

export class PostgresCreditTopupStore implements CreditTopupStore {
  constructor(private readonly database: Database) {}

  async prepare(input: Parameters<CreditTopupStore['prepare']>[0]): Promise<PrepareTopupResult> {
    return this.database.transaction(async (client) => {
      const replay = await client.query<TopupRow & { payload_digest: string }>(
        `SELECT ${topupColumns}, payload_digest FROM kai_credit_topups
         WHERE subject_id = $1 AND client_request_id = $2 FOR UPDATE`, [input.subjectId, input.clientRequestId],
      );
      if (replay.rows[0]) return replay.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', topup: mapTopup(replay.rows[0]) }
        : { status: 'conflict' };
      const result = await client.query<TopupRow>(
        `INSERT INTO kai_credit_topups(id, subject_id, created_by_user_id, client_request_id, payload_digest,
          provider, channel, provider_reference, amount_cents, credit_micros, conversion_cny_micros_per_credit, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${topupColumns}`,
        [input.id, input.subjectId, input.userId, input.clientRequestId, input.payloadDigest, input.provider,
          input.channel, input.providerReference, input.amountCents, input.creditMicros.toString(),
          input.conversionCnyMicrosPerCredit.toString(), input.expiresAt],
      );
      return { status: 'created', topup: mapTopup(result.rows[0]!) };
    });
  }

  async saveCheckout(topupId: string, checkout: ProviderCheckout) {
    const result = await this.database.query<TopupRow>(
      `UPDATE kai_credit_topups SET provider_payment_id = $2, checkout_payload = $3, status = 'pending',
         next_reconcile_at = now(), reconciliation_locked_at = NULL
       WHERE id = $1 AND status = 'created' RETURNING ${topupColumns}`,
      [topupId, checkout.providerPaymentId, checkout.checkoutPayload],
    );
    return result.rows[0] ? mapTopup(result.rows[0]) : null;
  }

  async failCheckout(topupId: string) {
    await this.database.query(`UPDATE kai_credit_topups SET last_reconciliation_error = 'CHECKOUT_CREATION_FAILED'
      WHERE id = $1 AND status = 'created'`, [topupId]);
  }

  async get(subjectId: string, topupId: string) {
    const result = await this.database.query<TopupRow>(
      `SELECT ${topupColumns} FROM kai_credit_topups WHERE id = $1 AND subject_id = $2`, [topupId, subjectId],
    );
    return result.rows[0] ? mapTopup(result.rows[0]) : null;
  }

  async list(subjectId: string, limit: number) {
    const result = await this.database.query<TopupRow>(
      `SELECT ${topupColumns} FROM kai_credit_topups WHERE subject_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [subjectId, limit],
    );
    return result.rows.map(mapTopup);
  }

  async applyVerifiedEvent(event: VerifiedTopupEvent, now: Date): Promise<TopupEventResult> {
    return this.database.transaction(async (client) => {
      const result = await client.query<TopupRow>(
        `SELECT ${topupColumns} FROM kai_credit_topups WHERE provider = $1 AND provider_reference = $2 FOR UPDATE`,
        [event.provider, event.providerReference],
      );
      const topup = result.rows[0] ? mapTopup(result.rows[0]) : null;
      const eventExists = await client.query<{ processing_result: string }>(
        `SELECT processing_result FROM kai_credit_topup_events WHERE provider = $1 AND provider_event_id = $2`,
        [event.provider, event.eventId],
      );
      if (eventExists.rows[0]) return 'duplicate';
      if (!topup) {
        await this.insertEvent(client, event, null, 'unknown_reference', now);
        return 'unknown_reference';
      }
      if (topup.amountCents !== event.amountCents || topup.currency !== event.currency) {
        await this.insertEvent(client, event, topup.id, 'amount_or_currency_mismatch', now);
        await client.query(`UPDATE kai_credit_topups SET status = 'manual_review' WHERE id = $1 AND status <> 'succeeded'`, [topup.id]);
        return 'amount_mismatch';
      }
      if (event.status === 'failed') {
        await this.insertEvent(client, event, topup.id, 'failed', now);
        await client.query(`UPDATE kai_credit_topups SET status = 'failed' WHERE id = $1 AND status IN ('created', 'pending')`, [topup.id]);
        return 'failed';
      }
      if (topup.status === 'succeeded') {
        await this.insertEvent(client, event, topup.id, 'duplicate', now);
        return 'duplicate';
      }
      if (topup.status === 'manual_review') {
        await this.insertEvent(client, event, topup.id, 'manual_review', now);
        return 'manual_review';
      }
      const claimed = await client.query<{ topup_id: string }>(
        `INSERT INTO kai_credit_topup_provider_claims(provider, provider_transaction_id, topup_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING topup_id`,
        [event.provider, event.providerTransactionId, topup.id],
      );
      if (!claimed.rows[0]) {
        await this.insertEvent(client, event, topup.id, 'provider_transaction_conflict', now);
        await client.query(`UPDATE kai_credit_topups SET status = 'manual_review' WHERE id = $1`, [topup.id]);
        return 'provider_transaction_conflict';
      }

      const available = await this.ensureAvailableAccount(client, topup.subjectId);
      const ledgerTransactionId = randomUUID();
      await client.query(
        `INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key, payload_digest,
          reference_type, reference_id, description, status)
         VALUES ($1, $2, 'CREDIT_TOPUP_CAPTURE', $3, $4, 'topup', $5, $6, 'pending')`,
        [ledgerTransactionId, `subject:${topup.subjectId}`, `topup:${topup.id}`, event.payloadDigest,
          topup.id, `卡时充值 ${topup.providerReference}`],
      );
      await client.query(
        `INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
         ($1, $2, $3, $4, '充值卡时到账'), ($5, $2, $6, $7, '卡时发行')`,
        [randomUUID(), ledgerTransactionId, available, topup.creditMicros.toString(), randomUUID(),
          KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, (-topup.creditMicros).toString()],
      );
      await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`, [ledgerTransactionId, now]);
      await this.insertEvent(client, event, topup.id, 'succeeded', now);
      await client.query(
        `UPDATE kai_credit_topups SET status = 'succeeded', succeeded_at = $2,
          provider_transaction_id = $3, provider_payment_id = COALESCE(provider_payment_id, $3),
          reconciliation_locked_at = NULL, last_reconciled_at = $2, last_provider_status = 'SUCCESS'
         WHERE id = $1`, [topup.id, now, event.providerTransactionId],
      );
      const users = await client.query<{ user_id: string }>(
        `SELECT user_id FROM subject_memberships WHERE subject_id = $1 AND status = 'active' AND role IN ('owner', 'admin')`,
        [topup.subjectId],
      );
      for (const user of users.rows) {
        const notificationId = randomUUID();
        await client.query(
          `INSERT INTO notifications(id, user_id, category, title, body, data)
           VALUES ($1, $2, 'payment', '卡时已到账', $3, $4::jsonb)`,
          [notificationId, user.user_id, `${formatCreditDisplayMicros(topup.creditMicros)} KAI 卡时已加入当前账户。`,
            JSON.stringify({ topupId: topup.id, subjectId: topup.subjectId })],
        );
      }
      return 'succeeded';
    });
  }

  private async ensureAvailableAccount(client: PoolClient, subjectId: string) {
    await client.query(
      `INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
       VALUES ($1, 'subject', $2, $3, 'available', false)
       ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
      [randomUUID(), subjectId, `subject:${subjectId}:available`],
    );
    const result = await client.query<{ id: string }>(
      `SELECT id FROM kai_credit_accounts WHERE subject_id = $1 AND account_kind = 'available' FOR UPDATE`, [subjectId],
    );
    if (!result.rows[0]) throw new Error('KAI_CREDIT_AVAILABLE_ACCOUNT_MISSING');
    return result.rows[0].id;
  }

  private insertEvent(client: PoolClient, event: VerifiedTopupEvent, topupId: string | null, result: string, now: Date) {
    return client.query(
      `INSERT INTO kai_credit_topup_events(id, provider, provider_event_id, topup_id, provider_transaction_id,
        status, amount_cents, currency, payload_digest, normalized_payload, processing_result, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
      [randomUUID(), event.provider, event.eventId, topupId, event.providerTransactionId, event.status,
        event.amountCents, event.currency, event.payloadDigest, JSON.stringify(event.normalizedPayload), result, now],
    ).then(() => undefined);
  }

}
