import { describe, expect, it, vi } from 'vitest';
import { AdminAuthService } from '../src/admin/auth-service.js';
import { PostgresAdminAuditStore, type AdminAuditStore } from '../src/admin/audit-store.js';
import { PostgresAdminIdentityStore } from '../src/admin/identity-store.js';
import { PostgresAdminLoginTransactionStore } from '../src/admin/login-transaction-store.js';
import { PostgresAdminRbacStore } from '../src/admin/rbac-store.js';
import type { AdminAuthRuntimeSettings } from '../src/admin/runtime.js';
import { PostgresAdminSessionStore } from '../src/admin/session-store.js';
import { KAI_OIDC_ISSUER } from '../src/identity/kai-oidc-constants.js';
import { adminFixture } from './admin-test-database.js';

function expectErrorCode(work: () => unknown, code: string) {
  try {
    work();
    throw new Error('expected operation to reject');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

const settings: AdminAuthRuntimeSettings = Object.freeze({
  webOrigin: 'https://admin.example.test',
  apiOrigin: 'https://admin-api.example.test',
  oidcClientId: 'admin-client',
  oidcClientSecret: 'admin-client-secret-unique',
  oidcRedirectUri: 'https://admin-api.example.test/admin/v1/auth/callback',
  oidcScopes: Object.freeze(['email', 'kai_admin', 'openid', 'profile']),
  oidcGroupClaim: 'kai_admin_groups',
  oidcGroupRoleMappings: Object.freeze([
    Object.freeze({ group: 'alpha-support', roleCode: 'support_viewer' as const }),
  ]),
  oidcFlowPepper: 'f'.repeat(40),
  oidcSubjectPepper: 's'.repeat(40),
  oidcGroupPepper: 'g'.repeat(40),
  oidcTransactionEncryptionKey: Buffer.alloc(32, 21).toString('base64'),
  sessionTokenPepper: 't'.repeat(40),
  csrfTokenPepper: 'c'.repeat(40),
  piiEncryptionKey: Buffer.alloc(32, 22).toString('base64'),
  auditPepper: 'a'.repeat(40),
  loginTransactionTtlSeconds: 300,
  sessionIdleTtlSeconds: 1_800,
  sessionAbsoluteTtlSeconds: 28_800,
  sessionRotationSeconds: 900,
  previousTokenGraceSeconds: 10,
  reauthFreshnessSeconds: 300,
});

describe('admin authentication service', () => {
  it('completes OIDC admission, derives CSRF, authorizes each request, logs out, and compensates audit failure',
    { timeout: 120_000 }, async () => {
      const f = await adminFixture();
      const identities = new PostgresAdminIdentityStore(f.database);
      const rbac = new PostgresAdminRbacStore(f.database);
      const sessions = new PostgresAdminSessionStore(f.database, { previousTokenGraceMs: 10_000 });
      const transactions = new PostgresAdminLoginTransactionStore(f.database);
      const audit = new PostgresAdminAuditStore(f.database, settings.auditPepper);
      let nonce = '';
      const oidc = {
        exchange: vi.fn(async () => ({ idToken: 'signed-id-token', accessToken: 'opaque-access-token' })),
        userInfoWithClaims: vi.fn(async () => ({
          profile: { subject: 'raw-admin-subject', displayName: 'Admin Reviewer',
            email: 'admin@example.test', emailVerified: true },
          claims: { kai_admin_groups: ['alpha-support'] },
        })),
      };
      const verifier = {
        verifyWithClaims: vi.fn(async () => ({
          identity: { subject: 'raw-admin-subject', nonce, displayName: 'Admin Reviewer',
            email: 'admin@example.test', emailVerified: true },
          claims: { kai_admin_groups: ['alpha-support'] },
        })),
      };
      const service = new AdminAuthService(identities, rbac, sessions, transactions, audit,
        oidc, verifier, settings);
      const startedAt = new Date('2026-08-19T08:00:00.000Z');
      const requestContext = { requestId: 'external-request-id', ip: '127.0.0.1',
        userAgent: 'admin-browser', now: startedAt };
      const started = await service.startLogin('/compute-orders?status=paid', requestContext);
      const authorization = new URL(started.authorizationUrl);
      nonce = authorization.searchParams.get('nonce')!;
      const completed = await service.completeLogin({
        state: authorization.searchParams.get('state')!,
        code: 'authorization-code',
        issuer: KAI_OIDC_ISSUER,
        providerError: undefined,
        browserBindingToken: started.browserBindingToken,
      }, requestContext);
      expect(completed.returnPath).toBe('/compute-orders?status=paid');
      expect(completed.principal.roles).toEqual(['support_viewer']);
      expect(completed.principal.permissions).toContain('admin.order.read');
      expect(JSON.stringify(completed)).not.toContain('raw-admin-subject');
      expect(JSON.stringify(completed)).not.toContain('alpha-support');

      const authenticated = await service.authenticate(completed.sessionToken, {
        ...requestContext, now: new Date(startedAt.getTime() + 1_000),
      });
      expect(authenticated.csrfToken).toMatch(/^[a-f0-9]{128}$/u);
      expect(() => service.requireCsrf(authenticated, authenticated.csrfToken!)).not.toThrow();
      expectErrorCode(() => service.requireCsrf(authenticated, 'wrong'), 'ADMIN_CSRF_INVALID');
      expect(() => service.requirePermission(authenticated, 'admin.order.read')).not.toThrow();
      expectErrorCode(() => service.requirePermission(authenticated, 'admin.payout.read'), 'ADMIN_PERMISSION_DENIED');
      expect(() => service.requireRecentReauthentication(authenticated, {
        ...requestContext,
        now: new Date(startedAt.getTime() + settings.reauthFreshnessSeconds * 1_000),
      })).not.toThrow();
      expectErrorCode(() => service.requireRecentReauthentication(authenticated, {
        ...requestContext,
        now: new Date(startedAt.getTime() + settings.reauthFreshnessSeconds * 1_000 + 1),
      }), 'ADMIN_REAUTHENTICATION_REQUIRED');
      expectErrorCode(() => service.requireRecentReauthentication({
        ...authenticated,
        principal: { ...authenticated.principal, reauthenticatedAt: null },
      }, requestContext), 'ADMIN_REAUTHENTICATION_REQUIRED');
      const rotationTime = new Date(startedAt.getTime() + settings.sessionRotationSeconds * 1_000 + 1);
      const concurrent = await Promise.all([
        service.authenticate(completed.sessionToken, { ...requestContext, now: rotationTime }),
        service.authenticate(completed.sessionToken, { ...requestContext, now: rotationTime }),
      ]);
      const rotated = concurrent.find((result) => result.rotatedSessionToken);
      const stale = concurrent.find((result) => result.staleSession);
      expect(rotated?.csrfToken).toMatch(/^[a-f0-9]{128}$/u);
      expect(stale?.csrfToken).toBeNull();
      expect(await service.logout(rotated!, false, {
        ...requestContext, now: new Date(rotationTime.getTime() + 1_000),
      })).toBe(1);
      await expect(service.authenticate(completed.sessionToken, {
        ...requestContext, now: new Date(rotationTime.getTime() + 2_000),
      })).rejects.toMatchObject({ code: 'ADMIN_AUTH_REQUIRED' });

      const events = await audit.recent(20);
      expect(events.map((event) => event.action)).toEqual(expect.arrayContaining([
        'admin.auth.login.started', 'admin.auth.login.succeeded', 'admin.auth.logout',
      ]));
      expect(JSON.stringify(events)).not.toContain('raw-admin-subject');
      expect(JSON.stringify(events)).not.toContain('alpha-support');
      expect(events.every((event) => event.requestId !== requestContext.requestId)).toBe(true);

      const failingAudit: AdminAuditStore = {
        append: async (input) => {
          if (input.action === 'admin.auth.login.succeeded') throw new Error('audit unavailable');
          return audit.append(input);
        },
        recent: (limit) => audit.recent(limit),
        forTarget: (targetType, targetId, limit) => audit.forTarget(targetType, targetId, limit),
      };
      const failClosed = new AdminAuthService(identities, rbac, sessions, transactions, failingAudit,
        oidc, verifier, settings);
      const secondTime = new Date(rotationTime.getTime() + 10_000);
      const second = await failClosed.startLogin('/', { ...requestContext, now: secondTime });
      const secondAuthorization = new URL(second.authorizationUrl);
      nonce = secondAuthorization.searchParams.get('nonce')!;
      await expect(failClosed.completeLogin({
        state: secondAuthorization.searchParams.get('state')!, code: 'authorization-code-2',
        issuer: KAI_OIDC_ISSUER, providerError: undefined,
        browserBindingToken: second.browserBindingToken,
      }, { ...requestContext, now: secondTime })).rejects.toMatchObject({ code: 'ADMIN_AUDIT_UNAVAILABLE' });
      const active = await f.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM admin_sessions WHERE status='active'`,
      );
      expect(active.rows[0]?.count).toBe('0');
      await f.database.close();
    });

  it('admits an exact verified-email allowlist without requiring a provider-specific Group claim',
    { timeout: 120_000 }, async () => {
      const f = await adminFixture();
      const emailSettings: AdminAuthRuntimeSettings = Object.freeze({
        ...settings,
        oidcGroupClaim: 'email',
        oidcScopes: Object.freeze(['email', 'openid', 'profile']),
        oidcGroupRoleMappings: Object.freeze([
          Object.freeze({ group: 'admin@example.test', roleCode: 'super_admin' as const }),
        ]),
      });
      const identities = new PostgresAdminIdentityStore(f.database);
      const rbac = new PostgresAdminRbacStore(f.database);
      const sessions = new PostgresAdminSessionStore(f.database, { previousTokenGraceMs: 10_000 });
      const transactions = new PostgresAdminLoginTransactionStore(f.database);
      const audit = new PostgresAdminAuditStore(f.database, emailSettings.auditPepper);
      let nonce = '';
      const verifiedProfile = {
        subject: 'raw-email-admin-subject', displayName: 'Email Administrator',
        email: 'admin@example.test', emailVerified: true,
      } as const;
      const oidc = {
        exchange: vi.fn(async () => ({ idToken: 'signed-id-token', accessToken: 'opaque-access-token' })),
        userInfoWithClaims: vi.fn(async () => ({
          profile: verifiedProfile,
          claims: { email: 'admin@example.test', email_verified: true },
        })),
      };
      const verifier = {
        verifyWithClaims: vi.fn(async () => ({
          identity: { ...verifiedProfile, nonce },
          claims: { email: 'admin@example.test', email_verified: true },
        })),
      };
      const service = new AdminAuthService(identities, rbac, sessions, transactions, audit,
        oidc, verifier, emailSettings);
      const context = { requestId: 'email-allowlist-request', ip: '127.0.0.1',
        userAgent: 'admin-browser', now: new Date('2026-08-20T10:00:00.000Z') };
      const started = await service.startLogin('/', context);
      const authorization = new URL(started.authorizationUrl);
      nonce = authorization.searchParams.get('nonce')!;
      const completed = await service.completeLogin({
        state: authorization.searchParams.get('state')!,
        code: 'email-allowlist-code',
        issuer: KAI_OIDC_ISSUER,
        providerError: undefined,
        browserBindingToken: started.browserBindingToken,
      }, context);
      expect(completed.principal.roles).toEqual(['super_admin']);
      expect(JSON.stringify(completed)).not.toContain('admin@example.test');
      expect(JSON.stringify(await audit.recent(20))).not.toContain('admin@example.test');
      await f.database.close();
    });
});
