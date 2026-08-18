import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { SubjectService } from './service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。', {
    fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
  return result.data;
}

function context(request: FastifyRequest) {
  return { requestId: request.id, ip: request.ip };
}

function requestKey(request: FastifyRequest) {
  return String(request.headers['idempotency-key'] ?? '');
}

export async function registerSubjectRoutes(app: FastifyInstance, accounts: AccountService, subjects: SubjectService) {
  app.get('/mobile/v1/subjects', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    return { ok: true, ...(await subjects.list(principal)) };
  });

  app.post('/mobile/v1/subjects/organizations', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const body = parse(z.object({ displayName: z.string().trim().min(2).max(120) }), request.body);
    const result = await subjects.createOrganization(principal, body.displayName, requestKey(request), context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.put('/mobile/v1/me/current-subject', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const body = parse(z.object({ subjectId: z.string().uuid() }), request.body);
    return { ok: true, subject: await subjects.select(principal, body.subjectId, context(request)) };
  });

  app.get('/mobile/v1/provider/bootstrap', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    return { ok: true, workspace: await subjects.providerBootstrap(principal) };
  });
}
