import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComputeDataFlywheelService } from '../src/compute-data/service.js';
import { PostgresComputeDataFlywheelStore } from '../src/compute-data/store.js';
import type {
  CaptureComputeRankingInput,
  ComputeJourneyEventName,
  RecordComputeJourneyEventInput,
} from '../src/compute-data/types.js';
import type { Database } from '../src/database.js';

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0,
    command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) =>
      pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) =>
      pglite.transaction(async (transaction: Transaction) => work({
        query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)),
      } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

const baseTime = new Date('2026-08-23T01:00:00.000Z');
const at = (seconds: number) => new Date(baseTime.getTime() + seconds * 1_000);

function rankingInput(): CaptureComputeRankingInput {
  const requestId = randomUUID();
  const rankingRunId = randomUUID();
  return {
    request: {
      id: requestId,
      sourceEntityType: 'compute-demand',
      sourceEntityId: `demand-${requestId}`,
      requirement: { gpuModel: 'H100', gpuCount: 2, region: 'cn-east', durationHours: 8 },
      parsedRequirement: { gpuModel: 'H100', gpuCount: 2, region: 'cn-east', durationHours: 8 },
      requirementVersion: 'compute-demand-v1',
      occurredAt: at(0), source: 'routing-api', sourceVersion: '1.0.0',
      environment: 'production', dataOrigin: 'business', traceId: `trace-${requestId}`,
    },
    ranking: {
      id: rankingRunId, sourceEventId: `ranking-${rankingRunId}`,
      algorithmVersion: 'rule-baseline-v1', policyVersion: 'policy-2026-08-23',
      context: { demandBand: 'interactive', candidatePoolVersion: 'catalog-42' },
      occurredAt: at(1), source: 'routing-api', sourceVersion: '1.0.0',
    },
    candidates: [
      {
        candidateKey: 'candidate-a', featureSnapshot: { gpuModel: 'H100', region: 'cn-east', memoryGb: 80 },
        score: '0.930000', componentScores: { price: 0.8, reliability: 0.99 }, rankPosition: 1,
        eligible: true, rejectionReasons: [], listedPriceMicros: '12000000', quotedPriceMicros: '11500000',
        currency: 'CNY', quantity: '2', durationSeconds: '28800', availabilitySnapshot: { available: 4 },
        slaSnapshot: { uptimeBasisPoints: 9990 }, priceObservedAt: at(1), inventoryObservedAt: at(1),
        capturedAt: at(1), dataOrigin: 'business',
      },
      {
        candidateKey: 'candidate-b', featureSnapshot: { gpuModel: 'H100', region: 'cn-east', memoryGb: 80 },
        score: '0.880000', componentScores: { price: 0.95, reliability: 0.91 }, rankPosition: 2,
        eligible: true, rejectionReasons: [], listedPriceMicros: '11000000', quotedPriceMicros: '10800000',
        currency: 'CNY', quantity: '2', durationSeconds: '28800', availabilitySnapshot: { available: 2 },
        slaSnapshot: { uptimeBasisPoints: 9950 }, priceObservedAt: at(1), inventoryObservedAt: at(1),
        capturedAt: at(1), dataOrigin: 'business',
      },
      {
        candidateKey: 'candidate-c', featureSnapshot: { gpuModel: 'A100', region: 'cn-east', memoryGb: 40 },
        score: '0.210000', componentScores: { compatibility: 0.1 }, rankPosition: 3,
        eligible: false, rejectionReasons: ['GPU_MEMORY_TOO_LOW'], listedPriceMicros: '8000000',
        currency: 'CNY', quantity: '2', durationSeconds: '28800', availabilitySnapshot: { available: 8 },
        slaSnapshot: { uptimeBasisPoints: 9900 }, priceObservedAt: at(1), inventoryObservedAt: at(1),
        capturedAt: at(1), dataOrigin: 'business',
      },
    ],
  };
}

