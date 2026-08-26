import type { PublicCreditListing } from '../listings/types.js';
import {
  defaultRankingWeights,
  type CandidateFacts,
  type ComponentScores,
  type ComputeRankingResult,
  type ComputeRecommendation,
  type ComputeRequirement,
  type EvaluatedCandidate,
  type RankingComparison,
  type RankingWeights,
  type RejectionReason,
} from './types.js';

const COMPONENT_LABELS: Readonly<Record<keyof RankingWeights, string>> = {
  cost: '成本', reliability: '可靠性', availability: '可用容量', latency: '时延', sla: 'SLA', hardwareFit: '硬件适配',
};

function finiteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function percentage(value: unknown) {
  if (typeof value === 'string') {
    const match = /(\d+(?:\.\d+)?)\s*%/u.exec(value);
    if (match?.[1]) return Number(match[1]);
  }
  const parsed = finiteNumber(value);
  if (parsed === null) return null;
  if (parsed > 0 && parsed <= 1) return parsed * 100;
  if (parsed >= 0 && parsed <= 100) return parsed;
  if (parsed > 100 && parsed <= 10_000) return parsed / 100;
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) { const value = finiteNumber(source[key]); if (value !== null) return value; }
  return null;
}

function firstPercentage(source: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) { const value = percentage(source[key]); if (value !== null) return value; }
  return null;
}

function gpuModel(listing: PublicCreditListing) {
  const explicit = ['gpuModel', 'model', 'gpu', 'acceleratorModel']
    .map((key) => listing.specifications[key])
    .find((value) => typeof value === 'string' && value.trim());
  const source = String(explicit ?? listing.productCode).toUpperCase().replace(/[\s_-]+/gu, '');
  const known = ['B300', 'B200', 'H200', 'H100', 'H800', 'A100', 'A800', 'L40S', 'L40', 'RTX5090', 'RTX4090', 'MI300X', '910B'];
  return known.find((model) => source.includes(model)) ?? String(explicit ?? listing.productCode).trim().toUpperCase();
}

function priceCny(micros: bigint) { return Number(micros) / 1_000_000; }
function decimal(value: string) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function quantity(value: number) { return value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, ''); }
function clamp(value: number) { return Math.max(0, Math.min(1, value)); }

function normalizedCost(cost: number, minimum: number, maximum: number) {
  return maximum <= minimum ? 1 : clamp(1 - (cost - minimum) / (maximum - minimum));
}

function availabilityScore(available: number, required: number) {
  if (available < required || required <= 0) return 0;
  return clamp(0.55 + Math.log2(Math.max(1, available / required)) * 0.20);
}

function hardwareFitScore(memory: number | null, required: number) {
  if (memory === null || memory < required) return 0;
  const ratio = memory / required;
  return ratio <= 1.5 ? 1 : clamp(1 - (ratio - 1.5) * 0.18);
}

function reliabilityScore(reliability: number | null) {
  return reliability === null ? 0.5 : clamp((reliability - 90) / 10);
}

function slaScore(availability: number | null, provisioningMinutes: number | null) {
  if (availability === null && provisioningMinutes === null) return 0.5;
  const availabilityPart = availability === null ? 0.5 : clamp((availability - 95) / 5);
  const provisioningPart = provisioningMinutes === null ? 0.5 : clamp(1 - provisioningMinutes / (24 * 60));
  return availabilityPart * 0.7 + provisioningPart * 0.3;
}

function latencyScore(latencyMs: number | null, requirementRegion: string | null, candidateRegion: string) {
  if (latencyMs !== null) return clamp(1 - latencyMs / 500);
  if (requirementRegion !== null) return requirementRegion === candidateRegion ? 1 : 0;
  return 0.5;
}

function validateWeights(weights: RankingWeights) {
  const entries = Object.entries(weights);
  if (entries.some(([, value]) => !Number.isFinite(value) || value < 0)) throw new Error('ranking weights must be non-negative');
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (Math.abs(total - 1) > 0.000_001) throw new Error('ranking weights must sum to 1');
  return weights;
}

