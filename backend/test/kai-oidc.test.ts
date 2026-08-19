import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type {
  KaiAppLoginCodeResult,
  KaiIdentityStore,
  KaiOidcTransaction,
} from '../src/account/kai-identity-store.js';
import { PostgresKaiIdentityStore } from '../src/account/kai-identity-store.js';
import {
  KAI_OIDC_CALLBACK_URL,
  KAI_OIDC_ISSUER,
  KAI_OIDC_SCOPE,
  KaiIdTokenVerifier,
  KaiOidcBroker,
  KaiOidcClient,
} from '../src/account/kai-oidc.js';
import type { Database } from '../src/database.js';
import { buildApp } from '../src/app.js';

const clientId = 'cloudpay-mobile-broker';
const fixedNow = new Date('2026-08-15T04:00:00.000Z');
const appVerifier = 'app-verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE';
const appChallenge = createHash('sha256').update(appVerifier).digest('base64url');
const device = { deviceId: 'android-device-oidc', appVersion: '1.0.0', platform: 'android' as const };
const consents = { termsVersion: '2026-08-11', privacyVersion: '2026-08-11' };
const authContext = { requestId: 'request-callback', ip: '127.0.0.1', userAgent: 'vitest' };

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function databaseAdapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => {
      const client = { query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)) } as unknown as PoolClient;
      return work(client);
    }),
    close: () => pglite.close(),
  } as unknown as Database;
}

function brokerConfig(flowPepper = 'f'.repeat(40)) {
  return loadConfig({
    NODE_ENV: 'test',
    ACCESS_TOKEN_SECRET: 'a'.repeat(64),
    REFRESH_TOKEN_PEPPER: 'r'.repeat(40),
    OTP_PEPPER: 'o'.repeat(40),
    AUDIT_PEPPER: 'd'.repeat(40),
    CURSOR_SECRET: 'c'.repeat(40),
    PII_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
    KAI_OIDC_CLIENT_ID: clientId,
    KAI_OIDC_CLIENT_SECRET: 'oidc-client-secret-for-tests',
    KAI_OIDC_FLOW_PEPPER: flowPepper,
    KAI_OIDC_SUBJECT_PEPPER: 's'.repeat(40),
    KAI_OIDC_TRANSACTION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    KAI_OIDC_APP_REDIRECT_URIS: 'kaicloudpay://auth/kai/callback',
  });
}

class MemoryKaiStore implements KaiIdentityStore {
  transaction: (KaiOidcTransaction & { stateHash: string; expiresAt: Date; consumed: boolean }) | null = null;
  appCode: { codeHash: string; challenge: string; userId: string; consumed: boolean } | null = null;
  resolvedSubjectHash: string | null = null;

  async createTransaction(input: Parameters<KaiIdentityStore['createTransaction']>[0]) {
    this.transaction = {
      id: input.id,
      stateHash: input.stateHash,
      nonceHash: input.nonceHash,
      pkceVerifierCiphertext: input.pkceVerifierCiphertext,
      appRedirectUri: input.appRedirectUri,
      appCodeChallenge: input.appCodeChallenge,
      termsVersion: input.termsVersion,
      privacyVersion: input.privacyVersion,
      expiresAt: input.expiresAt,
      consumed: false,
    };
  }
  async consumeTransaction(stateHash: string, now: Date) {
    if (!this.transaction || this.transaction.stateHash !== stateHash || this.transaction.consumed
      || this.transaction.expiresAt <= now) return null;
    this.transaction.consumed = true;
    return this.transaction;
  }
  async resolveIdentity(input: Parameters<KaiIdentityStore['resolveIdentity']>[0]) {
    this.resolvedSubjectHash = input.subjectHash;
    return '10000000-0000-4000-8000-000000000001';
  }
  async createAppLoginCode(input: Parameters<KaiIdentityStore['createAppLoginCode']>[0]) {
    this.appCode = { codeHash: input.codeHash, challenge: input.appCodeChallenge, userId: input.userId, consumed: false };
  }
  async consumeAppLoginCode(input: Parameters<KaiIdentityStore['consumeAppLoginCode']>[0]): Promise<KaiAppLoginCodeResult> {
    if (!this.appCode || this.appCode.codeHash !== input.codeHash) return { status: 'invalid' };
    if (this.appCode.consumed) return { status: 'already_used' };
    if (this.appCode.challenge !== input.appCodeChallenge) return { status: 'pkce_mismatch' };
    this.appCode.consumed = true;
    return { status: 'consumed', userId: this.appCode.userId };
  }
}