describe('compute data flywheel V1', () => {
  let pglite: PGlite;
  let database: Database;
  let service: ComputeDataFlywheelService;

  beforeEach(async () => {
    pglite = new PGlite();
    for (const name of ['0001_cloudpay_ledger.sql', '0016_trading_subjects.sql', '0066_compute_data_flywheel_v1.sql']) {
      await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    }
    database = adapter(pglite);
    service = new ComputeDataFlywheelService(new PostgresComputeDataFlywheelStore(database));
  });

  afterEach(async () => database.close());

  it('keeps unselected candidates and joins the complete business outcome chain', { timeout: 30_000 }, async () => {
    const input = rankingInput();
    const captured = await service.captureRanking(input);
    expect(captured).toEqual({ replayed: false, requestId: input.request.id,
      rankingRunId: input.ranking.id, candidateCount: 3 });
    await expect(service.captureRanking(input)).resolves.toMatchObject({ replayed: true });

    let eventOffset = 2;
    const record = async (eventName: ComputeJourneyEventName, extra: Partial<RecordComputeJourneyEventInput> = {}) => {
      const event: RecordComputeJourneyEventInput = {
        id: randomUUID(), requestId: input.request.id, rankingRunId: input.ranking.id,
        candidateKey: 'candidate-b', eventName, sourceEventId: `${eventName}-${eventOffset}`,
        payload: {}, occurredAt: at(eventOffset++), source: 'commerce-domain', sourceVersion: '1.0.0',
        dataOrigin: 'business', ...extra,
      };
      return service.recordEvent(event);
    };

    await record('viewed');
    await record('clicked');
    await record('selected');
    await record('quote_created', { quoteId: 'quote-42' });
    await record('quote_accepted', { quoteId: 'quote-42', acceptedPriceMicros: '10800000', currency: 'CNY' });
    await record('reservation_succeeded', { reservationId: 'reservation-42' });
    await record('provisioning_started', { fulfillmentId: 'fulfillment-42' });
    await record('provisioning_succeeded', { fulfillmentId: 'fulfillment-42', latencyMs: '42000' });
    await record('fulfillment_started', { fulfillmentId: 'fulfillment-42' });
    await record('telemetry_observed', { fulfillmentId: 'fulfillment-42', payload: { gpuUtilizationBasisPoints: 8700 } });
    await record('fulfillment_completed', { fulfillmentId: 'fulfillment-42' });
    await record('settlement_completed', { settlementId: 'settlement-42', finalCostMicros: '10600000', currency: 'CNY' });

    const trace = await service.trace(input.request.id);
    expect(trace.request?.id).toBe(input.request.id);
    expect(trace.candidates.map((row) => row.candidate_key)).toEqual(['candidate-a', 'candidate-b', 'candidate-c']);
    expect(trace.events).toHaveLength(12);
    expect(await service.qualityIssues()).toEqual([]);

    const exported = await service.exportDataset({
      from: at(-1), to: at(100), limit: 10, anonymizationKey: 'a-private-export-key-with-at-least-32-characters',
    });
    expect(exported.hasMore).toBe(false);
    expect(exported.rows).toHaveLength(3);
    const selected = exported.rows.find((row) => row.rank_position === 2);
    const notSelected = exported.rows.find((row) => row.rank_position === 1);
    const rejected = exported.rows.find((row) => row.rank_position === 3);
    expect(selected).toMatchObject({ selected: true, quote_accepted: true, reservation_success: true,
      provisioning_success: true, completion: true, accepted_price_micros: '10800000',
      final_cost_micros: '10600000', latency_ms: '42000', telemetry_observation_count: '1',
      latest_telemetry_payload: { gpuUtilizationBasisPoints: 8700 } });
    expect(notSelected).toMatchObject({ selected: false, completion: false });
    expect(rejected).toMatchObject({ eligible: false, selected: false });
    expect(selected).not.toHaveProperty('request_id');
    expect(selected).not.toHaveProperty('candidate_key');
    expect(selected?.request_anon_id).toMatch(/^hmac-sha256:v1:/u);
    expect(selected?.candidate_anon_id).toMatch(/^hmac-sha256:v1:/u);

    const limited = await service.exportDataset({
      from: at(-1), to: at(100), limit: 1, anonymizationKey: 'a-private-export-key-with-at-least-32-characters',
    });
    expect(limited).toMatchObject({ hasMore: true });
    expect(limited.rows).toHaveLength(1);
  });

  it('rejects impossible transitions, idempotency conflicts, bad prices and sensitive fields', async () => {
    const input = rankingInput();
    await service.captureRanking(input);
    await expect(service.recordEvent({
      id: randomUUID(), requestId: input.request.id, rankingRunId: input.ranking.id,
      candidateKey: 'candidate-a', eventName: 'provisioning_succeeded', sourceEventId: 'invalid-transition',
      fulfillmentId: 'fulfillment-invalid', payload: {}, occurredAt: at(2),
      source: 'commerce-domain', sourceVersion: '1.0.0', dataOrigin: 'business',
    })).rejects.toMatchObject({ code: 'COMPUTE_DATA_INVALID_TRANSITION' });
    await expect(service.recordEvent({
      id: randomUUID(), requestId: input.request.id, rankingRunId: input.ranking.id,
      candidateKey: 'candidate-a', eventName: 'viewed', sourceEventId: 'event-before-ranking',
      payload: {}, occurredAt: at(0), source: 'commerce-domain', sourceVersion: '1.0.0', dataOrigin: 'business',
    })).rejects.toMatchObject({ code: 'COMPUTE_DATA_INVALID_TRANSITION' });

    const conflicting = { ...input, ranking: { ...input.ranking, policyVersion: 'changed-policy' } };
    await expect(service.captureRanking(conflicting)).rejects.toMatchObject({ code: 'COMPUTE_DATA_IDEMPOTENCY_CONFLICT' });

    const negativeBase = rankingInput();
    const negative = { ...negativeBase, candidates: negativeBase.candidates.map((candidate, index) =>
      index === 0 ? { ...candidate, listedPriceMicros: '-1' } : candidate) };
    await expect(service.captureRanking(negative)).rejects.toMatchObject({ code: 'COMPUTE_DATA_INVALID' });

    const sensitiveBase = rankingInput();
    const sensitive = { ...sensitiveBase, request: { ...sensitiveBase.request,
      requirement: { ...sensitiveBase.request.requirement, userEmail: 'must-not-be-collected@example.test' } } };
    await expect(service.captureRanking(sensitive)).rejects.toMatchObject({ code: 'COMPUTE_DATA_SENSITIVE_FIELD' });

    await expect(database.query('UPDATE compute_ranking_candidates SET score=1 WHERE ranking_run_id=$1', [input.ranking.id]))
      .rejects.toBeTruthy();
  });

  it('excludes reference candidates from the anonymized business export', async () => {
    const base = rankingInput();
    const input: CaptureComputeRankingInput = {
      ...base, request: { ...base.request, dataOrigin: 'seed_reference' },
      candidates: base.candidates.map((candidate) => ({ ...candidate, dataOrigin: 'seed_reference' })),
    };
    await service.captureRanking(input);
    const exported = await service.exportDataset({
      from: at(-1), to: at(100), anonymizationKey: 'a-private-export-key-with-at-least-32-characters',
    });
    expect(exported.rows).toEqual([]);
    await expect(service.recordEvent({
      id: randomUUID(), requestId: input.request.id, rankingRunId: input.ranking.id,
      candidateKey: 'candidate-a', eventName: 'viewed', sourceEventId: 'seed-as-business',
      payload: {}, occurredAt: at(2), source: 'commerce-domain', sourceVersion: '1.0.0', dataOrigin: 'business',
    })).rejects.toMatchObject({ code: 'COMPUTE_DATA_INVALID_TRANSITION' });
  });
});
