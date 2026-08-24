import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { DisputeService } from './service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

const category = z.enum(['not_delivered', 'spec_mismatch', 'service_unavailable', 'billing', 'unauthorized', 'other']);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。', {
    fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
  return result.data;
}

function context(request: FastifyRequest) { return { requestId: request.id, ip: request.ip }; }

export async function registerDisputeRoutes(app: FastifyInstance, accounts: AccountService, disputes: DisputeService) {
  app.post('/mobile/v1/orders/:orderId/disputes', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({ category, reason: z.string().trim().min(8).max(2_000) }), request.body);
    const result = await disputes.open(principal, {
      orderId: parameters.orderId, ...body, idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    }, context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.get('/mobile/v1/disputes', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    return { ok: true, disputes: await disputes.list(principal) };
  });

  app.get('/mobile/v1/disputes/:disputeId', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ disputeId: z.string().uuid() }), request.params);
    return { ok: true, dispute: await disputes.detail(principal, parameters.disputeId) };
  });

  app.post('/mobile/v1/disputes/:disputeId/evidence/uploads', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ disputeId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      mimeType: z.enum(['image/jpeg', 'image/png', 'application/pdf', 'text/plain', 'application/json']),
      sizeBytes: z.number().int().min(1).max(20 * 1024 * 1024),
      sha256Digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    }), request.body);
    return reply.status(201).send({ ok: true, ...(await disputes.createEvidenceUpload(principal, { disputeId: parameters.disputeId, ...body }, context(request))) });
  });

  app.post('/mobile/v1/disputes/:disputeId/evidence/:evidenceId/upload-grant', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ disputeId: z.string().uuid(), evidenceId: z.string().uuid() }), request.params);
    return { ok: true, upload: await disputes.renewEvidenceUpload(principal, parameters.disputeId, parameters.evidenceId) };
  });

  app.post('/mobile/v1/disputes/:disputeId/evidence/:evidenceId/complete', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ disputeId: z.string().uuid(), evidenceId: z.string().uuid() }), request.params);
    return { ok: true, evidence: await disputes.completeEvidenceUpload(principal, parameters.disputeId, parameters.evidenceId, context(request)) };
  });

  app.post('/mobile/v1/disputes/:disputeId/evidence/:evidenceId/discard', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ disputeId: z.string().uuid(), evidenceId: z.string().uuid() }), request.params);
    return { ok: true, evidence: await disputes.discardEvidence(principal, parameters.disputeId, parameters.evidenceId, context(request)) };
  });

  app.get('/mobile/v1/disputes/:disputeId/evidence/:evidenceId/download', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ disputeId: z.string().uuid(), evidenceId: z.string().uuid() }), request.params);
    return { ok: true, download: await disputes.evidenceDownload(principal, parameters.disputeId, parameters.evidenceId) };
  });

  app.post('/mobile/v1/disputes/:disputeId/close', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ disputeId: z.string().uuid() }), request.params);
    return { ok: true, dispute: await disputes.close(principal, parameters.disputeId, context(request)) };
  });

  app.post('/mobile/v1/disputes/:disputeId/evidence/submit', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ disputeId: z.string().uuid() }), request.params);
    return { ok: true, dispute: await disputes.completeEvidenceSubmission(principal, parameters.disputeId, context(request)) };
  });

  app.post('/mobile/v1/operator/disputes/:disputeId/resolve', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ disputeId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      outcome: z.enum(['buyer', 'supplier']), resolution: z.string().trim().min(8).max(2_000),
      refundAmountCents: z.number().int().positive().max(100_000_000_000).optional(),
    }), request.body);
    return {
      ok: true,
      dispute: await disputes.resolve(principal, {
        disputeId: parameters.disputeId, outcome: body.outcome, resolution: body.resolution,
        ...(body.refundAmountCents === undefined ? {} : { refundAmountCents: body.refundAmountCents }),
      }, context(request)),
    };
  });
}
