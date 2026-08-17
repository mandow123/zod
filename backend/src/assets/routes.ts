import type { FastifyInstance } from 'fastify';
import type { AccountService } from '../account/service.js';
import type { AssetPortfolioService } from './service.js';
import { z } from 'zod';
import { AppError } from '../errors.js';

export async function registerAssetPortfolioRoutes(app: FastifyInstance, accounts: AccountService,
  assets: AssetPortfolioService) {
  app.get('/mobile/v1/assets/summary', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict().safeParse(request.query);
    if (!query.success) throw new AppError('VALIDATION_ERROR', 400, '查询参数格式不正确。');
    const input = query.data.limit === undefined ? {} : { limit: query.data.limit };
    return { ok: true, ...(await assets.summary(principal, input)) };
  });
}
