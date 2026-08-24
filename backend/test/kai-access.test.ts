import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresKaiIdentityStore } from '../src/account/kai-identity-store.js';
import { secretHash } from '../src/account/crypto.js';
import { AccountService } from '../src/account/service.js';
import { PostgresAccountStore } from '../src/account/store.js';
import { LEGAL_VERSIONS } from '../src/account/types.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import {
  KAI_AUTH_ISSUER,
  KAI_AUTH_PUBLIC_CLIENT_ID,
  KaiPairedOpaqueAccessTokenVerifier,
  KaiResourceAccessAuthenticator,
} from '../src/account/kai-access.js';

const requiredScope = 'zod.resource';

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

async function keys(kid: string) {
  const pair = await generateKeyPair('EdDSA');
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = kid;
  return { ...pair, kid, key: createLocalJWKSet({ keys: [jwk] }) };
}

async function idToken(input: Readonly<{
  privateKey: CryptoKey;
  kid: string;
  accessToken: string;
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  expiration?: number;
  azp?: string;
  atHash?: string;
}>) {
  const now = Math.floor(Date.now() / 1_000);
  const atHash = input.atHash ?? createHash('sha512').update(input.accessToken).digest()
    .subarray(0, 32).toString('base64url');
  return new SignJWT({ at_hash: atHash, ...(input.azp ? { azp: input.azp } : {}) })
    .setProtectedHeader({ alg: 'EdDSA', kid: input.kid, typ: 'JWT' })
    .setIssuer(input.issuer ?? KAI_AUTH_ISSUER)
    .setAudience(input.audience ?? KAI_AUTH_PUBLIC_CLIENT_ID)
    .setSubject(input.subject ?? 'kai-user-123')
    .setIssuedAt(now)
    .setExpirationTime(input.expiration ?? now + 300)
    .sign(input.privateKey);
}