function brokerHarness(flowPepper = 'f'.repeat(40)) {
  const store = new MemoryKaiStore();
  let expectedNonce = '';
  const client = {
    exchange: async () => ({ idToken: 'signed-id-token', accessToken: 'opaque-access-token' }),
    userInfo: async () => ({
      subject: 'kai-user-123', displayName: 'KAI 主站用户', email: 'user@example.com', emailVerified: true,
    }),
  };
  const verifier = { verify: async () => ({
    subject: 'kai-user-123', nonce: expectedNonce,
    displayName: 'KAI 主站用户', email: 'user@example.com', emailVerified: true,
  }) };
  const issued: Array<{ userId: string; deviceId: string }> = [];
  const accounts = { createFederatedSession: async (userId: string, inputDevice: typeof device) => {
    issued.push({ userId, deviceId: inputDevice.deviceId });
    return { kind: 'session' as const, accessToken: 'cloudpay-access', refreshToken: 'cloudpay-refresh' };
  } };
  const broker = new KaiOidcBroker(store, accounts as never, brokerConfig(flowPepper), {
    client, verifier, now: () => fixedNow,
  });
  return { store, broker, issued, setNonce: (value: string) => { expectedNonce = value; } };
}

async function signIdToken(payload: JWTPayload, audience: string | string[], azp?: string) {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'auth-kai-test-key';
  const token = await new SignJWT({ nonce: 'n'.repeat(48), ...payload, ...(azp === undefined ? {} : { azp }) })
    .setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' })
    .setIssuer(KAI_OIDC_ISSUER)
    .setAudience(audience)
    .setSubject('kai-user-123')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { token, jwks: { keys: [jwk] } };
}

function verifierFor(jwks: Readonly<{ keys: readonly JsonWebKey[] }>) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(jwks), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  return new KaiIdTokenVerifier(clientId);
}

afterEach(() => vi.unstubAllGlobals());

