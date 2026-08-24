import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('public store-compliance pages', () => {
  const config = loadConfig({
    NODE_ENV: 'test', LEGAL_ENTITY_NAME: '凯云算力有限公司',
    UNIFIED_SOCIAL_CREDIT_CODE:'913000000000000000',SUPPORT_EMAIL: 'support@example.com', SUPPORT_PHONE: '4000000000',
    ICP_FILING_STATUS:'not_obtained',APP_FILING_STATUS:'not_obtained',
    INTERNET_SERVICE_CLASSIFICATION_STATUS:'not_assessed',
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
      expect(response.body).toContain('ICP备案：尚未取得');
      expect(response.body).toContain('App备案：尚未取得');
      expect(response.body).toContain('互联网服务分类：尚待合资格法务确认');
      expect(response.body).not.toContain('ICP-TEST');
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

  it('publishes honest inquiry-only legal copy and a deletion page with no OTP or mutation calls', async () => {
    const inquiryConfig = loadConfig({
      NODE_ENV: 'test', MOBILE_API_PROFILE: 'inquiry_only', LEGAL_ENTITY_NAME: '凯云算力有限公司',
      UNIFIED_SOCIAL_CREDIT_CODE:'913000000000000000',SUPPORT_EMAIL: 'support@example.com', SUPPORT_PHONE: '4000000000',
      ICP_FILING_STATUS:'not_obtained',APP_FILING_STATUS:'not_obtained',
      INTERNET_SERVICE_CLASSIFICATION_STATUS:'not_assessed',
    });
    const app = await buildApp({ config: inquiryConfig, database: null, logger: false });
    const terms = await app.inject({ method: 'GET', url: '/terms' });
    expect(terms.body).toContain('仅提供供应商报价资料查询与资源询期');
    expect(terms.body).toContain('不提供购买、支付、卡时冻结、订单、库存锁定或自动交付');
    const privacy = await app.inject({ method: 'GET', url: '/privacy' });
    expect(privacy.body).toContain('不接收支付');
    expect(privacy.body).toContain('不创建卡时账本、购买订单、库存预留或自动交付记录');
    const inquiry = await app.inject({ method: 'GET', url: '/inquiry-terms' });
    expect(inquiry.body).toContain('未经 KAI 验真');
    expect(inquiry.body).toContain('不会创建账本记录');
    const deletion = await app.inject({ method: 'GET', url: '/account/delete' });
    expect(deletion.body).toContain('不提供短信验证码或网页直接注销接口');
    expect(deletion.body).not.toContain('/mobile/v1/auth/otp/request');
    expect(deletion.body).not.toContain('/mobile/v1/auth/otp/verify');
    expect(deletion.body).not.toContain('/mobile/v1/account/deletion/public');
    expect(deletion.body).not.toContain('fetch(');
    await app.close();
  });
});
