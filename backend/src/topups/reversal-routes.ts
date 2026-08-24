import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { TopupReversalService } from './reversal-service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。');
  return result.data;
}

export async function registerTopupReversalRoutes(app: FastifyInstance, accounts: AccountService,
  reversals: TopupReversalService) {
  app.post('/mobile/v1/operator/credits/topups/:topupId/reversals', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ topupId: z.string().uuid() }), request.params);
    const body = parse(z.object({ kind: z.enum(['refund', 'chargeback']),
      amountCents: z.number().int().positive().max(10_000_000),
      providerEventReference: z.string().trim().min(8).max(160),
      evidenceDigest: z.string().trim().min(16).max(160) }).strict(), request.body);
    const result = await reversals.request(principal, parameters.topupId, { ...body,
      idempotencyKey: String(request.headers['idempotency-key'] ?? '') });
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });
  app.post('/mobile/v1/operator/credit-topup-reversals/:reversalId/recover-credits', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ reversalId: z.string().uuid() }), request.params);
    parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await reversals.recoverCredits(principal, parameters.reversalId)) };
  });
}
