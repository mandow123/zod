import { AppError } from '../errors.js';
import type {
  AdminP0ComputeCreditOrder,
  AdminP0Cursor,
  AdminP0DeviceOrder,
  AdminP0Overview,
  AdminP0Payout,
  AdminP0Store,
  AdminP0Topup,
} from './p0-store.js';

export type AdminP0Permission =
  | 'admin.overview.read'
  | 'admin.order.read'
  | 'admin.device-order.read'
  | 'admin.payout.read'
  | 'admin.topup.read';

export type AdminP0Principal = Readonly<{
  permissions: readonly string[];
}>;

export type AdminP0ListRequest = Readonly<{
  limit?: unknown;
  cursor?: unknown;
}>;

export type AdminP0Resource = 'compute-credit-orders' | 'device-orders' | 'payouts' | 'topups';

export type AdminP0Page<Item> = Readonly<{
  items: readonly Item[];
  nextCursor: string | null;
}>;

export type AdminP0OverviewView = AdminP0Overview;

export type AdminP0ComputeCreditOrderView = Readonly<Omit<AdminP0ComputeCreditOrder, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
}>;

export type AdminP0DeviceOrderView = Readonly<Omit<AdminP0DeviceOrder, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
}>;

export type AdminP0PayoutView = Readonly<Omit<AdminP0Payout, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
}>;

export type AdminP0TopupView = Readonly<Omit<AdminP0Topup, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
}>;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 512;
const CURSOR_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FORBIDDEN_RESOURCES = new Set(['refunds', 'disputes', 'invoices', 'vast']);

type PageSource = AdminP0ComputeCreditOrder | AdminP0DeviceOrder | AdminP0Payout | AdminP0Topup;
type PageView = AdminP0ComputeCreditOrderView | AdminP0DeviceOrderView | AdminP0PayoutView | AdminP0TopupView;

function requirePermission(principal: AdminP0Principal, permission: AdminP0Permission): void {
  if (!principal.permissions.includes(permission)) {
    throw new AppError('ADMIN_PERMISSION_REQUIRED', 403, '当前管理员没有读取该资源的权限。');
  }
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT) {
    throw new AppError('ADMIN_PAGINATION_LIMIT_INVALID', 400, '分页数量无效。');
  }
  return value as number;
}

function decodeCursor(value: unknown, resource: AdminP0Resource): AdminP0Cursor | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new AppError('ADMIN_PAGINATION_CURSOR_INVALID', 400, '分页位置无效。');
  }
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error('non-canonical');
    const parsed: unknown = JSON.parse(decoded);
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== CURSOR_VERSION
      || parsed[1] !== resource || typeof parsed[2] !== 'string' || typeof parsed[3] !== 'string'
      || !UUID_PATTERN.test(parsed[3])) throw new Error('shape');
    const createdAt = new Date(parsed[2]);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== parsed[2]) throw new Error('date');
    return { createdAt, id: parsed[3] };
  } catch {
    throw new AppError('ADMIN_PAGINATION_CURSOR_INVALID', 400, '分页位置无效。');
  }
}

function encodeCursor(resource: AdminP0Resource, item: PageSource): string {
  return Buffer.from(JSON.stringify([
    CURSOR_VERSION,
    resource,
    item.createdAt.toISOString(),
    item.id,
  ]), 'utf8').toString('base64url');
}

function view(item: PageSource): PageView {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function page<Item extends PageSource>(resource: AdminP0Resource, rows: readonly Item[], limit: number): AdminP0Page<PageView> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map((item) => view(item)),
    nextCursor: rows.length > limit && last ? encodeCursor(resource, last) : null,
  };
}

export class AdminP0Service {
  constructor(private readonly store: AdminP0Store) {}

  async overview(principal: AdminP0Principal): Promise<AdminP0OverviewView> {
    requirePermission(principal, 'admin.overview.read');
    return this.store.overview();
  }

  async listComputeCreditOrders(principal: AdminP0Principal, request: AdminP0ListRequest = {}) {
    requirePermission(principal, 'admin.order.read');
    const limit = parseLimit(request.limit);
    const cursor = decodeCursor(request.cursor, 'compute-credit-orders');
    const rows = await this.store.listComputeCreditOrders({ limit: limit + 1, cursor });
    return page('compute-credit-orders', rows, limit) as AdminP0Page<AdminP0ComputeCreditOrderView>;
  }

  async listDeviceOrders(principal: AdminP0Principal, request: AdminP0ListRequest = {}) {
    requirePermission(principal, 'admin.device-order.read');
    const limit = parseLimit(request.limit);
    const cursor = decodeCursor(request.cursor, 'device-orders');
    const rows = await this.store.listDeviceOrders({ limit: limit + 1, cursor });
    return page('device-orders', rows, limit) as AdminP0Page<AdminP0DeviceOrderView>;
  }

  async listPayouts(principal: AdminP0Principal, request: AdminP0ListRequest = {}) {
    requirePermission(principal, 'admin.payout.read');
    const limit = parseLimit(request.limit);
    const cursor = decodeCursor(request.cursor, 'payouts');
    const rows = await this.store.listPayouts({ limit: limit + 1, cursor });
    return page('payouts', rows, limit) as AdminP0Page<AdminP0PayoutView>;
  }

  async listTopups(principal: AdminP0Principal, request: AdminP0ListRequest = {}) {
    requirePermission(principal, 'admin.topup.read');
    const limit = parseLimit(request.limit);
    const cursor = decodeCursor(request.cursor, 'topups');
    const rows = await this.store.listTopups({ limit: limit + 1, cursor });
    return page('topups', rows, limit) as AdminP0Page<AdminP0TopupView>;
  }

  async listResource(principal: AdminP0Principal, resource: string, request: AdminP0ListRequest = {}) {
    switch (resource) {
      case 'compute-credit-orders': return this.listComputeCreditOrders(principal, request);
      case 'device-orders': return this.listDeviceOrders(principal, request);
      case 'payouts': return this.listPayouts(principal, request);
      case 'topups': return this.listTopups(principal, request);
      default:
        if (FORBIDDEN_RESOURCES.has(resource)) {
          throw new AppError('ADMIN_RESOURCE_NOT_AVAILABLE', 404, '该资源不在管理员 P0 只读范围内。');
        }
        throw new AppError('ADMIN_RESOURCE_UNKNOWN', 404, '管理员资源不存在。');
    }
  }
}
