export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;
export type ComputeDataOrigin = 'business' | 'seed_reference' | 'demo' | 'synthetic';
export type ComputeRuntimeEnvironment = 'production' | 'staging' | 'test' | 'development';

export type ComputeRankingCandidateInput = Readonly<{
  candidateKey: string;
  resourceId?: string;
  supplierId?: string;
  listingId?: string;
  featureSnapshot: JsonObject;
  score: string;
  componentScores: JsonObject;
  rankPosition: number;
  eligible: boolean;
  rejectionReasons: readonly JsonValue[];
  listedPriceMicros?: string;
  quotedPriceMicros?: string;
  currency?: string;
  quantity?: string;
  durationSeconds?: string;
  availabilitySnapshot: JsonObject;
  slaSnapshot: JsonObject;
  priceObservedAt?: Date;
  inventoryObservedAt?: Date;
  capturedAt: Date;
  dataOrigin: ComputeDataOrigin;
}>;

export type CaptureComputeRankingInput = Readonly<{
  request: Readonly<{
    id: string;
    buyerSubjectId?: string;
    sourceEntityType: string;
    sourceEntityId: string;
    requirement: JsonObject;
    parsedRequirement: JsonObject;
    requirementVersion: string;
    occurredAt: Date;
    source: string;
    sourceVersion: string;
    environment: ComputeRuntimeEnvironment;
    dataOrigin: ComputeDataOrigin;
    traceId?: string;
  }>;
  ranking: Readonly<{
    id: string;
    sourceEventId: string;
    algorithmVersion: string;
    policyVersion: string;
    context: JsonObject;
    occurredAt: Date;
    source: string;
    sourceVersion: string;
  }>;
  candidates: readonly ComputeRankingCandidateInput[];
}>;

export const computeJourneyEventNames = [
  'viewed', 'clicked', 'selected', 'quote_created', 'quote_accepted',
  'reservation_succeeded', 'reservation_failed',
  'provisioning_started', 'provisioning_succeeded', 'provisioning_failed',
  'fulfillment_started', 'fulfillment_completed', 'sla_violated',
  'telemetry_observed', 'settlement_completed', 'failed',
  'refund_requested', 'refunded', 'feedback_submitted',
] as const;

export type ComputeJourneyEventName = typeof computeJourneyEventNames[number];

export type RecordComputeJourneyEventInput = Readonly<{
  id: string;
  requestId: string;
  rankingRunId: string;
  candidateKey: string;
  eventName: ComputeJourneyEventName;
  sourceEventId: string;
  quoteId?: string;
  reservationId?: string;
  orderId?: string;
  fulfillmentId?: string;
  settlementId?: string;
  refundId?: string;
  acceptedPriceMicros?: string;
  finalCostMicros?: string;
  currency?: string;
  latencyMs?: string;
  reasonCode?: string;
  payload: JsonObject;
  occurredAt: Date;
  source: string;
  sourceVersion: string;
  dataOrigin: Exclude<ComputeDataOrigin, 'seed_reference'>;
  traceId?: string;
}>;

export type ComputeDataQualityIssue = Readonly<{
  issueCode: string;
  requestId: string;
  rankingRunId: string;
  eventId: string | null;
  detail: JsonObject;
}>;

export type ComputeTrainingDatasetRow = Readonly<Record<string, unknown>>;
