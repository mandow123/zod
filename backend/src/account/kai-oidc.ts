import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import {
  KAI_OIDC_AUTHORIZATION_ENDPOINT,
  KAI_OIDC_ISSUER,
  KAI_OIDC_SCOPE,
} from '../identity/kai-oidc-constants.js';
import { KaiIdTokenVerifier } from '../identity/kai-id-token-verifier.js';
import { KaiOidcClient } from '../identity/kai-oidc-client.js';
import { constantTimeEqual, decryptPii, encryptPii, generateOpaqueToken, lookupHash, secretHash } from './crypto.js';
import type { KaiIdentityStore } from './kai-identity-store.js';
import type { AccountService } from './service.js';
import { LEGAL_VERSIONS, type DeviceDescriptor } from './types.js';

export const KAI_OIDC_CALLBACK_URL = 'https://cloudpay.kai.com/mobile/v1/auth/kai/callback';
export {
  KAI_OIDC_AUTHORIZATION_ENDPOINT,
  KAI_OIDC_ISSUER,
  KAI_OIDC_JWKS_URI,
  KAI_OIDC_SCOPE,
  KAI_OIDC_TOKEN_ENDPOINT,
  KAI_OIDC_USERINFO_ENDPOINT,
} from '../identity/kai-oidc-constants.js';
export { KaiIdTokenVerifier } from '../identity/kai-id-token-verifier.js';
export { KaiOidcClient } from '../identity/kai-oidc-client.js';

type RequestContext = Readonly<{ requestId: string; ip: string; userAgent: string }>;

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
    this.client = dependencies.client ?? new KaiOidcClient(this.clientId, clientSecret, KAI_OIDC_CALLBACK_URL);
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
