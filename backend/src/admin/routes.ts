import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { KAI_OIDC_ISSUER } from '../identity/kai-oidc-constants.js';
import type { AdminAuthService, AdminRequestContext, AuthenticatedAdmin } from './auth-service.js';
import type { AdminAuthRuntimeSettings } from './runtime.js';
import {
  ADMIN_LOGIN_BINDING_COOKIE,
  ADMIN_SESSION_COOKIE,
  clearHostCookie,
  parseCookieHeader,
  requireOpaqueCookie,
  serializeHostCookie,
} from './security.js';

const loginQuery = z.object({ returnTo: z.string().max(500).optional() }).strict();
const callbackQuery = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
  iss: z.string().url().max(500),
  code: z.string().min(1).max(2_048).optional(),
  error: z.string().min(1).max(100).optional(),
  error_description: z.string().max(1_000).optional(),
}).strict().refine((value) => Boolean(value.code) !== Boolean(value.error));

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('ADMIN_REQUEST_INVALID', 400, '管理员请求格式无效。');
  return result.data;
}

export function adminRequestContext(request: FastifyRequest): AdminRequestContext {
  return {
    requestId: request.id,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? 'unknown',
  };
}

function requireAdminOrigin(request: FastifyRequest, settings: AdminAuthRuntimeSettings): void {
  if (request.headers.origin !== settings.webOrigin) {
    throw new AppError('ADMIN_ORIGIN_INVALID', 403, '管理员请求来源无效。');
  }
}

function sessionToken(request: FastifyRequest): string {
  const cookies = parseCookieHeader(request.headers.cookie);
  return requireOpaqueCookie(cookies[ADMIN_SESSION_COOKIE]);
}

export async function authenticateAdminHttpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  service: AdminAuthService,
  settings: AdminAuthRuntimeSettings,
  allowRotation = true,
): Promise<AuthenticatedAdmin> {
  let result: AuthenticatedAdmin;
  try {
    result = await service.authenticate(sessionToken(request), adminRequestContext(request), { allowRotation });
  } catch (error) {
    const failureCode = error instanceof AppError ? error.code : 'ADMIN_AUTH_REQUIRED';
    try {
      await service.recordSecurityDenial('session', failureCode, adminRequestContext(request));
    } catch { /* fail closed */ }
    throw error;
  }
  if (result.rotatedSessionToken) {
    const remainingSeconds = Math.max(1, Math.floor(
      (result.session.absoluteExpiresAt.getTime() - Date.now()) / 1_000,
    ));
    reply.header('Set-Cookie', serializeHostCookie(
      ADMIN_SESSION_COOKIE,
      result.rotatedSessionToken,
      Math.min(settings.sessionAbsoluteTtlSeconds, remainingSeconds),
    ));
  }
  if (result.staleSession) {
    try {
      await service.recordSecurityDenial(
        'session', 'ADMIN_SESSION_STALE', adminRequestContext(request), result,
      );
    } catch { /* the HTTP response remains fail-closed */ }
    throw new AppError('ADMIN_SESSION_STALE', 409, '管理员会话已更新，请重试。');
  }
  return result;
}

