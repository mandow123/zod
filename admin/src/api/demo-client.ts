import {
  adaptComputeOrders,
  adaptDashboard,
  adaptDeviceOrders,
  adaptMe,
  adaptPayouts,
  adaptTopups,
} from './adapters';
import type { ListQuery } from './contracts';
import { handleAdminDemoRequest, type DemoRequest, type DemoResponse } from '../../demo-api.mjs';

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = '管理员演示服务暂时不可用') {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

type DemoResult = Readonly<{ status: number; body: unknown }>;

function invoke(method: string, url: string, headers: DemoRequest['headers'] = {}): DemoResult {
  let statusCode = 200;
  let body = '';
  let nextCalled = false;
  const response: DemoResponse = {
    get statusCode() { return statusCode; },
    set statusCode(value: number) { statusCode = value; },
    setHeader() {},
    end(value = '') { body = value; },
  };

  handleAdminDemoRequest({ method, url, headers }, response, () => { nextCalled = true; });
  if (nextCalled || statusCode >= 400) {
    throw new AdminApiError(statusCode, 'ADMIN_DEMO_REQUEST_FAILED');
  }
  return { status: statusCode, body: body ? JSON.parse(body) as unknown : null };
}

function queryString(query: ListQuery): string {
  const search = new URLSearchParams();
  if (query.cursor) search.set('cursor', query.cursor);
  if (query.limit) search.set('limit', String(query.limit));
  const value = search.toString();
  return value ? `?${value}` : '';
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

export const adminApi = Object.freeze({
  login(returnTo: string): never {
    window.location.assign(normalizeReturnTo(returnTo));
    throw new Error('ADMIN_DEMO_NAVIGATION_STARTED');
  },

  async me() {
    return adaptMe(invoke('GET', '/admin/v1/auth/me').body);
  },

  async logout() {
    const session = adaptMe(invoke('GET', '/admin/v1/auth/me').body);
    invoke('POST', '/admin/v1/auth/logout', { 'x-admin-csrf': session.csrfToken });
  },

  async dashboard(_signal?: AbortSignal) {
    return adaptDashboard(invoke('GET', '/admin/v1/dashboard').body);
  },

  async computeOrders(query: ListQuery, _signal?: AbortSignal) {
    return adaptComputeOrders(invoke('GET', `/admin/v1/compute-orders${queryString(query)}`).body);
  },

  async deviceOrders(query: ListQuery, _signal?: AbortSignal) {
    return adaptDeviceOrders(invoke('GET', `/admin/v1/device-orders${queryString(query)}`).body);
  },

  async payouts(query: ListQuery, _signal?: AbortSignal) {
    return adaptPayouts(invoke('GET', `/admin/v1/payouts${queryString(query)}`).body);
  },

  async topups(query: ListQuery, _signal?: AbortSignal) {
    return adaptTopups(invoke('GET', `/admin/v1/topups${queryString(query)}`).body);
  },

  onUnauthorized(_listener: () => void) {
    return () => {};
  },
});

export const __testing = Object.freeze({ clearCsrf() {} });
