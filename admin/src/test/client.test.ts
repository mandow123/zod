import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, __testing, normalizeReturnTo, resolveApiOrigin } from '../api/client';

const me = (csrfToken: string) => ({
  admin: { id: 'admin-1', email: 'admin@example.test', roles: ['operator'], permissions: ['dashboard:read'] },
  session: { createdAt: '2026-08-19T00:00:00.000Z', expiresAt: '2026-08-20T00:00:00.000Z' },
  csrfToken,
});

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installBrowser(fetcher: typeof fetch): void {
  vi.stubGlobal('window', { location: { origin: 'https://admin.example.test' } });
  vi.stubGlobal('fetch', fetcher);
}

afterEach(() => {
  __testing.clearCsrf();
  vi.unstubAllGlobals();
});

describe('admin API configuration', () => {
  it('accepts an HTTPS origin and local development HTTP', () => {
    expect(resolveApiOrigin('https://admin-api.example.test', 'https://admin.example.test')).toBe('https://admin-api.example.test');
    expect(resolveApiOrigin('http://127.0.0.1:4100', 'http://127.0.0.1:4170')).toBe('http://127.0.0.1:4100');
  });

  it('uses the page origin only when the setting is absent or exactly empty', () => {
    expect(resolveApiOrigin(undefined, 'https://admin.example.test')).toBe('https://admin.example.test');
    expect(resolveApiOrigin('', 'https://admin.example.test')).toBe('https://admin.example.test');
  });

  it.each([
    ' http://127.0.0.1:4100',
    'https://user:pass@example.test',
    'https://example.test/admin',
    'https://example.test?tenant=kai',
    'https://example.test/#fragment',
    'http://example.test',
  ])('rejects unsafe API origin %s', (origin) => {
    expect(() => resolveApiOrigin(origin, 'https://admin.example.test')).toThrow(/^ADMIN_API_ORIGIN_/u);
  });
});

describe('login return path', () => {
  it('keeps internal paths including search and hash', () => {
    expect(normalizeReturnTo('/compute-orders?status=pending#list')).toBe('/compute-orders?status=pending#list');
  });

  it.each(['https://evil.example/', '//evil.example/', 'javascript:alert(1)', '/safe\u0000bad'])('rejects unsafe return path %s', (path) => {
    expect(normalizeReturnTo(path)).toBe('/');
  });
});

describe('administrator session refresh', () => {
  it('retries a stale me response once and adopts only the retry CSRF value', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: 'ADMIN_SESSION_STALE' } }, 409))
      .mockResolvedValueOnce(json(me('csrf-after-refresh')))
      .mockResolvedValueOnce(json(null, 204));
    installBrowser(fetcher);

    await expect(adminApi.me()).resolves.toMatchObject({ csrfToken: 'csrf-after-refresh' });
    await adminApi.logout();

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('x-admin-csrf')).toBe('csrf-after-refresh');
  });

  it('does not loop when the retry is also stale', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: 'ADMIN_SESSION_STALE' } }, 409))
      .mockResolvedValueOnce(json({ error: { code: 'ADMIN_SESSION_STALE' } }, 409));
    installBrowser(fetcher);

    await expect(adminApi.me()).rejects.toMatchObject({
      status: 409,
      code: 'ADMIN_SESSION_STALE',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer CSRF value when an older me request later receives 401', async () => {
    let finishOlderRequest: ((response: Response) => void) | undefined;
    const olderResponse = new Promise<Response>((resolve) => { finishOlderRequest = resolve; });
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(olderResponse)
      .mockResolvedValueOnce(json(me('csrf-newer')))
      .mockResolvedValueOnce(json(null, 204));
    installBrowser(fetcher);

    const older = adminApi.me();
    await expect(adminApi.me()).resolves.toMatchObject({ csrfToken: 'csrf-newer' });
    finishOlderRequest?.(json({ error: { code: 'ADMIN_SESSION_EXPIRED' } }, 401));
    await expect(older).rejects.toMatchObject({ status: 401 });
    await adminApi.logout();

    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('x-admin-csrf')).toBe('csrf-newer');
  });

  it('sends only the strict cursor and limit query parameters for P0 lists', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(me('csrf-for-list')))
      .mockResolvedValueOnce(json({ items: [], nextCursor: null }));
    installBrowser(fetcher);

    await adminApi.me();
    await adminApi.computeOrders({ cursor: 'page-2', limit: 50 });

    expect(String(fetcher.mock.calls[1]?.[0])).toBe('https://admin.example.test/admin/v1/compute-orders?cursor=page-2&limit=50');
  });
});
