import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { SupplierQuoteDirectoryService } from './service.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, '请求参数格式不正确。', {
    fields: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
  });
  return result.data;
}

export async function registerSupplierQuoteDirectoryRoutes(app: FastifyInstance, service: SupplierQuoteDirectoryService) {
  app.get('/mobile/v1/supplier-quote-directory', async (request) => {
    const query = parse(z.object({ model: z.enum(['H100', 'H200', 'B300']).optional(),
      query: z.string().trim().min(1).max(120).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict(), request.query);
    return { ok: true, ...await service.list({ ...(query.model ? { model: query.model } : {}),
      ...(query.query ? { query: query.query } : {}), ...(query.limit ? { limit: query.limit } : {}) }) };
  });
}
