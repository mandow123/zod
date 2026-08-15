import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../credits/types.js';
import type { CreditPayoutProfile, CreditPayoutRecord, CreditPayoutStatus } from './types.js';

type PayoutRow = QueryResultRow & {
  id: string; payout_number: string; subject_id: string; requested_by_user_id: string;
  status: CreditPayoutStatus; credit_micros: string; conversion_cny_micros_per_credit: string;
  cny_micros: string; payment_amount_cents: string; payout_account_id: string;
  freeze_transaction_id: string; resolution_transaction_id: string | null;
  company_payment_reference: string | null; company_payment_flow_digest: string | null;
  company_payment_amount_cents: string | null;
  failure_code: string | null; resolution_reason: string | null;
  available_before_micros: string; available_after_micros: string;
  frozen_before_micros: string; frozen_after_micros: string;
  resolution_available_before_micros: string | null; resolution_available_after_micros: string | null;
  resolution_frozen_before_micros: string | null; resolution_frozen_after_micros: string | null;
  reviewed_at: Date | null; paying_at: Date | null; resolved_at: Date | null; created_at: Date; updated_at: Date;
};

type ProfileRow = QueryResultRow & {
  subject_id: string; status: CreditPayoutProfile['status']; legal_entity_digest: string | null;
  recipient_reference: string | null; activated_at: Date | null;
};

const payoutColumns = `id, payout_number, subject_id, requested_by_user_id, status, credit_micros::text,
  conversion_cny_micros_per_credit::text, cny_micros::text, payment_amount_cents::text, payout_account_id,
  freeze_transaction_id, resolution_transaction_id, company_payment_reference, company_payment_flow_digest,
  company_payment_amount_cents::text,
  failure_code, resolution_reason, available_before_micros::text, available_after_micros::text,
  frozen_before_micros::text, frozen_after_micros::text, resolution_available_before_micros::text,
  resolution_available_after_micros::text, resolution_frozen_before_micros::text,
  resolution_frozen_after_micros::text, reviewed_at, paying_at, resolved_at, created_at, updated_at`;

