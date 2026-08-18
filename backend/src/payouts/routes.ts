import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { CreditPayoutService } from './service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。');
  return result.data;
}
function context(request: FastifyRequest) { return { requestId: request.id, ip: request.ip }; }
function key(request: FastifyRequest) { return String(request.headers['idempotency-key'] ?? ''); }

export async function registerCreditPayoutRoutes(app: FastifyInstance, accounts: AccountService, payouts: CreditPayoutService) {
  app.get('/mobile/v1/credits/payout-profile', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    return { ok: true, profile: await payouts.profile(principal) };
  });
  app.post('/mobile/v1/credits/payouts', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const body = parse(z.object({ creditAmount: z.string().trim().min(1).max(40) }).strict(), request.body);
    const result = await payouts.create(principal, { ...body, idempotencyKey: key(request) }, context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });
  app.get('/mobile/v1/credits/payouts', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }), request.query);
    return { ok: true, payouts: await payouts.list(principal, query.limit) };
  });
  app.get('/mobile/v1/credits/payouts/:payoutId', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const params = parse(z.object({ payoutId: z.string().uuid() }), request.params);
    return { ok: true, payout: await payouts.get(principal, params.payoutId) };
  });
  app.post('/mobile/v1/credits/payouts/:payoutId/cancel', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const params = parse(z.object({ payoutId: z.string().uuid() }), request.params);
    return { ok: true, ...(await payouts.cancel(principal, params.payoutId, key(request), context(request))) };
  });
  app.get('/mobile/v1/operator/credit-payouts', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }), request.query);
    return { ok: true, payouts: await payouts.queue(principal, query.limit) };
  });
  app.put('/mobile/v1/operator/credit-payout-profiles/:subjectId/activate', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const params = parse(z.object({ subjectId: z.string().uuid() }), request.params);
    const body = parse(z.object({ legalEntityDigest: z.string().min(16).max(160),
      recipientReference: z.string().min(8).max(160) }).strict(), request.body);
    return { ok: true, profile: await payouts.activateProfile(principal, { ...params, ...body }) };
  });
  for (const action of ['review', 'pay'] as const) app.post(`/mobile/v1/operator/credit-payouts/:payoutId/${action}`, async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const params = parse(z.object({ payoutId: z.string().uuid() }), request.params); parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await payouts[action](principal, params.payoutId, key(request), context(request))) };
  });
  app.post('/mobile/v1/operator/credit-payouts/:payoutId/succeed', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const params = parse(z.object({ payoutId: z.string().uuid() }), request.params);
    const body = parse(z.object({ companyPaymentReference: z.string().min(8).max(160),
      companyPaymentFlowDigest: z.string().min(16).max(160),
      companyPaymentAmountCents: z.number().int().positive().max(10_020_000) }).strict(), request.body);
    return { ok: true, ...(await payouts.succeed(principal, params.payoutId, key(request), context(request), body)) };
  });
  for (const action of ['fail', 'reject'] as const) app.post(`/mobile/v1/operator/credit-payouts/:payoutId/${action}`, async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const params = parse(z.object({ payoutId: z.string().uuid() }), request.params);
    const body = action === 'fail'
      ? parse(z.object({ failureCode: z.string().min(3).max(80), reason: z.string().min(3).max(500) }).strict(), request.body)
      : parse(z.object({ reason: z.string().min(3).max(500) }).strict(), request.body);
    return { ok: true, ...(await payouts[action](principal, params.payoutId, key(request), context(request), body as never)) };
  });
}
