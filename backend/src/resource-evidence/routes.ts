import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { ResourceEvidenceService } from './service.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。', {
    fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
  return result.data;
}

function context(request: FastifyRequest) { return { requestId: request.id, ip: request.ip }; }

const resourceParams = z.object({ resourceId: z.string().uuid() });
const evidenceParams = z.object({ resourceId: z.string().uuid(), evidenceId: z.string().uuid() });

export async function registerResourceEvidenceRoutes(
  app: FastifyInstance, accounts: AccountService, evidence: ResourceEvidenceService,
) {
  app.get('/mobile/v1/provider/resources/:resourceId/evidence', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(resourceParams, request.params);
    return { ok: true, checklist: await evidence.checklist(principal, parameters.resourceId) };
  });

  app.post('/mobile/v1/provider/resources/:resourceId/evidence/uploads', async (request, reply) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(resourceParams, request.params);
    const body = parse(z.object({
      category: z.enum(['ownership', 'configuration', 'availability']),
      fileName: z.string().trim().min(1).max(240),
      mimeType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
      sizeBytes: z.number().int().min(1).max(20 * 1024 * 1024),
      sha256Digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    }), request.body);
    const result = await evidence.createUpload(principal, {
      resourceId: parameters.resourceId, ...body,
      clientRequestId: String(request.headers['idempotency-key'] ?? ''),
    }, context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.post('/mobile/v1/provider/resources/:resourceId/evidence/:evidenceId/upload-grant', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(evidenceParams, request.params);
    const body = parse(z.object({ sha256Digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }), request.body);
    return {
      ok: true,
      upload: await evidence.renewUpload(principal, parameters.resourceId, parameters.evidenceId, body.sha256Digest),
    };
  });

  app.post('/mobile/v1/provider/resources/:resourceId/evidence/:evidenceId/complete', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(evidenceParams, request.params);
    return {
      ok: true,
      evidence: await evidence.completeUpload(principal, parameters.resourceId, parameters.evidenceId, context(request)),
    };
  });

  app.post('/mobile/v1/provider/resources/:resourceId/evidence/:evidenceId/discard', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(evidenceParams, request.params);
    return {
      ok: true,
      evidence: await evidence.discard(principal, parameters.resourceId, parameters.evidenceId, context(request)),
    };
  });

  app.post('/mobile/v1/provider/resources/:resourceId/evidence/submit', async (request, reply) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(resourceParams, request.params);
    const result = await evidence.submit(
      principal, parameters.resourceId, String(request.headers['idempotency-key'] ?? ''), context(request),
    );
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.get('/mobile/v1/operator/resources/:resourceId/evidence', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(resourceParams, request.params);
    return { ok: true, bundle: await evidence.operatorBundle(principal, parameters.resourceId) };
  });

  app.get('/mobile/v1/operator/resources/:resourceId/evidence/:evidenceId/download', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(evidenceParams, request.params);
    return {
      ok: true,
      download: await evidence.operatorDownload(principal, parameters.resourceId, parameters.evidenceId, context(request)),
    };
  });
}
