import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type {
  CaptureComputeRankingInput,
  ComputeDataQualityIssue,
  ComputeJourneyEventName,
  ComputeTrainingDatasetRow,
  JsonObject,
  RecordComputeJourneyEventInput,
} from './types.js';

export type StoreWriteResult = Readonly<{ status: 'created' | 'replayed' }>;
export type StoreWriteFailure = Readonly<{ status: 'conflict' | 'missing_parent' | 'invalid_transition' }>;

export interface ComputeDataFlywheelStore {
  captureRanking(input: CaptureComputeRankingInput, requestDigest: string, rankingDigest: string):
    Promise<StoreWriteResult | StoreWriteFailure>;
  recordEvent(input: RecordComputeJourneyEventInput, payloadDigest: string):
    Promise<StoreWriteResult | StoreWriteFailure>;
  qualityIssues(limit: number): Promise<readonly ComputeDataQualityIssue[]>;
  exportDataset(from: Date, to: Date, limit: number): Promise<Readonly<{
    rows: readonly ComputeTrainingDatasetRow[];
    hasMore: boolean;
  }>>;
  trace(requestId: string): Promise<Readonly<{
    request: QueryResultRow | null;
    rankings: readonly QueryResultRow[];
    candidates: readonly QueryResultRow[];
    events: readonly QueryResultRow[];
  }>>;
}

type DigestRow = QueryResultRow & { payload_digest: string };
type EventRow = QueryResultRow & { event_name: ComputeJourneyEventName; occurred_at: Date };
type CandidateOriginRow = QueryResultRow & {
  candidate_origin: string;
  request_origin: string;
  ranking_occurred_at: Date;
};
type QualityRow = QueryResultRow & {
  issue_code: string;
  request_id: string;
  ranking_run_id: string;
  event_id: string | null;
  detail: JsonObject;
};

