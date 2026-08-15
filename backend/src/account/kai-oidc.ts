import { createHash, randomUUID } from 'node:crypto';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import { constantTimeEqual, decryptPii, encryptPii, generateOpaqueToken, lookupHash, secretHash } from './crypto.js';
import type { KaiIdentityStore } from './kai-identity-store.js';
import type { AccountService } from './service.js';
import { LEGAL_VERSIONS, type DeviceDescriptor } from './types.js';

export const KAI_OIDC_ISSUER = 'https://auth.kai.com/api/auth';
export const KAI_OIDC_AUTHORIZATION_ENDPOINT = `${KAI_OIDC_ISSUER}/oauth2/authorize`;
export const KAI_OIDC_TOKEN_ENDPOINT = `${KAI_OIDC_ISSUER}/oauth2/token`;
export const KAI_OIDC_JWKS_URI = `${KAI_OIDC_ISSUER}/jwks`;
export const KAI_OIDC_USERINFO_ENDPOINT = `${KAI_OIDC_ISSUER}/oauth2/userinfo`;
export const KAI_OIDC_CALLBACK_URL = 'https://cloudpay.kai.com/mobile/v1/auth/kai/callback';
export const KAI_OIDC_SCOPE = 'openid profile email';

type RequestContext = Readonly<{ requestId: string; ip: string; userAgent: string }>;

type VerifiedIdToken = Readonly<{
  subject: string;
  nonce: string;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
}>;

type UserInfo = Readonly<{
  subject: string;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
}>;