export function rankingWeightsFromEnvironment(value: string | undefined): RankingWeights {
  if (!value?.trim()) return defaultRankingWeights;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('KAI_COMPUTE_RANKING_WEIGHTS must be valid JSON'); }
  const source = record(parsed);
  return validateWeights({
    cost: finiteNumber(source.cost) ?? Number.NaN,
    reliability: finiteNumber(source.reliability) ?? Number.NaN,
    availability: finiteNumber(source.availability) ?? Number.NaN,
    latency: finiteNumber(source.latency) ?? Number.NaN,
    sla: finiteNumber(source.sla) ?? Number.NaN,
    hardwareFit: finiteNumber(source.hardwareFit) ?? Number.NaN,
  });
}

function candidateFacts(listing: PublicCreditListing, requirement: ComputeRequirement): CandidateFacts {
  const specifications = record(listing.specifications);
  const sla = record(listing.sla);
  const requiredGpuHours = requirement.gpuCount * requirement.durationHours;
  return {
    listingId: listing.id, resourceId: listing.resourceId, supplierId: listing.supplierId,
    title: listing.title, productCode: listing.productCode, gpuModel: gpuModel(listing),
    memoryGiBPerGpu: firstNumber(specifications, ['memoryGiBPerGpu', 'gpuMemoryGiB', 'vramGiB', 'vramGb']),
    resourceGpuCount: firstNumber(specifications, ['gpuCount', 'acceleratorCount']),
    region: listing.region, availableGpuHours: decimal(listing.capacityAvailable), requiredGpuHours,
    minimumGpuHours: decimal(listing.minimumQuantity),
    unitPriceCnyPerGpuHour: priceCny(listing.referenceCnyMicros),
    estimatedPriceCny: priceCny(listing.referenceCnyMicros) * requiredGpuHours,
    reliabilityPercent: firstPercentage(sla, ['reliabilityPercent', 'reliability', 'reliabilityBps']),
    slaAvailabilityPercent: firstPercentage(sla, ['availabilityPercent', 'availability', 'uptimePercent', 'uptime']),
    latencyMs: firstNumber(sla, ['latencyMs', 'networkLatencyMs']),
    provisioningMinutes: firstNumber(sla, ['provisioningMinutes', 'responseMinutes', 'deliveryMinutes']),
    startsAt: listing.startsAt, expiresAt: listing.expiresAt, listingCreatedAt: listing.createdAt, sla,
  };
}

function reject(code: string, message: string, field: RejectionReason['field']): RejectionReason {
  return { code, message, field };
}

function hardConstraints(facts: CandidateFacts, requirement: ComputeRequirement, now: Date) {
  const reasons: RejectionReason[] = [];
  if (requirement.gpuCount !== 1) {
    reasons.push(reject('MULTI_GPU_EXECUTION_UNAVAILABLE', '现有订单履约是一单一卡，不能保证多卡同时预留。', 'gpu_count'));
  }
  if (facts.resourceGpuCount !== null && facts.resourceGpuCount < requirement.gpuCount) {
    reasons.push(reject('GPU_COUNT_INSUFFICIENT', '资源 GPU 数量低于需求。', 'gpu_count'));
  }
  if (facts.memoryGiBPerGpu === null) reasons.push(reject('VRAM_UNKNOWN', '资源未提供可验证的单卡显存。', 'data'));
  else if (facts.memoryGiBPerGpu < requirement.estimatedVramGiBPerGpu) {
    reasons.push(reject('VRAM_INSUFFICIENT', '单卡显存低于确定性估算下限。', 'vram'));
  }
  if (requirement.region !== null && facts.region !== requirement.region) {
    reasons.push(reject('REGION_MISMATCH', '资源地区不满足需求。', 'region'));
  }
  const requiredUntil = new Date(now.getTime() + requirement.durationHours * 3_600_000);
  if (facts.startsAt > now || facts.expiresAt < requiredUntil) {
    reasons.push(reject('LISTING_WINDOW_INSUFFICIENT', '挂牌有效窗口不能覆盖预计使用时长。', 'window'));
  }
  if (facts.availableGpuHours < facts.requiredGpuHours || facts.requiredGpuHours < facts.minimumGpuHours) {
    reasons.push(reject('GPU_HOURS_UNAVAILABLE', '可售 GPU 时不足或未达到最低起售量。', 'availability'));
  }
  if (requirement.budgetCny !== null && facts.estimatedPriceCny > requirement.budgetCny + 0.000_001) {
    reasons.push(reject('BUDGET_EXCEEDED', '预计价格超过预算。', 'budget'));
  }
  if (requirement.minimumReliabilityPercent !== null) {
    if (facts.reliabilityPercent === null) reasons.push(reject('RELIABILITY_UNKNOWN', '资源没有可验证的可靠性数值。', 'reliability'));
    else if (facts.reliabilityPercent < requirement.minimumReliabilityPercent) {
      reasons.push(reject('RELIABILITY_INSUFFICIENT', '资源可靠性低于硬约束。', 'reliability'));
    }
  }
  if (requirement.minimumSlaAvailabilityPercent !== null) {
    if (facts.slaAvailabilityPercent === null) reasons.push(reject('SLA_AVAILABILITY_UNKNOWN', '资源没有可验证的 SLA 可用性数值。', 'sla'));
    else if (facts.slaAvailabilityPercent < requirement.minimumSlaAvailabilityPercent) {
      reasons.push(reject('SLA_AVAILABILITY_INSUFFICIENT', '资源 SLA 可用性低于硬约束。', 'sla'));
    }
  }
  return reasons;
}

