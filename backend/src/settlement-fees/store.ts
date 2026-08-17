import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../credits/types.js';
import { planFeeReversal, planSettlementFee, shanghaiPeriodStart, validateFeeTiers } from './engine.js';
import type {
  FeeSegment, FeeTier, ReversibleFeeSegment, SupplierFeeBillItem,
} from './types.js';

export type FeeScheduleRecord = Readonly<{
  id: string;
  version: string;
  status: 'draft' | 'active' | 'retired';
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  tiers: readonly FeeTier[];
}>;

type ScheduleRow = QueryResultRow & {
  id: string; version: string; status: FeeScheduleRecord['status']; effective_from: Date | null;
  effective_to: Date | null;
};
type TierRow = QueryResultRow & {
  id: string; ordinal: number; lower_bound_micros: string; upper_bound_micros: string | null; rate_bps: number;
};
type AssessmentRow = QueryResultRow & {
  id: string; supplier_subject_id: string; order_id: string; schedule_id: string; schedule_version: string;
  period_id: string; period_start: string | Date; kind: 'settlement' | 'reversal';
  source_kind: SupplierFeeBillItem['sourceKind']; source_id: string; original_assessment_id: string | null;
  payload_digest: string; gross_credit_micros: string; service_fee_credit_micros: string;
  net_credit_micros: string; cumulative_before_micros: string; cumulative_after_micros: string;
  ledger_transaction_id: string | null;
  assessed_at: Date;
};

const assessmentColumns = `id, supplier_subject_id, order_id, schedule_id, schedule_version, period_id,
  period_start, kind, source_kind, source_id, original_assessment_id, payload_digest,
  gross_credit_micros::text, service_fee_credit_micros::text, net_credit_micros::text,
  cumulative_before_micros::text, cumulative_after_micros::text, ledger_transaction_id, assessed_at`;

function mapTier(row: TierRow): FeeTier {
  return {
    ordinal: row.ordinal,
    lowerBoundMicros: BigInt(row.lower_bound_micros),
    upperBoundMicros: row.upper_bound_micros === null ? null : BigInt(row.upper_bound_micros),
    rateBps: row.rate_bps,
  };
}

function periodLabel(value: string | Date) {
  if (typeof value === 'string') return value.slice(0, 7);
  return value.toISOString().slice(0, 7);
}

function compactLedgerEntries<T extends Readonly<{ amount: bigint }>>(entries: readonly T[]) {
  return entries.filter((entry) => entry.amount !== 0n);
}

export type FeeAssessmentResult =
  | Readonly<{ status: 'created' | 'replayed'; assessmentId: string; plan: {
      grossCreditMicros: bigint; serviceFeeCreditMicros: bigint; netCreditMicros: bigint;
      cumulativeBeforeMicros: bigint; cumulativeAfterMicros: bigint; segments: readonly FeeSegment[];
      ledgerTransactionId: string;
    } }>
  | Readonly<{ status: 'conflict' }>;

export interface SettlementFeeStore {
  createDraftSchedule(input: Readonly<{
    id: string; version: string; tiers: readonly FeeTier[]; operatorId: string; now: Date;
    requestId: string; payloadDigest: string;
  }>): Promise<FeeScheduleRecord>;
  activateSchedule(input: Readonly<{
    scheduleId: string; operatorId: string; now: Date; requestId: string; payloadDigest: string;
  }>): Promise<FeeScheduleRecord>;
  activeSchedule(at: Date): Promise<FeeScheduleRecord | null>;
  assessSettlement(input: Readonly<{
    id: string; supplierSubjectId: string; orderId: string; sourceKind: 'compute_settlement' | 'renewal_settlement';
    sourceId: string; grossCreditMicros: bigint; idempotencyOwner: string; idempotencyKey: string;
    payloadDigest: string; assessedAt: Date;
  }>): Promise<FeeAssessmentResult>;
  reverseSettlement(input: Readonly<{
    id: string; supplierSubjectId: string; orderId: string; originalAssessmentId: string;
    sourceId: string; grossCreditMicros: bigint; idempotencyOwner: string; idempotencyKey: string;
    payloadDigest: string; assessedAt: Date;
  }>): Promise<FeeAssessmentResult>;
  listSupplierBills(subjectId: string, limit: number): Promise<SupplierFeeBillItem[]>;
}

export class PostgresSettlementFeeStore implements SettlementFeeStore {
  constructor(private readonly database: Database) {}

