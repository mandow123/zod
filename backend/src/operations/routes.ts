import type { FastifyInstance } from 'fastify';
import type { AccountService } from '../account/service.js';
import type { OperationsService } from './service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

export async function registerOperationsRoutes(app: FastifyInstance, accounts: AccountService | undefined,
  operations: OperationsService, includeMobileOperator = true) {
  app.get('/internal/metrics', async (request, reply) => {
    operations.authorizeMetrics(request.headers.authorization);
    const body = await operations.prometheus();
    return reply.header('cache-control', 'no-store').type('text/plain; version=0.0.4; charset=utf-8').send(body);
  });

  if (includeMobileOperator && accounts) app.get('/mobile/v1/operator/operations/summary', async (request, reply) => {
    const { principal } = await authenticateMobileRequest(accounts, request);
    return reply.header('cache-control', 'no-store').send({ ok: true, ...(await operations.summary(principal)) });
  });
}
