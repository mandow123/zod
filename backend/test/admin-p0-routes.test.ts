import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AppError, installErrorHandling } from '../src/errors.js';
import { registerAdminP0Routes } from '../src/admin/p0-routes.js';
import { AdminP0Service, type AdminP0Principal } from '../src/admin/p0-service.js';
import type { AdminP0Store } from '../src/admin/p0-store.js';
import type { AdminAuthRuntimeSettings } from '../src/admin/runtime.js';

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

const ID_1 = '10000000-0000-4000-8000-000000000001';
const ID_2 = '10000000-0000-4000-8000-000000000002';
const BASE_PERMISSIONS = [
  'admin.overview.read',
  'admin.order.read',
  'admin.device-order.read',
  'admin.payout.read',
  'admin.topup.read',
] as const;

function storeFixture(): AdminP0Store {
  return {
    overview: vi.fn(async () => ({
      computeOrders: { total: 1, active: 1 },
      deviceOrders: { total: 1, active: 1 },
      payouts: { total: 1, pending: 1 },
      topups: { total: 1, attentionRequired: 1 },
    })),
    listComputeCreditOrders: vi.fn(async () => [{
      id: ID_1, orderNumber: 'COMPUTE-0001', status: 'ready', quantity: '1.000000', capacityUnit: 'GPU_HOUR',
      totalCreditMicros: '1000000', createdAt: new Date('2026-08-19T01:00:00.000Z'),
      updatedAt: new Date('2026-08-19T01:30:00.000Z'),
    }]),
    listDeviceOrders: vi.fn(async () => [{
      id: ID_1, orderNumber: 'DEVICE-0001', status: 'shipping', quantity: 1, grossCreditMicros: '2000000',
      createdAt: new Date('2026-08-19T02:00:00.000Z'), updatedAt: new Date('2026-08-19T02:30:00.000Z'),
    }]),
    listPayouts: vi.fn(async () => [{
      id: ID_1, payoutNumber: 'PAYOUT-000001', status: 'submitted', creditMicros: '3000000',
      paymentAmountCents: '300', createdAt: new Date('2026-08-19T03:00:00.000Z'),
      updatedAt: new Date('2026-08-19T03:30:00.000Z'),
    }]),
    listTopups: vi.fn(async () => [{
      id: ID_1, provider: 'alipay', status: 'manual_review', amountCents: '400', currency: 'CNY',
      creditMicros: '4000000', reversedAmountCents: '0', reversedCreditMicros: '0',
      createdAt: new Date('2026-08-19T04:00:00.000Z'), updatedAt: new Date('2026-08-19T04:30:00.000Z'),
    }]),
  };
}

async function fixture(permissions: readonly string[] = BASE_PERMISSIONS) {
  const app = Fastify();
  installErrorHandling(app);
  const store = storeFixture();
  const service = new AdminP0Service(store);
  const principal: AdminP0Principal = { permissions };
  const recordSucceeded = vi.fn(async () => undefined);
  const recordDenied = vi.fn(async () => undefined);
  const recordFailed = vi.fn(async () => undefined);
  const recordOriginDenial = vi.fn(async () => undefined);
  const resolvePrincipal = vi.fn(async () => ({
    principal, recordSucceeded, recordDenied, recordFailed,
  }));
  await registerAdminP0Routes(app, service, resolvePrincipal, settings, recordOriginDenial);
  return { app, store, resolvePrincipal, recordSucceeded, recordDenied, recordFailed, recordOriginDenial };
}

