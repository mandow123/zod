import type { FastifyInstance } from 'fastify';
import type { AccountService } from '../account/service.js';
import type { CreditLedgerService } from './service.js';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

export async function registerCreditRoutes(app: FastifyInstance, accounts: AccountService, credits: CreditLedgerService) {
  app.get('/mobile/v1/credits/balance', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    return { ok: true, balance: await credits.balance(principal) };
  });
  app.get('/mobile/v1/credits/entries', async (request) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict().safeParse(request.query);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 400, '查询参数格式不正确。');
    return { ok: true, entries: await credits.entries(principal, parsed.data.limit) };
  });
}