function weightedScore(scores: ComponentScores, weights: RankingWeights) {
  return Object.keys(weights).reduce((total, key) => {
    const name = key as keyof RankingWeights;
    return total + scores[name] * weights[name];
  }, 0) * 100;
}

function risks(facts: CandidateFacts, requirement: ComputeRequirement) {
  const values: string[] = [];
  if (facts.reliabilityPercent === null) values.push('可靠性缺少结构化证据，分项使用中性基线，不表示已达标。');
  if (facts.slaAvailabilityPercent === null) values.push('SLA 可用性缺少结构化数值。');
  if (facts.latencyMs === null) values.push('未提供实测时延。');
  values.push('当前无工作负载吞吐 benchmark，不能证明一定在 deadline 前完成。');
  if (requirement.budgetCny !== null && facts.estimatedPriceCny > requirement.budgetCny * 0.9) {
    values.push('预计价格接近预算上限，额外时长可能导致超预算。');
  }
  return values;
}

function recommendationReasons(facts: CandidateFacts, requirement: ComputeRequirement, scores: ComponentScores) {
  const values = [
    `单卡 ${facts.memoryGiBPerGpu ?? 0} GiB 显存满足 ${requirement.estimatedVramGiBPerGpu} GiB 估算下限。`,
    `${quantity(facts.requiredGpuHours)} GPU时预计 ¥${facts.estimatedPriceCny.toFixed(2)}。`,
    `挂牌可售 ${quantity(facts.availableGpuHours)} GPU时，覆盖本次需求。`,
  ];
  const strongest = (Object.keys(scores) as Array<keyof ComponentScores>)
    .sort((left, right) => scores[right] - scores[left])[0];
  if (strongest) values.push(`本方案最强分项是${COMPONENT_LABELS[strongest]}（${(scores[strongest] * 100).toFixed(0)}/100）。`);
  return values;
}

function comparisons(candidates: readonly EvaluatedCandidate[], weights: RankingWeights): RankingComparison[] {
  const result: RankingComparison[] = [];
  for (let index = 0; index < Math.min(candidates.length - 1, 2); index += 1) {
    const higher = candidates[index]!;
    const lower = candidates[index + 1]!;
    const differentiator = (Object.keys(weights) as Array<keyof RankingWeights>)
      .map((key) => ({ key, delta: (higher.componentScores[key] - lower.componentScores[key]) * weights[key] }))
      .sort((left, right) => right.delta - left.delta)[0];
    const reason = differentiator && differentiator.delta > 0.000_001
      ? `${COMPONENT_LABELS[differentiator.key]}的加权贡献高 ${(differentiator.delta * 100).toFixed(1)} 分。`
      : `总分相同或接近时，预计价格 ¥${higher.facts.estimatedPriceCny.toFixed(2)} 更低。`;
    result.push({ higherListingId: higher.facts.listingId, lowerListingId: lower.facts.listingId, reason });
  }
  return result;
}

