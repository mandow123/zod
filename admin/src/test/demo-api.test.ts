import { describe, expect, it } from 'vitest';
import {
  handleAdminDemoRequest,
  type DemoRequest,
  type DemoResponse,
} from '../../demo-api.mjs';

class ResponseCapture implements DemoResponse {
  statusCode = 200;
  readonly headers = new Map<string, string>();
  body = '';

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  end(body = ''): void {
    this.body = body;
  }

  json(): unknown {
    return JSON.parse(this.body) as unknown;
  }
}

function invoke(method: string, url: string, headers: DemoRequest['headers'] = {}) {
  const response = new ResponseCapture();
  let nextCalled = false;
  handleAdminDemoRequest({ method, url, headers }, response, () => { nextCalled = true; });
  return { response, nextCalled };
}

describe('local administrator demo API', () => {
  it('passes non-admin requests to Vite', () => {
    const result = invoke('GET', '/src/main.tsx');
    expect(result.nextCalled).toBe(true);
    expect(result.response.body).toBe('');
  });

  it('provides a complete synthetic administrator session', () => {
    const { response } = invoke('GET', '/admin/v1/auth/me');
    const body = response.json() as {
      admin: { displayName: string; roles: string[]; permissions: string[] };
      session: { absoluteExpiresAt: string };
      csrfToken: string;
    };

    expect(response.statusCode).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.admin.displayName).toBe('本地演示管理员');
    expect(body.admin.roles).toContain('support_viewer');
    expect(body.admin.permissions).toEqual(expect.arrayContaining([
      'admin.overview.read', 'admin.order.read', 'admin.device-order.read',
      'admin.payout.read', 'admin.topup.read',
    ]));
    expect(body.session.absoluteExpiresAt).toBeTruthy();
    expect(body.csrfToken).toBeTruthy();
  });

  it('provides dashboard metrics and every supported list', () => {
    const dashboard = invoke('GET', '/admin/v1/dashboard').response.json() as {
      metrics: Record<string, { total: number }>;
      activity: unknown[];
    };
    expect(dashboard.metrics.computeOrders?.total).toBeGreaterThan(0);
    expect(dashboard.metrics.deviceOrders?.total).toBeGreaterThan(0);
    expect(dashboard.metrics.payouts?.total).toBeGreaterThan(0);
    expect(dashboard.metrics.topups?.total).toBeGreaterThan(0);
    expect(dashboard.activity.length).toBeGreaterThan(0);

    for (const path of ['compute-orders', 'device-orders', 'payouts', 'topups']) {
      const body = invoke('GET', `/admin/v1/${path}`).response.json() as { items: unknown[]; nextCursor: null };
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.nextCursor).toBeNull();
    }
  });

  it('requires the demo CSRF token for logout', () => {
    const denied = invoke('POST', '/admin/v1/auth/logout');
    expect(denied.response.statusCode).toBe(403);
    expect(denied.response.json()).toEqual({ error: { code: 'ADMIN_CSRF_INVALID' } });

    const session = invoke('GET', '/admin/v1/auth/me').response.json() as { csrfToken: string };
    const allowed = invoke('POST', '/admin/v1/auth/logout', { 'x-admin-csrf': session.csrfToken });
    expect(allowed.response.statusCode).toBe(204);
    expect(allowed.response.body).toBe('');
  });

  it('normalizes login return targets', () => {
    const safe = invoke('GET', '/admin/v1/auth/login?returnTo=%2Fpayouts%3Fpage%3D1');
    expect(safe.response.statusCode).toBe(302);
    expect(safe.response.headers.get('location')).toBe('/payouts?page=1');

    const unsafe = invoke('GET', '/admin/v1/auth/login?returnTo=%2F%2Fevil.example');
    expect(unsafe.response.headers.get('location')).toBe('/');
  });

  it('returns stable JSON for unsupported administrator routes', () => {
    const { response } = invoke('GET', '/admin/v1/unknown');
    expect(response.statusCode).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.json()).toEqual({ error: { code: 'ADMIN_DEMO_ROUTE_NOT_FOUND' } });
  });
});
