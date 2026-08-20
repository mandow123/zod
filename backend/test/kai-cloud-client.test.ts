import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { KaiCloudError, KaiCloudPublicClient } from '../src/kai-cloud/client.js';
import { KaiCloudWebhookVerifier } from '../src/kai-cloud/webhook.js';

function response(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)) } });
}
const token = { access_token: 'token-value-that-is-long-enough', token_type: 'Bearer', expires_in: 300,
  scope: 'resource:read verification:write agent:write' };
const record = { id: 'verification_123', version: 1, status: 'running', updatedAt: '2026-08-20T01:00:00.000Z',
  failure: null, ignoredFutureField: true };

describe('KAI Cloud public API client', () => {
  it('uses client credentials, caches the scoped token, sends no Cookie, and ignores unknown response fields', async () => {
    const http = vi.fn().mockResolvedValueOnce(response(token)).mockImplementation(async () => response({ record }));
    const client = new KaiCloudPublicClient('https://sandbox-api.cloud.kai.com',
      'https://sandbox-auth.cloud.kai.com/oauth/token', 'client-id', 'S'.repeat(32), http as typeof fetch);
    const created = await client.createVerification({ organizationReference: 'organization_1',
      resourceReference: 'resource_1', productCode: 'H100', region: 'cn-east', specifications: { gpuCount: 8 },
      idempotencyKey: 'verification-request-0001' });
    await client.getVerification(created.id);
    expect(created).toEqual({ id: record.id, version: 1, status: 'running', updatedAt: record.updatedAt, failure: null });
    expect(http).toHaveBeenCalledTimes(3);
    const tokenRequest = http.mock.calls[0]![1] as RequestInit;
    expect(tokenRequest.headers).toMatchObject({ authorization: expect.stringMatching(/^Basic /u) });
    expect(new URLSearchParams(String(tokenRequest.body)).get('scope')).toBe('resource:read verification:write');
    expect(String(tokenRequest.body)).not.toContain('agent:write');
    const apiRequest = http.mock.calls[1]![1] as RequestInit;
    expect(apiRequest.headers).toMatchObject({ authorization: `Bearer ${token.access_token}`,
      'idempotency-key': 'verification-request-0001' });
    expect(JSON.stringify(apiRequest.headers)).not.toMatch(/cookie|secret/i);
  });

  it('retries safe reads but never retries a mutation with an unknown outcome', async () => {
    const readHttp = vi.fn().mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response({ error: { code: 'UNAVAILABLE' } }, 503))
      .mockResolvedValueOnce(response({ record }));
    const reader = new KaiCloudPublicClient('https://sandbox-api.cloud.kai.com',
      'https://sandbox-auth.cloud.kai.com/oauth/token', 'client-id', 'S'.repeat(32), readHttp as typeof fetch);
    await expect(reader.getVerification(record.id)).resolves.toMatchObject({ status: 'running' });
    expect(readHttp).toHaveBeenCalledTimes(3);

    const writeHttp = vi.fn().mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response({ error: { code: 'RATE_LIMITED' } }, 429));
    const writer = new KaiCloudPublicClient('https://sandbox-api.cloud.kai.com',
      'https://sandbox-auth.cloud.kai.com/oauth/token', 'client-id', 'S'.repeat(32), writeHttp as typeof fetch);
    await expect(writer.createVerification({ organizationReference: 'organization_1', resourceReference: 'resource_1',
      productCode: 'H100', region: 'cn-east', specifications: {}, idempotencyKey: 'verification-request-0002' }))
      .rejects.toMatchObject({ code: 'KAI_CLOUD_RATE_LIMITED', outcomeUnknown: true });
    expect(writeHttp).toHaveBeenCalledTimes(2);
  });

  it.each([[401, 'KAI_CLOUD_UNAUTHORIZED'], [403, 'KAI_CLOUD_UNAUTHORIZED'], [404, 'KAI_CLOUD_NOT_FOUND'],
    [409, 'KAI_CLOUD_CONFLICT'], [429, 'KAI_CLOUD_RATE_LIMITED'], [503, 'KAI_CLOUD_UNAVAILABLE']])(
    'maps HTTP %i to %s', async (status, code) => {
      const http = vi.fn().mockResolvedValueOnce(response(token)).mockImplementation(async () => response({ error: { code } }, status));
      const client = new KaiCloudPublicClient('https://sandbox-api.cloud.kai.com',
        'https://sandbox-auth.cloud.kai.com/oauth/token', 'client-id', 'S'.repeat(32), http as typeof fetch);
      await expect(client.getVerification(record.id)).rejects.toMatchObject({ code });
    });

  it('rejects missing scopes and malformed success responses', async () => {
    const badScope = vi.fn().mockResolvedValue(response({ ...token, scope: 'resource:read' }));
    const client = new KaiCloudPublicClient('https://sandbox-api.cloud.kai.com',
      'https://sandbox-auth.cloud.kai.com/oauth/token', 'client-id', 'S'.repeat(32), badScope as typeof fetch);
    await expect(client.getVerification(record.id)).rejects.toBeInstanceOf(KaiCloudError);
    const malformed = vi.fn().mockResolvedValueOnce(response(token)).mockResolvedValue(response({ record: { status: 'passed' } }));
    const second = new KaiCloudPublicClient('https://sandbox-api.cloud.kai.com',
      'https://sandbox-auth.cloud.kai.com/oauth/token', 'client-id', 'S'.repeat(32), malformed as typeof fetch);
    await expect(second.getVerification(record.id)).rejects.toMatchObject({ code: 'KAI_CLOUD_INVALID_RESPONSE' });
  });
});

