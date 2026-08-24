import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { ListingAuditService } from './service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

const uuid = z.string().uuid();
const serviceMode = z.enum(['dedicated', 'shared', 'slice', 'node', 'reserved']);
const publicRecord = z.record(z.string(), z.unknown());
const wizardStep = z.enum(['service', 'terms', 'price', 'review']);
const draftPriceEvidence = z.object({
  type: z.enum(['contract', 'invoice', 'market_quote', 'cost_breakdown']),
  source: z.string().trim().max(120),
  summary: z.string().trim().max(1_000),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
}).strict();
const wizardPayload = z.object({
  title: z.string().max(120).optional(),
  serviceMode: serviceMode.optional(),
  nativeUnit: z.string().max(40).optional(),
  minimumQuantity: z.string().max(40).optional(),
  sla: publicRecord.optional(),
  deliveryTerms: publicRecord.optional(),
  acceptanceTerms: publicRecord.optional(),
  refundTerms: publicRecord.optional(),
  cleanupTerms: publicRecord.optional(),
  suggestedUnitCredits: z.string().max(32).optional(),
  priceComponents: publicRecord.optional(),
  priceEvidence: z.array(draftPriceEvidence).max(20).optional(),
}).strict();
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

export async function registerListingAuditRoutes(app: FastifyInstance, accounts: AccountService, listings: ListingAuditService) {
  app.get('/mobile/v1/market/listings', async (request) => {
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }), request.query);
    const authenticated = request.headers.authorization
      ? await authenticateMobileRequest(accounts, request)
      : null;
    return { ok: true, listings: await listings.publicListings(query.limit, authenticated?.principal) };
  });

  app.get('/mobile/v1/provider/offers', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    return { ok: true, offers: await listings.supplierOffers(principal) };
  });

  app.get('/mobile/v1/provider/listings', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    return { ok: true, listings: await listings.supplierListings(principal) };
  });

  app.get('/mobile/v1/provider/listings/availability', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const base = { offerId: uuid };
    const query = parse(z.discriminatedUnion('startMode', [
      z.object({ ...base, startMode: z.literal('immediate'), durationDays: z.coerce.number().int().min(1).max(366) }).strict(),
      z.object({ ...base, startMode: z.literal('scheduled'), startsAt: z.string().datetime(), expiresAt: z.string().datetime() }).strict(),
    ]), request.query);
    return { ok: true, availability: await listings.listingWindowAvailability(principal, query) };
  });

  app.get('/mobile/v1/provider/offer-drafts', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    return { ok: true, drafts: await listings.wizardDrafts(principal) };
  });

  app.get('/mobile/v1/provider/offer-drafts/:draftId', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ draftId: uuid }), request.params);
    return { ok: true, draft: await listings.wizardDraft(principal, parameters.draftId) };
  });

  app.post('/mobile/v1/provider/offer-drafts', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const body = parse(z.object({ resourceId: uuid }).strict(), request.body);
    const result = await listings.createWizardDraft(principal, body.resourceId, requestKey(request), context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.put('/mobile/v1/provider/offer-drafts/:draftId', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ draftId: uuid }), request.params);
    const body = parse(z.object({
      expectedVersion: z.number().int().positive(), currentStep: wizardStep, payload: wizardPayload,
    }).strict(), request.body);
    return { ok: true, draft: await listings.saveWizardDraft(principal, parameters.draftId, body) };
  });

  app.delete('/mobile/v1/provider/offer-drafts/:draftId', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ draftId: uuid }), request.params);
    const body = parse(z.object({ expectedVersion: z.number().int().positive() }).strict(), request.body);
    return { ok: true, ...(await listings.abandonWizardDraft(principal, parameters.draftId, body.expectedVersion, context(request))) };
  });

  app.post('/mobile/v1/provider/offer-drafts/:draftId/submit', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ draftId: uuid }), request.params);
    const body = parse(z.object({ expectedVersion: z.number().int().positive() }).strict(), request.body);
    const result = await listings.submitWizardDraft(principal, parameters.draftId, body.expectedVersion, requestKey(request), context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.get('/mobile/v1/provider/offers/:offerId', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ offerId: uuid }), request.params);
    return { ok: true, offer: await listings.supplierOffer(principal, parameters.offerId) };
  });

  app.post('/mobile/v1/provider/offers/:offerId/revision', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ offerId: uuid }), request.params);
    const result = await listings.createOfferRevision(principal, parameters.offerId, requestKey(request), context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.get('/mobile/v1/provider/offers/:offerId/revision', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ offerId: uuid }), request.params);
    return { ok: true, draft: await listings.offerRevision(principal, parameters.offerId) };
  });

  app.put('/mobile/v1/provider/offers/:offerId/revision', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ offerId: uuid }), request.params);
    const body = parse(z.object({
      expectedVersion: z.number().int().positive(), currentStep: wizardStep, payload: wizardPayload,
    }).strict(), request.body);
    return { ok: true, draft: await listings.saveOfferRevision(principal, parameters.offerId, body) };
  });

  app.post('/mobile/v1/provider/offers/:offerId/revision/submit', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ offerId: uuid }), request.params);
    const body = parse(z.object({ expectedVersion: z.number().int().positive() }).strict(), request.body);
    const result = await listings.submitOfferRevision(
      principal, parameters.offerId, body.expectedVersion, requestKey(request), context(request),
    );
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.post('/mobile/v1/provider/offers/:offerId/reaudit', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ offerId: uuid }), request.params);
    const body = parse(z.object({ expectedVersion: z.number().int().positive() }).strict(), request.body);
    const result = await listings.resubmitExpiredOffer(principal, parameters.offerId, body.expectedVersion, context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.post('/mobile/v1/operator/offers/:offerId/audits/:kind/decision', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ offerId: uuid, kind: z.enum(['resource', 'price']) }), request.params);
    const body = parse(z.object({
      decision: z.enum(['approve', 'changes_requested', 'reject']),
      decisionReason: z.string().trim().min(4).max(2_000),
      evidenceSummary: z.string().trim().min(4).max(4_000),
      evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      returnStep: z.enum(['service', 'terms', 'price']).optional(),
      validUntil: z.string().datetime().optional(),
      approvedUnitCreditMicros: z.string().regex(/^\d{1,18}$/u).optional(),
    }), request.body);
    return { ok: true, offer: await listings.decideAudit(principal, {
      offerId: parameters.offerId, kind: parameters.kind, decision: body.decision,
      decisionReason: body.decisionReason, evidenceSummary: body.evidenceSummary, evidenceDigest: body.evidenceDigest,
      ...(body.returnStep === undefined ? {} : { returnStep: body.returnStep }),
      ...(body.validUntil === undefined ? {} : { validUntil: body.validUntil }),
      ...(body.approvedUnitCreditMicros === undefined ? {} : { approvedUnitCreditMicros: body.approvedUnitCreditMicros }),
    }, context(request)) };
  });

  app.post('/mobile/v1/provider/listings', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const base = { offerId: uuid, capacityTotal: z.string().trim().min(1).max(40) };
    const body = parse(z.discriminatedUnion('startMode', [
      z.object({ ...base, startMode: z.literal('immediate'), durationDays: z.number().int().min(1).max(366) }).strict(),
      z.object({ ...base, startMode: z.literal('scheduled'), startsAt: z.string().datetime(), expiresAt: z.string().datetime() }).strict(),
    ]), request.body);
    const result = await listings.publish(principal, body, requestKey(request), context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  app.put('/mobile/v1/provider/listings/:listingId/status', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parameters = parse(z.object({ listingId: uuid }), request.params);
    const body = parse(z.object({ status: z.enum(['active', 'paused', 'withdrawn']) }).strict(), request.body);
    return { ok: true, ...(await listings.setListingStatus(principal, parameters.listingId, body.status, context(request))) };
  });
}