const prerequisites: Readonly<Partial<Record<ComputeJourneyEventName, readonly ComputeJourneyEventName[]>>> = {
  quote_created: ['selected'],
  quote_accepted: ['quote_created'],
  reservation_succeeded: ['quote_accepted'],
  reservation_failed: ['quote_accepted'],
  provisioning_started: ['reservation_succeeded'],
  provisioning_succeeded: ['provisioning_started'],
  provisioning_failed: ['provisioning_started'],
  fulfillment_started: ['provisioning_succeeded'],
  fulfillment_completed: ['fulfillment_started', 'provisioning_succeeded'],
  sla_violated: ['provisioning_succeeded'],
  telemetry_observed: ['provisioning_succeeded'],
  settlement_completed: ['fulfillment_completed'],
  failed: ['selected'],
  refund_requested: ['failed', 'reservation_failed', 'provisioning_failed', 'sla_violated', 'fulfillment_completed',
    'settlement_completed'],
  refunded: ['refund_requested'],
  feedback_submitted: ['selected'],
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function stable(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeDataPayloadDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
}

async function existingBySource(client: PoolClient, table: string, source: string, sourceEventId: string) {
  const result = await client.query<DigestRow>(
    `SELECT payload_digest FROM ${table} WHERE source=$1 AND source_event_id=$2`,
    [source, sourceEventId],
  );
  return result.rows[0]?.payload_digest ?? null;
}

async function requestDigest(client: PoolClient, requestId: string) {
  const result = await client.query<DigestRow>(
    'SELECT payload_digest FROM compute_data_requests WHERE id=$1', [requestId],
  );
  return result.rows[0]?.payload_digest ?? null;
}

export class PostgresComputeDataFlywheelStore implements ComputeDataFlywheelStore {
  constructor(private readonly database: Database) {}

  async captureRanking(input: CaptureComputeRankingInput, demandDigest: string, rankingDigest: string) {
    return this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `compute-data-ranking:${input.ranking.source}:${input.ranking.sourceEventId}`,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `compute-data-entity:${input.request.source}:${input.request.sourceEntityType}:${input.request.sourceEntityId}`,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `compute-data-request:${input.request.id}`,
      ]);
      const replayDigest = await existingBySource(
        client, 'compute_ranking_runs', input.ranking.source, input.ranking.sourceEventId,
      );
      if (replayDigest !== null) {
        return replayDigest === rankingDigest
          ? { status: 'replayed' as const }
          : { status: 'conflict' as const };
      }

      const existingRequestDigest = await requestDigest(client, input.request.id);
      if (existingRequestDigest !== null && existingRequestDigest !== demandDigest) {
        return { status: 'conflict' as const };
      }
      if (existingRequestDigest === null) {
        await client.query(`INSERT INTO compute_data_requests(
          id,buyer_subject_id,source_entity_type,source_entity_id,requirement,parsed_requirement,
          requirement_version,payload_digest,occurred_at,source,source_version,environment,data_origin,trace_id
        ) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)`, [
          input.request.id, input.request.buyerSubjectId ?? null,
          input.request.sourceEntityType, input.request.sourceEntityId,
          json(input.request.requirement), json(input.request.parsedRequirement),
          input.request.requirementVersion, demandDigest, input.request.occurredAt,
          input.request.source, input.request.sourceVersion, input.request.environment,
          input.request.dataOrigin, input.request.traceId ?? null,
        ]);
      }

      await client.query(`INSERT INTO compute_ranking_runs(
        id,request_id,source_event_id,algorithm_version,policy_version,expected_candidate_count,
        context,payload_digest,occurred_at,source,source_version
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`, [
        input.ranking.id, input.request.id, input.ranking.sourceEventId,
        input.ranking.algorithmVersion, input.ranking.policyVersion, input.candidates.length,
        json(input.ranking.context), rankingDigest, input.ranking.occurredAt,
        input.ranking.source, input.ranking.sourceVersion,
      ]);

      for (const candidate of input.candidates) {
        await client.query(`INSERT INTO compute_ranking_candidates(
          ranking_run_id,request_id,candidate_key,resource_id,supplier_id,listing_id,feature_snapshot,
          score,component_scores,rank_position,eligible,rejection_reasons,listed_price_micros,
          quoted_price_micros,currency,quantity,duration_seconds,availability_snapshot,sla_snapshot,
          price_observed_at,inventory_observed_at,captured_at,data_origin
        ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,
          $18::jsonb,$19::jsonb,$20,$21,$22,$23)`, [
          input.ranking.id, input.request.id, candidate.candidateKey,
          candidate.resourceId ?? null, candidate.supplierId ?? null, candidate.listingId ?? null,
          json(candidate.featureSnapshot), candidate.score, json(candidate.componentScores),
          candidate.rankPosition, candidate.eligible, json(candidate.rejectionReasons),
          candidate.listedPriceMicros ?? null, candidate.quotedPriceMicros ?? null,
          candidate.currency ?? null, candidate.quantity ?? null, candidate.durationSeconds ?? null,
          json(candidate.availabilitySnapshot), json(candidate.slaSnapshot),
          candidate.priceObservedAt ?? null, candidate.inventoryObservedAt ?? null, candidate.capturedAt,
          candidate.dataOrigin,
        ]);
      }
      return { status: 'created' as const };
    });
  }

  async recordEvent(input: RecordComputeJourneyEventInput, payloadDigest: string) {
    return this.database.transaction((client) => recordComputeJourneyEventInTransaction(client, input, payloadDigest));
  }

  async qualityIssues(limit: number) {
    const result = await this.database.query<QualityRow>(`SELECT issue_code,request_id,ranking_run_id,event_id,detail
      FROM compute_data_quality_issues_v1
      ORDER BY request_id,ranking_run_id,event_id NULLS FIRST,issue_code LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ issueCode: row.issue_code, requestId: row.request_id,
      rankingRunId: row.ranking_run_id, eventId: row.event_id, detail: row.detail }));
  }

  async exportDataset(from: Date, to: Date, limit: number) {
    const result = await this.database.query<QueryResultRow>(`SELECT * FROM compute_training_dataset_v1
      WHERE demand_occurred_at >= $1 AND demand_occurred_at < $2
        AND request_data_origin='business' AND candidate_data_origin='business'
      ORDER BY demand_occurred_at,request_id,ranking_run_id,rank_position LIMIT $3`, [from, to, limit + 1]);
    return { rows: result.rows.slice(0, limit), hasMore: result.rows.length > limit };
  }

  async trace(requestId: string) {
    const [request, rankings, candidates, events] = await Promise.all([
      this.database.query('SELECT * FROM compute_data_requests WHERE id=$1', [requestId]),
      this.database.query('SELECT * FROM compute_ranking_runs WHERE request_id=$1 ORDER BY occurred_at,id', [requestId]),
      this.database.query(`SELECT candidate.* FROM compute_ranking_candidates candidate
        WHERE candidate.request_id=$1 ORDER BY candidate.ranking_run_id,candidate.rank_position`, [requestId]),
      this.database.query(`SELECT * FROM compute_journey_events WHERE request_id=$1
        ORDER BY occurred_at,recorded_at,id`, [requestId]),
    ]);
    return { request: request.rows[0] ?? null, rankings: rankings.rows,
      candidates: candidates.rows, events: events.rows };
  }
}

export async function recordComputeJourneyEventInTransaction(
  client: PoolClient, input: RecordComputeJourneyEventInput, payloadDigest: string,
): Promise<StoreWriteResult | StoreWriteFailure> {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `compute-data-source-event:${input.source}:${input.sourceEventId}`,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `compute-data-event:${input.requestId}`,
      ]);
      const replayDigest = await existingBySource(client, 'compute_journey_events', input.source, input.sourceEventId);
      if (replayDigest !== null) {
        return replayDigest === payloadDigest
          ? { status: 'replayed' as const }
          : { status: 'conflict' as const };
      }
      const candidate = await client.query<CandidateOriginRow>(`SELECT candidate.data_origin AS candidate_origin,
          request.data_origin AS request_origin,ranking.occurred_at AS ranking_occurred_at
        FROM compute_ranking_candidates candidate
        JOIN compute_data_requests request ON request.id=candidate.request_id
        JOIN compute_ranking_runs ranking ON ranking.id=candidate.ranking_run_id
        WHERE candidate.ranking_run_id=$1 AND candidate.request_id=$2 AND candidate.candidate_key=$3`, [
        input.rankingRunId, input.requestId, input.candidateKey,
      ]);
      if (!candidate.rowCount) return { status: 'missing_parent' as const };
      const origin = candidate.rows[0];
      if (origin && input.occurredAt < origin.ranking_occurred_at) {
        return { status: 'invalid_transition' as const };
      }
      if (input.dataOrigin === 'business'
        && (origin?.candidate_origin !== 'business' || origin.request_origin !== 'business')) {
        return { status: 'invalid_transition' as const };
      }

      const events = await client.query<EventRow>(`SELECT event_name,occurred_at FROM compute_journey_events
        WHERE ranking_run_id=$1 AND candidate_key=$2 AND occurred_at<=$3`, [
        input.rankingRunId, input.candidateKey, input.occurredAt,
      ]);
      const seen = new Set(events.rows.map((event) => event.event_name));
      if (input.eventName === 'selected') {
        const selection = await client.query(`SELECT 1 FROM compute_journey_events
          WHERE ranking_run_id=$1 AND event_name='selected' LIMIT 1`, [input.rankingRunId]);
        if (selection.rowCount) return { status: 'invalid_transition' as const };
      }
      const required = prerequisites[input.eventName];
      if (required && !required.some((name) => seen.has(name))) {
        return { status: 'invalid_transition' as const };
      }

      await client.query(`INSERT INTO compute_journey_events(
        id,request_id,ranking_run_id,candidate_key,event_name,source_event_id,
        quote_id,reservation_id,order_id,fulfillment_id,settlement_id,refund_id,
        accepted_price_micros,final_cost_micros,currency,latency_ms,reason_code,
        payload,payload_digest,occurred_at,source,source_version,data_origin,trace_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18::jsonb,$19,$20,$21,$22,$23,$24)`, [
        input.id, input.requestId, input.rankingRunId, input.candidateKey,
        input.eventName, input.sourceEventId, input.quoteId ?? null,
        input.reservationId ?? null, input.orderId ?? null, input.fulfillmentId ?? null,
        input.settlementId ?? null, input.refundId ?? null,
        input.acceptedPriceMicros ?? null, input.finalCostMicros ?? null,
        input.currency ?? null, input.latencyMs ?? null, input.reasonCode ?? null,
        json(input.payload), payloadDigest, input.occurredAt, input.source,
        input.sourceVersion, input.dataOrigin, input.traceId ?? null,
      ]);
      return { status: 'created' as const };
}