describe('KAI unified identity broker', () => {
  it('refuses to start a login transaction without the exact current CloudPay legal versions', async () => {
    const harness = brokerHarness();
    await expect(harness.broker.start('kaicloudpay://auth/kai/callback', appChallenge, {
      termsVersion: 'stale', privacyVersion: consents.privacyVersion,
    })).rejects.toMatchObject({ code: 'LEGAL_CONSENT_REQUIRED' });
    expect(harness.store.transaction).toBeNull();
  });

  it('creates a backend-bound authorization request and exchanges only an App-PKCE-bound one-time code', async () => {
    const harness = brokerHarness();
    const authorization = new URL(await harness.broker.start('kaicloudpay://auth/kai/callback', appChallenge, consents));
    expect(authorization.origin + authorization.pathname).toBe(`${KAI_OIDC_ISSUER}/oauth2/authorize`);
    expect(authorization.searchParams.get('scope')).toBe(KAI_OIDC_SCOPE);
    expect(authorization.searchParams.get('redirect_uri')).toBe(KAI_OIDC_CALLBACK_URL);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    harness.setNonce(authorization.searchParams.get('nonce')!);

    const appRedirect = new URL(await harness.broker.callback({
      state: authorization.searchParams.get('state')!, issuer: KAI_OIDC_ISSUER, code: 'provider-code',
    }, authContext));
    expect(appRedirect.protocol).toBe('kaicloudpay:');
    const appLoginCode = appRedirect.searchParams.get('code')!;
    await expect(harness.broker.exchangeAppLoginCode(
      appLoginCode, 'wrong-verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDE', device,
      { requestId: 'request-1', ip: '127.0.0.1', userAgent: 'vitest' },
    )).rejects.toMatchObject({ code: 'AUTH_KAI_APP_PKCE_MISMATCH' });
    const session = await harness.broker.exchangeAppLoginCode(
      appLoginCode, appVerifier, device,
      { requestId: 'request-2', ip: '127.0.0.1', userAgent: 'vitest' },
    );
    expect(session).toMatchObject({ kind: 'session', accessToken: 'cloudpay-access' });
    expect(harness.issued).toEqual([{
      userId: '10000000-0000-4000-8000-000000000001', deviceId: device.deviceId,
    }]);
    await expect(harness.broker.exchangeAppLoginCode(
      appLoginCode, appVerifier, device,
      { requestId: 'request-3', ip: '127.0.0.1', userAgent: 'vitest' },
    )).rejects.toMatchObject({ code: 'AUTH_KAI_APP_CODE_ALREADY_USED' });
  });

  it('keeps the issuer+sub identity key stable when only the ephemeral flow pepper rotates', async () => {
    const hashes: string[] = [];
    for (const flowPepper of ['x'.repeat(40), 'y'.repeat(40)]) {
      const harness = brokerHarness(flowPepper);
      const authorization = new URL(await harness.broker.start('kaicloudpay://auth/kai/callback', appChallenge, consents));
      harness.setNonce(authorization.searchParams.get('nonce')!);
      await harness.broker.callback({
        state: authorization.searchParams.get('state')!, issuer: KAI_OIDC_ISSUER, code: 'provider-code',
      }, authContext);
      hashes.push(harness.store.resolvedSubjectHash!);
    }
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('verifies EdDSA issuer, audience and nonce claims and enforces azp for multiple audiences', async () => {
    const valid = await signIdToken({ name: 'KAI User' }, [clientId, 'another-api'], clientId);
    await expect(verifierFor(valid.jwks).verify(valid.token))
      .resolves.toMatchObject({ subject: 'kai-user-123', nonce: 'n'.repeat(48) });

    const missingAzp = await signIdToken({}, [clientId, 'another-api']);
    await expect(verifierFor(missingAzp.jwks).verify(missingAzp.token))
      .rejects.toMatchObject({ code: 'AUTH_KAI_ID_TOKEN_INVALID' });

    const wrongSingleAzp = await signIdToken({}, clientId, 'another-api');
    await expect(verifierFor(wrongSingleAzp.jwks).verify(wrongSingleAzp.token))
      .rejects.toMatchObject({ code: 'AUTH_KAI_ID_TOKEN_INVALID' });

    const wrongAudience = await signIdToken({}, 'another-api');
    await expect(verifierFor(wrongAudience.jwks).verify(wrongAudience.token))
      .rejects.toMatchObject({ code: 'AUTH_KAI_ID_TOKEN_INVALID' });
  });

  it('keeps the confidential client secret in HTTP Basic and out of the token request body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id_token: 'id-token', access_token: 'access-token', token_type: 'Bearer' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const client = new KaiOidcClient(clientId, 'confidential-secret', KAI_OIDC_CALLBACK_URL, request as typeof fetch);
    await client.exchange('authorization-code', 'backend-pkce-verifier');
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${clientId}:confidential-secret`).toString('base64')}`,
    });
    expect(String(calls[0]?.init.body)).toContain(`redirect_uri=${encodeURIComponent(KAI_OIDC_CALLBACK_URL)}`);
    expect(String(calls[0]?.init.body)).not.toContain('confidential-secret');
  });

  it('applies the federated schema and atomically maps repeated issuer+sub logins to one local user', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const migration of ['0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0045_kai_oidc_mobile_broker.sql']) {
      await pglite.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
    const database = databaseAdapter(pglite);
    const store = new PostgresKaiIdentityStore(database);
    const identity = {
      issuer: KAI_OIDC_ISSUER,
      subjectHash: 'subject-hash',
      displayName: '无邮箱统一身份用户',
      emailCiphertext: null,
      emailVerified: false,
      ...consents,
      ipHash: 'ip-hash',
      userAgentHash: 'ua-hash',
      now: fixedNow,
    };
    const first = await store.resolveIdentity(identity);
    const second = await store.resolveIdentity({ ...identity, now: new Date(fixedNow.getTime() + 1_000) });
    expect(second).toBe(first);
    expect((await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM users WHERE federated_principal = true',
    )).rows[0]?.count).toBe('1');
    expect((await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM legal_consents WHERE user_id = $1', [first],
    )).rows[0]?.count).toBe('2');
    await store.resolveIdentity({ ...identity, termsVersion: '2026-09-01', privacyVersion: '2026-09-01' });
    expect((await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM legal_consents WHERE user_id = $1', [first],
    )).rows[0]?.count).toBe('4');
    expect((await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM kai_oidc_identities WHERE issuer = $1 AND subject_hash = $2',
      [KAI_OIDC_ISSUER, identity.subjectHash],
    )).rows[0]?.count).toBe('1');
    await database.close();
  });

  it('exposes browser start/callback redirects and a JSON-only App exchange contract', async () => {
    const harness = brokerHarness();
    const routeAccounts = {
      legalDocuments: () => ({}),
    };
    const app = await buildApp({
      config: brokerConfig(), database: null,
      accountService: routeAccounts as never, kaiOidc: harness.broker, logger: false,
    });
    const started = await app.inject({
      method: 'GET',
      url: `/mobile/v1/auth/kai/start?${new URLSearchParams({
        appRedirect: 'kaicloudpay://auth/kai/callback',
        appChallenge,
        appChallengeMethod: 'S256',
        ...consents,
      })}`,
    });
    expect(started.statusCode).toBe(302);
    expect(started.headers['cache-control']).toBe('no-store');
    const authorization = new URL(started.headers.location!);
    harness.setNonce(authorization.searchParams.get('nonce')!);
    const callback = await app.inject({
      method: 'GET',
      url: `/mobile/v1/auth/kai/callback?${new URLSearchParams({
        state: authorization.searchParams.get('state')!,
        iss: KAI_OIDC_ISSUER,
        code: 'provider-code',
      })}`,
    });
    expect(callback.statusCode).toBe(302);
    const appLoginCode = new URL(callback.headers.location!).searchParams.get('code')!;
    const exchanged = await app.inject({
      method: 'POST', url: '/mobile/v1/auth/kai/exchange',
      payload: { code: appLoginCode, codeVerifier: appVerifier, device },
    });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json()).toMatchObject({ ok: true, result: { kind: 'session', accessToken: 'cloudpay-access' } });
    await app.close();
  });
});
