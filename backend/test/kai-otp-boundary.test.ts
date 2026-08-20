import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('production unified-identity boundary', () => {
  it('retires every production OTP purpose and the local session routes', async () => {
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
    expect(readiness.json()).toMatchObject({ authentication: {
      mode: 'auth-kai-native',
      issuer: 'https://auth.kai.com/api/auth',
      clientId: 'xUTgWjuzpAz-JT-wDbTJxh9xoh3ssU7K',
      redirect: {
        mode: 'native-ipv4-loopback-pool',
        host: '127.0.0.1',
        path: '/oauth2redirect/kai',
        ports: [52711, 53419, 54127, 54833, 55603, 56311, 57119, 57901, 58687],
        registeredUris: [
          'http://127.0.0.1:52711/oauth2redirect/kai',
          'http://127.0.0.1:53419/oauth2redirect/kai',
          'http://127.0.0.1:54127/oauth2redirect/kai',
          'http://127.0.0.1:54833/oauth2redirect/kai',
          'http://127.0.0.1:55603/oauth2redirect/kai',
          'http://127.0.0.1:56311/oauth2redirect/kai',
          'http://127.0.0.1:57119/oauth2redirect/kai',
          'http://127.0.0.1:57901/oauth2redirect/kai',
          'http://127.0.0.1:58687/oauth2redirect/kai',
        ],
        selection: 'random-order-first-bind',
      },
      resourceAccess: { ready: false, tokenFormat: null, audience: null },
    } });
    expect(readiness.json().deployment.blockers).toContain('UNIFIED_IDENTITY');
    expect((await app.inject({ method: 'GET', url: '/mobile/v1/auth/kai/start' })).statusCode).toBe(404);
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
    expect(deletion.statusCode).toBe(410);
    expect(requestOtp).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/mobile/v1/auth/refresh', payload: {} })).statusCode).toBe(410);
    expect((await app.inject({ method: 'GET', url: '/mobile/v1/auth/sessions' })).statusCode).toBe(410);
    expect((await app.inject({ method: 'POST', url: '/mobile/v1/auth/logout' })).statusCode).toBe(410);
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
