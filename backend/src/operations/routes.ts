import type { FastifyInstance } from 'fastify';
import type { AccountService } from '../account/service.js';
import type { OperationsService } from './service.js';

export async function registerOperationsRoutes(app: FastifyInstance, accounts: AccountService | undefined, operations: OperationsService) {
  app.get('/internal/metrics', async (request, reply) => {
    operations.authorizeMetrics(request.headers.authorization);
    const body = await operations.prometheus();
    return reply.header('cache-control', 'no-store').type('text/plain; version=0.0.4; charset=utf-8').send(body);
  });

  if (accounts) app.get('/mobile/v1/operator/operations/summary', async (request, reply) => {
    const { principal } = await accounts.authenticate(request.headers.authorization);
    return reply.header('cache-control', 'no-store').send({ ok: true, ...(await operations.summary(principal)) });
  });
}
