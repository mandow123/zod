import { describe, expect, it } from 'vitest';
import { ComputeDataFlywheelService } from '../src/compute-data/service.js';
import type { CaptureComputeRankingInput } from '../src/compute-data/types.js';
import type { ComputeDataFlywheelStore } from '../src/compute-data/store.js';
import { ComputeIntelligenceService } from '../src/compute-intelligence/service.js';
import { ComputeRequirementParser } from '../src/compute-intelligence/parser.js';
import { defaultRankingWeights } from '../src/compute-intelligence/types.js';
import type { PublicCreditListing } from '../src/listings/types.js';
import type { SubjectAccess } from '../src/subjects/types.js';

const now = new Date('2026-08-24T04:00:00.000Z');
const buyerSubjectId = '10000000-0000-4000-8000-000000000001';

function listing(index: number, memoryGiBPerGpu: number, priceCny: number): PublicCreditListing {
  const suffix = String(index).padStart(12, '0');
  return {
    id: `30000000-0000-4000-8000-${suffix}`,
    offerId: `31000000-0000-4000-8000-${suffix}`,
    resourceId: `40000000-0000-4000-8000-${suffix}`,
    supplierId: `50000000-0000-4000-8000-${suffix}`,
    supplierSubjectId: `60000000-0000-4000-8000-${suffix}`,
    capacityTotal: '720', capacityReserved: '0', capacitySold: '0', capacityAvailable: '720',
    capacityUnit: 'GPU时', minimumQuantity: '1', unitCreditMicros: BigInt(priceCny * 1_000_000),
    referenceCnyMicros: BigInt(priceCny * 1_000_000), conversionCnyMicrosPerCredit: 1_000_000n,
    status: 'active', startsAt: new Date('2026-08-24T00:00:00.000Z'),
    expiresAt: new Date('2026-09-24T00:00:00.000Z'), auditValidUntil: new Date('2026-09-24T00:00:00.000Z'),
    createdAt: new Date('2026-08-23T00:00:00.000Z'), title: `fixture-${index}`,
    serviceMode: 'dedicated', productCode: index === 4 ? 'RTX4090' : 'H100', kind: 'gpu', region: '上海',
    specifications: { gpuModel: index === 4 ? 'RTX4090' : 'H100', gpuCount: 8, memoryGiBPerGpu },
    sla: { reliabilityPercent: 99.9, availabilityPercent: 99.9, latencyMs: 20, provisioningMinutes: 10 },
  };
}

const inventory = [listing(1, 80, 20), listing(2, 80, 24), listing(3, 141, 32), listing(4, 24, 3)];
const subjects = { current: async (userId: string) => ({
  subjectId: buyerSubjectId, kind: 'personal', displayName: 'fixture', subjectStatus: 'active',
  role: 'owner', userId, permissions: ['orders.buy'],
}) } as unknown as SubjectAccess;

function serviceWith(store: ComputeDataFlywheelStore) {
  return new ComputeIntelligenceService(
    { listPublicListings: async () => inventory }, subjects, new ComputeRequirementParser(),
    new ComputeDataFlywheelService(store), defaultRankingWeights, 'production', 'business', () => now,
  );
}

describe('Compute Intelligence production flywheel wiring', () => {
  it('persists demand and every eligible or rejected candidate before returning a recommendation', async () => {
    let captured: CaptureComputeRankingInput | undefined;
    const store = {
      captureRanking: async (input: CaptureComputeRankingInput) => { captured = input; return { status: 'created' as const }; },
      recordEvent: async () => ({ status: 'created' as const }), qualityIssues: async () => [],
      exportDataset: async () => ({ rows: [], hasMore: false }),
      trace: async () => ({ request: null, rankings: [], candidates: [], events: [] }),
    } satisfies ComputeDataFlywheelStore;
    const result = await serviceWith(store).recommend(
      '上海微调 7B 模型，24 小时，预算 2000 元。RAW-MARKER-NEVER-PERSIST',
      { actorId: '70000000-0000-4000-8000-000000000001' },
    );
    expect(result.persisted).toBe(true);
    expect(captured?.request.buyerSubjectId).toBe(buyerSubjectId);
    expect(captured?.request.dataOrigin).toBe('business');
    expect(captured?.ranking.context).toMatchObject({ candidatePool: { limit: 200, source: 'verified-public-listings' } });
    expect(captured?.candidates).toHaveLength(4);
    expect(captured?.candidates.some((candidate) => !candidate.eligible)).toBe(true);
    expect(captured?.candidates.map((candidate) => candidate.rankPosition)).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(captured)).not.toContain('RAW-MARKER-NEVER-PERSIST');
    expect(result.recommendations[0]?.orderHandoff.body.recommendationRunId).toBe(result.runId);
  });

  it('fails closed when the ranking transaction cannot be persisted', async () => {
    const store = {
      captureRanking: async () => ({ status: 'conflict' as const }),
      recordEvent: async () => ({ status: 'created' as const }), qualityIssues: async () => [],
      exportDataset: async () => ({ rows: [], hasMore: false }),
      trace: async () => ({ request: null, rankings: [], candidates: [], events: [] }),
    } satisfies ComputeDataFlywheelStore;
    await expect(serviceWith(store).recommend('上海微调 7B 模型，24 小时，预算 2000 元。', {
      actorId: '70000000-0000-4000-8000-000000000001',
    })).rejects.toMatchObject({ code: 'COMPUTE_INTELLIGENCE_DATA_UNAVAILABLE', statusCode: 503 });
  });
});
