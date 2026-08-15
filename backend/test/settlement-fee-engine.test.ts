import { describe, expect, it } from 'vitest';
import {
  cumulativeFeeMicros, planFeeReversal, planSettlementFee, shanghaiPeriodStart, validateFeeTiers,
} from '../src/settlement-fees/engine.js';
import type { FeeTier, ReversibleFeeSegment } from '../src/settlement-fees/types.js';

const C = 1_000_000n;
const proposedFixture: readonly FeeTier[] = [
  { ordinal: 0, lowerBoundMicros: 0n, upperBoundMicros: 100_000n * C, rateBps: 100 },
  { ordinal: 1, lowerBoundMicros: 100_000n * C, upperBoundMicros: 500_000n * C, rateBps: 80 },
  { ordinal: 2, lowerBoundMicros: 500_000n * C, upperBoundMicros: 2_000_000n * C, rateBps: 60 },
  { ordinal: 3, lowerBoundMicros: 2_000_000n * C, upperBoundMicros: 10_000_000n * C, rateBps: 40 },
  { ordinal: 4, lowerBoundMicros: 10_000_000n * C, upperBoundMicros: null, rateBps: 20 },
];

describe('settlement fee engine', () => {
  it('uses the cumulative fee function so split and combined settlements are identical', () => {
    const start = 99_999n * C + 999_993n;
    const volumes = [3n, 8n, 499_999n * C, 1_500_001n * C, 9n];
    let cursor = start;
    let splitFee = 0n;
    for (const volume of volumes) {
      const plan = planSettlementFee(proposedFixture, cursor, volume);
      splitFee += plan.serviceFeeCreditMicros;
      cursor = plan.cumulativeAfterMicros;
    }
    const gross = volumes.reduce((sum, value) => sum + value, 0n);
    const combined = planSettlementFee(proposedFixture, start, gross);
    expect(splitFee).toBe(combined.serviceFeeCreditMicros);
    expect(splitFee).toBe(cumulativeFeeMicros(proposedFixture, start + gross)
      - cumulativeFeeMicros(proposedFixture, start));
    expect(combined.segments.reduce((sum, segment) => sum + segment.serviceFeeCreditMicros, 0n))
      .toBe(combined.serviceFeeCreditMicros);
  });

  it('crosses tiers by marginal volume and never applies one rate to the whole settlement', () => {
    const plan = planSettlementFee(proposedFixture, 99_999n * C, 2n * C);
    expect(plan.segments.map((segment) => ({ volume: segment.settledCreditMicros, rate: segment.rateBps })))
      .toEqual([{ volume: 1n * C, rate: 100 }, { volume: 1n * C, rate: 80 }]);
    expect(plan.serviceFeeCreditMicros).toBe(18_000n);
    expect(plan.netCreditMicros).toBe(1_982_000n);
  });

  it('reverses original segments LIFO, is split invariant, and cannot over-reverse', () => {
    const original = planSettlementFee(proposedFixture, 99_999n * C, 2n * C);
    const segments: ReversibleFeeSegment[] = original.segments.map((segment, index) => ({
      ...segment, id: `segment-${index}`, reversedCreditMicros: 0n, reversedFeeCreditMicros: 0n,
    }));
    const once = planFeeReversal(segments, 1_500_000n);
    const first = planFeeReversal(segments, 500_000n);
    const afterFirst = segments.map((segment) => {
      const allocation = first.allocations.find((candidate) => candidate.originalSegmentId === segment.id);
      return allocation ? {
        ...segment,
        reversedCreditMicros: segment.reversedCreditMicros + allocation.reversedCreditMicros,
        reversedFeeCreditMicros: segment.reversedFeeCreditMicros + allocation.reversedFeeCreditMicros,
      } : segment;
    });
    const second = planFeeReversal(afterFirst, 1_000_000n);
    expect(first.reversedServiceFeeCreditMicros + second.reversedServiceFeeCreditMicros)
      .toBe(once.reversedServiceFeeCreditMicros);
    expect(once.allocations[0]).toMatchObject({ originalTierOrdinal: 1, reversedCreditMicros: 1_000_000n });
    expect(() => planFeeReversal(segments, 2_000_001n)).toThrow('FEE_REVERSAL_EXCEEDS_ORIGINAL');
  });

  it('rejects gaps and identifies natural months in Asia/Shanghai', () => {
    expect(() => validateFeeTiers([
      { ordinal: 0, lowerBoundMicros: 0n, upperBoundMicros: 10n, rateBps: 100 },
      { ordinal: 1, lowerBoundMicros: 11n, upperBoundMicros: null, rateBps: 80 },
    ])).toThrow('FEE_TIERS_NOT_CONTIGUOUS');
    expect(() => validateFeeTiers([
      { ordinal: 0, lowerBoundMicros: 0n, upperBoundMicros: 10n, rateBps: 20 },
      { ordinal: 1, lowerBoundMicros: 10n, upperBoundMicros: null, rateBps: 21 },
    ])).toThrow('FEE_TIER_RATE_MUST_NOT_INCREASE');
    expect(shanghaiPeriodStart(new Date('2026-07-31T16:00:00.000Z'))).toBe('2026-08-01');
  });
});