describe('KAI Cloud integration configuration and webhook', () => {
  const configured = { NODE_ENV: 'test', KAI_CLOUD_PUBLIC_API_URL: 'http://127.0.0.1:4410',
    KAI_CLOUD_PUBLIC_TOKEN_URL: 'http://127.0.0.1:4410/oauth/token', KAI_CLOUD_PUBLIC_CLIENT_ID: 'sandbox-client',
    KAI_CLOUD_PUBLIC_CLIENT_SECRET: 'C'.repeat(32), KAI_CLOUD_PUBLIC_WEBHOOK_SECRET: 'W'.repeat(32) } as const;
  it('is optional and fail-closed, while complete independent sandbox settings become available', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).readiness.capabilities.kaiCloudPublicApi.available).toBe(false);
    const config = loadConfig(configured);
    expect(config.readiness.capabilities.kaiCloudPublicApi.available).toBe(true);
    expect(JSON.stringify(config.readiness)).not.toContain('C'.repeat(32));
    expect(loadConfig({ ...configured, KAI_CLOUD_PUBLIC_WEBHOOK_SECRET: 'C'.repeat(32) })
      .readiness.capabilities.kaiCloudPublicApi.available).toBe(false);
    expect(loadConfig({ ...configured, NODE_ENV: 'production' })
      .readiness.capabilities.kaiCloudPublicApi.available).toBe(false);
  });

  it('accepts a fresh HMAC and rejects tampering, stale timestamps, and malformed delivery ids', () => {
    const now = Date.parse('2026-08-20T01:00:00.000Z'); const secret = 'W'.repeat(32);
    const verifier = new KaiCloudWebhookVerifier(secret, 300, () => now);
    const timestamp = String(Math.floor(now / 1_000)); const rawBody = '{"type":"resource.verification.updated"}';
    const signature = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
    expect(verifier.verify({ deliveryId: 'delivery-0001', timestamp, signature, rawBody }))
      .toMatchObject({ deliveryId: 'delivery-0001', payloadDigest: expect.stringMatching(/^sha256:/u) });
    expect(verifier.verify({ deliveryId: 'delivery-0001', timestamp, signature, rawBody: `${rawBody} ` })).toBeNull();
    expect(verifier.verify({ deliveryId: 'delivery-0001', timestamp: String(Number(timestamp) - 301), signature, rawBody })).toBeNull();
    expect(verifier.verify({ deliveryId: 'short', timestamp, signature, rawBody })).toBeNull();
  });
});
