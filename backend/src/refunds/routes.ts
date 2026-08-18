import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { RefundService } from './service.js';
import type { RefundProcessor } from './processor.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

const refundStatus = z.enum(['requested', 'reviewing', 'approved', 'provider_pending', 'succeeded', 'rejected', 'cancelled', 'failed']);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。', {
      fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    });
  }
  return result.data;
}

function context(request: FastifyRequest) {
  return { requestId: request.id, ip: request.ip };
}

function stringHeaders(request: FastifyRequest) {
  return Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
}

export async function registerRefundRoutes(
  app: FastifyInstance, accounts: AccountService, refunds: RefundService, processor?: RefundProcessor,
) {
  app.post('/mobile/v1/orders/:orderId/refunds', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      amountCents: z.number().int().positive().max(100_000_000_000).optional(),
      reason: z.string().trim().min(8).max(1_000),
    }), request.body);
    const idempotencyKey = String(request.headers['idempotency-key'] ?? '');
    const result = await refunds.request(principal, {
      orderId: parameters.orderId, reason: body.reason, idempotencyKey,
      ...(body.amountCents === undefined ? {} : { amountCents: body.amountCents }),
    }, context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.get('/mobile/v1/refunds', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    return { ok: true, refunds: await refunds.list(principal) };
  });

  app.get('/mobile/v1/refunds/:refundId', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ refundId: z.string().uuid() }), request.params);
    return { ok: true, refund: await refunds.get(principal, parameters.refundId) };
  });

  app.post('/mobile/v1/refunds/:refundId/cancel', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ refundId: z.string().uuid() }), request.params);
    return { ok: true, refund: await refunds.cancel(principal, parameters.refundId, context(request)) };
  });

  app.post('/mobile/v1/operator/refunds/:refundId/review', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ refundId: z.string().uuid() }), request.params);
    const body = parse(z.object({ approved: z.boolean(), reason: z.string().trim().max(1_000).optional() }), request.body);
    return {
      ok: true,
      refund: await refunds.review(principal, {
        refundId: parameters.refundId, approved: body.approved,
        ...(body.reason ? { reason: body.reason } : {}),
      }, context(request)),
    };
  });

  app.get('/mobile/v1/operator/refunds', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const query = parse(z.object({
      status: refundStatus.optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
    }), request.query);
    return {
      ok: true,
      refunds: await refunds.reviewQueue(principal, query.status, query.limit),
    };
  });

  if (processor) app.post('/mobile/v1/payments/wechat/refund-notify', {
    config: { rawBody: true, rateLimit: { max: 300, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
      if (!rawBody) throw new AppError('REFUND_NOTIFICATION_INVALID', 400, '微信退款通知正文为空。');
      await processor.wechatNotification(stringHeaders(request), rawBody);
      return reply.send({ code: 'SUCCESS', message: '成功' });
    } catch (error) {
      request.log.warn({ err: error }, 'wechat refund notification rejected');
      return reply.status(400).send({ code: 'FAIL', message: '失败' });
    }
  });
}
