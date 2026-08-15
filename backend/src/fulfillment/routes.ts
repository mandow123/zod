import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { FulfillmentService } from './service.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。');
  return result.data;
}
function context(request: FastifyRequest) { return { requestId: request.id, ip: request.ip }; }

export async function registerFulfillmentRoutes(app: FastifyInstance, accounts: AccountService,
  fulfillment: FulfillmentService) {
  app.get('/mobile/v1/orders/:orderId/fulfillment', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await fulfillment.get(principal, parameters.orderId)) };
  });

  app.post('/mobile/v1/provider/orders/:orderId/fulfillment/provision', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await fulfillment.provisionForProvider(principal, parameters.orderId,
      String(request.headers['idempotency-key'] ?? ''), context(request))) };
  });

  app.post('/mobile/v1/orders/:orderId/fulfillment/access-session', async (request, reply) => {
    reply.header('cache-control', 'no-store, private').header('pragma', 'no-cache');
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await fulfillment.createAccessSession(principal, parameters.orderId,
      String(request.headers['idempotency-key'] ?? ''), context(request))) };
  });

  app.post('/mobile/v1/orders/:orderId/fulfillment/stop', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await fulfillment.stop(principal, parameters.orderId,
      String(request.headers['idempotency-key'] ?? ''), context(request))) };
  });

  app.post('/mobile/v1/orders/:orderId/fulfillment/accept', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await fulfillment.accept(principal, parameters.orderId,
      String(request.headers['idempotency-key'] ?? ''), context(request))) };
  });

  app.post('/mobile/v1/orders/:orderId/fulfillment/issue', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      kind: z.enum(['access', 'metering']), description: z.string().trim().min(10).max(2_000),
    }).strict(), request.body);
    return { ok: true, ...(await fulfillment.reportIssue(principal, parameters.orderId, body,
      String(request.headers['idempotency-key'] ?? ''), context(request))) };
  });

  app.get('/mobile/v1/orders/:orderId/fulfillment/issue', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await fulfillment.issue(principal, parameters.orderId)) };
  });

  app.get('/mobile/v1/operator/fulfillment-issues', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict(), request.query);
    return { ok: true, issues: await fulfillment.openIssues(principal, query.limit) };
  });

  app.post('/mobile/v1/operator/fulfillment-issues/:orderId/decision', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({ outcome: z.enum(['full_refund', 'partial_refund', 'reject_refund']),
      refundCredits: z.string().trim().min(1).max(40).optional(), reason: z.string().trim().min(10).max(2_000) }).strict(),
    request.body);
    return { ok: true, ...(await fulfillment.decideIssue(principal, parameters.orderId, {
      outcome: body.outcome, reason: body.reason,
      ...(body.refundCredits === undefined ? {} : { refundCredits: body.refundCredits }),
    },
      String(request.headers['idempotency-key'] ?? ''), context(request))) };
  });
}
