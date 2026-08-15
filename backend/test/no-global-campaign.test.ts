import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('Spark promotion scope', () => {
  it('does not expose the retired global campaign route', async () => {
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), database: null, logger: false });
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/campaigns/baige-spark-02672' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    await app.close();
  });
});

