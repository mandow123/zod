import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import type { AdminAuthService, AuthenticatedAdmin } from '../src/admin/auth-service.js';
import { adminAuthRuntimeSettings } from '../src/admin/runtime.js';
import { AdminP0Service } from '../src/admin/p0-service.js';
import { ADMIN_SESSION_COOKIE } from '../src/admin/security.js';

const WEB_ORIGIN = 'https://admin.example.test';
const API_ORIGIN = 'https://admin-api.example.test';
const SESSION_TOKEN = 's'.repeat(64);

function configuredAdminConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://public-api.example.test',
    ADMIN_AUTH_ENABLED: 'true',
    ADMIN_WEB_ORIGIN: `${WEB_ORIGIN}/`,
    ADMIN_API_ORIGIN: `${API_ORIGIN}/`,
    ADMIN_OIDC_CLIENT_ID: 'admin-test-client',
    ADMIN_OIDC_CLIENT_SECRET: 'admin-test-confidential-client-secret',
    ADMIN_OIDC_REDIRECT_URI: `${API_ORIGIN}/admin/v1/auth/callback`,
    ADMIN_OIDC_SCOPE: 'openid profile',
    ADMIN_OIDC_GROUP_CLAIM: 'admin_groups',
    ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON: JSON.stringify({ 'test-admins': 'support_viewer' }),
    ADMIN_OIDC_FLOW_PEPPER: 'f'.repeat(40),
    ADMIN_OIDC_SUBJECT_PEPPER: 's'.repeat(40),
    ADMIN_OIDC_GROUP_PEPPER: 'g'.repeat(40),
    ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    ADMIN_SESSION_TOKEN_PEPPER: 't'.repeat(40),
    ADMIN_CSRF_TOKEN_PEPPER: 'c'.repeat(40),
    ADMIN_PII_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    ADMIN_AUDIT_PEPPER: 'a'.repeat(40),
  });
}

function authenticated(): AuthenticatedAdmin {
  const now = new Date('2026-08-19T00:00:00.000Z');
  const expires = new Date('2026-08-19T01:00:00.000Z');
  return {
    principal: {
      identityId: 'admin-identity', sessionId: 'admin-session', displayName: 'Admin',
      roles: ['support_viewer'], permissions: ['admin.overview.read'], authzVersion: 1,
      sessionCreatedAt: now, idleExpiresAt: expires, absoluteExpiresAt: expires, reauthenticatedAt: now,
    },
    session: {
      id: 'admin-session', adminIdentityId: 'admin-identity', tokenHash: 'h'.repeat(128),
      previousTokenHash: null, previousTokenValidUntil: null, csrfTokenHash: 'c'.repeat(128), status: 'active',
      authzVersionAtIssue: 1, permissionDefinitionVersion: 'admin-permissions-v1',
      permissionSnapshotDigest: 'p'.repeat(128), createdAt: now, lastSeenAt: now,
      idleExpiresAt: expires, absoluteExpiresAt: expires, rotatedAt: null, reauthenticatedAt: now,
      revokedAt: null, revocationReasonCode: null, createdIpHash: 'i'.repeat(64), lastIpHash: 'i'.repeat(64),
      userAgentHash: 'u'.repeat(64),
    },
    csrfToken: 'z'.repeat(128),
  };
}

function adminAuthFixture() {
  const service = {
    startLogin: vi.fn(),
    completeLogin: vi.fn(),
    authenticate: vi.fn(async (token: string) => {
      if (token !== SESSION_TOKEN) {
        throw new AppError('ADMIN_AUTHENTICATION_REQUIRED', 401, '需要管理员登录。');
      }
      return authenticated();
    }),
    requireCsrf: vi.fn(),
    logout: vi.fn(),
    recordRejectedCallback: vi.fn(async () => undefined),
    recordSecurityDenial: vi.fn(async () => undefined),
    recordAuthorizedRead: vi.fn(async () => undefined),
    recordFailedRead: vi.fn(async () => undefined),
  };
  return service;
}

function adminP0Fixture() {
  const store = {
    overview: vi.fn(async () => ({
      computeOrders: { total: 1, active: 0 },
      deviceOrders: { total: 2, active: 1 },
      payouts: { total: 3, pending: 1 },
      topups: { total: 4, attentionRequired: 0 },
    })),
    listComputeCreditOrders: vi.fn(),
    listDeviceOrders: vi.fn(),
    listPayouts: vi.fn(),
    listTopups: vi.fn(),
  };
  return { ...store, service: new AdminP0Service(store) };
}

async function enabledFixture() {
  const config = configuredAdminConfig();
  const auth = adminAuthFixture();
  const p0 = adminP0Fixture();
  const settings = adminAuthRuntimeSettings(config);
  expect(settings).not.toBeNull();
  const app = await buildApp({
    config,
    database: null,
    adminAuthService: auth as unknown as AdminAuthService,
    adminAuthSettings: settings!,
    adminP0Service: p0.service,
    logger: false,
  });
  await app.ready();
  return { app, auth, p0 };
}