function mapPayout(row: PayoutRow): CreditPayoutRecord {
  const optionalBigInt = (value: string | null) => value === null ? null : BigInt(value);
  return {
    id: row.id, payoutNumber: row.payout_number, subjectId: row.subject_id,
    requestedByUserId: row.requested_by_user_id, status: row.status, creditMicros: BigInt(row.credit_micros),
    conversionCnyMicrosPerCredit: BigInt(row.conversion_cny_micros_per_credit), cnyMicros: BigInt(row.cny_micros),
    paymentAmountCents: BigInt(row.payment_amount_cents), payoutAccountId: row.payout_account_id,
    freezeTransactionId: row.freeze_transaction_id, resolutionTransactionId: row.resolution_transaction_id,
    companyPaymentReference: row.company_payment_reference, companyPaymentFlowDigest: row.company_payment_flow_digest,
    companyPaymentAmountCents: row.company_payment_amount_cents === null ? null : BigInt(row.company_payment_amount_cents),
    failureCode: row.failure_code, resolutionReason: row.resolution_reason,
    supplierEarningsBeforeMicros: BigInt(row.available_before_micros),
    supplierEarningsAfterMicros: BigInt(row.available_after_micros),
    frozenBeforeMicros: BigInt(row.frozen_before_micros), frozenAfterMicros: BigInt(row.frozen_after_micros),
    resolutionSupplierEarningsBeforeMicros: optionalBigInt(row.resolution_available_before_micros),
    resolutionSupplierEarningsAfterMicros: optionalBigInt(row.resolution_available_after_micros),
    resolutionFrozenBeforeMicros: optionalBigInt(row.resolution_frozen_before_micros),
    resolutionFrozenAfterMicros: optionalBigInt(row.resolution_frozen_after_micros),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : null,
    payingAt: row.paying_at ? new Date(row.paying_at) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

function mapProfile(row: ProfileRow): CreditPayoutProfile {
  return { subjectId: row.subject_id, status: row.status, legalEntityDigest: row.legal_entity_digest,
    recipientReference: row.recipient_reference, activatedAt: row.activated_at ? new Date(row.activated_at) : null };
}

export type CreatePayoutResult =
  | Readonly<{ status: 'created' | 'replayed'; payout: CreditPayoutRecord }>
  | Readonly<{ status: 'conflict' | 'profile_pending' | 'insufficient_earnings' }>;

export type PayoutTransitionResult =
  | Readonly<{ status: 'updated' | 'replayed'; payout: CreditPayoutRecord }>
  | Readonly<{ status: 'conflict' | 'not_found' | 'invalid_state' }>;

export interface CreditPayoutStore {
  profile(subjectId: string): Promise<CreditPayoutProfile | null>;
  activateProfile(input: Readonly<{ subjectId: string; operatorId: string; legalEntityDigest: string;
    recipientReference: string; now: Date }>): Promise<CreditPayoutProfile | null>;
  create(input: Readonly<{ id: string; payoutNumber: string; subjectId: string; userId: string;
    clientRequestId: string; payloadDigest: string; creditMicros: bigint; conversionCnyMicrosPerCredit: bigint;
    cnyMicros: bigint; paymentAmountCents: bigint; now: Date }>): Promise<CreatePayoutResult>;
  get(subjectId: string, payoutId: string): Promise<CreditPayoutRecord | null>;
  getAny(payoutId: string): Promise<CreditPayoutRecord | null>;
  list(subjectId: string, limit: number): Promise<CreditPayoutRecord[]>;
  listQueue(limit: number): Promise<CreditPayoutRecord[]>;
  transition(input: Readonly<{ payoutId: string; actorId: string; action: 'review' | 'pay' | 'succeed' | 'fail' | 'reject' | 'cancel';
    from: CreditPayoutStatus; to: CreditPayoutStatus; clientRequestId: string; payloadDigest: string; now: Date;
    companyPaymentReference?: string; companyPaymentFlowDigest?: string; companyPaymentAmountCents?: bigint;
    failureCode?: string; reason?: string;
  }>): Promise<PayoutTransitionResult>;
}

export class PostgresCreditPayoutStore implements CreditPayoutStore {
  constructor(private readonly database: Database) {}

  async profile(subjectId: string) {
    const result = await this.database.query<ProfileRow>(`SELECT subject_id, status, legal_entity_digest,
      recipient_reference, activated_at FROM kai_credit_payout_profiles WHERE subject_id = $1`, [subjectId]);
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async activateProfile(input: Parameters<CreditPayoutStore['activateProfile']>[0]) {
    const result = await this.database.query<ProfileRow>(`INSERT INTO kai_credit_payout_profiles(subject_id, status,
      legal_entity_digest, recipient_reference, activated_by_user_id, activated_at)
      SELECT id, 'active', $2, $3, $4, $5 FROM trading_subjects WHERE id = $1 AND status = 'active'
      ON CONFLICT (subject_id) DO UPDATE SET status = 'active', legal_entity_digest = EXCLUDED.legal_entity_digest,
        recipient_reference = EXCLUDED.recipient_reference, activated_by_user_id = EXCLUDED.activated_by_user_id,
        activated_at = EXCLUDED.activated_at
      RETURNING subject_id, status, legal_entity_digest, recipient_reference, activated_at`,
    [input.subjectId, input.legalEntityDigest, input.recipientReference, input.operatorId, input.now]);
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async create(input: Parameters<CreditPayoutStore['create']>[0]): Promise<CreatePayoutResult> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<PayoutRow & { payload_digest: string }>(`SELECT ${payoutColumns}, payload_digest
        FROM kai_credit_payout_requests WHERE subject_id = $1 AND client_request_id = $2 FOR UPDATE`,
      [input.subjectId, input.clientRequestId]);
      if (existing.rows[0]) return existing.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', payout: mapPayout(existing.rows[0]) } : { status: 'conflict' };
      const profile = await client.query<ProfileRow>(`SELECT subject_id, status, legal_entity_digest,
        recipient_reference, activated_at FROM kai_credit_payout_profiles WHERE subject_id = $1 FOR UPDATE`, [input.subjectId]);
      if (profile.rows[0]?.status !== 'active' || !profile.rows[0].recipient_reference) return { status: 'profile_pending' };
      const accounts = await this.ensureAccounts(client, input.subjectId);
      const before = await this.balances(client, accounts.supplierEarnings, accounts.payoutFrozen);
      if (before.supplierEarnings < input.creditMicros) return { status: 'insufficient_earnings' };
      const freezeTransactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
        payload_digest, reference_type, reference_id, description, status) VALUES
        ($1, $2, 'CREDIT_PAYOUT_FREEZE', $3, $4, 'payout', $5, $6, 'pending')`,
      [freezeTransactionId, `subject:${input.subjectId}`, `payout-freeze:${input.id}`, input.payloadDigest,
        input.id, `兑付 ${input.payoutNumber} 卡时冻结`]);
      await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
        ($1, $2, $3, $4, '兑付申请冻结'), ($5, $2, $6, $7, '兑付申请冻结')`,
      [randomUUID(), freezeTransactionId, accounts.supplierEarnings, (-input.creditMicros).toString(), randomUUID(),
        accounts.payoutFrozen, input.creditMicros.toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`,
      [freezeTransactionId, input.now]);
      const result = await client.query<PayoutRow>(`INSERT INTO kai_credit_payout_requests(id, payout_number,
        subject_id, requested_by_user_id, client_request_id, payload_digest, status, credit_micros,
        conversion_cny_micros_per_credit, cny_micros, payment_amount_cents, payout_account_id,
        freeze_transaction_id, recipient_reference, available_before_micros, available_after_micros,
        frozen_before_micros, frozen_after_micros) VALUES
        ($1,$2,$3,$4,$5,$6,'submitted',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING ${payoutColumns}`,
      [input.id, input.payoutNumber, input.subjectId, input.userId, input.clientRequestId, input.payloadDigest,
        input.creditMicros.toString(), input.conversionCnyMicrosPerCredit.toString(), input.cnyMicros.toString(),
        input.paymentAmountCents.toString(), accounts.payoutFrozen, freezeTransactionId,
        profile.rows[0].recipient_reference, before.supplierEarnings.toString(),
        (before.supplierEarnings - input.creditMicros).toString(),
        before.frozen.toString(), (before.frozen + input.creditMicros).toString()]);
      return { status: 'created', payout: mapPayout(result.rows[0]!) };
    });
  }

  async get(subjectId: string, payoutId: string) {
    const result = await this.database.query<PayoutRow>(`SELECT ${payoutColumns} FROM kai_credit_payout_requests
      WHERE id = $1 AND subject_id = $2`, [payoutId, subjectId]);
    return result.rows[0] ? mapPayout(result.rows[0]) : null;
  }
  async getAny(payoutId: string) {
    const result = await this.database.query<PayoutRow>(`SELECT ${payoutColumns} FROM kai_credit_payout_requests WHERE id = $1`, [payoutId]);
    return result.rows[0] ? mapPayout(result.rows[0]) : null;
  }
  async list(subjectId: string, limit: number) {
    const result = await this.database.query<PayoutRow>(`SELECT ${payoutColumns} FROM kai_credit_payout_requests
      WHERE subject_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [subjectId, limit]);
    return result.rows.map(mapPayout);
  }
  async listQueue(limit: number) {
    const result = await this.database.query<PayoutRow>(`SELECT ${payoutColumns} FROM kai_credit_payout_requests
      WHERE status IN ('submitted','reviewing','paying') ORDER BY created_at, id LIMIT $1`, [limit]);
    return result.rows.map(mapPayout);
  }

  async transition(input: Parameters<CreditPayoutStore['transition']>[0]): Promise<PayoutTransitionResult> {
    return this.database.transaction(async (client) => {
      const replay = await client.query<{ payout_id: string; action: string; payload_digest: string }>(`SELECT payout_id,
        action, payload_digest FROM kai_credit_payout_actions WHERE actor_id = $1 AND client_request_id = $2 FOR UPDATE`,
      [input.actorId, input.clientRequestId]);
      if (replay.rows[0]) {
        if (replay.rows[0].payout_id !== input.payoutId || replay.rows[0].action !== input.action
          || replay.rows[0].payload_digest !== input.payloadDigest) return { status: 'conflict' };
        const payout = await this.lockPayout(client, input.payoutId);
        return payout ? { status: 'replayed', payout } : { status: 'not_found' };
      }
      const payout = await this.lockPayout(client, input.payoutId);
      if (!payout) return { status: 'not_found' };
      if (payout.status !== input.from) {
        await this.saveAction(client, input, 'invalid_state');
        return { status: 'invalid_state' };
      }
      if (input.action === 'succeed' && input.companyPaymentAmountCents !== payout.paymentAmountCents) {
        await this.saveAction(client, input, 'invalid_state');
        return { status: 'invalid_state' };
      }
      let resolutionTransactionId: string | null = null;
      let balances: { supplierEarningsBefore: bigint; supplierEarningsAfter: bigint;
        frozenBefore: bigint; frozenAfter: bigint } | null = null;
      if (['succeed', 'fail', 'reject', 'cancel'].includes(input.action)) {
        const accounts = await this.ensureAccounts(client, payout.subjectId);
        const before = await this.balances(client, accounts.supplierEarnings, accounts.payoutFrozen);
        if (before.frozen < payout.creditMicros) throw new Error('KAI_CREDIT_PAYOUT_FROZEN_BALANCE_INVALID');
        const success = input.action === 'succeed';
        resolutionTransactionId = randomUUID();
        const target = success ? KAI_CREDIT_PLATFORM_ACCOUNTS.issuance : accounts.supplierEarnings;
        await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
          payload_digest, reference_type, reference_id, description, status) VALUES
          ($1,$2,$3,$4,$5,'payout',$6,$7,'pending')`,
        [resolutionTransactionId, `subject:${payout.subjectId}`, success ? 'CREDIT_PAYOUT_SUCCEEDED' : 'CREDIT_PAYOUT_RELEASE',
          `payout-resolution:${payout.id}`, input.payloadDigest, payout.id,
          success ? `兑付 ${payout.payoutNumber} 公司打款完成` : `兑付 ${payout.payoutNumber} 冻结退回`]);
        await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
          ($1,$2,$3,$4,$5), ($6,$2,$7,$8,$9)`,
        [randomUUID(), resolutionTransactionId, accounts.payoutFrozen, (-payout.creditMicros).toString(),
          success ? '兑付完成扣除' : '兑付失败解冻', randomUUID(), target, payout.creditMicros.toString(),
          success ? '兑付后核销发行负债' : '兑付退回供应收益']);
        await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`,
        [resolutionTransactionId, input.now]);
        balances = { supplierEarningsBefore: before.supplierEarnings,
          supplierEarningsAfter: before.supplierEarnings + (success ? 0n : payout.creditMicros),
          frozenBefore: before.frozen, frozenAfter: before.frozen - payout.creditMicros };
      }
      const updated = await client.query<PayoutRow>(`UPDATE kai_credit_payout_requests SET status = $2,
        reviewed_by_user_id = CASE WHEN $2 = 'reviewing' THEN $3 ELSE reviewed_by_user_id END,
        reviewed_at = CASE WHEN $2 = 'reviewing' THEN $4 ELSE reviewed_at END,
        paying_at = CASE WHEN $2 = 'paying' THEN $4 ELSE paying_at END,
        resolved_at = CASE WHEN $2 IN ('succeeded','failed','rejected','cancelled') THEN $4 ELSE NULL END,
        resolution_transaction_id = $5, company_payment_reference = $6, company_payment_flow_digest = $7,
        company_payment_amount_cents = $8, failure_code = $9, resolution_reason = $10,
        resolution_available_before_micros = $11, resolution_available_after_micros = $12,
        resolution_frozen_before_micros = $13, resolution_frozen_after_micros = $14
        WHERE id = $1 AND status = $15 RETURNING ${payoutColumns}`,
      [input.payoutId, input.to, input.actorId, input.now, resolutionTransactionId,
        input.companyPaymentReference ?? null, input.companyPaymentFlowDigest ?? null,
        input.companyPaymentAmountCents?.toString() ?? null, input.failureCode ?? null, input.reason ?? null,
        balances?.supplierEarningsBefore.toString() ?? null, balances?.supplierEarningsAfter.toString() ?? null,
        balances?.frozenBefore.toString() ?? null, balances?.frozenAfter.toString() ?? null, input.from]);
      if (!updated.rows[0]) throw new Error('KAI_CREDIT_PAYOUT_STATE_CHANGED');
      await this.saveAction(client, input, input.to);
      return { status: 'updated', payout: mapPayout(updated.rows[0]) };
    });
  }

  private async lockPayout(client: PoolClient, id: string) {
    const result = await client.query<PayoutRow>(`SELECT ${payoutColumns} FROM kai_credit_payout_requests WHERE id = $1 FOR UPDATE`, [id]);
    return result.rows[0] ? mapPayout(result.rows[0]) : null;
  }
  private async ensureAccounts(client: PoolClient, subjectId: string) {
    const subject = await client.query<{ id: string }>(`SELECT id FROM trading_subjects WHERE id = $1 AND status = 'active' FOR UPDATE`, [subjectId]);
    if (!subject.rows[0]) throw new Error('ACTIVE_TRADING_SUBJECT_REQUIRED');
    for (const kind of ['supplier_earnings_available', 'payout_frozen'] as const) await client.query(`INSERT INTO kai_credit_accounts
      (id, owner_kind, subject_id, code, account_kind, allow_negative) VALUES ($1,'subject',$2,$3,$4,false)
      ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
    [randomUUID(), subjectId, `subject:${subjectId}:${kind}`, kind]);
    const rows = await client.query<{ id: string; account_kind: 'supplier_earnings_available' | 'payout_frozen' }>(`SELECT id,
      account_kind FROM kai_credit_accounts WHERE subject_id = $1
      AND account_kind IN ('supplier_earnings_available','payout_frozen')
      ORDER BY id FOR UPDATE`, [subjectId]);
    const supplierEarnings = rows.rows.find((row) => row.account_kind === 'supplier_earnings_available')?.id;
    const payoutFrozen = rows.rows.find((row) => row.account_kind === 'payout_frozen')?.id;
    if (!supplierEarnings || !payoutFrozen) throw new Error('KAI_CREDIT_PAYOUT_ACCOUNTS_MISSING');
    return { supplierEarnings, payoutFrozen };
  }
  private async balances(client: PoolClient, supplierEarningsId: string, frozenId: string) {
    const result = await client.query<{ id: string; amount: string }>(`SELECT a.id,
      COALESCE(sum(e.amount_micros) FILTER (WHERE t.status = 'posted'),0)::text AS amount
      FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id = a.id
      LEFT JOIN kai_credit_transactions t ON t.id = e.transaction_id
      WHERE a.id = ANY($1::uuid[]) GROUP BY a.id`, [[supplierEarningsId, frozenId].sort()]);
    return { supplierEarnings: BigInt(result.rows.find((row) => row.id === supplierEarningsId)?.amount ?? '0'),
      frozen: BigInt(result.rows.find((row) => row.id === frozenId)?.amount ?? '0') };
  }
  private saveAction(client: PoolClient, input: Parameters<CreditPayoutStore['transition']>[0], result: string) {
    return client.query(`INSERT INTO kai_credit_payout_actions(actor_id, client_request_id, payout_id, action,
      payload_digest, result_status) VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.actorId, input.clientRequestId, input.payoutId, input.action, input.payloadDigest, result]).then(() => undefined);
  }
}
