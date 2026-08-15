import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('public store-compliance pages', () => {
  const config = loadConfig({
    NODE_ENV: 'test', LEGAL_ENTITY_NAME: '凯云算力有限公司',
    SUPPORT_EMAIL: 'support@example.com', SUPPORT_PHONE: '4000000000',
  });

  it('publishes discoverable privacy, terms, and app-independent deletion pages with strict browser headers', async () => {
    const app = await buildApp({ config, database: null, logger: false });
    for (const [path, text] of [
      ['/privacy', '隐私政策'], ['/terms', '用户协议'], ['/account/delete', '删除 CloudPay 账户'],
    ] as const) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['cache-control']).toBe('no-store, max-age=0');
      expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
      expect(response.body).toContain(text);
      expect(response.body).toContain('KAI CloudPay');
      expect(response.body).toContain('凯云算力有限公司');
      expect(response.body).not.toContain('运营主体（待生产配置）');
    }
    await app.close();
  });

  it('accepts a deletion request without an active App session after fresh phone verification', async () => {
    const requested: Array<{ token: string; reason: string | undefined }> = [];
    const service = {
      requestDeletionFromWeb: async (token: string, reason: string | undefined) => {
        requested.push({ token, reason });
        return {
          id: 'deletion-id', status: 'cooling_off', requestedAt: new Date().toISOString(),
          coolingOffUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), legalHoldReason: null,
        };
      },
    };
    const app = await buildApp({ config, database: null, accountService: service as never, logger: false });
    const response = await app.inject({
      method: 'POST', url: '/mobile/v1/account/deletion/public',
      payload: { reauthenticationToken: 'r'.repeat(64), reason: '已经卸载应用' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().request.status).toBe('cooling_off');
    expect(requested).toEqual([{ token: 'r'.repeat(64), reason: '已经卸载应用' }]);
    await app.close();
  });
});
