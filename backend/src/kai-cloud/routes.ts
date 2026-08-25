import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { KaiCloudVerificationService } from './service.js';

const uuid = z.string().uuid();
function parameter(request: FastifyRequest) {
  const result = z.object({ assetId: uuid }).strict().safeParse(request.params);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '资产参数格式不正确。');
  return result.data.assetId;
}
function idempotency(request: FastifyRequest) {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string') throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '缺少有效的幂等标识。');
  return value;
}
function context(request: FastifyRequest) { return { requestId: request.id, ip: request.ip }; }
function noStore(reply: { header(name: string, value: string): unknown }) { reply.header('cache-control', 'no-store, private'); }

export async function registerKaiCloudVerificationRoutes(app: FastifyInstance, accounts: AccountService,
  service: KaiCloudVerificationService) {
  app.get('/mobile/v1/provider/assets/:assetId/kai-cloud-verification', async (request, reply) => {
    noStore(reply); const { principal } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, verification: await service.get(principal, parameter(request)) };
  });
  app.post('/mobile/v1/provider/assets/:assetId/kai-cloud-verification', async (request, reply) => {
    noStore(reply); const { principal } = await accounts.authenticate(request.headers.authorization);
    const result = await service.start(principal, parameter(request), idempotency(request), context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });
  app.delete('/mobile/v1/provider/assets/:assetId/kai-cloud-verification', async (request, reply) => {
    noStore(reply); const { principal } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, ...(await service.revoke(principal, parameter(request), idempotency(request), context(request))) };
  });
  app.post('/integrations/kai-cloud/public/v1/events', { config: { rawBody: true } }, async (request, reply) => {
    noStore(reply);
    const rawBody = typeof (request as FastifyRequest & { rawBody?: unknown }).rawBody === 'string'
      ? (request as FastifyRequest & { rawBody: string }).rawBody : '';
    const result = await service.acceptWebhook({ deliveryId: header(request, 'x-kai-delivery-id'),
      timestamp: header(request, 'x-kai-timestamp'), signature: header(request, 'x-kai-signature'), rawBody });
    return reply.status(202).send({ ok: true, ...result });
  });
}

function header(request: FastifyRequest, name: string) {
  const value = request.headers[name]; return typeof value === 'string' ? value : undefined;
}