  async createDraftSchedule(input: Parameters<SettlementFeeStore['createDraftSchedule']>[0]) {
    const tiers = validateFeeTiers(input.tiers);
    return this.database.transaction(async (client) => {
      const requestsTable = await client.query<{ name: string | null }>(
        `SELECT to_regclass('kai_credit_fee_schedule_operator_requests')::text AS name`,
      );
      if (requestsTable.rows[0]?.name) {
        const replay = await client.query<{ action: string; schedule_id: string; payload_digest: string }>(
          `SELECT action,schedule_id,payload_digest FROM kai_credit_fee_schedule_operator_requests
           WHERE operator_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.operatorId, input.requestId],
        );
        if (replay.rows[0]) {
          if (replay.rows[0].action !== 'draft' || replay.rows[0].payload_digest !== input.payloadDigest) {
            throw new Error('FEE_SCHEDULE_IDEMPOTENCY_CONFLICT');
          }
          return this.scheduleById(client, replay.rows[0].schedule_id);
        }
      }
      const inserted = await client.query<ScheduleRow>(`INSERT INTO kai_credit_fee_schedules(
          id, version, fee_category, created_by_user_id, created_at)
        VALUES ($1, $2, 'compute_trade', $3, $4)
        RETURNING id, version, status, effective_from, effective_to`,
      [input.id, input.version, input.operatorId, input.now]);
      for (const tier of tiers) await client.query(`INSERT INTO kai_credit_fee_tiers(
          id, schedule_id, ordinal, lower_bound_micros, upper_bound_micros, rate_bps, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), input.id, tier.ordinal, tier.lowerBoundMicros.toString(),
        tier.upperBoundMicros?.toString() ?? null, tier.rateBps, input.now]);
      if (requestsTable.rows[0]?.name) await client.query(`INSERT INTO kai_credit_fee_schedule_operator_requests(
          operator_id,idempotency_key,action,schedule_id,payload_digest,created_at)
        VALUES($1,$2,'draft',$3,$4,$5)`,
      [input.operatorId, input.requestId, input.id, input.payloadDigest, input.now]);
      await this.audit(client, input.operatorId, 'KAI_CREDIT_FEE_SCHEDULE_DRAFTED', input.id,
        input.requestId, input.payloadDigest, { version: input.version, tierCount: tiers.length });
      return { ...this.mapSchedule(inserted.rows[0]!), tiers };
    });
  }

