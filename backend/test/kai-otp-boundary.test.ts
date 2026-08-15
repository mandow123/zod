import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('production unified-identity boundary', () => {
  it('retires OTP login and registration while leaving the legacy phone deletion challenge explicit', async () => {
    const requestOtp = vi.fn().mockResolvedValue({
      challengeId: '10000000-0000-4000-8000-000000000001', expiresInSeconds: 300, resendAfterSeconds: 60,
    });
    const verifyOtp = vi.fn().mockResolvedValue({ kind: 'reauthentication', reauthenticationToken: 'r'.repeat(64) });
    const accounts = { legalDocuments: () => ({}), requestOtp, verifyOtp };
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://cloudpay.kai.com' }),
      database: null, accountService: accounts as never, logger: false,
    });
    const readiness = await app.inject({ method: 'GET', url: '/mobile/v1/readiness' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({ capabilities: { unifiedIdentity: false } });
    expect(readiness.json().deployment.blockers).toContain('UNIFIED_IDENTITY');
    for (const purpose of ['login', 'register'] as const) {
      const requested = await app.inject({
        method: 'POST', url: '/mobile/v1/auth/otp/request', payload: { phone: '13800138000', purpose },
      });
      expect(requested.statusCode).toBe(410);
      expect(requested.json()).toMatchObject({ error: { code: 'AUTH_OTP_LOGIN_RETIRED' } });
      const verified = await app.inject({
        method: 'POST', url: '/mobile/v1/auth/otp/verify',
        payload: {
          phone: '13800138000', purpose,
          challengeId: '10000000-0000-4000-8000-000000000001', code: '123456',
          device: { deviceId: 'android-device-001', appVersion: '1.0.0', platform: 'android' },
        },
      });
      expect(verified.statusCode).toBe(410);
      expect(verified.json()).toMatchObject({ error: { code: 'AUTH_OTP_LOGIN_RETIRED' } });
    }
    expect(requestOtp).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();

    const deletion = await app.inject({
      method: 'POST', url: '/mobile/v1/auth/otp/request',
      payload: { phone: '13800138000', purpose: 'delete_account' },
    });
    expect(deletion.statusCode).toBe(202);
    expect(requestOtp).toHaveBeenCalledOnce();
    await app.close();
  });

  it('keeps local test OTP login available for the token-protected E2E harness', async () => {
    const requestOtp = vi.fn().mockResolvedValue({
      challengeId: '10000000-0000-4000-8000-000000000001', expiresInSeconds: 300, resendAfterSeconds: 60,
    });
    const accounts = { legalDocuments: () => ({}), requestOtp };
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: accounts as never, logger: false,
    });
    const response = await app.inject({
      method: 'POST', url: '/mobile/v1/auth/otp/request',
      payload: { phone: '13800138000', purpose: 'login' },
    });
    expect(response.statusCode).toBe(202);
    expect(requestOtp).toHaveBeenCalledOnce();
    await app.close();
  });
});