describe('KAI direct resource access', () => {
  it('serves /me from the paired issuer+sub mapped local user without a mobile_session', async () => {
    const user = {
      id: '10000000-0000-4000-8000-000000000001', phoneCiphertext: null, phoneLookupHash: null,
      emailCiphertext: null, displayName: 'Zod 用户', role: 'member' as const, status: 'active' as const,
      createdAt: new Date('2026-08-18T00:00:00.000Z'),
    };
    const paired = { authenticate: async (_authorization: unknown, proofToken: unknown) => {
      if (proofToken !== 'header.payload.signature') {
        throw new AppError('AUTH_ACCESS_TOKEN_INVALID', 401, 'invalid');
      }
      return { principal: { userId: user.id, sessionId: 'kai-access:test', role: user.role } };
    } };
    const config = loadConfig({
      NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://cloud.kai.com',
      ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'r'.repeat(32), OTP_PEPPER: 'o'.repeat(32),
      AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'c'.repeat(32),
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
    });
    const accounts = new AccountService({ findUserById: async () => user } as never, {} as never,
      config, () => new Date(), paired as never);
    const app = await buildApp({ config, database: null, accountService: accounts, logger: false });
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/me', headers: {
      authorization: 'Bearer opaque-access', 'x-kai-id-token': 'header.payload.signature',
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, user: { id: user.id, displayName: 'Zod 用户', role: 'member' } });
    expect((await app.inject({ method: 'GET', url: '/mobile/v1/me', headers: {
      authorization: 'Bearer legacy-local-token',
    } })).statusCode).toBe(401);
    await app.close();
  });

  it('binds both initial and refreshed opaque access tokens to their own short-lived Zod ID token', async () => {
    const trusted = await keys('paired-key');
    const calls: string[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      calls.push(authorization);
      return new Response(JSON.stringify({ sub: 'kai-user-123', name: 'ignored profile' }), {
        status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    };
    const verifier = new KaiPairedOpaqueAccessTokenVerifier(trusted.key, fetcher as typeof fetch);
    for (const accessToken of ['opaque-initial-access', 'opaque-refreshed-access']) {
      const proofToken = await idToken({ ...trusted, accessToken });
      await expect(verifier.verify(accessToken, proofToken)).resolves.toMatchObject({
        issuer: KAI_AUTH_ISSUER, subject: 'kai-user-123', audiences: [KAI_AUTH_PUBLIC_CLIENT_ID],
      });
    }
    expect(calls).toEqual(['Bearer opaque-initial-access', 'Bearer opaque-refreshed-access']);
  });

  it('rejects token splicing, wrong audience, expiry, unknown kid, revoked access and userinfo subject mismatch', async () => {
    const trusted = await keys('paired-key');
    const unknown = await keys('unknown-key');
    const attacker = await keys('attacker-key');
    const accessToken = 'opaque-access-one';
    const validProof = await idToken({ ...trusted, accessToken });
    const userinfo = (status = 200, sub = 'kai-user-123') => (async () => new Response(JSON.stringify({ sub }), {
      status, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const verifier = new KaiPairedOpaqueAccessTokenVerifier(trusted.key, userinfo());
    const now = Math.floor(Date.now() / 1_000);
    const invalidProofs = [
      [verifier, 'opaque-access-two', validProof],
      [verifier, accessToken, await idToken({ ...trusted, accessToken, audience: 'another-client' })],
      [verifier, accessToken, await idToken({ ...trusted, accessToken, issuer: 'https://evil.example/auth' })],
      [verifier, accessToken, await idToken({ ...trusted, accessToken, expiration: now - 1 })],
      [verifier, accessToken, await idToken({ ...unknown, accessToken })],
      [verifier, accessToken, await idToken({ privateKey: attacker.privateKey, kid: trusted.kid, accessToken })],
      [verifier, accessToken, await idToken({ ...trusted, accessToken,
        audience: [KAI_AUTH_PUBLIC_CLIENT_ID, 'another-audience'], azp: 'another-client' })],
    ] as const;
    for (const [candidate, access, proofToken] of invalidProofs) {
      await expect(candidate.verify(access, proofToken)).rejects.toMatchObject({
        code: 'AUTH_ACCESS_TOKEN_INVALID', statusCode: 401,
      });
    }
    await expect(new KaiPairedOpaqueAccessTokenVerifier(trusted.key, userinfo(401)).verify(accessToken, validProof))
      .rejects.toMatchObject({ code: 'AUTH_ACCESS_TOKEN_INVALID', statusCode: 401 });
    await expect(new KaiPairedOpaqueAccessTokenVerifier(trusted.key, userinfo(200, 'different-subject'))
      .verify(accessToken, validProof)).rejects.toMatchObject({ code: 'AUTH_ACCESS_TOKEN_INVALID', statusCode: 401 });
  });

  it('requires exactly one opaque Bearer and exactly one paired ID-token header before identity lookup', async () => {
    let verifierCalls = 0;
    const identities = { resolveAccessIdentity: async () => {
      throw new Error('identity lookup must not happen');
    } };
    const authenticator = new KaiResourceAccessAuthenticator({ verify: async () => {
      verifierCalls += 1;
      throw new Error('verification stopped');
    } }, identities, 'p'.repeat(40));
    for (const input of [
      [undefined, undefined, undefined],
      ['Bearer opaque-access', undefined, undefined],
      [undefined, 'header.payload.signature', undefined],
      ['Bearer header.payload.signature', 'header.payload.signature', undefined],
      ['Bearer opaque-access', 'header.payload.signature', [
        'authorization', 'Bearer opaque-access', 'authorization', 'Bearer second',
        'x-kai-id-token', 'header.payload.signature',
      ]],
      ['Bearer opaque-access', 'header.payload.signature', [
        'authorization', 'Bearer opaque-access', 'x-kai-id-token', 'header.payload.signature',
        'x-kai-id-token', 'second.payload.signature',
      ]],
    ] as const) {
      await expect(authenticator.authenticate(input[0], input[1], input[2]))
        .rejects.toMatchObject({ code: 'AUTH_ACCESS_TOKEN_INVALID', statusCode: 401 });
    }
    expect(verifierCalls).toBe(0);
  });

  it('maps issuer+sub once, never email/phone-merges legacy assets, and auth failure writes no orders or credits', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const migration of [
      '0001_cloudpay_ledger.sql', '0016_trading_subjects.sql', '0022_kai_credit_double_entry_ledger.sql',
      '0045_kai_oidc_mobile_broker.sql',
    ]) await pglite.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    const database = databaseAdapter(pglite);
    const legacyUserId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, phone_lookup_hash, email_ciphertext, email_lookup_hash, display_name)
       VALUES ($1, 'same-phone-ciphertext', 'same-phone-hash', 'same-email-ciphertext', 'same-email-hash', '旧资产账号')`,
      [legacyUserId],
    );
    const identities = new PostgresKaiIdentityStore(database);
    const subject = 'subject-with-profile-email-and-phone-that-are-never-consumed';
    const subjectPepper = 'p'.repeat(40);
    const existingBrokerUserId = await identities.resolveIdentity({
      issuer: KAI_AUTH_ISSUER,
      subjectHash: secretHash(subject, subjectPepper),
      displayName: '已由旧 broker 建立的身份',
      emailCiphertext: null,
      emailVerified: false,
      termsVersion: '2026-08-11',
      privacyVersion: '2026-08-11',
      ipHash: 'ip-hash',
      userAgentHash: 'ua-hash',
      now: new Date(),
    });
    const verifier = { verify: async () => ({
      issuer: KAI_AUTH_ISSUER as typeof KAI_AUTH_ISSUER,
      subject,
      role: 'admin',
      audiences: [], scopes: [requiredScope], expiresAt: new Date(Date.now() + 300_000),
    }) };
    const authenticator = new KaiResourceAccessAuthenticator(verifier, identities, subjectPepper);
    const first = await authenticator.authenticate('Bearer opaque-token', 'header.payload.signature');
    const second = await authenticator.authenticate('Bearer opaque-token', 'header.payload.signature');
    expect(second.principal.userId).toBe(first.principal.userId);
    expect(first.principal.userId).toBe(existingBrokerUserId);
    expect(first.principal.role).toBe('member');
    expect(first.principal.userId).not.toBe(legacyUserId);
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM users')).rows[0]?.count).toBe('2');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM kai_oidc_identities')).rows[0]?.count).toBe('1');

    const closed = new KaiResourceAccessAuthenticator({
      verify: async () => { throw Object.assign(new Error('invalid'), { code: 'AUTH_ACCESS_TOKEN_INVALID', statusCode: 401 }); },
    }, identities, subjectPepper);
    await expect(closed.authenticate('Bearer forged', 'header.payload.signature'))
      .rejects.toMatchObject({ code: 'AUTH_ACCESS_TOKEN_INVALID' });
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM orders')).rows[0]?.count).toBe('0');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM kai_credit_transactions')).rows[0]?.count).toBe('0');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM audit_events')).rows[0]?.count).toBe('0');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM outbox_events')).rows[0]?.count).toBe('0');
    await database.close();
  });

  it('gates every business surface on current legal consent while keeping bootstrap and consent available', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const migration of [
      '0001_cloudpay_ledger.sql', '0045_kai_oidc_mobile_broker.sql', '0060_kai_direct_auth_consents.sql',
    ]) await pglite.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    const database = databaseAdapter(pglite);
    const accountStore = new PostgresAccountStore(database);
    const identities = new PostgresKaiIdentityStore(database);
    const subject = 'new-direct-user-without-consent';
    const subjectPepper = 'p'.repeat(40);
    const authenticator = new KaiResourceAccessAuthenticator({ verify: async () => ({
      issuer: KAI_AUTH_ISSUER as typeof KAI_AUTH_ISSUER,
      subject, audiences: [KAI_AUTH_PUBLIC_CLIENT_ID], scopes: [], expiresAt: new Date(Date.now() + 300_000),
    }) }, identities, subjectPepper);
    const config = loadConfig({
      NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://cloud.kai.com',
      AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'c'.repeat(32),
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
    });
    const accounts = new AccountService(accountStore, {} as never, config, () => new Date(), authenticator);
    let businessCalls = 0;
    const business = new Proxy({}, { get: () => async () => { businessCalls += 1; return {}; } });
    const operations = {
      authorizeMetrics: () => undefined,
      prometheus: async () => '',
      summary: async () => { businessCalls += 1; return {}; },
    };
    const app = await buildApp({
      config, database: { health: async () => true }, accountService: accounts,
      creditOrderService: business as never, creditLedgerService: business as never,
      assetPortfolioService: business as never, deviceCommerceService: business as never,
      operationsService: operations as never, logger: false,
    });
    const headers = { authorization: 'Bearer opaque-access', 'x-kai-id-token': 'header.payload.signature' };

    const bootstrap = await app.inject({ method: 'GET', url: '/mobile/v1/me', headers });
    expect(bootstrap.statusCode).toBe(200);
    const userId = bootstrap.json<{ user: { id: string } }>().user.id;
    await database.query(
      `INSERT INTO legal_consents(id,user_id,document_kind,document_version,ip_hash,user_agent_hash)
       VALUES ($1,$3,'terms','old-version','ip','ua'),($2,$3,'privacy','old-version','ip','ua')`,
      [randomUUID(), randomUUID(), userId],
    );
    const protectedRequests = [
      { method: 'GET', url: '/mobile/v1/orders' },
      { method: 'GET', url: '/mobile/v1/credits/balance' },
      { method: 'GET', url: '/mobile/v1/assets/summary' },
      { method: 'POST', url: `/mobile/v1/provider/device-orders/${randomUUID()}/confirm` },
      { method: 'GET', url: '/mobile/v1/operator/operations/summary' },
    ] as const;
    for (const request of protectedRequests) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode, request.url).toBe(428);
      expect(response.json(), request.url).toMatchObject({ error: { code: 'LEGAL_CONSENT_REQUIRED' } });
    }
    expect(businessCalls).toBe(0);
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM orders')).rows[0]?.count).toBe('0');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM audit_events')).rows[0]?.count).toBe('0');
    expect((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM outbox_events')).rows[0]?.count).toBe('0');

    const consent = await app.inject({
      method: 'POST', url: '/mobile/v1/auth/kai/consents', headers,
      payload: { termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy, attemptId: randomUUID() },
    });
    expect(consent.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/mobile/v1/credits/balance', headers })).statusCode).toBe(200);
    expect(businessCalls).toBe(1);
    await app.close();
    await database.close();
  });

  it('records paired legal consent atomically with concurrent replay and payload-conflict protection', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const migration of [
      '0001_cloudpay_ledger.sql', '0045_kai_oidc_mobile_broker.sql', '0060_kai_direct_auth_consents.sql',
    ]) await pglite.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    const database = databaseAdapter(pglite);
    const userId = randomUUID();
    await database.query(
      `INSERT INTO users(id, display_name, federated_principal) VALUES ($1, '同意测试用户', true)`, [userId],
    );
    const store = new PostgresAccountStore(database);
    const attemptId = randomUUID();
    const input = {
      userId, attemptId, payloadDigest: 'digest-current-versions',
      termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy,
      requestId: 'consent-request', ipHash: 'ip-hash', userAgentHash: 'ua-hash',
    };
    const results = await Promise.all([store.recordKaiConsents(input), store.recordKaiConsents(input)]);
    expect(results.map((item) => item.status).sort()).toEqual(['created', 'replayed']);
    await expect(store.recordKaiConsents({ ...input, payloadDigest: 'different-payload-digest' }))
      .resolves.toEqual({ status: 'conflict' });
    expect((await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM kai_auth_consent_attempts WHERE user_id=$1', [userId],
    )).rows[0]?.count).toBe('1');
    expect((await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM legal_consents WHERE user_id=$1', [userId],
    )).rows[0]?.count).toBe('2');
    expect((await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE actor_id=$1 AND action='KAI_DIRECT_LEGAL_CONSENT_ACCEPTED'`, [userId],
    )).rows[0]?.count).toBe('1');

    const config = loadConfig({
      NODE_ENV: 'production', AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'c'.repeat(32),
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
    });
    const service = new AccountService(store, {} as never, config);
    await expect(service.acceptKaiConsents(
      { userId, sessionId: 'kai-access:test', role: 'member' },
      { termsVersion: 'stale', privacyVersion: LEGAL_VERSIONS.privacy, attemptId: randomUUID() },
      { requestId: 'wrong-version', ip: '127.0.0.1', userAgent: 'vitest' },
    )).rejects.toMatchObject({ code: 'LEGAL_CONSENT_VERSION_MISMATCH', statusCode: 409 });
    expect((await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM kai_auth_consent_attempts WHERE user_id=$1', [userId],
    )).rows[0]?.count).toBe('1');
    await database.close();
  });
});
