import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseAdminRoutingArguments,
  verifyAdminRouting,
  writeImmutableAdminRoutingReport,
  type AdminAuthState,
} from '../deploy/kubernetes/verify-admin-routing.mjs';

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const securityHeaders = {
  'cache-control': 'no-store, max-age=0',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'x-frame-options': 'DENY',
};
const adminHtml = '<!doctype html><title>KAI 管理控制台</title><div id="root"></div><!-- DISTINCTIVE_RESPONSE_SECRET -->';

function backendError(status: number, code: string) {
  return new Response(JSON.stringify({
    ok: false,
    error: { code, message: 'DISTINCTIVE_PRIVATE_MESSAGE', requestId: 'request-fixture' },
    token: 'DISTINCTIVE_PRIVATE_TOKEN',
  }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function fixtureFetch(authState: AdminAuthState, options: { missingHeader?: boolean; apiScopeTakeover?: boolean } = {}) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === 'admin.kai.com') {
      const headers = { ...securityHeaders };
      if (options.missingHeader) delete (headers as Partial<typeof securityHeaders>)['x-frame-options'];
      if (url.pathname === '/healthz') return new Response('ok\n', { status: 200, headers: { ...headers, 'content-type': 'text/plain' } });
      return new Response(adminHtml, { status: 200, headers: { ...headers, 'content-type': 'text/html' } });
    }
    if (url.pathname === '/admin/v1/auth/me') {
      return authState === 'disabled' ? backendError(404, 'NOT_FOUND') : backendError(401, 'ADMIN_AUTH_REQUIRED');
    }
    if (options.apiScopeTakeover && url.pathname === '/mobile/v1/health') {
      return new Response(JSON.stringify({ ok: true, service: 'kai-cloudpay-backend', token: 'DISTINCTIVE_PRIVATE_TOKEN' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found DISTINCTIVE_RESPONSE_SECRET', { status: 404, headers: { 'content-type': 'text/plain' } });
  };
}

describe('administrator Kubernetes route canary', () => {
  it.each(['disabled', 'enabled'] as const)('keeps exact administrator routes when auth is %s', async (authState) => {
    const report = await verifyAdminRouting({
      webOrigin: 'https://admin.kai.com',
      apiOrigin: 'https://admin-api.kai.com',
      authState,
      fetchImplementation: fixtureFetch(authState),
    });

    expect(report.ok).toBe(true);
    expect(report.decision).toBe('keep_admin_routes');
    expect(report.rollback).toBeNull();
    expect(report.failures).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/DISTINCTIVE_|cookie|token|query/iu);
  });

  it('fails closed with a rollback limited to the two administrator ingresses', async () => {
    const report = await verifyAdminRouting({
      webOrigin: 'https://admin.kai.com/',
      apiOrigin: 'https://admin-api.kai.com/',
      authState: 'enabled',
      fetchImplementation: fixtureFetch('enabled', { missingHeader: true, apiScopeTakeover: true }),
    });

    expect(report.ok).toBe(false);
    expect(report.decision).toBe('remove_admin_routes');
    expect(report.rollback).toEqual({
      removeOnly: ['ingress/cloudpay-admin-web', 'ingress/cloudpay-admin-api'],
      preserve: ['ingress/cloudpay-mobile-api', 'deployment/cloudpay-backend', 'database migrations', 'admin audit data'],
      reason: expect.any(String),
    });
    expect(report.failures).toEqual(expect.arrayContaining([
      'admin_web_root_security_headers',
      'admin_web_health_security_headers',
      'admin_api_scope__mobile_v1_health',
    ]));
  });

  it('fails closed when the staged canary transition contract is missing', async () => {
    const report = await verifyAdminRouting({
      webOrigin: 'https://admin.kai.com',
      apiOrigin: 'https://admin-api.kai.com',
      authState: 'enabled',
      fetchImplementation: fixtureFetch('enabled'),
      routingContract: {
        schemaVersion: 1,
        web: {
          host: 'admin.kai.com', path: '/', pathType: 'Prefix',
          service: 'cloudpay-admin-web', tlsSecret: 'cloudpay-admin-kai-com-tls',
        },
        api: {
          host: 'admin-api.kai.com', path: '/admin/v1', pathType: 'Prefix',
          service: 'cloudpay-backend', tlsSecret: 'cloudpay-admin-api-kai-com-tls',
        },
        rollback: {
          removeOnly: ['ingress/cloudpay-admin-web', 'ingress/cloudpay-admin-api'],
          preserve: ['ingress/cloudpay-mobile-api', 'deployment/cloudpay-backend', 'database migrations', 'admin audit data'],
        },
      },
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toContain('routing_contract_exact');
    expect(report.decision).toBe('remove_admin_routes');
  });

  it('requires exact HTTPS origins and an explicit rollout state and report path', async () => {
    expect(parseAdminRoutingArguments([
      '--web-origin', 'https://admin.kai.com', '--api-origin', 'https://admin-api.kai.com',
      '--auth-state', 'disabled', '--report', '/tmp/report.json',
    ])).toMatchObject({ 'auth-state': 'disabled', report: '/tmp/report.json' });
    expect(() => parseAdminRoutingArguments(['--auth-state', 'unknown'])).toThrow();
    expect(() => parseAdminRoutingArguments([
      '--web-origin', 'https://admin.kai.com', '--api-origin', 'https://admin-api.kai.com',
      '--auth-state', 'disabled', '--report', 'relative-report.json',
    ])).toThrow('--report must be an absolute path');
    await expect(verifyAdminRouting({
      webOrigin: 'http://admin.kai.com',
      apiOrigin: 'https://admin-api.kai.com',
      authState: 'disabled',
      fetchImplementation: fixtureFetch('disabled'),
    })).rejects.toThrow('canonical HTTPS origin');
  });

  it('creates a private report exactly once without storing response bodies', async () => {
    const report = await verifyAdminRouting({
      webOrigin: 'https://admin.kai.com',
      apiOrigin: 'https://admin-api.kai.com',
      authState: 'disabled',
      fetchImplementation: fixtureFetch('disabled'),
    });
    const directory = await mkdtemp(join(tmpdir(), 'admin-routing-report-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'report.json');

    await expect(writeImmutableAdminRoutingReport('relative-report.json', report))
      .rejects.toThrow('report path must be absolute');
    await writeImmutableAdminRoutingReport(path, report);
    const original = await readFile(path, 'utf8');
    await expect(writeImmutableAdminRoutingReport(path, { ...report, decision: 'remove_admin_routes' }))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(original).not.toMatch(/DISTINCTIVE_|PRIVATE_MESSAGE|PRIVATE_TOKEN|RESPONSE_SECRET/iu);
  });
});
