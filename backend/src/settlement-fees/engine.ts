import {
  FEE_DENOMINATOR_BPS,
  type FeeAssessmentPlan,
  type FeeReversalPlan,
  type FeeSegment,
  type FeeTier,
  type ReversibleFeeSegment,
} from './types.js';

function ceilDiv(numerator: bigint, denominator: bigint) {
  if (numerator < 0n || denominator <= 0n) throw new Error('FEE_INTEGER_DOMAIN_INVALID');
  return numerator === 0n ? 0n : ((numerator - 1n) / denominator) + 1n;
}

export function validateFeeTiers(tiersInput: readonly FeeTier[]) {
  if (tiersInput.length === 0) throw new Error('FEE_TIERS_REQUIRED');
  const tiers = [...tiersInput].sort((left, right) => left.ordinal - right.ordinal);
  let expectedLower = 0n;
  let previousRate: number | null = null;
  for (const [index, tier] of tiers.entries()) {
    if (tier.ordinal !== index || tier.lowerBoundMicros !== expectedLower
      || !Number.isInteger(tier.rateBps) || tier.rateBps < 20 || tier.rateBps > 100) {
      throw new Error('FEE_TIERS_NOT_CONTIGUOUS');
    }
    if (previousRate !== null && tier.rateBps > previousRate) throw new Error('FEE_TIER_RATE_MUST_NOT_INCREASE');
    if (tier.upperBoundMicros === null) {
      if (index !== tiers.length - 1) throw new Error('FEE_TIER_OPEN_BOUND_MUST_BE_LAST');
    } else {
      if (tier.upperBoundMicros <= tier.lowerBoundMicros) throw new Error('FEE_TIER_RANGE_INVALID');
      expectedLower = tier.upperBoundMicros;
    }
    previousRate = tier.rateBps;
  }
  if (tiers.at(-1)?.upperBoundMicros !== null) throw new Error('FEE_TIERS_MUST_COVER_INFINITY');
  return tiers;
}

function tierVolumeAt(tier: FeeTier, cumulativeMicros: bigint) {
  if (cumulativeMicros <= tier.lowerBoundMicros) return 0n;
  const end = tier.upperBoundMicros === null || cumulativeMicros < tier.upperBoundMicros
    ? cumulativeMicros : tier.upperBoundMicros;
  return end - tier.lowerBoundMicros;
}

export function cumulativeFeeNumerator(tiersInput: readonly FeeTier[], cumulativeMicros: bigint) {
  if (cumulativeMicros < 0n) throw new Error('FEE_CUMULATIVE_VOLUME_INVALID');
  const tiers = validateFeeTiers(tiersInput);
  return tiers.reduce((total, tier) => total + tierVolumeAt(tier, cumulativeMicros) * BigInt(tier.rateBps), 0n);
}

export function cumulativeFeeMicros(tiers: readonly FeeTier[], cumulativeMicros: bigint) {
  return ceilDiv(cumulativeFeeNumerator(tiers, cumulativeMicros), FEE_DENOMINATOR_BPS);
}

function allocateLargestRemainder(
  raw: readonly Omit<FeeSegment, 'serviceFeeCreditMicros'>[],
  feeMicros: bigint,
): FeeSegment[] {
  const totalNumerator = raw.reduce((sum, segment) => sum + segment.exactFeeNumerator, 0n);
  if (feeMicros === 0n || totalNumerator === 0n) {
    if (feeMicros !== 0n) throw new Error('FEE_ALLOCATION_NUMERATOR_INVALID');
    return raw.map((segment) => ({ ...segment, serviceFeeCreditMicros: 0n }));
  }
  const working = raw.map((segment) => {
    const weighted = segment.exactFeeNumerator * feeMicros;
    return {
      segment,
      fee: weighted / totalNumerator,
      remainder: weighted % totalNumerator,
    };
  });
  let unallocated = feeMicros - working.reduce((sum, item) => sum + item.fee, 0n);
  const ranked = [...working].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.segment.tierOrdinal - right.segment.tierOrdinal;
  });
  for (const item of ranked) {
    if (unallocated === 0n) break;
    item.fee += 1n;
    unallocated -= 1n;
  }
  if (unallocated !== 0n) throw new Error('FEE_ALLOCATION_UNBALANCED');
  return working.map((item) => ({ ...item.segment, serviceFeeCreditMicros: item.fee }));
}

