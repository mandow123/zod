export const FEE_DENOMINATOR_BPS = 10_000n;
export const CNY_MICROS_PER_KAI_CREDIT = 1_002_000n;

export type FeeTier = Readonly<{
  ordinal: number;
  lowerBoundMicros: bigint;
  upperBoundMicros: bigint | null;
  rateBps: number;
}>;

export type FeeSegment = Readonly<{
  ordinal: number;
  tierOrdinal: number;
  lowerBoundMicros: bigint;
  upperBoundMicros: bigint | null;
  settledCreditMicros: bigint;
  rateBps: number;
  exactFeeNumerator: bigint;
  serviceFeeCreditMicros: bigint;
}>;

export type FeeAssessmentPlan = Readonly<{
  cumulativeBeforeMicros: bigint;
  cumulativeAfterMicros: bigint;
  grossCreditMicros: bigint;
  serviceFeeCreditMicros: bigint;
  netCreditMicros: bigint;
  segments: readonly FeeSegment[];
}>;

export type ReversibleFeeSegment = FeeSegment & Readonly<{
  id: string;
  reversedCreditMicros: bigint;
  reversedFeeCreditMicros: bigint;
}>;

export type FeeReversalAllocation = Readonly<{
  originalSegmentId: string;
  originalTierOrdinal: number;
  reversedCreditMicros: bigint;
  reversedFeeCreditMicros: bigint;
  rateBps: number;
  exactFeeNumerator: bigint;
}>;

export type FeeReversalPlan = Readonly<{
  reversedGrossCreditMicros: bigint;
  reversedServiceFeeCreditMicros: bigint;
  reversedNetCreditMicros: bigint;
  allocations: readonly FeeReversalAllocation[];
}>;

export type SupplierFeeBillItem = Readonly<{
  id: string;
  orderId: string | null;
  kind: 'settlement' | 'reversal';
  sourceKind: 'compute_settlement' | 'renewal_settlement' | 'compute_settlement_refund';
  sourceId: string;
  grossCreditMicros: bigint;
  serviceFeeCreditMicros: bigint;
  netCreditMicros: bigint;
  feeScheduleVersion: string;
  period: string;
  settledAt: Date;
  tierBreakdown: readonly FeeSegment[];
}>;
