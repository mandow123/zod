import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { NotificationService } from './service.js';

const category = z.enum(['order', 'payment', 'delivery', 'market', 'account', 'system']);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。', {
      fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    });
  }
  return result.data;
}

function context(request: FastifyRequest) {
  return { requestId: request.id, ip: request.ip };
}

export async function registerNotificationRoutes(
  app: FastifyInstance, accounts: AccountService, notifications: NotificationService,
) {
  app.get('/mobile/v1/notifications', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const query = parse(z.object({
      category: category.optional(), unreadOnly: z.enum(['true', 'false']).optional(),
      cursor: z.string().max(2_000).optional(), limit: z.coerce.number().int().min(1).max(50).optional(),
    }), request.query);
    return {
      ok: true,
      ...(await notifications.list(principal, {
        ...(query.category ? { category: query.category } : {}),
        ...(query.unreadOnly ? { unreadOnly: query.unreadOnly === 'true' } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      })),
    };
  });

  app.get('/mobile/v1/notifications/unread-count', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, unreadCount: await notifications.unreadCount(principal) };
  });

  app.post('/mobile/v1/notifications/:notificationId/read', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const parameters = parse(z.object({ notificationId: z.string().uuid() }), request.params);
    return { ok: true, ...(await notifications.markRead(principal, parameters.notificationId)) };
  });

  app.post('/mobile/v1/notifications/read-all', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, ...(await notifications.markAllRead(principal)) };
  });

  app.put('/mobile/v1/devices/push', async (request) => {
    const { principal, identity } = await accounts.authenticate(request.headers.authorization);
    const body = parse(z.object({
      pushToken: z.string().trim().min(20).max(4096),
      locale: z.string().trim().min(2).max(40).default('zh-CN'),
      timezone: z.string().trim().min(1).max(100).default('Asia/Shanghai'),
    }), request.body);
    return { ok: true, installation: await notifications.registerPush(principal, identity.device, body, context(request)) };
  });

  app.get('/mobile/v1/devices/push', async (request) => {
    const { principal, identity } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, ...(await notifications.pushStatus(principal, identity.device)) };
  });

  app.delete('/mobile/v1/devices/push', async (request) => {
    const { principal, identity } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, ...(await notifications.disablePush(principal, identity.device, context(request))) };
  });
}
