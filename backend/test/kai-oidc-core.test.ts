import { createSecretKey } from 'node:crypto';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KAI_OIDC_ISSUER,
  KAI_OIDC_TOKEN_ENDPOINT,
} from '../src/identity/kai-oidc-constants.js';
import { KaiIdTokenVerifier } from '../src/identity/kai-id-token-verifier.js';
import { KaiOidcClient } from '../src/identity/kai-oidc-client.js';
import {
  KaiIdTokenVerifier as CompatibleVerifier,
  KaiOidcClient as CompatibleClient,
  KAI_OIDC_ISSUER as COMPATIBLE_ISSUER,
} from '../src/account/kai-oidc.js';

const clientId = 'oidc-core-test-client';
const clientSecret = 'confidential-client-secret';
const mobileRedirect = 'https://cloudpay.kai.com/mobile/v1/auth/kai/callback';
const adminRedirect = 'https://admin-api.kai.com/admin/v1/auth/callback';

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function successfulToken(refreshToken?: string) {
  return {
    id_token: 'signed-id-token', access_token: 'opaque-access-token', token_type: 'Bearer',
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
  };
}

async function signedToken(input: Readonly<{
  payload?: JWTPayload;
  issuer?: string;
  audience?: string | string[];
  azp?: string;
  nonce?: string;
  issuedAt?: number | null;
  expiresAt?: number | null;
}> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const jwk = await exportJWK(publicKey); jwk.kid = 'oidc-core-key';
  const now = Math.floor(Date.now() / 1_000);
  let signer = new SignJWT({
    nonce: input.nonce ?? 'n'.repeat(48),
    ...(input.payload ?? {}),
    ...(input.azp === undefined ? {} : { azp: input.azp }),
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' })
    .setIssuer(input.issuer ?? KAI_OIDC_ISSUER)
    .setAudience(input.audience ?? clientId)
    .setSubject('kai-user-123');
  if (input.issuedAt !== null) signer = signer.setIssuedAt(input.issuedAt ?? now);
  if (input.expiresAt !== null) signer = signer.setExpirationTime(input.expiresAt ?? now + 300);
  return { token: await signer.sign(privateKey), jwks: { keys: [jwk] } };
}

function verifierFor(jwks: Readonly<{ keys: readonly JsonWebKey[] }>) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(jwks), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  return new KaiIdTokenVerifier(clientId);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('parameterized KAI OIDC client', () => {
  it('uses each construction-time redirect URI exactly without endpoint or cross-instance override', async () => {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
      return jsonResponse(successfulToken());
    };
    const mobile = new KaiOidcClient(clientId, clientSecret, mobileRedirect, request as typeof fetch);
    const admin = new KaiOidcClient(clientId, clientSecret, adminRedirect, request as typeof fetch);
    await mobile.exchange('mobile-code', 'mobile-verifier');
    await admin.exchange('admin-code', 'admin-verifier');
    expect(calls.map((call) => call.url)).toEqual([KAI_OIDC_TOKEN_ENDPOINT, KAI_OIDC_TOKEN_ENDPOINT]);
    expect(calls.map((call) => call.body.get('redirect_uri'))).toEqual([mobileRedirect, adminRedirect]);
  });

  it.each([
    'http://cloudpay.kai.com/callback',
    '/relative/callback',
    'https://user@cloudpay.kai.com/callback',
    'https://user:password@cloudpay.kai.com/callback',
    'https://cloudpay.kai.com/callback#fragment',
  ])('rejects an unsafe redirect URI: %s', (redirectUri) => {
    expect(() => new KaiOidcClient(clientId, clientSecret, redirectUri)).toThrow('KAI_OIDC_REDIRECT_URI_INVALID');
  });

  it('uses HTTP Basic only, forces redirect:error, and drops an unexpected refresh token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(successfulToken('must-not-escape'));
    };
    const client = new KaiOidcClient(clientId, clientSecret, mobileRedirect, request as typeof fetch);
    await expect(client.exchange('authorization-code', 'server-pkce-verifier')).resolves.toEqual({
      idToken: 'signed-id-token', accessToken: 'opaque-access-token',
    });
    const call = calls[0]!;
    expect(call.url).toBe(KAI_OIDC_TOKEN_ENDPOINT);
    expect(call.init.redirect).toBe('error');
    expect(call.init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    });
    expect(String(call.init.body)).not.toContain(clientSecret);
    expect(call.url).not.toContain(clientSecret);
  });

  it.each([
    ['upstream redirect', async () => new Response(null, { status: 302 })],
    ['upstream non-2xx', async () => jsonResponse({ error: 'unavailable' }, 503)],
    ['invalid JSON', async () => new Response('{invalid', { status: 200 })],
    ['network failure', async () => { throw new TypeError('fetch failed'); }],
  ] as const)('fails closed on %s', async (_name, request) => {
    const client = new KaiOidcClient(clientId, clientSecret, mobileRedirect, request as typeof fetch);
    await expect(client.exchange('code', 'verifier')).rejects.toMatchObject({
      code: 'AUTH_KAI_UPSTREAM_UNAVAILABLE',
    });
  });

  it('aborts an upstream request after five seconds', async () => {
    vi.useFakeTimers();
    const request = async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const client = new KaiOidcClient(clientId, clientSecret, mobileRedirect, request as typeof fetch);
    const assertion = expect(client.exchange('code', 'verifier')).rejects.toMatchObject({
      code: 'AUTH_KAI_UPSTREAM_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it.each([
    { access_token: 'access', token_type: 'Bearer' },
    { id_token: 'id', token_type: 'Bearer' },
    { id_token: 'id', access_token: 'access', token_type: 'MAC' },
  ])('rejects an invalid token response %#', async (payload) => {
    const request = async () => jsonResponse(payload);
    const client = new KaiOidcClient(clientId, clientSecret, mobileRedirect, request as typeof fetch);
    await expect(client.exchange('code', 'verifier')).rejects.toMatchObject({
      code: 'AUTH_KAI_TOKEN_RESPONSE_INVALID',
    });
  });

  it.each([undefined, '', 'x'.repeat(501)])('rejects an invalid UserInfo subject', async (subject) => {
    const request = async () => jsonResponse({ sub: subject });
    const client = new KaiOidcClient(clientId, clientSecret, mobileRedirect, request as typeof fetch);
    await expect(client.userInfo('access-token')).rejects.toMatchObject({ code: 'AUTH_KAI_USERINFO_INVALID' });
  });

  it('bounds upstream response bodies and opaque token sizes', async () => {
    const declaredTooLarge = new KaiOidcClient(clientId, clientSecret, mobileRedirect,
      (async () => new Response('{}', { status: 200, headers: { 'content-length': '999999' } })) as typeof fetch);
    await expect(declaredTooLarge.exchange('code', 'verifier')).rejects.toMatchObject({
      code: 'AUTH_KAI_UPSTREAM_UNAVAILABLE',
    });
    const streamedTooLarge = new KaiOidcClient(clientId, clientSecret, mobileRedirect,
      (async () => jsonResponse({ padding: 'x'.repeat(70_000) })) as typeof fetch);
    await expect(streamedTooLarge.exchange('code', 'verifier')).rejects.toMatchObject({
      code: 'AUTH_KAI_UPSTREAM_UNAVAILABLE',
    });
    const oversizedToken = new KaiOidcClient(clientId, clientSecret, mobileRedirect,
      (async () => jsonResponse({ id_token: 'i'.repeat(32_769), access_token: 'access', token_type: 'Bearer' })) as typeof fetch);
    await expect(oversizedToken.exchange('code', 'verifier')).rejects.toMatchObject({
      code: 'AUTH_KAI_TOKEN_RESPONSE_INVALID',
    });
  });
});