const sessionCookie = `${ADMIN_SESSION_COOKIE}=${SESSION_TOKEN}`;

describe('buildApp administrator wiring', () => {
  it('does not mount any administrator surface when admin authentication is disabled', async () => {
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), database: null, logger: false });
    for (const path of [
      '/admin/v1/health', '/admin/v1/auth/me', '/admin/v1/dashboard', '/admin/v1/payouts',
    ]) {
      expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    }
    await app.close();
  });

  it('mounts authentication and P0 reads through the configured app integration only', async () => {
    const { app } = await enabledFixture();
    const auth = await app.inject({ method: 'GET', url: '/admin/v1/auth/me', headers: { cookie: sessionCookie } });
    expect(auth.statusCode).toBe(200);
    expect(auth.json()).toMatchObject({ ok: true, admin: { displayName: 'Admin' } });
    const dashboard = await app.inject({ method: 'GET', url: '/admin/v1/dashboard', headers: { cookie: sessionCookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({ ok: true, metrics: { payouts: { total: 3 } }, activity: [] });
    await app.close();
  });

  it('accepts P0 authority only from the fixed session cookie, never bearer or forged permission headers', async () => {
    const { app, auth, p0 } = await enabledFixture();
    const bearerOnly = await app.inject({
      method: 'GET', url: '/admin/v1/dashboard',
      headers: { authorization: 'Bearer forged-mobile-token', 'x-admin-permissions': 'admin.overview.read' },
    });
    expect(bearerOnly.statusCode).toBe(401);
    expect(p0.overview).not.toHaveBeenCalled();

    const forgedPermission = await app.inject({
      method: 'GET', url: '/admin/v1/payouts',
      headers: { cookie: sessionCookie, authorization: 'Bearer forged-mobile-token', 'x-admin-permissions': 'admin.payout.read' },
    });
    expect(forgedPermission.statusCode).toBe(403);
    expect(forgedPermission.json().error.code).toBe('ADMIN_PERMISSION_REQUIRED');
    expect(auth.authenticate).toHaveBeenCalledWith(SESSION_TOKEN, expect.anything(), expect.anything());
    expect(p0.listPayouts).not.toHaveBeenCalled();
    expect(auth.recordSecurityDenial).toHaveBeenCalledWith(
      'permission', 'ADMIN_PERMISSION_REQUIRED', expect.anything(), expect.anything(),
    );
    expect(auth.recordAuthorizedRead).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects foreign origins before session resolution', async () => {
    const { app, auth, p0 } = await enabledFixture();
    const response = await app.inject({
      method: 'GET', url: '/admin/v1/dashboard',
      headers: { cookie: sessionCookie, origin: 'https://attacker.example.test' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ADMIN_ORIGIN_INVALID');
    expect(auth.authenticate).not.toHaveBeenCalled();
    expect(p0.overview).not.toHaveBeenCalled();
    await app.close();
  });

  it('fails closed when an authorized P0-read audit cannot be appended', async () => {
    const { app, auth, p0 } = await enabledFixture();
    auth.recordAuthorizedRead.mockRejectedValueOnce(new Error('audit unavailable'));
    const response = await app.inject({ method: 'GET', url: '/admin/v1/dashboard', headers: { cookie: sessionCookie } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('ADMIN_AUDIT_UNAVAILABLE');
    expect(p0.overview).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('records an authorized P0 query failure without recording a successful read', async () => {
    const { app, auth, p0 } = await enabledFixture();
    p0.overview.mockRejectedValueOnce(new Error('database failure canary'));
    const response = await app.inject({ method: 'GET', url: '/admin/v1/dashboard', headers: { cookie: sessionCookie } });
    expect(response.statusCode).toBe(500);
    expect(auth.recordFailedRead).toHaveBeenCalledWith(
      expect.anything(), 'admin.dashboard.read', 'ADMIN_READ_FAILED', expect.anything(),
    );
    expect(auth.recordAuthorizedRead).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a stale-session conflict without principal, CSRF, or a replacement cookie', async () => {
    const { app, auth } = await enabledFixture();
    auth.authenticate.mockResolvedValueOnce({ ...authenticated(), csrfToken: null, staleSession: true });
    const response = await app.inject({ method: 'GET', url: '/admin/v1/auth/me', headers: { cookie: sessionCookie } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'ADMIN_SESSION_STALE' } });
    expect(response.body).not.toContain('csrfToken');
    expect(response.body).not.toContain('Admin');
    expect(response.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('returns exact credentialed CORS, no-store and fixed security headers for an authorized read', async () => {
    const { app, auth, p0 } = await enabledFixture();
    const response = await app.inject({
      method: 'GET', url: '/admin/v1/dashboard', headers: { cookie: sessionCookie, origin: WEB_ORIGIN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers.vary).toBe('Origin');
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(p0.overview).toHaveBeenCalledTimes(1);
    expect(auth.recordAuthorizedRead).toHaveBeenCalledWith(
      expect.anything(), 'admin.dashboard.read', expect.objectContaining({ requestId: expect.any(String) }),
    );
    await app.close();
  });
});