  async activateSchedule(input: Parameters<SettlementFeeStore['activateSchedule']>[0]) {
    return this.database.transaction(async (client) => {
      const requestsTable = await client.query<{ name: string | null }>(
        `SELECT to_regclass('kai_credit_fee_schedule_operator_requests')::text AS name`,
      );
      if (requestsTable.rows[0]?.name) {
        const replay = await client.query<{ action: string; schedule_id: string; payload_digest: string }>(
          `SELECT action,schedule_id,payload_digest FROM kai_credit_fee_schedule_operator_requests
           WHERE operator_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.operatorId, input.requestId],
        );
        if (replay.rows[0]) {
          if (replay.rows[0].action !== 'approve_and_activate' || replay.rows[0].schedule_id !== input.scheduleId
            || replay.rows[0].payload_digest !== input.payloadDigest) throw new Error('FEE_SCHEDULE_IDEMPOTENCY_CONFLICT');
          return this.scheduleById(client, replay.rows[0].schedule_id);
        }
      }
      const draft = await client.query<ScheduleRow>(`SELECT id, version, status, effective_from, effective_to
          ,created_by_user_id FROM kai_credit_fee_schedules WHERE id = $1 FOR UPDATE`, [input.scheduleId]);
      const row = draft.rows[0];
      if (!row) throw new Error('FEE_SCHEDULE_NOT_FOUND');
      if (row.status !== 'draft') throw new Error('FEE_SCHEDULE_NOT_ACTIVATABLE');
      const creator = (row as ScheduleRow & { created_by_user_id: string }).created_by_user_id;
      if (creator === input.operatorId) throw new Error('FEE_SCHEDULE_INDEPENDENT_APPROVER_REQUIRED');
      const tiers = await this.tiers(client, row.id);
      validateFeeTiers(tiers);
      const active = await client.query<ScheduleRow>(`SELECT id, version, status, effective_from, effective_to
        FROM kai_credit_fee_schedules WHERE fee_category = 'compute_trade' AND status = 'active' FOR UPDATE`);
      if (active.rows[0]) await client.query(`UPDATE kai_credit_fee_schedules SET status = 'retired', effective_to = $2
        WHERE id = $1 AND status = 'active'`, [active.rows[0].id, input.now]);
      if (requestsTable.rows[0]?.name) await client.query(`INSERT INTO kai_credit_fee_schedule_approvals(schedule_id,
          requested_by_user_id,approved_by_user_id,approval_request_id,approval_payload_digest,approved_at)
        VALUES($1,$2,$3,$4,$5,$6)`,
      [row.id, creator, input.operatorId, input.requestId, input.payloadDigest, input.now]);
      const activated = await client.query<ScheduleRow>(`UPDATE kai_credit_fee_schedules SET status = 'active',
          effective_from = $2, activated_by_user_id = $3, activated_at = $2
        WHERE id = $1 AND status = 'draft'
        RETURNING id, version, status, effective_from, effective_to`,
      [row.id, input.now, input.operatorId]);
      if (!activated.rows[0]) throw new Error('FEE_SCHEDULE_ACTIVATION_RACE');
      if (requestsTable.rows[0]?.name) await client.query(`INSERT INTO kai_credit_fee_schedule_operator_requests(
          operator_id,idempotency_key,action,schedule_id,payload_digest,created_at)
        VALUES($1,$2,'approve_and_activate',$3,$4,$5)`,
      [input.operatorId, input.requestId, row.id, input.payloadDigest, input.now]);
      await this.audit(client, input.operatorId, 'KAI_CREDIT_FEE_SCHEDULE_ACTIVATED', row.id,
        input.requestId, input.payloadDigest, { version: row.version, replacedScheduleId: active.rows[0]?.id ?? null });
      return { ...this.mapSchedule(activated.rows[0]), tiers };
    });
  }

  async activeSchedule(at: Date) {
    const result = await this.database.query<ScheduleRow>(`SELECT id, version, status, effective_from, effective_to
      FROM kai_credit_fee_schedules WHERE fee_category = 'compute_trade' AND status = 'active'
        AND effective_from <= $1`, [at]);
    return result.rows[0] ? this.scheduleWithTiers(this.database, result.rows[0]) : null;
  }

  async assessSettlement(input: Parameters<SettlementFeeStore['assessSettlement']>[0]): Promise<FeeAssessmentResult> {
    if (input.grossCreditMicros <= 0n) throw new Error('FEE_ASSESSMENT_VOLUME_INVALID');
    return this.database.transaction(async (client) => this.assessSettlementInTransaction(client, input));
  }

  async assessSettlementInTransaction(
    client: PoolClient,
    input: Parameters<SettlementFeeStore['assessSettlement']>[0],
  ): Promise<FeeAssessmentResult> {
      const replay = await this.replay(client, input.idempotencyOwner, input.idempotencyKey, input.payloadDigest);
      if (replay) return replay;
      const source = await client.query<{ payload_digest: string }>(`SELECT payload_digest FROM kai_credit_fee_assessments
        WHERE source_kind = $1 AND source_id = $2 FOR UPDATE`, [input.sourceKind, input.sourceId]);
      if (source.rows[0]) return { status: 'conflict' };
      const policy = await client.query<{ schedule_id: string; schedule_version: string }>(`SELECT schedule_id,
          schedule_version FROM kai_credit_order_fee_policies
        WHERE order_id = $1 AND policy_state = 'schedule_locked' FOR SHARE`, [input.orderId]);
      if (!policy.rows[0]) throw new Error('FEE_ORDER_POLICY_NOT_LOCKED');
      const schedule = await client.query<ScheduleRow>(`SELECT id, version, status, effective_from, effective_to
        FROM kai_credit_fee_schedules WHERE id = $1 AND version = $2 AND status IN ('active', 'retired') FOR SHARE`,
      [policy.rows[0].schedule_id, policy.rows[0].schedule_version]);
      if (!schedule.rows[0]) throw new Error('FEE_LOCKED_SCHEDULE_UNAVAILABLE');
      const tiers = await this.tiers(client, schedule.rows[0].id);
      const periodStart = shanghaiPeriodStart(input.assessedAt);
      const period = await this.lockPeriod(client, input.supplierSubjectId, periodStart);
      const plan = planSettlementFee(tiers, BigInt(period.net_settled_credit_micros), input.grossCreditMicros);
      if (plan.serviceFeeCreditMicros < 0n || plan.netCreditMicros <= 0n) {
        throw new Error('FEE_LEDGER_AMOUNT_INVALID');
      }
      const accounts = await this.lockSettlementAccounts(client, input.supplierSubjectId);
      const transactionId = randomUUID();
      await this.createTransaction(client, {
        id: transactionId, owner: input.idempotencyOwner, scope: 'CREDIT_SUPPLIER_SETTLEMENT_WITH_FEE',
        key: input.idempotencyKey, digest: input.payloadDigest, referenceType: 'settlement',
        referenceId: input.orderId, description: '算力成交结算与服务费', now: input.assessedAt,
        entries: compactLedgerEntries([
          { accountId: accounts.receivable, amount: -plan.grossCreditMicros, memo: '成交毛额结转' },
          { accountId: accounts.supplierEarnings, amount: plan.netCreditMicros, memo: '提供方净收益到账' },
          { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.revenue, amount: plan.serviceFeeCreditMicros, memo: '平台成交服务费' },
        ]),
      });
      await this.insertAssessment(client, input, schedule.rows[0], period.id, periodStart, plan, transactionId);
      await client.query(`UPDATE kai_credit_supplier_fee_periods SET net_settled_credit_micros = $2, version = version + 1
        WHERE id = $1`, [period.id, plan.cumulativeAfterMicros.toString()]);
      await this.audit(client, null, 'KAI_CREDIT_SETTLEMENT_FEE_ASSESSED', input.id,
        null, input.payloadDigest, { orderId: input.orderId, scheduleVersion: schedule.rows[0].version,
          grossCreditMicros: plan.grossCreditMicros.toString(), feeCreditMicros: plan.serviceFeeCreditMicros.toString() });
      return { status: 'created', assessmentId: input.id, plan: { ...plan, ledgerTransactionId: transactionId } };
  }

  async reverseSettlement(input: Parameters<SettlementFeeStore['reverseSettlement']>[0]): Promise<FeeAssessmentResult> {
    if (input.grossCreditMicros <= 0n) throw new Error('FEE_REVERSAL_VOLUME_INVALID');
    return this.database.transaction(async (client) => {
      const replay = await this.replay(client, input.idempotencyOwner, input.idempotencyKey, input.payloadDigest);
      if (replay) return replay;
      const originalResult = await client.query<AssessmentRow>(`SELECT ${assessmentColumns}
        FROM kai_credit_fee_assessments WHERE id = $1 AND kind = 'settlement' FOR UPDATE`,
      [input.originalAssessmentId]);
      const original = originalResult.rows[0];
      if (!original || original.supplier_subject_id !== input.supplierSubjectId || original.order_id !== input.orderId) {
        throw new Error('FEE_REVERSAL_ORIGINAL_NOT_FOUND');
      }
      const existingSource = await client.query<{ id: string }>(`SELECT id FROM kai_credit_fee_assessments
        WHERE source_kind = 'compute_settlement_refund' AND source_id = $1 FOR UPDATE`, [input.sourceId]);
      if (existingSource.rows[0]) return { status: 'conflict' };
      const period = await client.query<{ id: string; net_settled_credit_micros: string }>(`SELECT id,
          net_settled_credit_micros::text FROM kai_credit_supplier_fee_periods WHERE id = $1 FOR UPDATE`,
      [original.period_id]);
      if (!period.rows[0] || BigInt(period.rows[0].net_settled_credit_micros) < input.grossCreditMicros) {
        throw new Error('FEE_REVERSAL_PERIOD_VOLUME_INVALID');
      }
      const segments = await client.query<TierRow & {
        assessment_id: string; tier_ordinal: number; settled_credit_micros: string; exact_fee_numerator: string;
        service_fee_credit_micros: string;
      }>(`SELECT s.id, s.assessment_id, s.ordinal, s.tier_ordinal, s.lower_bound_micros::text,
          s.upper_bound_micros::text, s.rate_bps, s.settled_credit_micros::text,
          s.exact_fee_numerator::text, s.service_fee_credit_micros::text
        FROM kai_credit_fee_assessment_segments s WHERE s.assessment_id = $1
        ORDER BY s.ordinal FOR UPDATE`, [original.id]);
      const reversed = await client.query<{
        original_segment_id: string; reversed_credit_micros: string; reversed_fee_credit_micros: string;
      }>(`SELECT original_segment_id, sum(reversed_credit_micros)::text AS reversed_credit_micros,
          sum(reversed_fee_credit_micros)::text AS reversed_fee_credit_micros
        FROM kai_credit_fee_reversal_allocations WHERE original_segment_id = ANY($1::uuid[])
        GROUP BY original_segment_id`, [segments.rows.map((row) => row.id)]);
      const reversible: ReversibleFeeSegment[] = segments.rows.map((row) => ({
        id: row.id, ordinal: row.ordinal, tierOrdinal: row.tier_ordinal,
        lowerBoundMicros: BigInt(row.lower_bound_micros),
        upperBoundMicros: row.upper_bound_micros === null ? null : BigInt(row.upper_bound_micros),
        settledCreditMicros: BigInt(row.settled_credit_micros), rateBps: row.rate_bps,
        exactFeeNumerator: BigInt(row.exact_fee_numerator),
        serviceFeeCreditMicros: BigInt(row.service_fee_credit_micros),
        reversedCreditMicros: BigInt(reversed.rows.find((item) => item.original_segment_id === row.id)?.reversed_credit_micros ?? '0'),
        reversedFeeCreditMicros: BigInt(reversed.rows.find((item) => item.original_segment_id === row.id)?.reversed_fee_credit_micros ?? '0'),
      }));
      const reversal = planFeeReversal(reversible, input.grossCreditMicros);
      if (reversal.reversedServiceFeeCreditMicros < 0n || reversal.reversedNetCreditMicros <= 0n) {
        throw new Error('FEE_LEDGER_AMOUNT_INVALID');
      }
      const parties = await client.query<{ buyer_subject_id: string }>(`SELECT buyer_subject_id
        FROM kai_credit_orders WHERE id = $1 AND supplier_subject_id = $2 FOR SHARE`,
      [input.orderId, input.supplierSubjectId]);
      if (!parties.rows[0]) throw new Error('FEE_REVERSAL_ORDER_MISMATCH');
      const accounts = await this.lockRefundAccounts(client, input.supplierSubjectId, parties.rows[0].buyer_subject_id);
      const transactionId = randomUUID();
      await this.createTransaction(client, {
        id: transactionId, owner: input.idempotencyOwner,
        scope: 'CREDIT_SETTLEMENT_REFUND_WITH_FEE_REVERSAL', key: input.idempotencyKey,
        digest: input.payloadDigest, referenceType: 'service_fee_reversal', referenceId: input.orderId,
        description: '算力成交退款与服务费冲正', now: input.assessedAt,
        entries: compactLedgerEntries([
          { accountId: accounts.supplierEarnings, amount: -reversal.reversedNetCreditMicros, memo: '提供方结算净收益冲回' },
          { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.revenue, amount: -reversal.reversedServiceFeeCreditMicros, memo: '平台服务费冲正' },
          { accountId: accounts.buyerAvailable, amount: reversal.reversedGrossCreditMicros, memo: '买方退款到账' },
        ]),
      });
      const cumulativeBefore = BigInt(period.rows[0].net_settled_credit_micros);
      const cumulativeAfter = cumulativeBefore - input.grossCreditMicros;
      const reversalSegments: FeeSegment[] = reversal.allocations.map((allocation, ordinal) => {
        const originalSegment = reversible.find((segment) => segment.id === allocation.originalSegmentId)!;
        return {
          ordinal, tierOrdinal: allocation.originalTierOrdinal,
          lowerBoundMicros: originalSegment.lowerBoundMicros, upperBoundMicros: originalSegment.upperBoundMicros,
          settledCreditMicros: allocation.reversedCreditMicros, rateBps: allocation.rateBps,
          exactFeeNumerator: allocation.exactFeeNumerator,
          serviceFeeCreditMicros: allocation.reversedFeeCreditMicros,
        };
      });
      await this.insertReversalAssessment(client, input, original, cumulativeBefore, cumulativeAfter,
        reversal.reversedServiceFeeCreditMicros, reversal.reversedNetCreditMicros, reversalSegments, transactionId);
      for (const allocation of reversal.allocations) await client.query(`INSERT INTO kai_credit_fee_reversal_allocations(
          reversal_assessment_id, original_segment_id, reversed_credit_micros, reversed_fee_credit_micros)
        VALUES ($1, $2, $3, $4)`, [input.id, allocation.originalSegmentId,
        allocation.reversedCreditMicros.toString(), allocation.reversedFeeCreditMicros.toString()]);
      await client.query(`UPDATE kai_credit_supplier_fee_periods SET net_settled_credit_micros = $2, version = version + 1
        WHERE id = $1`, [original.period_id, cumulativeAfter.toString()]);
      return { status: 'created', assessmentId: input.id, plan: {
        grossCreditMicros: reversal.reversedGrossCreditMicros,
        serviceFeeCreditMicros: reversal.reversedServiceFeeCreditMicros,
        netCreditMicros: reversal.reversedNetCreditMicros,
        cumulativeBeforeMicros: cumulativeBefore, cumulativeAfterMicros: cumulativeAfter,
        segments: reversalSegments, ledgerTransactionId: transactionId,
      } };
    });
  }

  async listSupplierBills(subjectId: string, limit: number) {
    const rows = await this.database.query<AssessmentRow>(`SELECT ${assessmentColumns}
      FROM kai_credit_fee_assessments WHERE supplier_subject_id = $1
      ORDER BY assessed_at DESC, id DESC LIMIT $2`, [subjectId, limit]);
    const bills: SupplierFeeBillItem[] = [];
    for (const row of rows.rows) {
      const segments = await this.database.query<TierRow & { tier_ordinal: number;
        settled_credit_micros: string; exact_fee_numerator: string; service_fee_credit_micros: string;
      }>(`SELECT id, ordinal, tier_ordinal, lower_bound_micros::text, upper_bound_micros::text,
          rate_bps, settled_credit_micros::text, exact_fee_numerator::text, service_fee_credit_micros::text
        FROM kai_credit_fee_assessment_segments WHERE assessment_id = $1
        ORDER BY kai_credit_fee_assessment_segments.ordinal`, [row.id]);
      bills.push({
        id: row.id, orderId: row.order_id, kind: row.kind, sourceKind: row.source_kind, sourceId: row.source_id,
        grossCreditMicros: BigInt(row.gross_credit_micros),
        serviceFeeCreditMicros: BigInt(row.service_fee_credit_micros),
        netCreditMicros: BigInt(row.net_credit_micros), feeScheduleVersion: row.schedule_version,
        period: periodLabel(row.period_start), settledAt: new Date(row.assessed_at),
        tierBreakdown: segments.rows.map((segment, ordinal) => ({
          ordinal, tierOrdinal: segment.tier_ordinal, lowerBoundMicros: BigInt(segment.lower_bound_micros),
          upperBoundMicros: segment.upper_bound_micros === null ? null : BigInt(segment.upper_bound_micros),
          settledCreditMicros: BigInt(segment.settled_credit_micros), rateBps: segment.rate_bps,
          exactFeeNumerator: BigInt(segment.exact_fee_numerator),
          serviceFeeCreditMicros: BigInt(segment.service_fee_credit_micros),
        })),
      });
    }
    return bills;
  }

  private mapSchedule(row: ScheduleRow): Omit<FeeScheduleRecord, 'tiers'> {
    return { id: row.id, version: row.version, status: row.status,
      effectiveFrom: row.effective_from ? new Date(row.effective_from) : null,
      effectiveTo: row.effective_to ? new Date(row.effective_to) : null };
  }

  private async scheduleWithTiers(client: PoolClient | Database, row: ScheduleRow) {
    return { ...this.mapSchedule(row), tiers: await this.tiers(client, row.id) };
  }

  private async scheduleById(client: PoolClient, scheduleId: string) {
    const result = await client.query<ScheduleRow>(`SELECT id,version,status,effective_from,effective_to
      FROM kai_credit_fee_schedules WHERE id=$1`, [scheduleId]);
    if (!result.rows[0]) throw new Error('FEE_SCHEDULE_NOT_FOUND');
    return this.scheduleWithTiers(client, result.rows[0]);
  }

  private async tiers(client: PoolClient | Database, scheduleId: string) {
    const query = client.query.bind(client) as Database['query'];
    const result = await query<TierRow>(`SELECT id, ordinal, lower_bound_micros::text,
      upper_bound_micros::text, rate_bps FROM kai_credit_fee_tiers WHERE schedule_id = $1 ORDER BY ordinal`,
    [scheduleId]);
    return result.rows.map(mapTier);
  }

  private async lockPeriod(client: PoolClient, supplierSubjectId: string, periodStart: string) {
    await client.query(`INSERT INTO kai_credit_supplier_fee_periods(id, supplier_subject_id, fee_category, period_start)
      VALUES ($1, $2, 'compute_trade', $3) ON CONFLICT (supplier_subject_id, fee_category, period_start) DO NOTHING`,
    [randomUUID(), supplierSubjectId, periodStart]);
    const result = await client.query<{ id: string; net_settled_credit_micros: string }>(`SELECT id,
        net_settled_credit_micros::text FROM kai_credit_supplier_fee_periods
      WHERE supplier_subject_id = $1 AND fee_category = 'compute_trade' AND period_start = $2 FOR UPDATE`,
    [supplierSubjectId, periodStart]);
    if (!result.rows[0]) throw new Error('FEE_PERIOD_LOCK_FAILED');
    return result.rows[0];
  }

  private async lockSettlementAccounts(client: PoolClient, supplierSubjectId: string) {
    await client.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
      VALUES ($1, 'subject', $2, $3, 'supplier_earnings_available', false)
      ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
    [randomUUID(), supplierSubjectId, `subject:${supplierSubjectId}:supplier_earnings_available`]);
    const result = await client.query<{ id: string; account_kind: string }>(`SELECT id, account_kind
      FROM kai_credit_accounts WHERE subject_id = $1
      AND account_kind IN ('supplier_earnings_available', 'supplier_receivable')
      ORDER BY id FOR UPDATE`, [supplierSubjectId]);
    const supplierEarnings = result.rows.find((row) => row.account_kind === 'supplier_earnings_available')?.id;
    const receivable = result.rows.find((row) => row.account_kind === 'supplier_receivable')?.id;
    if (!supplierEarnings || !receivable) throw new Error('FEE_SETTLEMENT_ACCOUNTS_MISSING');
    return { supplierEarnings, receivable };
  }

  private async lockRefundAccounts(client: PoolClient, supplierSubjectId: string, buyerSubjectId: string) {
    await client.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
      VALUES ($1, 'subject', $2, $3, 'supplier_earnings_available', false)
      ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
    [randomUUID(), supplierSubjectId, `subject:${supplierSubjectId}:supplier_earnings_available`]);
    await client.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
      VALUES ($1, 'subject', $2, $3, 'available', false)
      ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
    [randomUUID(), buyerSubjectId, `subject:${buyerSubjectId}:available`]);
    const result = await client.query<{ id: string; subject_id: string; account_kind: string }>(`SELECT id, subject_id,
      account_kind FROM kai_credit_accounts WHERE (subject_id = $1 AND account_kind = 'supplier_earnings_available')
      OR (subject_id = $2 AND account_kind = 'available') ORDER BY id FOR UPDATE`, [supplierSubjectId, buyerSubjectId]);
    const supplierEarnings = result.rows.find((row) => row.subject_id === supplierSubjectId
      && row.account_kind === 'supplier_earnings_available')?.id;
    const buyerAvailable = result.rows.find((row) => row.subject_id === buyerSubjectId
      && row.account_kind === 'available')?.id;
    if (!supplierEarnings || !buyerAvailable) throw new Error('FEE_REFUND_ACCOUNTS_MISSING');
    return { supplierEarnings, buyerAvailable };
  }

  private async createTransaction(client: PoolClient, input: Readonly<{
    id: string; owner: string; scope: string; key: string; digest: string;
    referenceType: 'settlement' | 'service_fee_reversal'; referenceId: string; description: string; now: Date;
    entries: readonly { accountId: string; amount: bigint; memo: string }[];
  }>) {
    if (input.entries.length < 2 || input.entries.length > 3 || input.entries.some((entry) => entry.amount === 0n)
      || input.entries.reduce((sum, entry) => sum + entry.amount, 0n) !== 0n) {
      throw new Error('FEE_LEDGER_ENTRIES_UNBALANCED');
    }
    const entries = [...input.entries].sort((left, right) => left.accountId.localeCompare(right.accountId));
    await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
        payload_digest, reference_type, reference_id, description, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
    [input.id, input.owner, input.scope, input.key, input.digest, input.referenceType,
      input.referenceId, input.description, input.now]);
    for (const entry of entries) await client.query(`INSERT INTO kai_credit_entries(
        id, transaction_id, account_id, amount_micros, memo, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), input.id, entry.accountId, entry.amount.toString(), entry.memo, input.now]);
    await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`,
    [input.id, input.now]);
  }

  private async insertAssessment(client: PoolClient,
    input: Parameters<SettlementFeeStore['assessSettlement']>[0], schedule: ScheduleRow,
    periodId: string, periodStart: string,
    plan: Omit<Exclude<FeeAssessmentResult, { status: 'conflict' }>['plan'], 'ledgerTransactionId'>,
    transactionId: string) {
    await client.query(`INSERT INTO kai_credit_fee_assessments(id, supplier_subject_id, order_id,
        schedule_id, schedule_version, period_id, period_start, kind, source_kind, source_id,
        idempotency_owner, idempotency_key, payload_digest, gross_credit_micros,
        service_fee_credit_micros, net_credit_micros, cumulative_before_micros,
        cumulative_after_micros, ledger_transaction_id, assessed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'settlement',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [input.id, input.supplierSubjectId, input.orderId, schedule.id, schedule.version, periodId, periodStart,
      input.sourceKind, input.sourceId, input.idempotencyOwner, input.idempotencyKey, input.payloadDigest,
      plan.grossCreditMicros.toString(), plan.serviceFeeCreditMicros.toString(), plan.netCreditMicros.toString(),
      plan.cumulativeBeforeMicros.toString(), plan.cumulativeAfterMicros.toString(), transactionId, input.assessedAt]);
    await this.insertSegments(client, input.id, plan.segments);
  }

  private async insertReversalAssessment(client: PoolClient,
    input: Parameters<SettlementFeeStore['reverseSettlement']>[0], original: AssessmentRow,
    cumulativeBefore: bigint, cumulativeAfter: bigint, fee: bigint, net: bigint,
    segments: readonly FeeSegment[], transactionId: string) {
    await client.query(`INSERT INTO kai_credit_fee_assessments(id, supplier_subject_id, order_id,
        schedule_id, schedule_version, period_id, period_start, kind, source_kind, source_id,
        original_assessment_id, idempotency_owner, idempotency_key, payload_digest, gross_credit_micros,
        service_fee_credit_micros, net_credit_micros, cumulative_before_micros,
        cumulative_after_micros, ledger_transaction_id, assessed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'reversal','compute_settlement_refund',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [input.id, input.supplierSubjectId, input.orderId, original.schedule_id, original.schedule_version,
      original.period_id, typeof original.period_start === 'string' ? original.period_start : original.period_start,
      input.sourceId, original.id, input.idempotencyOwner, input.idempotencyKey, input.payloadDigest,
      input.grossCreditMicros.toString(), fee.toString(), net.toString(), cumulativeBefore.toString(),
      cumulativeAfter.toString(), transactionId, input.assessedAt]);
    await this.insertSegments(client, input.id, segments);
  }

  private async insertSegments(client: PoolClient, assessmentId: string, segments: readonly FeeSegment[]) {
    for (const segment of segments) await client.query(`INSERT INTO kai_credit_fee_assessment_segments(
        id, assessment_id, ordinal, tier_ordinal, lower_bound_micros, upper_bound_micros,
        settled_credit_micros, rate_bps, exact_fee_numerator, service_fee_credit_micros)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), assessmentId, segment.ordinal, segment.tierOrdinal, segment.lowerBoundMicros.toString(),
      segment.upperBoundMicros?.toString() ?? null, segment.settledCreditMicros.toString(), segment.rateBps,
      segment.exactFeeNumerator.toString(), segment.serviceFeeCreditMicros.toString()]);
  }

