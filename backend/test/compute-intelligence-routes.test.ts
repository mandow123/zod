import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AccountService } from '../src/account/service.js';
import { loadConfig } from '../src/config.js';
import type { ComputeIntelligenceService } from '../src/compute-intelligence/service.js';
import { AppError } from '../src/errors.js';

const accounts = {
  authenticate: async (authorization?: string) => {
    if (!authorization) throw new AppError('AUTHENTICATION_REQUIRED', 401, '请先登录。');
    return {
      principal: { userId: '60000000-0000-4000-8000-000000000001', sessionId: 'route-session', role: 'member' },
      identity: {},
    };
  },
} as unknown as AccountService;

const parsed = {
  requirement: {
    taskType: 'fine_tuning', workload: 'training', modelFamily: null, modelSizeBillions: 7,
    datasetRows: 100_000, fineTuningMethod: 'lora', estimatedVramGiBPerGpu: 40, gpuCount: 1,
    deadlineHours: 24, budgetCny: 2_000, region: null, durationHours: 24,
    precision: 'unspecified', minimumReliabilityPercent: null, minimumSlaAvailabilityPercent: null,
  },
  parser: { mode: 'deterministic', version: 'compute-requirement-v1' },
  assumptions: ['synthetic route fixture'], uncertainties: [], confirmationRequired: true,
} as const;

const intelligence = {
  parse: async () => parsed,
  recommend: async () => ({
    runId: '70000000-0000-4000-8000-000000000001', parsed,
    algorithmVersion: 'explainable-weighted-baseline-v1', weights: {},
    candidateCount: 3, eligibleCandidateCount: 3,
    recommendations: [{
      rank: 1, listingId: '30000000-0000-4000-8000-000000000001',
      orderHandoff: { method: 'POST', path: '/mobile/v1/orders', body: {
        listingId: '30000000-0000-4000-8000-000000000001', quantity: '24',
        recommendationRunId: '70000000-0000-4000-8000-000000000001',
      }, capacityUnit: 'GPU时', createsOrder: false },
    }],
    comparisons: [], fallback: null, persisted: true, preview: true,
  }),
} as unknown as ComputeIntelligenceService;

describe('compute intelligence routes', () => {
  it('requires a mobile account and returns the structured confirmation draft', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: accounts, computeIntelligenceService: intelligence, logger: false,
    });
    const unauthorized = await app.inject({
      method: 'POST', url: '/mobile/v1/intelligence/requirements/parse', payload: { text: '微调 7B 模型，一天内完成。' },
    });
    expect(unauthorized.statusCode).toBe(401);
    const response = await app.inject({
      method: 'POST', url: '/mobile/v1/intelligence/requirements/parse',
      headers: { authorization: 'Bearer route-test' }, payload: { text: '微调 7B 模型，一天内完成。' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, requirement: { modelSizeBillions: 7 }, confirmationRequired: true });
    await app.close();
  });

  it('returns a persisted preview whose handoff targets the existing order route without creating an order', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: accounts, computeIntelligenceService: intelligence, logger: false,
    });
    const response = await app.inject({
      method: 'POST', url: '/mobile/v1/intelligence/recommendations',
      headers: { authorization: 'Bearer route-test' }, payload: { text: '微调 7B 模型，一天内完成，预算 2000 元。' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true, persisted: true, preview: true,
      recommendations: [{ orderHandoff: { path: '/mobile/v1/orders',
        body: { quantity: '24', recommendationRunId: '70000000-0000-4000-8000-000000000001' },
        createsOrder: false } }],
    });
    await app.close();
  });

  it('does not expose recommendation routing in the inquiry-only production profile', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', MOBILE_API_PROFILE: 'inquiry_only' }), database: null,
      accountService: accounts, computeIntelligenceService: intelligence, logger: false,
    });
    const response = await app.inject({
      method: 'POST', url: '/mobile/v1/intelligence/recommendations',
      headers: { authorization: 'Bearer route-test' }, payload: { text: '微调 7B 模型，一天内完成。' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