type TokenSet = Readonly<{ idToken: string; accessToken: string }>;
type KaiTokenClient = Pick<KaiOidcClient, 'exchange' | 'userInfo'>;
type KaiTokenVerifier = Pick<KaiIdTokenVerifier, 'verify'>;
type FederatedSessionIssuer = Pick<AccountService, 'createFederatedSession'>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sha256Base64Url(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

function safeProfile(payload: JWTPayload): Omit<VerifiedIdToken, 'subject' | 'nonce'> {
  const displayName = typeof payload.name === 'string' && payload.name.trim()
    ? payload.name.trim().slice(0, 80) : null;
  const email = typeof payload.email === 'string' && payload.email.trim().length <= 320
    ? payload.email.trim() : null;
  return { displayName, email, emailVerified: payload.email_verified === true };
}

export class KaiIdTokenVerifier {
  private readonly key: JWTVerifyGetKey;

  constructor(private readonly clientId: string, key?: JWTVerifyGetKey) {
    this.key = key ?? createRemoteJWKSet(new URL(KAI_OIDC_JWKS_URI), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1_000,
    });
  }

  async verify(idToken: string): Promise<VerifiedIdToken> {
    try {
      const { payload } = await jwtVerify(idToken, this.key, {
        issuer: KAI_OIDC_ISSUER,
        audience: this.clientId,
        algorithms: ['EdDSA'],
        requiredClaims: ['sub', 'nonce', 'iat', 'exp'],
        maxTokenAge: '10m',
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 500
        || typeof payload.nonce !== 'string' || payload.nonce.length < 32 || payload.nonce.length > 200) {
        throw new Error('invalid identity claims');
      }
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if ((audiences.length > 1 && payload.azp !== this.clientId)
        || (payload.azp !== undefined && payload.azp !== this.clientId)) {
        throw new Error('invalid authorized party');
      }
      return { subject: payload.sub, nonce: payload.nonce, ...safeProfile(payload) };
    } catch {
      throw new AppError('AUTH_KAI_ID_TOKEN_INVALID', 401, '统一身份返回的登录凭证无效，请重新登录。');
    }
  }
}

export class KaiOidcClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async exchange(code: string, pkceVerifier: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: KAI_OIDC_CALLBACK_URL,
      code_verifier: pkceVerifier,
    });
    const payload = await this.fetchJson(KAI_OIDC_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: body.toString(),
    });
    const token = payload as { id_token?: unknown; access_token?: unknown; token_type?: unknown };
    if (typeof token.id_token !== 'string' || typeof token.access_token !== 'string'
      || String(token.token_type).toLowerCase() !== 'bearer') {
      throw new AppError('AUTH_KAI_TOKEN_RESPONSE_INVALID', 502, '统一身份暂时无法完成登录。');
    }
    return { idToken: token.id_token, accessToken: token.access_token };
  }

  async userInfo(accessToken: string): Promise<UserInfo> {
    const payload = await this.fetchJson(KAI_OIDC_USERINFO_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    }) as JWTPayload;
    if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 500) {
      throw new AppError('AUTH_KAI_USERINFO_INVALID', 502, '统一身份暂时无法确认账户资料。');
    }
    return { subject: payload.sub, ...safeProfile(payload) };
  }

  private async fetchJson(url: string, init: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.request(url, { ...init, signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error(`upstream status ${response.status}`);
      return await response.json() as unknown;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('AUTH_KAI_UPSTREAM_UNAVAILABLE', 502, '统一身份服务暂时不可用，请稍后重试。');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class KaiOidcBroker {
  private readonly clientId: string;
  private readonly flowPepper: string;
  private readonly subjectPepper: string;
  private readonly auditPepper: string;
  private readonly transactionKey: string;
  private readonly piiKey: string;
  private readonly appRedirects: ReadonlySet<string>;
  private readonly client: KaiTokenClient;
  private readonly verifier: KaiTokenVerifier;
  private readonly transactionTtlMilliseconds = 5 * 60 * 1_000;
  private readonly appLoginCodeTtlMilliseconds = 90 * 1_000;

  constructor(
    private readonly store: KaiIdentityStore,
    private readonly accounts: FederatedSessionIssuer,
    config: RuntimeConfig,
    dependencies: Readonly<{
      client?: KaiTokenClient;
      verifier?: KaiTokenVerifier;
      now?: () => Date;
    }> = {},
  ) {
    this.clientId = required(config.KAI_OIDC_CLIENT_ID, 'KAI_OIDC_CLIENT_ID');
    const clientSecret = required(config.KAI_OIDC_CLIENT_SECRET, 'KAI_OIDC_CLIENT_SECRET');
    this.flowPepper = required(config.KAI_OIDC_FLOW_PEPPER, 'KAI_OIDC_FLOW_PEPPER');
    this.subjectPepper = required(config.KAI_OIDC_SUBJECT_PEPPER, 'KAI_OIDC_SUBJECT_PEPPER');
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
    this.transactionKey = required(config.KAI_OIDC_TRANSACTION_ENCRYPTION_KEY, 'KAI_OIDC_TRANSACTION_ENCRYPTION_KEY');
    this.piiKey = required(config.PII_ENCRYPTION_KEY, 'PII_ENCRYPTION_KEY');
    this.appRedirects = new Set(config.kaiOidcAppRedirects);
    if (!this.appRedirects.size) throw new Error('KAI_OIDC_APP_REDIRECT_URIS is required.');
    this.client = dependencies.client ?? new KaiOidcClient(this.clientId, clientSecret);
    this.verifier = dependencies.verifier ?? new KaiIdTokenVerifier(this.clientId);
    this.now = dependencies.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  async start(appRedirectUri: string, appCodeChallenge: string, consents: Readonly<{
    termsVersion: string;
    privacyVersion: string;
  }>) {
    if (!this.appRedirects.has(appRedirectUri)) {
      throw new AppError('AUTH_KAI_APP_REDIRECT_INVALID', 400, '登录回到 App 的地址未登记。');
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(appCodeChallenge)) {
      throw new AppError('AUTH_KAI_APP_PKCE_INVALID', 400, '登录请求缺少有效的 App 安全校验。');
    }
    if (consents.termsVersion !== LEGAL_VERSIONS.terms || consents.privacyVersion !== LEGAL_VERSIONS.privacy) {
      throw new AppError('LEGAL_CONSENT_REQUIRED', 400, '请阅读并同意当前版本的用户协议和隐私政策。');
    }
    const state = generateOpaqueToken();
    const nonce = generateOpaqueToken();
    const pkceVerifier = generateOpaqueToken();
    const now = this.now();
    await this.store.createTransaction({
      id: randomUUID(),
      stateHash: secretHash(state, this.flowPepper),
      nonceHash: secretHash(nonce, this.flowPepper),
      pkceVerifierCiphertext: encryptPii(pkceVerifier, this.transactionKey),
      appRedirectUri,
      appCodeChallenge,
      termsVersion: consents.termsVersion,
      privacyVersion: consents.privacyVersion,
      expiresAt: new Date(now.getTime() + this.transactionTtlMilliseconds),
    });
    const authorization = new URL(KAI_OIDC_AUTHORIZATION_ENDPOINT);
    authorization.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: KAI_OIDC_CALLBACK_URL,
      response_type: 'code',
      response_mode: 'query',
      scope: KAI_OIDC_SCOPE,
      state,
      nonce,
      code_challenge: sha256Base64Url(pkceVerifier),
      code_challenge_method: 'S256',
    }).toString();
    return authorization.toString();
  }

  async callback(input: Readonly<{
    state: string;
    issuer: string;
    code?: string;
    providerError?: string;
  }>, context: RequestContext) {
    if (input.issuer !== KAI_OIDC_ISSUER) {
      throw new AppError('AUTH_KAI_ISSUER_MISMATCH', 400, '统一身份响应来源不可信。');
    }
    const transaction = await this.store.consumeTransaction(secretHash(input.state, this.flowPepper), this.now());
    if (!transaction) throw new AppError('AUTH_KAI_STATE_INVALID', 400, '登录请求已失效，请回到 App 重新登录。');
    if (input.providerError) return this.appRedirect(transaction.appRedirectUri, { error: 'authentication_cancelled' });
    if (!input.code) return this.appRedirect(transaction.appRedirectUri, { error: 'authentication_failed' });

    try {
      const tokenSet = await this.client.exchange(input.code, decryptPii(transaction.pkceVerifierCiphertext, this.transactionKey));
      const verified = await this.verifier.verify(tokenSet.idToken);
      if (!constantTimeEqual(secretHash(verified.nonce, this.flowPepper), transaction.nonceHash)) {
        throw new AppError('AUTH_KAI_NONCE_MISMATCH', 401, '统一身份登录校验失败，请重新登录。');
      }
      const userInfo = await this.client.userInfo(tokenSet.accessToken);
      if (userInfo.subject !== verified.subject) {
        throw new AppError('AUTH_KAI_SUBJECT_MISMATCH', 401, '统一身份账户校验失败，请重新登录。');
      }
      const email = userInfo.email ?? verified.email;
      const emailVerified = userInfo.email ? userInfo.emailVerified : verified.emailVerified;
      const displayName = (userInfo.displayName ?? verified.displayName ?? 'KAI 用户').trim().slice(0, 80) || 'KAI 用户';
      const userId = await this.store.resolveIdentity({
        issuer: KAI_OIDC_ISSUER,
        subjectHash: secretHash(verified.subject, this.subjectPepper),
        displayName,
        emailCiphertext: email ? encryptPii(email, this.piiKey) : null,
        emailVerified,
        termsVersion: transaction.termsVersion,
        privacyVersion: transaction.privacyVersion,
        ipHash: lookupHash(context.ip || 'unknown', this.auditPepper),
        userAgentHash: lookupHash(context.userAgent || 'unknown', this.auditPepper),
        now: this.now(),
      });
      const appLoginCode = generateOpaqueToken();
      await this.store.createAppLoginCode({
        id: randomUUID(),
        transactionId: transaction.id,
        userId,
        codeHash: secretHash(appLoginCode, this.flowPepper),
        appCodeChallenge: transaction.appCodeChallenge,
        expiresAt: new Date(this.now().getTime() + this.appLoginCodeTtlMilliseconds),
      });
      return this.appRedirect(transaction.appRedirectUri, { code: appLoginCode });
    } catch {
      return this.appRedirect(transaction.appRedirectUri, { error: 'authentication_failed' });
    }
  }

  async exchangeAppLoginCode(code: string, appCodeVerifier: string, device: DeviceDescriptor, context: RequestContext) {
    const consumed = await this.store.consumeAppLoginCode({
      codeHash: secretHash(code, this.flowPepper),
      appCodeChallenge: sha256Base64Url(appCodeVerifier),
      now: this.now(),
    });
    const errors = {
      invalid: ['AUTH_KAI_APP_CODE_INVALID', 401, '登录凭证无效，请重新登录。'],
      expired: ['AUTH_KAI_APP_CODE_EXPIRED', 410, '登录凭证已过期，请重新登录。'],
      already_used: ['AUTH_KAI_APP_CODE_ALREADY_USED', 409, '登录凭证已经使用，请重新登录。'],
      pkce_mismatch: ['AUTH_KAI_APP_PKCE_MISMATCH', 401, '登录请求与当前设备不匹配。'],
    } as const;
    if (consumed.status !== 'consumed') {
      const [errorCode, status, message] = errors[consumed.status];
      throw new AppError(errorCode, status, message);
    }
    return this.accounts.createFederatedSession(consumed.userId, device, context);
  }

  private appRedirect(base: string, parameters: Record<string, string>) {
    if (!this.appRedirects.has(base)) throw new Error('unregistered app redirect');
    const redirect = new URL(base);
    for (const [key, value] of Object.entries(parameters)) redirect.searchParams.set(key, value);
    return redirect.toString();
  }
}
