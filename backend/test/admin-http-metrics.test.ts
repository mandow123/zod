import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AdminProcessMetrics } from '../src/admin/metrics.js';
import { loadConfig } from '../src/config.js';

describe('administrator HTTP metrics', () => {
  it('counts only final 5xx responses on the fixed admin API boundary without labels', async () => {
    const metrics = new AdminProcessMetrics();
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }),
      database: null,
      adminMetrics: metrics,
      logger: false,
    });
    app.get('/admin/v1/test-403', async (_request, reply) => reply.code(403).send({ ok: false }));
    app.get('/admin/v1/test-500', async () => { throw new Error('secret failure body'); });
    app.get('/mobile/v1/test-500', async () => { throw new Error('non-admin failure'); });

    expect((await app.inject({ method: 'GET', url: '/admin/v1/not-found' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/admin/v1/test-403' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/mobile/v1/test-500' })).statusCode).toBe(500);
    expect(metrics.snapshot().http5xxTotal).toBe(0);

    const failed = await app.inject({
      method: 'GET',
      url: '/admin/v1/test-500?email=must-not-be-recorded@example.test',
    });
    expect(failed.statusCode).toBe(500);
    expect(metrics.snapshot()).toEqual({ auditAppendFailuresTotal: 0, http5xxTotal: 1 });

    await app.close();
  });
});
