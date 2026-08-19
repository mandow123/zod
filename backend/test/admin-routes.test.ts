import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AdminAuthService, AuthenticatedAdmin } from '../src/admin/auth-service.js';
import { registerAdminAuthRoutes } from '../src/admin/routes.js';
import type { AdminAuthRuntimeSettings } from '../src/admin/runtime.js';
import { ADMIN_LOGIN_BINDING_COOKIE, ADMIN_SESSION_COOKIE } from '../src/admin/security.js';
import { installErrorHandling } from '../src/errors.js';
import { KAI_OIDC_ISSUER } from '../src/identity/kai-oidc-constants.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const settings: AdminAuthRuntimeSettings = {
  webOrigin: 'https://admin.example.test', apiOrigin: 'https://api.example.test',
  oidcClientId: 'admin', oidcClientSecret: 'secret-secret-secret',
  oidcRedirectUri: 'https://api.example.test/admin/v1/auth/callback',
  oidcScopes: ['openid'], oidcGroupClaim: 'groups', oidcGroupRoleMappings: [],
  oidcFlowPepper: 'f'.repeat(40), oidcSubjectPepper: 's'.repeat(40), oidcGroupPepper: 'g'.repeat(40),
  oidcTransactionEncryptionKey: Buffer.alloc(32, 1).toString('base64'),
  sessionTokenPepper: 't'.repeat(40), csrfTokenPepper: 'c'.repeat(40),
  piiEncryptionKey: Buffer.alloc(32, 2).toString('base64'), auditPepper: 'a'.repeat(40),
  loginTransactionTtlSeconds: 300, sessionIdleTtlSeconds: 1_800,
  sessionAbsoluteTtlSeconds: 28_800, sessionRotationSeconds: 900,
  previousTokenGraceSeconds: 10, reauthFreshnessSeconds: 300,
};

function authenticated(): AuthenticatedAdmin {
  const now = new Date(); const absolute = new Date(now.getTime() + 60_000);
  return {
    principal: { identityId: 'identity', sessionId: 'session', displayName: 'Admin',
      roles: ['support_viewer'], permissions: ['admin.overview.read'], authzVersion: 2,
      sessionCreatedAt: now, idleExpiresAt: absolute, absoluteExpiresAt: absolute, reauthenticatedAt: now },
    session: { id: 'session', adminIdentityId: 'identity', tokenHash: 'h'.repeat(128),
      previousTokenHash: null, previousTokenValidUntil: null, csrfTokenHash: 'c'.repeat(128), status: 'active',
      authzVersionAtIssue: 2, permissionDefinitionVersion: 'admin-permissions-v1',
      permissionSnapshotDigest: 'p'.repeat(128), createdAt: now, lastSeenAt: now,
      idleExpiresAt: absolute, absoluteExpiresAt: absolute, rotatedAt: null, reauthenticatedAt: now,
      revokedAt: null, revocationReasonCode: null, createdIpHash: 'i'.repeat(64), lastIpHash: 'i'.repeat(64),
      userAgentHash: 'u'.repeat(64) },
    csrfToken: 'z'.repeat(128),
  };
}

async function fixture() {
  const auth = authenticated();
  const service = {
    startLogin: vi.fn(async () => ({ authorizationUrl: `${KAI_OIDC_ISSUER}/oauth2/authorize?state=safe`,
      browserBindingToken: 'b'.repeat(64) })),
    completeLogin: vi.fn(async () => ({ sessionToken: 's'.repeat(64), returnPath: '/compute-orders',
      principal: auth.principal })),
    authenticate: vi.fn(async () => auth),
    requireCsrf: vi.fn(),
    logout: vi.fn(async () => 1),
    recordRejectedCallback: vi.fn(async () => undefined),
    recordSecurityDenial: vi.fn(async () => undefined),
  };
  const app = Fastify({ logger: false });
  installErrorHandling(app);
  await registerAdminAuthRoutes(app, service as unknown as AdminAuthService, settings);
  await app.ready();
  return { app, service };
}

