import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { CreditAccountBalance, SubjectCreditAccountKind } from './types.js';

type AccountRow = QueryResultRow & { id: string; account_kind: SubjectCreditAccountKind; amount_micros: string };
type TransactionRow = QueryResultRow & { id: string; payload_digest: string; status: 'pending' | 'posted' };

export type PostCreditTransactionInput = Readonly<{
  id: string;
  idempotencyOwner: string;
  scope: string;
  idempotencyKey: string;
  payloadDigest: string;
  referenceType: 'topup' | 'order_reservation' | 'order_release' | 'order_capture' | 'refund' | 'settlement' | 'payout' | 'adjustment';
  referenceId?: string;
  description: string;
  entries: ReadonlyArray<Readonly<{ accountId: string; amountMicros: bigint; memo: string }>>;
}>;

export type PostCreditTransactionResult =
  | Readonly<{ status: 'created' | 'replayed'; transactionId: string }>
  | Readonly<{ status: 'conflict' | 'in_progress' }>;

export interface CreditLedgerStore {
  ensureSubjectAccounts(subjectId: string): Promise<CreditAccountBalance[]>;
  post(input: PostCreditTransactionInput): Promise<PostCreditTransactionResult>;
}

// Payout-frozen is provisioned only when the payout feature is used. Keeping
// the three long-lived accounts here also makes the payout migration safe to
// roll out after the existing ledger service.
const accountKinds: SubjectCreditAccountKind[] = ['available', 'reserved', 'supplier_receivable'];

export class PostgresCreditLedgerStore implements CreditLedgerStore {
  constructor(private readonly database: Database) {}

  async ensureSubjectAccounts(subjectId: string) {
    return this.database.transaction(async (client) => {
      const subject = await client.query<{ id: string }>(
        `SELECT id FROM trading_subjects WHERE id = $1 AND status = 'active' FOR UPDATE`, [subjectId],
      );
      if (!subject.rows[0]) throw new Error('ACTIVE_TRADING_SUBJECT_REQUIRED');
      for (const kind of accountKinds) {
        await client.query(
          `INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
           VALUES ($1, 'subject', $2, $3, $4, false)
           ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
          [randomUUID(), subjectId, `subject:${subjectId}:${kind}`, kind],
        );
      }
      const result = await client.query<AccountRow>(
        `SELECT a.id, a.account_kind,
          COALESCE(sum(e.amount_micros) FILTER (WHERE t.status = 'posted'), 0)::text AS amount_micros
         FROM kai_credit_accounts a
         LEFT JOIN kai_credit_entries e ON e.account_id = a.id
         LEFT JOIN kai_credit_transactions t ON t.id = e.transaction_id
         WHERE a.subject_id = $1 GROUP BY a.id, a.account_kind ORDER BY a.account_kind`, [subjectId],
      );
      return result.rows.map((row) => ({ accountId: row.id, kind: row.account_kind, amountMicros: BigInt(row.amount_micros) }));
    });
  }

  async post(input: PostCreditTransactionInput): Promise<PostCreditTransactionResult> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<TransactionRow>(
        `SELECT id, payload_digest, status FROM kai_credit_transactions
         WHERE idempotency_owner = $1 AND scope = $2 AND idempotency_key = $3 FOR UPDATE`,
        [input.idempotencyOwner, input.scope, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].payload_digest !== input.payloadDigest) return { status: 'conflict' };
        return existing.rows[0].status === 'posted'
          ? { status: 'replayed', transactionId: existing.rows[0].id }
          : { status: 'in_progress' };
      }

      const accountIds = [...new Set(input.entries.map((entry) => entry.accountId))].sort();
      const locked = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM kai_credit_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [accountIds],
      );
      if (locked.rows.length !== accountIds.length || locked.rows.some((account) => account.status !== 'active')) {
        throw new Error('KAI_CREDIT_ACCOUNT_UNAVAILABLE');
      }
      await client.query(
        `INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key, payload_digest,
          reference_type, reference_id, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        [input.id, input.idempotencyOwner, input.scope, input.idempotencyKey, input.payloadDigest,
          input.referenceType, input.referenceId ?? null, input.description],
      );
      for (const entry of input.entries) {
        await client.query(
          `INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), input.id, entry.accountId, entry.amountMicros.toString(), entry.memo],
        );
      }
      await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = now() WHERE id = $1`, [input.id]);
      return { status: 'created', transactionId: input.id };
    });
  }
}
