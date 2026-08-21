import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { AdminReadAuditAction } from './auth-service.js';
import type { AdminAuthRuntimeSettings } from './runtime.js';
import type {
  AdminP0ComputeCreditOrderView,
  AdminP0DeviceOrderView,
  AdminP0ListRequest,
  AdminP0PayoutView,
  AdminP0Principal,
  AdminP0TopupView,
} from './p0-service.js';
import type { AdminP0Service } from './p0-service.js';

export type AdminP0AuthorizedRequest = Readonly<{
  principal: AdminP0Principal;
  recordSucceeded(): Promise<void>;
  recordDenied(failureCode: string): Promise<void>;
  recordFailed(failureCode: string): Promise<void>;
}>;

export type AdminP0PrincipalResolver = (
  action: AdminReadAuditAction,
  request: FastifyRequest,
  reply: FastifyReply,
) => AdminP0AuthorizedRequest | Promise<AdminP0AuthorizedRequest>;

export type AdminP0OriginDenialRecorder = (
  request: FastifyRequest,
  failureCode: 'ADMIN_ORIGIN_INVALID',
) => Promise<void>;

export type AdminP0DashboardActivity = Readonly<{
  resource: 'compute-order' | 'device-order' | 'payout' | 'topup';
  id: string;
  displayId: string;
  status: string;
  occurredAt: string;
}>;

const emptyQuery = z.object({}).strict();
const listQuery = z.object({
  limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/u).transform(Number).optional(),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u).optional(),
}).strict();

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('ADMIN_REQUEST_INVALID', 400, '管理员请求格式无效。', {
      fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    });
  }
  return result.data;
}

function requestFrom(query: z.infer<typeof listQuery>): AdminP0ListRequest {
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

function stableReadFailureCode(error: unknown): string {
  if (error instanceof AppError && /^[A-Z0-9_]{1,80}$/u.test(error.code)) return error.code;
  return 'ADMIN_READ_FAILED';
}

async function auditedRead<T>(
  authorized: AdminP0AuthorizedRequest,
  operation: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    const failureCode = stableReadFailureCode(error);
    try {
      if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
        await authorized.recordDenied(failureCode);
      } else {
        await authorized.recordFailed(failureCode);
      }
    } catch { /* A denied or failed read remains fail-closed when audit is unavailable. */ }
    throw error;
  }
  await authorized.recordSucceeded();
  return result;
}

function computeActivity(item: AdminP0ComputeCreditOrderView): AdminP0DashboardActivity {
  return { resource: 'compute-order', id: item.id, displayId: item.orderNumber,
    status: item.status, occurredAt: item.createdAt };
}

function deviceActivity(item: AdminP0DeviceOrderView): AdminP0DashboardActivity {
  return { resource: 'device-order', id: item.id, displayId: item.orderNumber,
    status: item.status, occurredAt: item.createdAt };
}

function payoutActivity(item: AdminP0PayoutView): AdminP0DashboardActivity {
  return { resource: 'payout', id: item.id, displayId: item.payoutNumber,
    status: item.status, occurredAt: item.createdAt };
}

function topupActivity(item: AdminP0TopupView): AdminP0DashboardActivity {
  return { resource: 'topup', id: item.id, displayId: item.id,
    status: item.status, occurredAt: item.createdAt };
}

async function dashboardActivity(service: AdminP0Service, principal: AdminP0Principal) {
  const readers: Promise<readonly AdminP0DashboardActivity[]>[] = [];
  if (principal.permissions.includes('admin.order.read')) {
    readers.push(service.listComputeCreditOrders(principal, { limit: 5 })
      .then((result) => result.items.map(computeActivity)));
  }
  if (principal.permissions.includes('admin.device-order.read')) {
    readers.push(service.listDeviceOrders(principal, { limit: 5 })
      .then((result) => result.items.map(deviceActivity)));
  }
  if (principal.permissions.includes('admin.payout.read')) {
    readers.push(service.listPayouts(principal, { limit: 5 })
      .then((result) => result.items.map(payoutActivity)));
  }
  if (principal.permissions.includes('admin.topup.read')) {
    readers.push(service.listTopups(principal, { limit: 5 })
      .then((result) => result.items.map(topupActivity)));
  }
  const activity = (await Promise.all(readers)).flat();
  return activity.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)
    || left.resource.localeCompare(right.resource) || left.id.localeCompare(right.id)).slice(0, 12);
}

export async function registerAdminP0Routes(
  app: FastifyInstance,
  service: AdminP0Service,
  resolvePrincipal: AdminP0PrincipalResolver,
  settings: AdminAuthRuntimeSettings,
  recordOriginDenial: AdminP0OriginDenialRecorder,
) {
  await app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      if (request.headers.origin !== undefined && request.headers.origin !== settings.webOrigin) {
        try { await recordOriginDenial(request, 'ADMIN_ORIGIN_INVALID'); } catch { /* denial stays fail-closed */ }
        throw new AppError('ADMIN_ORIGIN_INVALID', 403, '管理员请求来源无效。');
      }
    });
    admin.addHook('onSend', async (request, reply, payload) => {
      reply.header('Cache-Control', 'no-store, private');
      reply.header('Pragma', 'no-cache');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      if (request.headers.origin === settings.webOrigin) {
        reply.header('Access-Control-Allow-Origin', settings.webOrigin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Vary', 'Origin');
      }
      return payload;
    });

    admin.get('/dashboard', { config: { cors: false } }, async (request, reply) => {
      parsed(emptyQuery, request.query);
      const authorized = await resolvePrincipal('admin.dashboard.read', request, reply);
      const { metrics, activity } = await auditedRead(authorized, async () => ({
        metrics: await service.overview(authorized.principal),
        activity: await dashboardActivity(service, authorized.principal),
      }));
      return { ok: true, metrics, activity };
    });

    admin.get('/compute-orders', { config: { cors: false } }, async (request, reply) => {
      const query = parsed(listQuery, request.query);
      const authorized = await resolvePrincipal('admin.compute_order.list', request, reply);
      const result = await auditedRead(authorized,
        () => service.listComputeCreditOrders(authorized.principal, requestFrom(query)));
      return { ok: true, items: result.items, nextCursor: result.nextCursor };
    });

    admin.get('/device-orders', { config: { cors: false } }, async (request, reply) => {
      const query = parsed(listQuery, request.query);
      const authorized = await resolvePrincipal('admin.device_order.list', request, reply);
      const result = await auditedRead(authorized,
        () => service.listDeviceOrders(authorized.principal, requestFrom(query)));
      return { ok: true, items: result.items, nextCursor: result.nextCursor };
    });

    admin.get('/payouts', { config: { cors: false } }, async (request, reply) => {
      const query = parsed(listQuery, request.query);
      const authorized = await resolvePrincipal('admin.payout.list', request, reply);
      const result = await auditedRead(authorized,
        () => service.listPayouts(authorized.principal, requestFrom(query)));
      return { ok: true, items: result.items, nextCursor: result.nextCursor };
    });

    admin.get('/topups', { config: { cors: false } }, async (request, reply) => {
      const query = parsed(listQuery, request.query);
      const authorized = await resolvePrincipal('admin.topup.list', request, reply);
      const result = await auditedRead(authorized,
        () => service.listTopups(authorized.principal, requestFrom(query)));
      return { ok: true, items: result.items, nextCursor: result.nextCursor };
    });
  }, { prefix: '/admin/v1' });
}
