import type { FastifyInstance } from 'fastify';
import type { AccountService } from '../account/service.js';
import type { CreditLedgerService } from './service.js';

export async function registerCreditRoutes(app: FastifyInstance, accounts: AccountService, credits: CreditLedgerService) {
  app.get('/mobile/v1/credits/balance', async (request) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    return { ok: true, balance: await credits.balance(principal) };
  });
}

