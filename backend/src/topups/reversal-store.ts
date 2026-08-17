import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../credits/types.js';
import { quantizeCreditMicros } from '../credits/precision.js';

export type TopupReversalStatus = 'submitted' | 'credit_recovered_external_unverified' | 'rejected' | 'cancelled';
export type TopupReversalRecord = Readonly<{
  id: string; topupId: string; subjectId: string; provider: 'alipay' | 'wechat'; kind: 'refund' | 'chargeback';
  providerEventReference: string; evidenceDigest: string; amountCents: number; creditMicros: bigint;
  status: TopupReversalStatus; requestedByOperatorId: string; approvedByOperatorId: string | null;
  recoveryTransactionId: string | null; resolutionReason: string | null; requestedAt: Date; resolvedAt: Date | null;
}>;

type Row = QueryResultRow & {
  id: string; topup_id: string; subject_id: string; provider: 'alipay' | 'wechat'; kind: 'refund' | 'chargeback';
  provider_event_reference: string; evidence_digest: string; amount_cents: string; credit_micros: string;
  status: TopupReversalStatus; requested_by_operator_id: string; approved_by_operator_id: string | null;
  recovery_transaction_id: string | null; resolution_reason: string | null; requested_at: Date; resolved_at: Date | null;
};

const columns = `id,topup_id,subject_id,provider,kind,provider_event_reference,evidence_digest,
  amount_cents::text,credit_micros::text,status,requested_by_operator_id,approved_by_operator_id,
  recovery_transaction_id,resolution_reason,requested_at,resolved_at`;

function map(row: Row): TopupReversalRecord {
  return { id: row.id, topupId: row.topup_id, subjectId: row.subject_id, provider: row.provider, kind: row.kind,
    providerEventReference: row.provider_event_reference, evidenceDigest: row.evidence_digest,
    amountCents: Number(row.amount_cents), creditMicros: BigInt(row.credit_micros), status: row.status,
    requestedByOperatorId: row.requested_by_operator_id, approvedByOperatorId: row.approved_by_operator_id,
    recoveryTransactionId: row.recovery_transaction_id, resolutionReason: row.resolution_reason,
    requestedAt: new Date(row.requested_at), resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null };
}

export type CreateTopupReversalResult =
  | { status: 'created' | 'replayed'; reversal: TopupReversalRecord }
  | { status: 'conflict' | 'topup_not_found' | 'topup_not_settled' | 'amount_exceeds_remaining' };
export type RecoverTopupReversalResult =
  | { status: 'updated' | 'replayed'; reversal: TopupReversalRecord }
  | { status: 'not_found' | 'invalid_state' | 'same_operator' | 'insufficient_credits' };

export class PostgresTopupReversalStore {
  constructor(private readonly database: Database) {}

  async create(input: Readonly<{ id: string; topupId: string; operatorId: string; kind: 'refund' | 'chargeback';
    amountCents: number; providerEventReference: string; evidenceDigest: string; clientRequestId: string;
    payloadDigest: string; now: Date }>): Promise<CreateTopupReversalResult> {
    return this.database.transaction(async (client) => {
      const replay = await client.query<Row & { payload_digest: string }>(`SELECT ${columns},payload_digest
        FROM kai_credit_topup_reversals WHERE requested_by_operator_id=$1 AND client_request_id=$2 FOR UPDATE`,
      [input.operatorId, input.clientRequestId]);
      if (replay.rows[0]) return replay.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', reversal: map(replay.rows[0]) } : { status: 'conflict' };
      const topup = await client.query<{ subject_id: string; provider: 'alipay' | 'wechat'; status: string;
        amount_cents: string; credit_micros: string; reversed_amount_cents: string; reversed_credit_micros: string }>(
        `SELECT subject_id,provider,status,amount_cents::text,credit_micros::text,reversed_amount_cents::text,
          reversed_credit_micros::text FROM kai_credit_topups WHERE id=$1 FOR UPDATE`, [input.topupId]);
      const current = topup.rows[0];
      if (!current) return { status: 'topup_not_found' };
      if (current.status !== 'succeeded') return { status: 'topup_not_settled' };
      const pending = await client.query<{ cents: string; credits: string }>(`SELECT
        COALESCE(sum(amount_cents),0)::text cents,COALESCE(sum(credit_micros),0)::text credits
        FROM kai_credit_topup_reversals WHERE topup_id=$1 AND status='submitted'`, [input.topupId]);
      const allocatedCents = BigInt(current.reversed_amount_cents) + BigInt(pending.rows[0]?.cents ?? '0');
      const allocatedCredits = BigInt(current.reversed_credit_micros) + BigInt(pending.rows[0]?.credits ?? '0');
      const totalCents = BigInt(current.amount_cents); const requestedCents = BigInt(input.amountCents);
      if (requestedCents <= 0n || allocatedCents + requestedCents > totalCents) return { status: 'amount_exceeds_remaining' };
      const totalCredits = BigInt(current.credit_micros);
      const cumulativeCents = allocatedCents + requestedCents;
      const cumulativeCredits = cumulativeCents === totalCents
        ? totalCredits
        : quantizeCreditMicros(totalCredits * cumulativeCents / totalCents, 'floor');
      const creditMicros = cumulativeCredits - allocatedCredits;
      if (creditMicros <= 0n) return { status: 'amount_exceeds_remaining' };
      const inserted = await client.query<Row>(`INSERT INTO kai_credit_topup_reversals(id,topup_id,subject_id,
        provider,kind,provider_event_reference,evidence_digest,amount_cents,credit_micros,status,
        requested_by_operator_id,client_request_id,payload_digest,requested_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',$10,$11,$12,$13) RETURNING ${columns}`,
      [input.id,input.topupId,current.subject_id,current.provider,input.kind,input.providerEventReference,
        input.evidenceDigest,input.amountCents,creditMicros.toString(),input.operatorId,input.clientRequestId,
        input.payloadDigest,input.now]);
      return { status: 'created', reversal: map(inserted.rows[0]!) };
    });
  }

