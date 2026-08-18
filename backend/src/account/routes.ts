import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { AccountService } from './service.js';
import type { KaiOidcBroker } from './kai-oidc.js';
import { authenticateMobileBootstrapRequest, authenticateMobileRequest } from './request-auth.js';

const phone = z.string().trim().min(11).max(20);
const purpose = z.enum(['register', 'login', 'delete_account']);
const device = z.object({
  deviceId: z.string().trim().min(8).max(200),
  appVersion: z.string().trim().min(1).max(40),
  platform: z.enum(['android', 'ios']),
});
const consent = z.object({ kind: z.enum(['terms', 'privacy']), version: z.string().trim().min(1).max(40) });

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
  return {
    requestId: request.id,
    ip: request.ip,
    userAgent: String(request.headers['user-agent'] ?? 'unknown').slice(0, 500),
  };
}

export async function registerAccountRoutes(
  app: FastifyInstance,
  service: AccountService,
  config: RuntimeConfig,
  kaiOidc?: KaiOidcBroker,
) {
  app.get('/mobile/v1/legal', async () => ({ ok: true, documents: service.legalDocuments(config) }));

  app.post('/mobile/v1/auth/kai/consents', async (request, reply) => {
    const { principal } = await authenticateMobileBootstrapRequest(service, request);
    const body = parse(z.object({
      termsVersion: z.string().trim().min(1).max(40),
      privacyVersion: z.string().trim().min(1).max(40),
      attemptId: z.string().uuid(),
    }).strict(), request.body);
    const result = await service.acceptKaiConsents(principal, body, context(request));
    return reply.status(result.replayed ? 200 : 201).send({ ok: true, ...result });
  });

  if (kaiOidc) {
  app.get('/mobile/v1/auth/kai/start', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const query = parse(z.object({
      appRedirect: z.string().trim().min(1).max(300),
      appChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      appChallengeMethod: z.literal('S256'),
      termsVersion: z.string().trim().min(1).max(40),
      privacyVersion: z.string().trim().min(1).max(40),
    }), request.query);
    const destination = await kaiOidc.start(query.appRedirect, query.appChallenge, {
      termsVersion: query.termsVersion,
      privacyVersion: query.privacyVersion,
    });
    return reply
      .header('Cache-Control', 'no-store')
      .header('Pragma', 'no-cache')
      .header('Referrer-Policy', 'no-referrer')
      .redirect(destination);
  });

  app.get('/mobile/v1/auth/kai/callback', {
    config: { rateLimit: { max: 60, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const query = parse(z.object({
      state: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u),
      iss: z.string().url().max(300),
      code: z.string().min(1).max(2_048).optional(),
      error: z.string().trim().min(1).max(100).optional(),
      error_description: z.string().max(1_000).optional(),
    }).refine((value) => Boolean(value.code) !== Boolean(value.error)), request.query);
    const destination = await kaiOidc.callback({
      state: query.state,
      issuer: query.iss,
      ...(query.code ? { code: query.code } : {}),
      ...(query.error ? { providerError: query.error } : {}),
    }, context(request));
    return reply
      .header('Cache-Control', 'no-store')
      .header('Pragma', 'no-cache')
      .header('Referrer-Policy', 'no-referrer')
      .redirect(destination);
  });

  app.post('/mobile/v1/auth/kai/exchange', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (request) => {
    const body = parse(z.object({
      code: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u),
      codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
      device,
    }), request.body);
    return {
      ok: true,
      result: await kaiOidc.exchangeAppLoginCode(body.code, body.codeVerifier, body.device, context(request)),
    };
  });
  }

  app.post('/mobile/v1/auth/otp/request', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const body = parse(z.object({ phone, purpose }), request.body);
    if (config.NODE_ENV === 'production') {
      throw new AppError('AUTH_OTP_LOGIN_RETIRED', 410, '请使用 KAI 统一身份登录。');
    }
    const result = await service.requestOtp(body, context(request));
    return reply.status(202).send({ ok: true, challenge: result });
  });

  app.post('/mobile/v1/auth/otp/verify', {
    config: { rateLimit: { max: 12, timeWindow: '10 minutes' } },
  }, async (request) => {
    const body = parse(z.object({
      phone,
      challengeId: z.string().uuid(),
      code: z.string().regex(/^\d{6}$/u),
      purpose,
      displayName: z.string().trim().min(1).max(80).optional(),
      consents: z.array(consent).max(4).optional(),
      device: device.optional(),
    }), request.body);
    if (config.NODE_ENV === 'production') {
      throw new AppError('AUTH_OTP_LOGIN_RETIRED', 410, '请使用 KAI 统一身份登录。');
    }
    const verification = {
      phone: body.phone,
      challengeId: body.challengeId,
      code: body.code,
      purpose: body.purpose,
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.consents === undefined ? {} : { consents: body.consents }),
      ...(body.device === undefined ? {} : { device: body.device }),
    };
    return { ok: true, result: await service.verifyOtp(verification, context(request)) };
  });

  app.get('/mobile/v1/me', async (request) => {
    // Identity bootstrap is intentionally non-transactional and cannot perform
    // commerce. It remains available before legal acceptance so the App can
    // present the mapped local profile; every business route uses the gated guard.
    const { principal } = await authenticateMobileBootstrapRequest(service, request);
    return { ok: true, user: await service.profile(principal) };
  });

  if (config.NODE_ENV === 'test' && config.localE2E) {
  app.post('/mobile/v1/auth/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
  }, async (request) => {
    const body = parse(z.object({
      refreshToken: z.string().min(40).max(500),
      deviceId: z.string().trim().min(8).max(200),
    }), request.body);
    return { ok: true, session: await service.refresh(body.refreshToken, body.deviceId, context(request)) };
  });

  app.get('/mobile/v1/auth/sessions', async (request) => {
    const { principal } = await authenticateMobileRequest(service, request);
    return { ok: true, sessions: await service.sessions(principal) };
  });

  app.delete('/mobile/v1/auth/sessions/:sessionId', async (request) => {
    const { principal } = await authenticateMobileRequest(service, request);
    const parameters = parse(z.object({ sessionId: z.string().uuid() }), request.params);
    return { ok: true, ...(await service.logout(principal, parameters.sessionId, context(request))) };
  });

  app.post('/mobile/v1/auth/logout', async (request) => {
    const { principal } = await authenticateMobileRequest(service, request);
    return { ok: true, ...(await service.logout(principal, undefined, context(request))) };
  });
  } else {
    const retired = async () => { throw new AppError('AUTH_LOCAL_SESSION_RETIRED', 410, '请通过 KAI 统一身份管理登录状态。'); };
    app.post('/mobile/v1/auth/refresh', retired);
    app.get('/mobile/v1/auth/sessions', retired);
    app.delete('/mobile/v1/auth/sessions/:sessionId', retired);
    app.post('/mobile/v1/auth/logout', retired);
  }

  app.get('/mobile/v1/account/deletion', async (request) => {
    const { principal } = await authenticateMobileRequest(service, request);
    return { ok: true, request: await service.deletionStatus(principal) };
  });

  app.post('/mobile/v1/account/deletion', {
    config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { principal } = await authenticateMobileRequest(service, request);
    if (config.NODE_ENV === 'production') {
      throw new AppError('AUTH_RECENT_REAUTH_REQUIRED', 503, '账号注销的统一身份重新认证尚未接入。');
    }
    const body = parse(z.object({
      reauthenticationToken: z.string().min(40).max(2_000),
      reason: z.string().trim().max(1_000).optional(),
    }), request.body);
    const deletion = await service.requestDeletion(principal, body.reauthenticationToken, body.reason, context(request));
    return reply.status(202).send({ ok: true, request: deletion });
  });

  app.post('/mobile/v1/account/deletion/public', {
    config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    if (config.NODE_ENV === 'production') {
      throw new AppError('AUTH_RECENT_REAUTH_REQUIRED', 503, '账号注销的统一身份重新认证尚未接入。');
    }
    const body = parse(z.object({
      reauthenticationToken: z.string().min(40).max(2_000),
      reason: z.string().trim().max(1_000).optional(),
    }), request.body);
    const deletion = await service.requestDeletionFromWeb(
      body.reauthenticationToken, body.reason, context(request),
    );
    return reply.status(202).send({ ok: true, request: deletion });
  });

  app.delete('/mobile/v1/account/deletion', async (request) => {
    const { principal } = await authenticateMobileRequest(service, request);
    return { ok: true, ...(await service.cancelDeletion(principal, context(request))) };
  });
}
