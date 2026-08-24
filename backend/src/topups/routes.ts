import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { CreditTopupService } from './service.js';
import { assertDirectCommerceChannel } from '../distribution.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。', {
    fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
  return result.data;
}

function headers(request: FastifyRequest) {
  return Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
}

export async function registerCreditTopupRoutes(app: FastifyInstance, accounts: AccountService, topups: CreditTopupService) {
  app.post('/mobile/v1/credits/topups', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    assertDirectCommerceChannel(request);
    const body = parse(z.object({
      amountCents: z.number().int().min(100).max(10_000_000),
      provider: z.enum(['alipay', 'wechat']), channel: z.literal('app'),
    }).strict(), request.body);
    const result = await topups.create(principal, {
      ...body, idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    }, { requestId: request.id, ip: request.ip });
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.get('/mobile/v1/credits/topups', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }), request.query);
    return { ok: true, topups: await topups.list(principal, query.limit) };
  });

  app.get('/mobile/v1/credits/topups/:topupId', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ topupId: z.string().uuid() }), request.params);
    return { ok: true, topup: await topups.get(principal, parameters.topupId) };
  });

  app.post('/mobile/v1/credits/topups/alipay/notify', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const payload = parse(z.record(z.string(), z.string()), request.body);
      await topups.alipayNotification(payload);
      return reply.type('text/plain; charset=utf-8').send('success');
    } catch (error) {
      request.log.warn({ err: error }, 'alipay topup notification rejected');
      return reply.status(400).type('text/plain; charset=utf-8').send('failure');
    }
  });

  app.post('/mobile/v1/credits/topups/wechat/notify', {
    config: { rawBody: true, rateLimit: { max: 300, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
      if (!rawBody) throw new AppError('TOPUP_NOTIFICATION_INVALID', 400, '微信充值通知正文为空。');
      await topups.wechatNotification(headers(request), rawBody);
      return reply.send({ code: 'SUCCESS', message: '成功' });
    } catch (error) {
      request.log.warn({ err: error }, 'wechat topup notification rejected');
      return reply.status(400).send({ code: 'FAIL', message: '失败' });
    }
  });
}
