import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticateMobileRequest } from '../account/request-auth.js';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { ComputeIntelligenceService } from './service.js';

const requirement = z.object({
  taskType: z.enum(['fine_tuning', 'training', 'inference', 'rendering', 'other']),
  workload: z.enum(['training', 'inference']),
  modelFamily: z.string().trim().min(1).max(80).nullable(),
  modelSizeBillions: z.number().min(0.1).max(10_000).nullable(),
  datasetRows: z.number().int().min(1).max(10_000_000_000).nullable(),
  fineTuningMethod: z.enum(['full_ft', 'lora', 'qlora', 'not_applicable']),
  estimatedVramGiBPerGpu: z.number().min(1).max(2_048),
  gpuCount: z.number().int().min(1).max(256),
  deadlineHours: z.number().min(0.25).max(8_784).nullable(),
  budgetCny: z.number().min(0.01).max(1_000_000_000).nullable(),
  region: z.string().trim().min(1).max(80).nullable(),
  durationHours: z.number().min(0.25).max(8_784),
  precision: z.enum(['fp32', 'fp16', 'bf16', 'fp8', 'int8', 'int4', 'unspecified']),
  minimumReliabilityPercent: z.number().min(0).max(100).nullable(),
  minimumSlaAvailabilityPercent: z.number().min(0).max(100).nullable(),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。', {
    fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
  return result.data;
}

function context(actorId: string) {
  return { actorId };
}

export async function registerComputeIntelligenceRoutes(
  app: FastifyInstance, accounts: AccountService, intelligence: ComputeIntelligenceService,
) {
  app.post('/mobile/v1/intelligence/requirements/parse', {
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
  }, async (request) => {
    await authenticateMobileRequest(accounts, request);
    const body = parse(z.object({ text: z.string().trim().min(4).max(2_000) }).strict(), request.body);
    return { ok: true, ...(await intelligence.parse(body.text)) };
  });

  app.post('/mobile/v1/intelligence/recommendations', {
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
  }, async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const body = parse(z.object({
      text: z.string().trim().min(4).max(2_000), confirmedRequirement: requirement.optional(),
    }).strict(), request.body);
    return { ok: true, ...(await intelligence.recommend(
      body.text, context(principal.userId), body.confirmedRequirement,
    )) };
  });
}
