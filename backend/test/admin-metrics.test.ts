import { describe, expect, it, vi } from 'vitest';
import { AdminAuthService } from '../src/admin/auth-service.js';
import type { AdminAuditStore } from '../src/admin/audit-store.js';
import type { AdminIdentityStore } from '../src/admin/identity-store.js';
import type { AdminLoginTransactionStore } from '../src/admin/login-transaction-store.js';
import { AdminProcessMetrics } from '../src/admin/metrics.js';
import type { AdminRbacStore } from '../src/admin/rbac-store.js';
import type { AdminAuthRuntimeSettings } from '../src/admin/runtime.js';
import type { AdminSessionStore } from '../src/admin/session-store.js';

const settings: AdminAuthRuntimeSettings = Object.freeze({
  webOrigin: 'https://admin.example.test',
  apiOrigin: 'https://admin-api.example.test',
  oidcClientId: 'admin-client',
  oidcClientSecret: 'admin-client-secret-unique',
  oidcRedirectUri: 'https://admin-api.example.test/admin/v1/auth/callback',
  oidcScopes: Object.freeze(['openid', 'email']),
  oidcGroupClaim: 'email',
  oidcGroupRoleMappings: Object.freeze([
    Object.freeze({ group: 'admin@example.test', roleCode: 'support_viewer' as const }),
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

describe('administrator process metrics', () => {
  it('increments the unlabeled counter only when an audit append throws', async () => {
    const metrics = new AdminProcessMetrics();
    const transactions = {
      create: vi.fn(async () => undefined),
    } as unknown as AdminLoginTransactionStore;
    const audit = {
      append: vi.fn(async () => { throw new Error('audit sink unavailable with sensitive detail'); }),
    } as unknown as AdminAuditStore;
    const service = new AdminAuthService(
      {} as AdminIdentityStore,
      {} as AdminRbacStore,
      {} as AdminSessionStore,
      transactions,
      audit,
      { exchange: vi.fn(), userInfoWithClaims: vi.fn() },
      { verifyWithClaims: vi.fn() },
      settings,
      metrics,
    );

    await expect(service.startLogin('/', {
      requestId: 'request-that-must-not-be-a-label',
      ip: '192.0.2.10',
      userAgent: 'sensitive-browser-description',
      now: new Date('2026-08-20T00:00:00.000Z'),
    })).rejects.toThrow('audit sink unavailable');

    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot()).toEqual({ auditAppendFailuresTotal: 1, http5xxTotal: 0 });
    expect(Object.keys(metrics.snapshot())).toEqual(['auditAppendFailuresTotal', 'http5xxTotal']);
  });
});