export function planSettlementFee(
  tiersInput: readonly FeeTier[],
  cumulativeBeforeMicros: bigint,
  grossCreditMicros: bigint,
): FeeAssessmentPlan {
  if (cumulativeBeforeMicros < 0n || grossCreditMicros <= 0n) throw new Error('FEE_ASSESSMENT_VOLUME_INVALID');
  const tiers = validateFeeTiers(tiersInput);
  const cumulativeAfterMicros = cumulativeBeforeMicros + grossCreditMicros;
  const feeBefore = cumulativeFeeMicros(tiers, cumulativeBeforeMicros);
  const feeAfter = cumulativeFeeMicros(tiers, cumulativeAfterMicros);
  const serviceFeeCreditMicros = feeAfter - feeBefore;
  if (serviceFeeCreditMicros < 0n || serviceFeeCreditMicros > grossCreditMicros) {
    throw new Error('FEE_ASSESSMENT_AMOUNT_INVALID');
  }
  const rawSegments: Array<Omit<FeeSegment, 'serviceFeeCreditMicros'>> = [];
  for (const tier of tiers) {
    const beforeInTier = tierVolumeAt(tier, cumulativeBeforeMicros);
    const afterInTier = tierVolumeAt(tier, cumulativeAfterMicros);
    const settledCreditMicros = afterInTier - beforeInTier;
    if (settledCreditMicros <= 0n) continue;
    rawSegments.push({
      ordinal: rawSegments.length,
      tierOrdinal: tier.ordinal,
      lowerBoundMicros: tier.lowerBoundMicros,
      upperBoundMicros: tier.upperBoundMicros,
      settledCreditMicros,
      rateBps: tier.rateBps,
      exactFeeNumerator: settledCreditMicros * BigInt(tier.rateBps),
    });
  }
  const segments = allocateLargestRemainder(rawSegments, serviceFeeCreditMicros);
  if (segments.reduce((sum, segment) => sum + segment.settledCreditMicros, 0n) !== grossCreditMicros
    || segments.reduce((sum, segment) => sum + segment.serviceFeeCreditMicros, 0n) !== serviceFeeCreditMicros) {
    throw new Error('FEE_ASSESSMENT_UNBALANCED');
  }
  return {
    cumulativeBeforeMicros,
    cumulativeAfterMicros,
    grossCreditMicros,
    serviceFeeCreditMicros,
    netCreditMicros: grossCreditMicros - serviceFeeCreditMicros,
    segments,
  };
}

export function planFeeReversal(
  originalSegmentsInput: readonly ReversibleFeeSegment[],
  reversedGrossCreditMicros: bigint,
): FeeReversalPlan {
  if (reversedGrossCreditMicros <= 0n) throw new Error('FEE_REVERSAL_VOLUME_INVALID');
  const originalSegments = [...originalSegmentsInput].sort((left, right) => right.ordinal - left.ordinal);
  const remainingAvailable = originalSegments.reduce(
    (sum, segment) => sum + segment.settledCreditMicros - segment.reversedCreditMicros, 0n,
  );
  if (reversedGrossCreditMicros > remainingAvailable) throw new Error('FEE_REVERSAL_EXCEEDS_ORIGINAL');
  let remaining = reversedGrossCreditMicros;
  const allocations = [];
  for (const segment of originalSegments) {
    if (remaining === 0n) break;
    const available = segment.settledCreditMicros - segment.reversedCreditMicros;
    if (available <= 0n) continue;
    const volume = available < remaining ? available : remaining;
    const reversedVolumeAfter = segment.reversedCreditMicros + volume;
    const feeAfter = ceilDiv(segment.serviceFeeCreditMicros * reversedVolumeAfter, segment.settledCreditMicros);
    const feeBefore = ceilDiv(
      segment.serviceFeeCreditMicros * segment.reversedCreditMicros,
      segment.settledCreditMicros,
    );
    const fee = feeAfter - feeBefore;
    allocations.push({
      originalSegmentId: segment.id,
      originalTierOrdinal: segment.tierOrdinal,
      reversedCreditMicros: volume,
      reversedFeeCreditMicros: fee,
      rateBps: segment.rateBps,
      exactFeeNumerator: volume * BigInt(segment.rateBps),
    });
    remaining -= volume;
  }
  if (remaining !== 0n) throw new Error('FEE_REVERSAL_ALLOCATION_INVALID');
  const reversedServiceFeeCreditMicros = allocations.reduce(
    (sum, allocation) => sum + allocation.reversedFeeCreditMicros, 0n,
  );
  return {
    reversedGrossCreditMicros,
    reversedServiceFeeCreditMicros,
    reversedNetCreditMicros: reversedGrossCreditMicros - reversedServiceFeeCreditMicros,
    allocations,
  };
}

export function shanghaiPeriodStart(value: Date) {
  if (!Number.isFinite(value.getTime())) throw new Error('FEE_PERIOD_DATE_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).formatToParts(value);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('FEE_PERIOD_DATE_INVALID');
  return `${year}-${month}-01`;
}