export async function registerAdminAuthRoutes(
  app: FastifyInstance,
  service: AdminAuthService,
  settings: AdminAuthRuntimeSettings,
) {
  await app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      const origin = request.headers.origin;
      const oidcCallback = request.url.startsWith('/admin/v1/auth/callback');
      const trustedOidcOrigin = new URL(KAI_OIDC_ISSUER).origin;
      if (origin !== undefined && origin !== settings.webOrigin
        && !(oidcCallback && origin === trustedOidcOrigin)) {
        try {
          await service.recordSecurityDenial('origin', 'ADMIN_ORIGIN_INVALID', adminRequestContext(request));
        } catch { /* fail closed */ }
        throw new AppError('ADMIN_ORIGIN_INVALID', 403, '管理员请求来源无效。');
      }
    });
    admin.addHook('onSend', async (request, reply, payload) => {
      reply.header('Cache-Control', 'no-store, max-age=0');
      reply.header('Pragma', 'no-cache');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      if (request.headers.origin === settings.webOrigin) {
        reply.header('Access-Control-Allow-Origin', settings.webOrigin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Vary', 'Origin');
      }
      return payload;
    });

    admin.options('/*', { config: { cors: false } }, async (request, reply) => {
      requireAdminOrigin(request, settings);
      return reply
        .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        .header('Access-Control-Allow-Headers', 'content-type,x-admin-csrf,x-request-id')
        .code(204).send();
    });

    admin.get('/health', { config: { cors: false, rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => ({
      ok: true,
      service: 'kai-admin-api',
      apiVersion: 'admin/v1',
    }));

    admin.get('/auth/login', {
      config: { cors: false, rateLimit: { max: 20, timeWindow: '10 minutes' } }, logLevel: 'silent',
    }, async (request, reply) => {
      const query = parsed(loginQuery, request.query);
      const started = await service.startLogin(query.returnTo ?? '/', adminRequestContext(request));
      return reply
        .header('Set-Cookie', serializeHostCookie(
          ADMIN_LOGIN_BINDING_COOKIE,
          started.browserBindingToken,
          settings.loginTransactionTtlSeconds,
        ))
        .code(302)
        .redirect(started.authorizationUrl);
    });

    admin.get('/auth/callback', {
      config: { cors: false, rateLimit: { max: 60, timeWindow: '10 minutes' } }, logLevel: 'silent',
    }, async (request, reply) => {
      let serviceAttempted = false;
      try {
        const query = parsed(callbackQuery, request.query);
        const cookies = parseCookieHeader(request.headers.cookie);
        serviceAttempted = true;
        const completed = await service.completeLogin({
          state: query.state,
          code: query.code,
          issuer: query.iss,
          providerError: query.error,
          browserBindingToken: cookies[ADMIN_LOGIN_BINDING_COOKIE],
        }, adminRequestContext(request));
        return reply
          .header('Set-Cookie', [
            clearHostCookie(ADMIN_LOGIN_BINDING_COOKIE),
            serializeHostCookie(ADMIN_SESSION_COOKIE, completed.sessionToken, settings.sessionAbsoluteTtlSeconds),
          ])
          .code(303)
          .redirect(`${settings.webOrigin}${completed.returnPath}`);
      } catch {
        if (!serviceAttempted) {
          try {
            await service.recordRejectedCallback('ADMIN_CALLBACK_INVALID', adminRequestContext(request));
          } catch { /* fail closed */ }
        }
        return reply
          .header('Set-Cookie', clearHostCookie(ADMIN_LOGIN_BINDING_COOKIE))
          .code(303)
          .redirect(`${settings.webOrigin}/login?error=LOGIN_FAILED`);
      }
    });

    admin.get('/auth/me', { config: { cors: false } }, async (request, reply) => {
      const result = await authenticateAdminHttpRequest(request, reply, service, settings);
      return {
        ok: true,
        admin: {
          displayName: result.principal.displayName,
          roles: result.principal.roles,
          permissions: result.principal.permissions,
          authzVersion: result.principal.authzVersion,
        },
        session: {
          createdAt: result.principal.sessionCreatedAt.toISOString(),
          idleExpiresAt: result.principal.idleExpiresAt.toISOString(),
          absoluteExpiresAt: result.principal.absoluteExpiresAt.toISOString(),
          reauthenticatedAt: result.principal.reauthenticatedAt?.toISOString() ?? null,
        },
        csrfToken: result.csrfToken,
      };
    });

    for (const [path, allSessions] of [['/auth/logout', false], ['/auth/logout-all', true]] as const) {
      admin.post(path, { config: { cors: false, rateLimit: { max: 20, timeWindow: '10 minutes' } } },
        async (request, reply) => {
          requireAdminOrigin(request, settings);
          const result = await authenticateAdminHttpRequest(request, reply, service, settings, false);
          const csrfHeader = request.headers['x-admin-csrf'];
          try {
            service.requireCsrf(result, typeof csrfHeader === 'string' ? csrfHeader : undefined);
          } catch (error) {
            try {
              await service.recordSecurityDenial(
                'csrf', 'ADMIN_CSRF_INVALID', adminRequestContext(request), result,
              );
            } catch { /* fail closed */ }
            throw error;
          }
          const revokedSessionCount = await service.logout(
            result, allSessions, adminRequestContext(request),
          );
          return reply.header('Set-Cookie', clearHostCookie(ADMIN_SESSION_COOKIE)).send({
            ok: true,
            revokedSessionCount,
          });
        });
    }
  }, { prefix: '/admin/v1' });
}
