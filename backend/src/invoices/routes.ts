import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { InvoiceService } from './service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

const invoiceStatus = z.enum(['requested', 'processing', 'issued', 'failed', 'cancelled', 'red_pending', 'red_issued']);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。', {
    fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
  return result.data;
}

function context(request: FastifyRequest) { return { requestId: request.id, ip: request.ip }; }

export async function registerInvoiceRoutes(app: FastifyInstance, accounts: AccountService, invoices: InvoiceService) {
  app.post('/mobile/v1/orders/:orderId/invoices', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ orderId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      invoiceType: z.enum(['personal', 'business']), title: z.string().trim().min(2).max(100),
      taxId: z.string().trim().max(32).optional(), email: z.string().trim().email().max(254),
    }), request.body);
    const result = await invoices.request(principal, {
      orderId: parameters.orderId, invoiceType: body.invoiceType, title: body.title, email: body.email,
      ...(body.taxId === undefined ? {} : { taxId: body.taxId }),
      idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    }, context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.get('/mobile/v1/invoices', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const query = parse(z.object({ status: invoiceStatus.optional() }), request.query);
    return { ok: true, invoices: await invoices.list(principal, query.status) };
  });

  app.get('/mobile/v1/invoices/:invoiceId', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ invoiceId: z.string().uuid() }), request.params);
    return { ok: true, invoice: await invoices.detail(principal, parameters.invoiceId) };
  });

  app.post('/mobile/v1/invoices/:invoiceId/cancel', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ invoiceId: z.string().uuid() }), request.params);
    return { ok: true, invoice: await invoices.cancel(principal, parameters.invoiceId, context(request)) };
  });

  app.get('/mobile/v1/invoices/:invoiceId/documents/:kind/download', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ invoiceId: z.string().uuid(), kind: z.enum(['blue', 'red']) }), request.params);
    return { ok: true, download: await invoices.download(principal, parameters.invoiceId, parameters.kind) };
  });

  app.get('/mobile/v1/operator/invoices', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    if (principal.role !== 'operator' && principal.role !== 'admin') throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要运营审核权限。');
    const query = parse(z.object({ status: invoiceStatus.optional() }), request.query);
    return { ok: true, invoices: await invoices.list(principal, query.status) };
  });

  app.post('/mobile/v1/operator/invoices/:invoiceId/start', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ invoiceId: z.string().uuid() }), request.params);
    return { ok: true, invoice: await invoices.start(principal, parameters.invoiceId, context(request)) };
  });

  app.get('/mobile/v1/operator/invoices/:invoiceId/issuance-data', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ invoiceId: z.string().uuid() }), request.params);
    return { ok: true, issuanceData: await invoices.issuanceData(principal, parameters.invoiceId, context(request)) };
  });

  app.post('/mobile/v1/operator/invoices/:invoiceId/document-uploads', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ invoiceId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      kind: z.enum(['blue', 'red']), sizeBytes: z.number().int().min(8).max(10 * 1024 * 1024),
      sha256Digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    }), request.body);
    return reply.status(201).send({
      ok: true, ...(await invoices.createDocumentUpload(principal, { invoiceId: parameters.invoiceId, ...body }, context(request))),
    });
  });

  app.post('/mobile/v1/operator/invoices/:invoiceId/document-uploads/:uploadId/complete', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ invoiceId: z.string().uuid(), uploadId: z.string().uuid() }), request.params);
    const body = parse(z.object({
      invoiceCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
      invoiceNumber: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
    }), request.body);
    return { ok: true, invoice: await invoices.completeDocument(principal, { ...parameters, ...body }, context(request)) };
  });

  app.post('/mobile/v1/operator/invoices/:invoiceId/fail', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ invoiceId: z.string().uuid() }), request.params);
    const body = parse(z.object({ reason: z.string().trim().min(4).max(500) }), request.body);
    return { ok: true, invoice: await invoices.markFailed(principal, parameters.invoiceId, body.reason, context(request)) };
  });
}