describe('admin P0 read routes', () => {
  it('returns dashboard metrics and permission-filtered activity in stable newest-first order', async () => {
    const { app, store, resolvePrincipal } = await fixture();
    const response = await app.inject({ method: 'GET', url: '/admin/v1/dashboard' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.json()).toEqual({
      ok: true,
      metrics: {
        computeOrders: { total: 1, active: 1 }, deviceOrders: { total: 1, active: 1 },
        payouts: { total: 1, pending: 1 }, topups: { total: 1, attentionRequired: 1 },
      },
      activity: [
        { resource: 'topup', id: ID_1, displayId: ID_1, status: 'manual_review', occurredAt: '2026-08-19T04:00:00.000Z' },
        { resource: 'payout', id: ID_1, displayId: 'PAYOUT-000001', status: 'submitted', occurredAt: '2026-08-19T03:00:00.000Z' },
        { resource: 'device-order', id: ID_1, displayId: 'DEVICE-0001', status: 'shipping', occurredAt: '2026-08-19T02:00:00.000Z' },
        { resource: 'compute-order', id: ID_1, displayId: 'COMPUTE-0001', status: 'ready', occurredAt: '2026-08-19T01:00:00.000Z' },
      ],
    });
    expect(resolvePrincipal).toHaveBeenCalledTimes(1);
    expect(resolvePrincipal).toHaveBeenCalledWith('admin.dashboard.read', expect.anything(), expect.anything());
    expect(store.listComputeCreditOrders).toHaveBeenCalledWith({ limit: 6, cursor: null });
    expect(store.listDeviceOrders).toHaveBeenCalledWith({ limit: 6, cursor: null });
    expect(store.listPayouts).toHaveBeenCalledWith({ limit: 6, cursor: null });
    expect(store.listTopups).toHaveBeenCalledWith({ limit: 6, cursor: null });
    await app.close();
  });

  it('does not query activity resources the principal cannot read', async () => {
    const { app, store } = await fixture(['admin.overview.read']);
    const response = await app.inject({ method: 'GET', url: '/admin/v1/dashboard' });

    expect(response.statusCode).toBe(200);
    expect(response.json().activity).toEqual([]);
    expect(store.listComputeCreditOrders).not.toHaveBeenCalled();
    expect(store.listDeviceOrders).not.toHaveBeenCalled();
    expect(store.listPayouts).not.toHaveBeenCalled();
    expect(store.listTopups).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['/admin/v1/compute-orders', 'listComputeCreditOrders', 'COMPUTE-0001'],
    ['/admin/v1/device-orders', 'listDeviceOrders', 'DEVICE-0001'],
    ['/admin/v1/payouts', 'listPayouts', 'PAYOUT-000001'],
    ['/admin/v1/topups', 'listTopups', ID_1],
  ] as const)('returns uniform list envelope for %s', async (url, method, displayId) => {
    const { app, store, resolvePrincipal } = await fixture();
    const response = await app.inject({ method: 'GET', url: `${url}?limit=2` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.json()).toMatchObject({ ok: true, items: [{ id: ID_1 }], nextCursor: null });
    expect(response.body).toContain(displayId);
    expect(store[method]).toHaveBeenCalledWith({ limit: 3, cursor: null });
    expect(resolvePrincipal).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('passes only a validated canonical cursor and limit to the service', async () => {
    const { app, store } = await fixture();
    vi.mocked(store.listPayouts).mockResolvedValueOnce([
      { id: ID_2, payoutNumber: 'PAYOUT-000002', status: 'reviewing', creditMicros: '4000000', paymentAmountCents: '400',
        createdAt: new Date('2026-08-19T05:00:00.000Z'), updatedAt: new Date('2026-08-19T05:30:00.000Z') },
      { id: ID_1, payoutNumber: 'PAYOUT-000001', status: 'submitted', creditMicros: '3000000', paymentAmountCents: '300',
        createdAt: new Date('2026-08-19T03:00:00.000Z'), updatedAt: new Date('2026-08-19T03:30:00.000Z') },
    ]);
    const first = await app.inject({ method: 'GET', url: '/admin/v1/payouts?limit=1' });
    const cursor = first.json().nextCursor as string;
    expect(cursor).toEqual(expect.any(String));

    vi.mocked(store.listPayouts).mockResolvedValueOnce([]);
    const second = await app.inject({ method: 'GET', url: `/admin/v1/payouts?limit=1&cursor=${cursor}` });
    expect(second.statusCode).toBe(200);
    expect(store.listPayouts).toHaveBeenLastCalledWith({
      limit: 2,
      cursor: { createdAt: new Date('2026-08-19T05:00:00.000Z'), id: ID_2 },
    });
    await app.close();
  });

  it.each([
    '/admin/v1/payouts?unknown=1',
    '/admin/v1/payouts?limit=0',
    '/admin/v1/payouts?limit=01',
    '/admin/v1/payouts?limit=1e2',
    '/admin/v1/payouts?limit=%201',
    '/admin/v1/payouts?limit=1&limit=2',
    '/admin/v1/payouts?cursor=not%21base64',
    '/admin/v1/dashboard?limit=1',
  ])('rejects non-canonical or unknown query input before principal resolution: %s', async (url) => {
    const { app, store, resolvePrincipal } = await fixture();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.json().error.code).toBe('ADMIN_REQUEST_INVALID');
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(store.listPayouts).not.toHaveBeenCalled();
    await app.close();
  });

  it('ignores forged identity and permission headers because principal comes only from the resolver', async () => {
    const { app, store, resolvePrincipal, recordSucceeded, recordDenied } = await fixture(['admin.overview.read']);
    const response = await app.inject({
      method: 'GET', url: '/admin/v1/payouts',
      headers: { authorization: 'Bearer forged-mobile-token', 'x-admin-permissions': 'admin.payout.read' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ADMIN_PERMISSION_REQUIRED');
    expect(resolvePrincipal).toHaveBeenCalledTimes(1);
    expect(store.listPayouts).not.toHaveBeenCalled();
    expect(recordDenied).toHaveBeenCalledWith('ADMIN_PERMISSION_REQUIRED');
    expect(recordSucceeded).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a foreign Origin and returns credentialed CORS only to the configured admin web origin', async () => {
    const { app, resolvePrincipal, recordOriginDenial } = await fixture();
    const rejected = await app.inject({
      method: 'GET', url: '/admin/v1/dashboard', headers: { origin: 'https://attacker.example.test' },
    });
    expect(rejected.statusCode).toBe(403);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(recordOriginDenial).toHaveBeenCalledWith(expect.anything(), 'ADMIN_ORIGIN_INVALID');
    const accepted = await app.inject({
      method: 'GET', url: '/admin/v1/dashboard', headers: { origin: settings.webOrigin },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers['access-control-allow-origin']).toBe(settings.webOrigin);
    expect(accepted.headers['access-control-allow-credentials']).toBe('true');
    expect(accepted.headers['content-security-policy']).toContain("default-src 'none'");
    await app.close();
  });

  it('records a failed outcome only after an authorized query fails', async () => {
    const { app, store, recordSucceeded, recordDenied, recordFailed } = await fixture();
    vi.mocked(store.listPayouts).mockRejectedValueOnce(new Error('database canary must not enter audit'));
    const response = await app.inject({ method: 'GET', url: '/admin/v1/payouts' });
    expect(response.statusCode).toBe(500);
    expect(recordFailed).toHaveBeenCalledWith('ADMIN_READ_FAILED');
    expect(recordDenied).not.toHaveBeenCalled();
    expect(recordSucceeded).not.toHaveBeenCalled();
    await app.close();
  });

  it('records a semantic client cursor error as denied without poisoning operation failures', async () => {
    const { app, store, recordSucceeded, recordDenied, recordFailed } = await fixture();
    const response = await app.inject({ method: 'GET', url: '/admin/v1/payouts?cursor=e30' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('ADMIN_PAGINATION_CURSOR_INVALID');
    expect(store.listPayouts).not.toHaveBeenCalled();
    expect(recordDenied).toHaveBeenCalledWith('ADMIN_PAGINATION_CURSOR_INVALID');
    expect(recordFailed).not.toHaveBeenCalled();
    expect(recordSucceeded).not.toHaveBeenCalled();
    await app.close();
  });

  it('fails closed when the injected server-side principal resolver rejects authentication', async () => {
    const app = Fastify();
    installErrorHandling(app);
    const store = storeFixture();
    const resolvePrincipal = vi.fn(async () => {
      throw new AppError('ADMIN_AUTHENTICATION_REQUIRED', 401, '需要管理员登录。');
    });
    await registerAdminP0Routes(app, new AdminP0Service(store), resolvePrincipal, settings, async () => undefined);

    const response = await app.inject({ method: 'GET', url: '/admin/v1/topups' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('ADMIN_AUTHENTICATION_REQUIRED');
    expect(store.listTopups).not.toHaveBeenCalled();
    await app.close();
  });

  it('registers only GET endpoints under the admin API prefix', async () => {
    const { app } = await fixture();
    expect((await app.inject({ method: 'GET', url: '/payouts' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/admin/v1/payouts' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/admin/v1/refunds' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/admin/v1/vast' })).statusCode).toBe(404);
    await app.close();
  });
});