  async recoverCredits(input: Readonly<{ reversalId: string; operatorId: string; now: Date }>): Promise<RecoverTopupReversalResult> {
    return this.database.transaction(async (client) => {
      const result = await client.query<Row>(`SELECT ${columns} FROM kai_credit_topup_reversals WHERE id=$1 FOR UPDATE`,
        [input.reversalId]);
      const reversal = result.rows[0] ? map(result.rows[0]) : null;
      if (!reversal) return { status: 'not_found' };
      if (reversal.status === 'credit_recovered_external_unverified') return { status: 'replayed', reversal };
      if (reversal.status !== 'submitted') return { status: 'invalid_state' };
      if (reversal.requestedByOperatorId === input.operatorId) return { status: 'same_operator' };
      const available = await this.lockAvailable(client, reversal.subjectId);
      const balance = await client.query<{ amount: string }>(`SELECT COALESCE(sum(e.amount_micros),0)::text amount
        FROM kai_credit_entries e JOIN kai_credit_transactions t ON t.id=e.transaction_id AND t.status='posted'
        WHERE e.account_id=$1`, [available]);
      if (BigInt(balance.rows[0]?.amount ?? '0') < reversal.creditMicros) return { status: 'insufficient_credits' };
      const transactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,
        payload_digest,reference_type,reference_id,description,status)
        VALUES($1,$2,'CREDIT_TOPUP_REVERSAL_RECOVERY',$3,$4,'refund',$5,$6,'pending')`,
      [transactionId,`subject:${reversal.subjectId}`,`topup-reversal:${reversal.id}`,reversal.evidenceDigest,
        reversal.topupId,`充值冲正卡时回收 ${reversal.providerEventReference}`]);
      await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
        ($1,$2,$3,$4,'充值退款或拒付卡时回收'),($5,$2,$6,$7,'冲正已发行卡时')`,
      [randomUUID(),transactionId,available,(-reversal.creditMicros).toString(),randomUUID(),
        KAI_CREDIT_PLATFORM_ACCOUNTS.issuance,reversal.creditMicros.toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,
        [transactionId,input.now]);
      await client.query(`UPDATE kai_credit_topups SET reversed_amount_cents=reversed_amount_cents+$2,
        reversed_credit_micros=reversed_credit_micros+$3 WHERE id=$1`,
      [reversal.topupId,reversal.amountCents,reversal.creditMicros.toString()]);
      const updated = await client.query<Row>(`UPDATE kai_credit_topup_reversals
        SET status='credit_recovered_external_unverified',approved_by_operator_id=$2,
          recovery_transaction_id=$3,resolved_at=$4
        WHERE id=$1 AND status='submitted' RETURNING ${columns}`,
      [reversal.id,input.operatorId,transactionId,input.now]);
      if (!updated.rows[0]) throw new Error('KAI_CREDIT_TOPUP_REVERSAL_STATE_CHANGED');
      return { status: 'updated', reversal: map(updated.rows[0]) };
    });
  }

  async listForTopup(topupId: string) {
    const result = await this.database.query<Row>(`SELECT ${columns} FROM kai_credit_topup_reversals
      WHERE topup_id=$1 ORDER BY requested_at DESC,id DESC`, [topupId]);
    return result.rows.map(map);
  }

  private async lockAvailable(client: PoolClient, subjectId: string) {
    await client.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
      VALUES($1,'subject',$2,$3,'available',false)
      ON CONFLICT(subject_id,account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
    [randomUUID(),subjectId,`subject:${subjectId}:available`]);
    const result = await client.query<{ id: string }>(`SELECT id FROM kai_credit_accounts
      WHERE subject_id=$1 AND account_kind='available' FOR UPDATE`, [subjectId]);
    if (!result.rows[0]) throw new Error('KAI_CREDIT_AVAILABLE_ACCOUNT_MISSING');
    return result.rows[0].id;
  }
}
