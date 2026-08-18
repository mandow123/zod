import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import { assertDirectCommerceChannel } from '../distribution.js';
import type { VastMarketService } from './service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR',400,'提交的信息不完整或格式不正确。',{
    fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'),code: issue.code })) });
  return result.data;
}
function key(request: FastifyRequest) { return String(request.headers['idempotency-key'] ?? ''); }

export async function registerVastMarketRoutes(app: FastifyInstance,accounts: AccountService,service: VastMarketService) {
  app.get('/mobile/v1/vast/offers',async (request) => {
    const query = parse(z.object({ gpuName: z.string().trim().max(80).optional(),region: z.string().trim().max(80).optional(),
      minimumReliability: z.coerce.number().min(0).max(1).optional(),limit: z.coerce.number().int().min(1).max(50).optional() }).strict(),request.query);
    const filters = { ...(query.gpuName === undefined ? {} : { gpuName:query.gpuName }),
      ...(query.region === undefined ? {} : { region:query.region }),
      ...(query.minimumReliability === undefined ? {} : { minimumReliability:query.minimumReliability }),
      ...(query.limit === undefined ? {} : { limit:query.limit }) };
    return { ok: true,...await service.catalog(filters) };
  });
  app.post('/mobile/v1/vast/quotes',async (request,reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const body = parse(z.object({ offerId: z.string().regex(/^[1-9]\d*$/u),durationHours: z.number().int().min(1).max(720) }).strict(),request.body);
    return reply.status(201).send({ ok: true,quote: await service.quote(principal,body) });
  });
  app.post('/mobile/v1/vast/orders',async (request,reply) => {
    assertDirectCommerceChannel(request);
    const { principal } = await authenticateMobileRequest(accounts, request);
    const body = parse(z.object({ quoteId: z.string().uuid() }).strict(),request.body);
    const result = await service.purchase(principal,body.quoteId,key(request));
    return reply.status(result.replayed ? 200 : 202).send({ ok: true,...result });
  });
  app.get('/mobile/v1/vast/orders',async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const { limit } = parse(z.object({ limit:z.coerce.number().int().min(1).max(50).optional() }).strict(),request.query);
    return { ok:true,...await service.listOrders(principal,limit) };
  });
  app.get('/mobile/v1/vast/orders/:orderId',async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const { orderId } = parse(z.object({ orderId: z.string().uuid() }),request.params);
    return { ok: true,order: await service.getOrder(principal,orderId) };
  });
}
