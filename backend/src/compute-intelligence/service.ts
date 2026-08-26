import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import type { ComputeDataOrigin, ComputeRuntimeEnvironment, JsonObject } from '../compute-data/types.js';
import type { ComputeDataFlywheelService } from '../compute-data/service.js';
import type { ListingAuditStore } from '../listings/store.js';
import type { SubjectAccess } from '../subjects/types.js';
import { rankComputeCandidates } from './engine.js';
import { ComputeRequirementParser } from './parser.js';
import type { ComputeRequirement, RankingWeights } from './types.js';

export type ComputeRecommendationRequestContext = Readonly<{ actorId: string }>;

function decimal(value: number, digits = 6) {
  return value.toFixed(digits).replace(/0+$/u, '').replace(/\.$/u, '');
}

function parsedRequirement(requirement: ComputeRequirement): JsonObject {
  return {
    gpuModel: 'ANY_COMPATIBLE', gpuCount: requirement.gpuCount,
    region: requirement.region ?? 'ANY', durationHours: requirement.durationHours,
    quantity: requirement.gpuCount * requirement.durationHours,
    budgetMaxMicros: requirement.budgetCny === null ? null : Math.round(requirement.budgetCny * 1_000_000),
    currency: 'CNY', taskType: requirement.taskType, workload: requirement.workload,
    modelFamily: requirement.modelFamily, modelSizeBillions: requirement.modelSizeBillions,
    datasetRows: requirement.datasetRows, fineTuningMethod: requirement.fineTuningMethod,
    estimatedVramGiBPerGpu: requirement.estimatedVramGiBPerGpu,
    deadlineHours: requirement.deadlineHours, precision: requirement.precision,
    minimumReliabilityPercent: requirement.minimumReliabilityPercent,
    minimumSlaAvailabilityPercent: requirement.minimumSlaAvailabilityPercent,
  };
}

function policyVersion(weights: RankingWeights) {
  const canonical = Object.entries(weights).sort(([left], [right]) => left.localeCompare(right));
  return `weighted-policy-v1.${createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)}`;
}

export class ComputeIntelligenceService {
  constructor(
    private readonly listings: Pick<ListingAuditStore, 'listPublicListings'>,
    private readonly subjects: SubjectAccess,
    private readonly parser: ComputeRequirementParser,
    private readonly flywheel: ComputeDataFlywheelService,
    private readonly weights: RankingWeights,
    private readonly environment: ComputeRuntimeEnvironment,
    private readonly dataOrigin: ComputeDataOrigin,
    private readonly now: () => Date = () => new Date(),
  ) {}

  parse(text: string, confirmedRequirement?: ComputeRequirement) {
    return this.parser.parse(text, confirmedRequirement);
  }

  async recommend(text: string, context: ComputeRecommendationRequestContext, confirmedRequirement?: ComputeRequirement) {
    const parsed = await this.parse(text, confirmedRequirement);
    const candidates = await this.listings.listPublicListings(200);
    const subject = await this.subjects.current(context.actorId, 'orders.buy');
    const occurredAt = this.now();
    const ranking = rankComputeCandidates(parsed.requirement, candidates, occurredAt, this.weights);
    const runId = randomUUID();
    const requirement = parsedRequirement(parsed.requirement);
    try {
      await this.flywheel.captureRanking({
        request: {
          id: runId, buyerSubjectId: subject.subjectId,
          sourceEntityType: 'compute-recommendation', sourceEntityId: runId,
          requirement, parsedRequirement: requirement,
          requirementVersion: parsed.parser.version, occurredAt,
          source: 'compute-intelligence', sourceVersion: 'compute-intelligence-v1',
          environment: this.environment, dataOrigin: this.dataOrigin,
        },
        ranking: {
          id: runId, sourceEventId: `recommendation:${runId}`,
          algorithmVersion: ranking.algorithmVersion, policyVersion: policyVersion(ranking.weights),
          context: { parserMode: parsed.parser.mode, weights: ranking.weights,
            candidatePool: { source: 'verified-public-listings', limit: 200, ordering: 'listing-store-default' } }, occurredAt,
          source: 'compute-intelligence', sourceVersion: 'compute-intelligence-v1',
        },
        candidates: ranking.evaluatedCandidates.map((candidate) => ({
          candidateKey: candidate.facts.listingId, resourceId: candidate.facts.resourceId,
          supplierId: candidate.facts.supplierId, listingId: candidate.facts.listingId,
          featureSnapshot: {
            gpuModel: candidate.facts.gpuModel, memoryGiBPerGpu: candidate.facts.memoryGiBPerGpu,
            resourceGpuCount: candidate.facts.resourceGpuCount, region: candidate.facts.region,
            requiredGpuHours: candidate.facts.requiredGpuHours,
            minimumGpuHours: candidate.facts.minimumGpuHours,
            unitPriceCnyPerGpuHour: candidate.facts.unitPriceCnyPerGpuHour,
            estimatedPriceCny: candidate.facts.estimatedPriceCny,
            listingStartsAt: candidate.facts.startsAt.toISOString(),
            listingExpiresAt: candidate.facts.expiresAt.toISOString(),
          },
          score: decimal(candidate.score), componentScores: candidate.componentScores,
          rankPosition: candidate.rank, eligible: candidate.eligible,
          rejectionReasons: candidate.rejectionReasons.map((reason) => ({ code: reason.code, field: reason.field })),
          listedPriceMicros: candidate.listing.referenceCnyMicros.toString(),
          quotedPriceMicros: candidate.listing.referenceCnyMicros.toString(), currency: 'CNY',
          quantity: decimal(candidate.facts.requiredGpuHours),
          durationSeconds: String(Math.round(parsed.requirement.durationHours * 3_600)),
          availabilitySnapshot: {
            availableGpuHours: candidate.facts.availableGpuHours,
            requiredGpuHours: candidate.facts.requiredGpuHours,
          },
          slaSnapshot: {
            reliabilityPercent: candidate.facts.reliabilityPercent,
            availabilityPercent: candidate.facts.slaAvailabilityPercent,
            latencyMs: candidate.facts.latencyMs,
            provisioningMinutes: candidate.facts.provisioningMinutes,
          },
          priceObservedAt: occurredAt, inventoryObservedAt: occurredAt,
          capturedAt: occurredAt, dataOrigin: this.dataOrigin,
        })),
      });
    } catch {
      throw new AppError('COMPUTE_INTELLIGENCE_DATA_UNAVAILABLE', 503, '推荐结果暂时无法安全留痕，请稍后重试。');
    }
    const recommendations = ranking.recommendations.map((recommendation) => ({
      ...recommendation,
      orderHandoff: { ...recommendation.orderHandoff,
        body: { ...recommendation.orderHandoff.body, recommendationRunId: runId } },
    }));
    return {
      runId, parsed, algorithmVersion: ranking.algorithmVersion, weights: ranking.weights,
      candidateCount: ranking.candidateCount, eligibleCandidateCount: ranking.eligibleCandidateCount,
      recommendations, comparisons: ranking.comparisons, fallback: ranking.fallback,
      persisted: true as const, preview: parsed.confirmationRequired,
    };
  }
}