describe('admin auth HTTP routes', () => {
  it('does not register any administrator route while the capability is disabled', async () => {
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), database: null,
      adminAuthService: {} as AdminAuthService, adminAuthSettings: settings, logger: false });
    const response = await app.inject({ method: 'GET', url: '/admin/v1/health' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('uses fixed security headers and secure host cookies for the login redirect', async () => {
    const f = await fixture();
    const response = await f.app.inject({ method: 'GET', url: '/admin/v1/auth/login?returnTo=%2Fcompute-orders' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${KAI_OIDC_ISSUER}/oauth2/authorize?state=safe`);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain(`${ADMIN_LOGIN_BINDING_COOKIE}=`);
    expect(cookie).toContain('Secure'); expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax'); expect(cookie).not.toContain('Domain=');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    await f.app.close();
  });

  it('never reflects callback secrets and audits malformed callbacks', async () => {
    const f = await fixture();
    const response = await f.app.inject({ method: 'GET',
      url: '/admin/v1/auth/callback?state=secret-state&code=secret-code&error_description=private' });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('https://admin.example.test/login?error=LOGIN_FAILED');
    expect(JSON.stringify(response.headers)).not.toContain('secret-code');
    expect(JSON.stringify(response.headers)).not.toContain('secret-state');
    expect(f.service.recordRejectedCallback).toHaveBeenCalledWith('ADMIN_CALLBACK_INVALID', expect.anything());
    await f.app.close();
  });

  it('suppresses callback query secrets from actual Fastify request logs', async () => {
    const baseline = await fixture();
    await baseline.app.close();
    const logs: string[] = [];
    const app = Fastify({
      logger: {
        level: 'info',
        stream: { write: (line: string) => { logs.push(line); } },
      },
    });
    installErrorHandling(app);
    await registerAdminAuthRoutes(
      app, baseline.service as unknown as AdminAuthService, settings,
    );
    await app.ready();
    const state = `secret-state-${'q'.repeat(40)}`;
    await app.inject({
      method: 'GET',
      url: `/admin/v1/auth/callback?state=${state}&code=secret-code-marker&iss=${encodeURIComponent(KAI_OIDC_ISSUER)}&error_description=alpha-support-client-secret-marker`,
      headers: { cookie: `${ADMIN_LOGIN_BINDING_COOKIE}=${'b'.repeat(64)}` },
    });
    await app.close();
    const captured = logs.join('\n');
    for (const secret of [state, 'secret-code-marker', 'alpha-support', 'client-secret-marker']) {
      expect(captured).not.toContain(secret);
    }
  });

  it('sets the session cookie only after a valid bound callback', async () => {
    const f = await fixture();
    const state = 'q'.repeat(64);
    const response = await f.app.inject({ method: 'GET',
      url: `/admin/v1/auth/callback?state=${state}&code=code&iss=${encodeURIComponent(KAI_OIDC_ISSUER)}`,
      headers: { cookie: `${ADMIN_LOGIN_BINDING_COOKIE}=${'b'.repeat(64)}` } });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('https://admin.example.test/compute-orders');
    expect(String(response.headers['set-cookie'])).toContain(`${ADMIN_SESSION_COOKIE}=${'s'.repeat(64)}`);
    await f.app.close();
  });

  it('returns only the administrative principal and enforces exact Origin plus CSRF on logout', async () => {
    const f = await fixture(); const cookie = `${ADMIN_SESSION_COOKIE}=${'s'.repeat(64)}`;
    const me = await f.app.inject({ method: 'GET', url: '/admin/v1/auth/me',
      headers: { cookie, origin: settings.webOrigin } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ ok: true, admin: { displayName: 'Admin', roles: ['support_viewer'] } });
    expect(me.body).not.toContain('identity'); expect(me.body).not.toContain('tokenHash');
    expect(me.headers['access-control-allow-origin']).toBe(settings.webOrigin);

    const rejected = await f.app.inject({ method: 'POST', url: '/admin/v1/auth/logout',
      headers: { cookie, origin: 'https://admin.example.test.attacker.test', 'x-admin-csrf': 'z'.repeat(128) } });
    expect(rejected.statusCode).toBe(403);
    const logout = await f.app.inject({ method: 'POST', url: '/admin/v1/auth/logout',
      headers: { cookie, origin: settings.webOrigin, 'x-admin-csrf': 'z'.repeat(128) } });
    expect(logout.statusCode).toBe(200);
    expect(f.service.authenticate).toHaveBeenLastCalledWith('s'.repeat(64), expect.anything(), { allowRotation: false });
    expect(f.service.requireCsrf).toHaveBeenCalledWith(expect.anything(), 'z'.repeat(128));
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    await f.app.close();
  });

  it('returns a retryable conflict without principal or CSRF data for a stale session response', async () => {
    const f = await fixture();
    f.service.authenticate.mockResolvedValueOnce({ ...authenticated(), csrfToken: null, staleSession: true });
    const response = await f.app.inject({
      method: 'GET',
      url: '/admin/v1/auth/me',
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=${'s'.repeat(64)}`,
        origin: settings.webOrigin,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'ADMIN_SESSION_STALE' } });
    expect(response.body).not.toContain('csrfToken');
    expect(response.body).not.toContain('Admin');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(f.service.recordSecurityDenial).toHaveBeenCalledWith(
      'session', 'ADMIN_SESSION_STALE', expect.anything(), expect.objectContaining({ staleSession: true }),
    );
    await f.app.close();
  });
});