  private async replay(client: PoolClient, owner: string, key: string, digest: string): Promise<FeeAssessmentResult | null> {
    const result = await client.query<AssessmentRow>(`SELECT ${assessmentColumns}
      FROM kai_credit_fee_assessments WHERE idempotency_owner = $1 AND idempotency_key = $2 FOR UPDATE`,
    [owner, key]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.payload_digest !== digest) return { status: 'conflict' };
    const segments = await client.query<TierRow & { tier_ordinal: number; settled_credit_micros: string; exact_fee_numerator: string;
      service_fee_credit_micros: string }>(`SELECT id, ordinal, tier_ordinal,
        lower_bound_micros::text, upper_bound_micros::text, rate_bps, settled_credit_micros::text,
        exact_fee_numerator::text, service_fee_credit_micros::text
      FROM kai_credit_fee_assessment_segments WHERE assessment_id = $1
      ORDER BY kai_credit_fee_assessment_segments.ordinal`, [row.id]);
    return { status: 'replayed', assessmentId: row.id, plan: {
      grossCreditMicros: BigInt(row.gross_credit_micros),
      serviceFeeCreditMicros: BigInt(row.service_fee_credit_micros),
      netCreditMicros: BigInt(row.net_credit_micros),
      cumulativeBeforeMicros: BigInt(row.cumulative_before_micros),
      cumulativeAfterMicros: BigInt(row.cumulative_after_micros),
      ledgerTransactionId: row.ledger_transaction_id ?? (() => { throw new Error('FEE_LEDGER_TRANSACTION_MISSING'); })(),
      segments: segments.rows.map((segment, ordinal) => ({
        ordinal, tierOrdinal: segment.tier_ordinal, lowerBoundMicros: BigInt(segment.lower_bound_micros),
        upperBoundMicros: segment.upper_bound_micros === null ? null : BigInt(segment.upper_bound_micros),
        settledCreditMicros: BigInt(segment.settled_credit_micros), rateBps: segment.rate_bps,
        exactFeeNumerator: BigInt(segment.exact_fee_numerator),
        serviceFeeCreditMicros: BigInt(segment.service_fee_credit_micros),
      })),
    } };
  }

  private async audit(client: PoolClient, actorId: string | null, action: string, entityId: string,
    requestId: string | null, payloadDigest: string, metadata: Record<string, unknown>) {
    await client.query(`INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id,
        request_id, payload_digest, metadata) VALUES ($1,$2,$3,$4,'KAI_CREDIT_FEE',$5,$6,$7,$8::jsonb)`,
    [randomUUID(), actorId, actorId ? 'operator' : 'system', action, entityId, requestId,
      payloadDigest, JSON.stringify(metadata)]);
  }
}
