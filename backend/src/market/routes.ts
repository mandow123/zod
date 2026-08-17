import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { MarketService } from './service.js';

const resourceKind = z.enum(['gpu', 'token_capacity', 'token_usage', 'rack', 'storage', 'apple_silicon']);
const uuid = z.string().uuid();

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

function requestKey(request: FastifyRequest) {
  return String(request.headers['idempotency-key'] ?? '');
}

export async function registerMarketRoutes(app: FastifyInstance, accounts: AccountService, market: MarketService) {
  app.get('/mobile/v1/market/resources', async (request) => {
    const query = parse(z.object({
      kind: resourceKind.optional(),
      region: z.string().trim().max(80).optional(),
      query: z.string().trim().max(80).optional(),
      cursor: z.string().max(2_000).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }), request.query);
    const filters = {
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.region === undefined ? {} : { region: query.region }),
      ...(query.query === undefined ? {} : { query: query.query }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    };
    return { ok: true, ...(await market.resources(filters)) };
  });

  app.get('/mobile/v1/provider/profile', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, profile: await market.supplierProfile(principal) };
  });

  app.get('/mobile/v1/provider/resources', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, resources: await market.supplierResources(principal) };
  });

  app.get('/mobile/v1/provider/assets', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, ...(await market.providerAssets(principal)) };
  });

  app.get('/mobile/v1/provider/assets/:assetId', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ assetId: uuid }), request.params);
    return { ok: true, asset: await market.providerAsset(principal, parameters.assetId) };
  });

  app.post('/mobile/v1/provider/profile', async (request, reply) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const body = parse(z.object({
      legalName: z.string().trim().min(2).max(200),
      creditCode: z.string().trim().length(18),
      contactName: z.string().trim().min(1).max(80),
    }), request.body);
    return reply.status(202).send({ ok: true, profile: await market.submitSupplier(principal, body, context(request)) });
  });

  app.post('/mobile/v1/operator/suppliers/:supplierId/review', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ supplierId: uuid }), request.params);
    const body = parse(z.object({ approved: z.boolean(), reason: z.string().trim().max(1_000).optional() }), request.body);
    const review = { supplierId: parameters.supplierId, approved: body.approved, ...(body.reason === undefined ? {} : { reason: body.reason }) };
    return { ok: true, profile: await market.reviewSupplier(principal, review, context(request)) };
  });

  app.post('/mobile/v1/provider/resources', async (request, reply) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const body = parse(z.object({
      kind: resourceKind,
      productCode: z.string().trim().min(2).max(80),
      region: z.string().trim().min(2).max(80),
      specifications: z.record(z.string(), z.unknown()),
      capacityTotal: z.string().trim().min(1).max(40),
      capacityUnit: z.string().trim().min(1).max(40),
      assetReference: z.string().trim().min(4).max(160),
      assetIdentityKind: z.enum(['hardware_serial', 'cloud_resource_id', 'internal_asset_id']),
    }), request.body);
    const result = await market.createResource(principal, body, requestKey(request), context(request));
    return reply.status(result.replayed || result.recovered ? 200 : 202).send({ ok: true, ...result });
  });

  app.post('/mobile/v1/provider/resources/:resourceId/resubmit', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ resourceId: uuid }), request.params);
    const result = await market.resubmitResourceVerification(
      principal, parameters.resourceId, requestKey(request), context(request),
    );
    return reply.status(result.replayed ? 200 : 202).send({ ok: true, ...result });
  });

  app.post('/mobile/v1/operator/resources/:resourceId/verification', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ resourceId: uuid }), request.params);
    const body = parse(z.object({
      passed: z.boolean(),
      evidenceDigest: z.string().trim(),
      checks: z.record(z.string(), z.unknown()),
      failureReason: z.string().trim().max(2_000).optional(),
    }), request.body);
    const verification = {
      resourceId: parameters.resourceId, passed: body.passed, evidenceDigest: body.evidenceDigest, checks: body.checks,
      ...(body.failureReason === undefined ? {} : { failureReason: body.failureReason }),
    };
    return { ok: true, resource: await market.verifyResource(principal, verification, context(request)) };
  });

  app.post('/mobile/v1/demands', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const body = parse(z.object({
      kind: resourceKind,
      title: z.string().trim().min(2).max(120),
      productHint: z.string().trim().min(1).max(120),
      region: z.string().trim().min(2).max(80),
      quantity: z.string().trim().min(1).max(40),
      capacityUnit: z.string().trim().min(1).max(40),
      desiredStartAt: z.string().datetime(),
      deadlineAt: z.string().datetime(),
      description: z.string().trim().min(8).max(2_000),
    }), request.body);
    const demand = {
      kind: body.kind, title: body.title, productHint: body.productHint, region: body.region,
      quantity: body.quantity, capacityUnit: body.capacityUnit, desiredStartAt: body.desiredStartAt,
      deadlineAt: body.deadlineAt, description: body.description,
    };
    return reply.status(201).send({ ok: true, demand: await market.createDemand(principal, demand, context(request)) });
  });

  app.get('/mobile/v1/demands', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, demands: await market.demands(principal) };
  });

  app.post('/mobile/v1/demands/:demandId/cancel', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ demandId: uuid }), request.params);
    return { ok: true, demand: await market.cancelDemand(principal, parameters.demandId, context(request)) };
  });

}
