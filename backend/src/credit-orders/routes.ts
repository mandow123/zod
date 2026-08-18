import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { CreditOrderService } from './service.js';
import { assertDirectCommerceChannel } from '../distribution.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。', {
    fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
  return result.data;
}

function context(request: FastifyRequest) { return { requestId: request.id, ip: request.ip }; }

export async function registerCreditOrderRoutes(app: FastifyInstance, accounts: AccountService, orders: CreditOrderService) {
  app.post('/mobile/v1/orders', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    assertDirectCommerceChannel(request);
    const body = parse(z.object({
      listingId: z.string().uuid(), quantity: z.string().trim().min(1).max(40),
    }).strict(), request.body);
    const result = await orders.create(principal, {
      ...body, idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    }, context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.get('/mobile/v1/orders', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const query = parse(z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      side: z.enum(['all', 'buyer', 'provider']).optional(),
      cursor: z.string().min(1).max(500).optional(),
    }).strict(), request.query);
    return { ok: true, ...(await orders.list(principal, {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.side === undefined ? {} : { side: query.side }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    })) };
  });

  app.get('/mobile/v1/orders/:orderId', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, order: await orders.get(principal, parameters.orderId) };
  });

  app.post('/mobile/v1/provider/orders/:orderId/confirm', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await orders.confirm(
      principal, parameters.orderId, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.post('/mobile/v1/orders/:orderId/cancel', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await orders.cancel(
      principal, parameters.orderId, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.post('/mobile/v1/provider/orders/:orderId/delivery/start', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await orders.startDelivery(
      principal, parameters.orderId, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.post('/mobile/v1/provider/orders/:orderId/delivery/ready', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({ details: z.object({
      endpoint: z.string().trim().min(3).max(2_000),
      instructions: z.string().trim().min(3).max(2_000),
      username: z.string().trim().min(1).max(2_000).optional(),
      temporaryPassword: z.string().min(1).max(2_000).optional(),
    }).strict() }).strict(), request.body);
    return { ok: true, ...(await orders.deliveryReady(
      principal, parameters.orderId, body.details, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.post('/mobile/v1/provider/orders/:orderId/delivery/rework/start', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await orders.startRework(
      principal, parameters.orderId, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.get('/mobile/v1/orders/:orderId/delivery', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await orders.delivery(principal, parameters.orderId)) };
  });

  app.post('/mobile/v1/orders/:orderId/accept', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({ evidenceDigest: z.string().optional() }).strict(), request.body ?? {});
    return { ok: true, ...(await orders.accept(
      principal, parameters.orderId, body.evidenceDigest, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.post('/mobile/v1/orders/:orderId/delivery/issue', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      requestedResolution: z.enum(['rework', 'refund']), description: z.string().trim().min(5).max(2_000),
    }).strict(), request.body);
    return { ok: true, ...(await orders.reportDeliveryIssue(
      principal, parameters.orderId, body, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.get('/mobile/v1/orders/:orderId/delivery/issue', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await orders.deliveryIssue(principal, parameters.orderId)) };
  });

  app.post('/mobile/v1/provider/orders/:orderId/refund/approve', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await orders.approveMutualRefund(
      principal, parameters.orderId, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.get('/mobile/v1/orders/:orderId/refund', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await orders.mutualRefund(principal, parameters.orderId)) };
  });

  app.post('/mobile/v1/orders/:orderId/dispute/escalate', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await orders.escalateDispute(
      principal, parameters.orderId, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.get('/mobile/v1/orders/:orderId/dispute/adjudication', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await orders.disputeAdjudication(principal, parameters.orderId)) };
  });

  app.get('/mobile/v1/operator/order-disputes', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }), request.query);
    return { ok: true, disputes: await orders.pendingDisputeAdjudications(principal, query.limit) };
  });

  app.post('/mobile/v1/operator/order-disputes/:orderId/decision', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      outcome: z.enum(['full_refund', 'resume_acceptance']), reason: z.string().trim().min(10).max(2_000),
    }).strict(), request.body);
    return { ok: true, ...(await orders.decideDispute(
      principal, parameters.orderId, body, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.post('/mobile/v1/provider/orders/:orderId/settle', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await orders.settleSupplier(
      principal, parameters.orderId, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.get('/mobile/v1/orders/:orderId/settlement', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await orders.supplierSettlement(principal, parameters.orderId)) };
  });

  app.post('/mobile/v1/orders/:orderId/aftercare/refund', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      description: z.string().trim().min(10).max(2_000),
      creditAmount: z.string().trim().min(1).max(40),
    }).strict(), request.body);
    return { ok: true, ...(await orders.requestPostAcceptanceRefund(
      principal, parameters.orderId, body.description, body.creditAmount,
      String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.post('/mobile/v1/provider/orders/:orderId/aftercare/refund/approve', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await orders.approvePostAcceptanceRefund(
      principal, parameters.orderId, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.post('/mobile/v1/provider/orders/:orderId/aftercare/refund/contest', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({ response: z.string().trim().min(10).max(2_000) }).strict(), request.body);
    return { ok: true, ...(await orders.contestPostAcceptanceRefund(
      principal, parameters.orderId, body.response,
      String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.post('/mobile/v1/orders/:orderId/aftercare/refund/escalate', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    parse(z.object({}).strict(), request.body ?? {});
    return { ok: true, ...(await orders.escalatePostAcceptanceRefund(
      principal, parameters.orderId, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.get('/mobile/v1/operator/aftercare-refunds', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }), request.query);
    return { ok: true, refunds: await orders.pendingPostAcceptanceRefundAdjudications(principal, query.limit) };
  });

  app.post('/mobile/v1/operator/aftercare-refunds/:orderId/decision', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      outcome: z.enum(['approve_refund', 'reject_refund']), reason: z.string().trim().min(10).max(2_000),
    }).strict(), request.body);
    return { ok: true, ...(await orders.decidePostAcceptanceRefund(
      principal, parameters.orderId, body, String(request.headers['idempotency-key'] ?? ''), context(request),
    )) };
  });

  app.get('/mobile/v1/orders/:orderId/aftercare/refund', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    return { ok: true, ...(await orders.postAcceptanceRefund(principal, parameters.orderId)) };
  });
}