describe('KAI ID token verifier', () => {
  it('rejects oversized compact tokens before JWKS processing', async () => {
    await expect(new KaiIdTokenVerifier(clientId).verify('x'.repeat(32_769)))
      .rejects.toMatchObject({ code: 'AUTH_KAI_ID_TOKEN_INVALID' });
  });
  it('accepts EdDSA with fixed issuer, audience, nonce, iat, exp, and correct multi-audience azp', async () => {
    const signed = await signedToken({
      audience: [clientId, 'another-api'], azp: clientId,
      payload: { name: '  KAI User  ', email: 'user@example.com', email_verified: true },
    });
    await expect(verifierFor(signed.jwks).verify(signed.token)).resolves.toEqual({
      subject: 'kai-user-123', nonce: 'n'.repeat(48), displayName: 'KAI User',
      email: 'user@example.com', emailVerified: true,
    });
  });

  it.each([
    { issuer: 'https://attacker.example/issuer' },
    { audience: 'another-client' },
    { audience: [clientId, 'another-api'] },
    { audience: [clientId, 'another-api'], azp: 'another-client' },
    { nonce: 'short' },
    { issuedAt: Math.floor(Date.now() / 1_000) - 610 },
    { expiresAt: Math.floor(Date.now() / 1_000) - 10 },
    { issuedAt: null },
    { expiresAt: null },
  ])('rejects invalid identity claims %#', async (input) => {
    const signed = await signedToken(input);
    await expect(verifierFor(signed.jwks).verify(signed.token))
      .rejects.toMatchObject({ code: 'AUTH_KAI_ID_TOKEN_INVALID' });
  });

  it('rejects algorithm downgrade', async () => {
    const token = await new SignJWT({ nonce: 'n'.repeat(48) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(KAI_OIDC_ISSUER).setAudience(clientId).setSubject('kai-user-123')
      .setIssuedAt().setExpirationTime('5m')
      .sign(createSecretKey(Buffer.alloc(32, 7)));
    const validKey = await signedToken();
    await expect(verifierFor(validKey.jwks).verify(token))
      .rejects.toMatchObject({ code: 'AUTH_KAI_ID_TOKEN_INVALID' });
  });

  it('preserves account-layer compatibility re-exports', () => {
    expect(CompatibleClient).toBe(KaiOidcClient);
    expect(CompatibleVerifier).toBe(KaiIdTokenVerifier);
    expect(COMPATIBLE_ISSUER).toBe(KAI_OIDC_ISSUER);
  });
});
