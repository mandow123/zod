import type { PublicCreditListing } from '../listings/types.js';

export const computeTaskTypes = ['fine_tuning', 'training', 'inference', 'rendering', 'other'] as const;
export const computeWorkloadModes = ['training', 'inference'] as const;
export const computeFineTuningMethods = ['full_ft', 'lora', 'qlora', 'not_applicable'] as const;
export const computePrecisions = ['fp32', 'fp16', 'bf16', 'fp8', 'int8', 'int4', 'unspecified'] as const;

export type ComputeTaskType = typeof computeTaskTypes[number];
export type ComputeWorkloadMode = typeof computeWorkloadModes[number];
export type ComputeFineTuningMethod = typeof computeFineTuningMethods[number];
export type ComputePrecision = typeof computePrecisions[number];

export type ComputeRequirement = Readonly<{
  taskType: ComputeTaskType;
  workload: ComputeWorkloadMode;
  modelFamily: string | null;
  modelSizeBillions: number | null;
  datasetRows: number | null;
  fineTuningMethod: ComputeFineTuningMethod;
  estimatedVramGiBPerGpu: number;
  gpuCount: number;
  deadlineHours: number | null;
  budgetCny: number | null;
  region: string | null;
  durationHours: number;
  precision: ComputePrecision;
  minimumReliabilityPercent: number | null;
  minimumSlaAvailabilityPercent: number | null;
}>;

export type RequirementParseResult = Readonly<{
  requirement: ComputeRequirement;
  parser: Readonly<{
    mode: 'llm_structured_output' | 'deterministic' | 'deterministic_fallback' | 'user_confirmed';
    version: 'compute-requirement-v1';
  }>;
  assumptions: readonly string[];
  uncertainties: readonly string[];
  confirmationRequired: boolean;
}>;

export interface StructuredRequirementExtractor {
  readonly version: string;
  extract(text: string): Promise<unknown>;
}

export type RankingWeights = Readonly<{
  cost: number;
  reliability: number;
  availability: number;
  latency: number;
  sla: number;
  hardwareFit: number;
}>;

export const defaultRankingWeights: RankingWeights = Object.freeze({
  cost: 0.25,
  reliability: 0.20,
  availability: 0.15,
  latency: 0.10,
  sla: 0.15,
  hardwareFit: 0.15,
});

export type ComponentScores = RankingWeights;

export type RejectionReason = Readonly<{
  code: string;
  message: string;
  field: 'gpu_count' | 'vram' | 'region' | 'window' | 'availability' | 'budget' | 'reliability' | 'sla' | 'data';
}>;

export type CandidateFacts = Readonly<{
  listingId: string;
  resourceId: string;
  supplierId: string;
  title: string;
  productCode: string;
  gpuModel: string;
  memoryGiBPerGpu: number | null;
  resourceGpuCount: number | null;
  region: string;
  availableGpuHours: number;
  requiredGpuHours: number;
  minimumGpuHours: number;
  unitPriceCnyPerGpuHour: number;
  estimatedPriceCny: number;
  reliabilityPercent: number | null;
  slaAvailabilityPercent: number | null;
  latencyMs: number | null;
  provisioningMinutes: number | null;
  startsAt: Date;
  expiresAt: Date;
  listingCreatedAt: Date;
  sla: Record<string, unknown>;
}>;

export type EvaluatedCandidate = Readonly<{
  listing: PublicCreditListing;
  facts: CandidateFacts;
  eligible: boolean;
  rejectionReasons: readonly RejectionReason[];
  componentScores: ComponentScores;
  score: number;
  rank: number;
  risks: readonly string[];
  reasons: readonly string[];
}>;

export type ComputeRecommendation = Readonly<{
  rank: number;
  listingId: string;
  resourceId: string;
  title: string;
  productCode: string;
  gpuModel: string;
  gpuCount: number;
  memoryGiBPerGpu: number;
  region: string;
  estimatedPriceCny: string;
  estimatedDurationHours: number;
  score: number;
  componentScores: ComponentScores;
  reasons: readonly string[];
  risks: readonly string[];
  orderHandoff: Readonly<{
    method: 'POST';
    path: '/mobile/v1/orders';
    body: Readonly<{ listingId: string; quantity: string; recommendationRunId?: string }>;
    capacityUnit: 'GPU时';
    createsOrder: false;
  }>;
}>;

export type RankingComparison = Readonly<{
  higherListingId: string;
  lowerListingId: string;
  reason: string;
}>;

export type ComputeRankingResult = Readonly<{
  algorithmVersion: 'explainable-weighted-baseline-v1';
  weights: RankingWeights;
  candidateCount: number;
  eligibleCandidateCount: number;
  recommendations: readonly ComputeRecommendation[];
  comparisons: readonly RankingComparison[];
  evaluatedCandidates: readonly EvaluatedCandidate[];
  fallback: null | Readonly<{
    kind: 'resource_inquiry';
    path: '/mobile/v1/resource-inquiries';
    reason: string;
  }>;
}>;