export function rankComputeCandidates(
  requirement: ComputeRequirement,
  listings: readonly PublicCreditListing[],
  now = new Date(),
  rankingWeights: RankingWeights = defaultRankingWeights,
): ComputeRankingResult {
  const weights = validateWeights(rankingWeights);
  const prepared = listings.map((listing) => {
    const facts = candidateFacts(listing, requirement);
    return { listing, facts, rejectionReasons: hardConstraints(facts, requirement, now) };
  });
  const eligible = prepared.filter((candidate) => candidate.rejectionReasons.length === 0);
  const costs = eligible.map((candidate) => candidate.facts.estimatedPriceCny);
  const minimumCost = costs.length ? Math.min(...costs) : 0;
  const maximumCost = costs.length ? Math.max(...costs) : 0;
  const scored = eligible.map((candidate) => {
    const componentScores: ComponentScores = {
      cost: normalizedCost(candidate.facts.estimatedPriceCny, minimumCost, maximumCost),
      reliability: reliabilityScore(candidate.facts.reliabilityPercent),
      availability: availabilityScore(candidate.facts.availableGpuHours, candidate.facts.requiredGpuHours),
      latency: latencyScore(candidate.facts.latencyMs, requirement.region, candidate.facts.region),
      sla: slaScore(candidate.facts.slaAvailabilityPercent, candidate.facts.provisioningMinutes),
      hardwareFit: hardwareFitScore(candidate.facts.memoryGiBPerGpu, requirement.estimatedVramGiBPerGpu),
    };
    return { ...candidate, componentScores, score: weightedScore(componentScores, weights) };
  }).sort((left, right) => right.score - left.score
    || left.facts.estimatedPriceCny - right.facts.estimatedPriceCny
    || left.facts.listingId.localeCompare(right.facts.listingId));
  const rankedEligible: EvaluatedCandidate[] = scored.map((candidate, index) => ({
    ...candidate, eligible: true, rank: index + 1,
    risks: risks(candidate.facts, requirement),
    reasons: recommendationReasons(candidate.facts, requirement, candidate.componentScores),
  }));
  const rejected: EvaluatedCandidate[] = prepared.filter((candidate) => candidate.rejectionReasons.length > 0)
    .sort((left, right) => left.facts.listingId.localeCompare(right.facts.listingId))
    .map((candidate, index) => ({
      ...candidate, eligible: false,
      componentScores: { cost: 0, reliability: 0, availability: 0, latency: 0, sla: 0, hardwareFit: 0 },
      score: 0, rank: rankedEligible.length + index + 1,
      risks: candidate.rejectionReasons.map((reason) => reason.message), reasons: [],
    }));
  const top = rankedEligible.slice(0, 3);
  const recommendations: ComputeRecommendation[] = top.map((candidate) => ({
    rank: candidate.rank, listingId: candidate.facts.listingId, resourceId: candidate.facts.resourceId,
    title: candidate.facts.title, productCode: candidate.facts.productCode, gpuModel: candidate.facts.gpuModel,
    gpuCount: requirement.gpuCount, memoryGiBPerGpu: candidate.facts.memoryGiBPerGpu!, region: candidate.facts.region,
    estimatedPriceCny: candidate.facts.estimatedPriceCny.toFixed(2), estimatedDurationHours: requirement.durationHours,
    score: Number(candidate.score.toFixed(4)), componentScores: candidate.componentScores,
    reasons: candidate.reasons, risks: candidate.risks,
    orderHandoff: {
      method: 'POST', path: '/mobile/v1/orders',
      body: { listingId: candidate.facts.listingId, quantity: quantity(candidate.facts.requiredGpuHours) },
      capacityUnit: 'GPU时', createsOrder: false,
    },
  }));
  return {
    algorithmVersion: 'explainable-weighted-baseline-v1', weights,
    candidateCount: prepared.length, eligibleCandidateCount: rankedEligible.length,
    recommendations, comparisons: comparisons(top, weights), evaluatedCandidates: [...rankedEligible, ...rejected],
    fallback: recommendations.length ? null : {
      kind: 'resource_inquiry', path: '/mobile/v1/resource-inquiries',
      reason: '没有满足全部硬约束的已验真可售资源，转入现有人工询期流程。',
    },
  };
}
