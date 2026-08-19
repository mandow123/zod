import {
  adaptComputeOrders,
  adaptDashboard,
  adaptDeviceOrders,
  adaptMe,
  adaptPayouts,
  adaptTopups,
} from './adapters';
import type { ListQuery } from './contracts';

const JSON_CONTENT_TYPE = 'application/json';
let csrfToken: string | null = null;
let meRequestVersion = 0;
const unauthorizedListeners = new Set<() => void>();

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = '管理员服务暂时不可用') {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function resolveApiOrigin(configured: string | undefined, pageOrigin: string): string {
  const raw = configured === undefined || configured === '' ? pageOrigin : configured;
  if (raw !== raw.trim()) throw new Error('ADMIN_API_ORIGIN_INVALID');
  const url = new URL(raw);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ADMIN_API_ORIGIN_INVALID');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new Error('ADMIN_API_ORIGIN_INSECURE');
  }
  return url.origin;
}

export function normalizeReturnTo(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f\u007f]/u.test(value)) return '/';
  try {
    const parsed = new URL(value, 'https://admin.invalid');
    return parsed.origin === 'https://admin.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/';
  } catch {
    return '/';
  }
}

function getApiOrigin(): string {
  return resolveApiOrigin(import.meta.env.VITE_ADMIN_API_ORIGIN, window.location.origin);
}

function invalidateCsrf(): void {
  csrfToken = null;
  meRequestVersion += 1;
}

function notifyUnauthorized(): void {
  invalidateCsrf();
  for (const listener of unauthorizedListeners) listener();
}

type RequestOptions = Readonly<{
  canInvalidateCsrf?: () => boolean;
}>;

async function request(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<unknown> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('accept', JSON_CONTENT_TYPE);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', JSON_CONTENT_TYPE);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!csrfToken) throw new AdminApiError(403, 'ADMIN_CSRF_UNAVAILABLE', '安全凭据已失效，请重新登录');
    headers.set('x-admin-csrf', csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(new URL(path, getApiOrigin()), {
      ...init,
      method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
    });
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    throw new AdminApiError(0, 'ADMIN_NETWORK_ERROR', '无法连接管理员服务');
  }

  if (response.status === 401 && (options.canInvalidateCsrf?.() ?? true)) notifyUnauthorized();
  if (!response.ok) {
    let code = `ADMIN_HTTP_${response.status}`;
    try {
      const body = await response.json() as { error?: { code?: unknown }; code?: unknown };
      const candidate = body.error?.code ?? body.code;
      if (typeof candidate === 'string' && /^[A-Z0-9_]{1,80}$/u.test(candidate)) code = candidate;
    } catch {
      // Error bodies are intentionally optional and never surfaced verbatim.
    }
    throw new AdminApiError(response.status, code, response.status === 403 ? '当前账号没有此操作权限' : undefined);
  }

  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes(JSON_CONTENT_TYPE)) {
    throw new AdminApiError(502, 'ADMIN_RESPONSE_INVALID');
  }
  return response.json();
}

function queryString(query: ListQuery): string {
  const search = new URLSearchParams();
  if (query.cursor) search.set('cursor', query.cursor);
  if (query.limit) search.set('limit', String(query.limit));
  const value = search.toString();
  return value ? `?${value}` : '';
}

function isStaleSession(error: unknown): error is AdminApiError {
  return error instanceof AdminApiError && error.status === 409 && error.code === 'ADMIN_SESSION_STALE';
}

export const adminApi = Object.freeze({
  login(returnTo: string): never {
    const url = new URL('/admin/v1/auth/login', getApiOrigin());
    url.searchParams.set('returnTo', normalizeReturnTo(returnTo));
    window.location.assign(url);
    throw new Error('ADMIN_NAVIGATION_STARTED');
  },

  async me() {
    const requestVersion = meRequestVersion + 1;
    meRequestVersion = requestVersion;
    const isCurrentRequest = () => meRequestVersion === requestVersion;
    const fetchMe = () => request('/admin/v1/auth/me', {}, { canInvalidateCsrf: isCurrentRequest });

    try {
      const me = adaptMe(await fetchMe());
      if (isCurrentRequest()) csrfToken = me.csrfToken;
      return me;
    } catch (error) {
      if (!isStaleSession(error) || !isCurrentRequest()) throw error;
      const me = adaptMe(await fetchMe());
      if (isCurrentRequest()) csrfToken = me.csrfToken;
      return me;
    }
  },

  async logout() {
    await request('/admin/v1/auth/logout', { method: 'POST' });
    invalidateCsrf();
  },

  async dashboard(signal?: AbortSignal) {
    return adaptDashboard(await request('/admin/v1/dashboard', signal ? { signal } : {}));
  },

  async computeOrders(query: ListQuery, signal?: AbortSignal) {
    return adaptComputeOrders(await request(`/admin/v1/compute-orders${queryString(query)}`, signal ? { signal } : {}));
  },

  async deviceOrders(query: ListQuery, signal?: AbortSignal) {
    return adaptDeviceOrders(await request(`/admin/v1/device-orders${queryString(query)}`, signal ? { signal } : {}));
  },

  async payouts(query: ListQuery, signal?: AbortSignal) {
    return adaptPayouts(await request(`/admin/v1/payouts${queryString(query)}`, signal ? { signal } : {}));
  },

  async topups(query: ListQuery, signal?: AbortSignal) {
    return adaptTopups(await request(`/admin/v1/topups${queryString(query)}`, signal ? { signal } : {}));
  },

  onUnauthorized(listener: () => void) {
    unauthorizedListeners.add(listener);
    return () => { unauthorizedListeners.delete(listener); };
  },
});

export const __testing = Object.freeze({
  clearCsrf: invalidateCsrf,
});
