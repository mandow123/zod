import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../errors.js';
import type { RuntimeConfig } from '../config.js';
import { secretHash } from './crypto.js';
import type { KaiAccessIdentityStore } from './kai-identity-store.js';
import { LEGAL_VERSIONS, type AccountPrincipal } from './types.js';

export const KAI_AUTH_ISSUER = 'https://auth.kai.com/api/auth';
export const KAI_AUTH_PUBLIC_CLIENT_ID = 'xUTgWjuzpAz-JT-wDbTJxh9xoh3ssU7K';
export const KAI_AUTH_LOOPBACK_HOST = '127.0.0.1';
export const KAI_AUTH_LOOPBACK_PATH = '/oauth2redirect/kai';
export const KAI_AUTH_LOOPBACK_PORTS = [
  52711, 53419, 54127, 54833, 55603, 56311, 57119, 57901, 58687,
] as const;
export const KAI_AUTH_REDIRECT_URIS = KAI_AUTH_LOOPBACK_PORTS.map(
  (port) => `http://${KAI_AUTH_LOOPBACK_HOST}:${port}${KAI_AUTH_LOOPBACK_PATH}`,
);
export const KAI_AUTH_JWKS_URI = `${KAI_AUTH_ISSUER}/jwks`;
export const KAI_AUTH_USERINFO_ENDPOINT = `${KAI_AUTH_ISSUER}/oauth2/userinfo`;

export type VerifiedKaiAccess = Readonly<{
  issuer: typeof KAI_AUTH_ISSUER;
  subject: string;
  audiences: string[];
  scopes: string[];
  expiresAt: Date;
}>;

export interface KaiAccessTokenVerifier {
  verify(accessToken: string, idToken?: string): Promise<VerifiedKaiAccess>;
}

export interface ResourceAccessAuthenticator {
  authenticate(
    authorization: string | string[] | undefined,
    idToken?: string | string[],
    rawHeaders?: readonly string[],
    options?: Readonly<{ allowWithoutCurrentLegalConsents?: boolean }>,
  ): Promise<Readonly<{ principal: AccountPrincipal }>>;
}

function invalidAccessToken(): AppError {
  return new AppError('AUTH_ACCESS_TOKEN_INVALID', 401, '登录凭证无效或已过期，请重新登录。');
}

function audiences(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return [...new Set(value)];
  return [];
}

function validSubject(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function accessTokenHash(accessToken: string): string {
  return createHash('sha512').update(accessToken, 'utf8').digest().subarray(0, 32).toString('base64url');
}

function equalText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class KaiPairedOpaqueAccessTokenVerifier implements KaiAccessTokenVerifier {
  private readonly key: JWTVerifyGetKey;

  constructor(
    key?: JWTVerifyGetKey,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.key = key ?? createRemoteJWKSet(new URL(KAI_AUTH_JWKS_URI));
  }

  async verify(accessToken: string, idToken?: string): Promise<VerifiedKaiAccess> {
    try {
      if (!idToken) throw invalidAccessToken();
      const result = await jwtVerify(idToken, this.key, {
        issuer: KAI_AUTH_ISSUER,
        audience: KAI_AUTH_PUBLIC_CLIENT_ID,
        algorithms: ['EdDSA'],
        requiredClaims: ['sub', 'iat', 'exp', 'at_hash'],
      });
      if (!validSubject(result.payload.sub) || typeof result.payload.exp !== 'number'
        || typeof result.payload.iat !== 'number' || typeof result.payload.at_hash !== 'string') {
        throw invalidAccessToken();
      }
      const nowSeconds = Math.floor(Date.now() / 1_000);
      if (result.payload.iat > nowSeconds + 5 || result.payload.exp <= result.payload.iat) throw invalidAccessToken();
      const tokenAudiences = audiences(result.payload.aud);
      if (tokenAudiences.length > 1 && result.payload.azp !== KAI_AUTH_PUBLIC_CLIENT_ID) throw invalidAccessToken();
      if (tokenAudiences.length === 1 && result.payload.azp !== undefined
        && result.payload.azp !== KAI_AUTH_PUBLIC_CLIENT_ID) throw invalidAccessToken();
      if (!equalText(result.payload.at_hash, accessTokenHash(accessToken))) throw invalidAccessToken();

      const response = await this.fetcher(KAI_AUTH_USERINFO_ENDPOINT, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!response.ok || !contentType.startsWith('application/json')) throw invalidAccessToken();
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > 65_536) throw invalidAccessToken();
      const responseText = await response.text();
      if (Buffer.byteLength(responseText, 'utf8') > 65_536) throw invalidAccessToken();
      const profile = JSON.parse(responseText) as { sub?: unknown };
      if (!validSubject(profile.sub) || profile.sub !== result.payload.sub) throw invalidAccessToken();
      return {
        issuer: KAI_AUTH_ISSUER,
        subject: result.payload.sub,
        audiences: tokenAudiences,
        scopes: [],
        expiresAt: new Date(result.payload.exp * 1_000),
      };
    } catch {
      throw invalidAccessToken();
    }
  }
}

function bearer(authorization: string | string[] | undefined): string {
  if (typeof authorization !== 'string' || authorization.length > 8_199) throw invalidAccessToken();
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/u);
  if (!match?.[1]) throw invalidAccessToken();
  if (match[1].length > 8_192 || match[1].split('.').length === 3) throw invalidAccessToken();
  return match[1];
}

function proof(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)) throw invalidAccessToken();
  return value;
}

function exactlyOne(rawHeaders: readonly string[] | undefined, name: string) {
  if (!rawHeaders) return;
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  if (count !== 1) throw invalidAccessToken();
}

export class KaiResourceAccessAuthenticator implements ResourceAccessAuthenticator {
  constructor(
    private readonly verifier: KaiAccessTokenVerifier,
    private readonly identities: KaiAccessIdentityStore,
    private readonly subjectPepper: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authenticate(
    authorization: string | string[] | undefined,
    idToken?: string | string[],
    rawHeaders?: readonly string[],
    options?: Readonly<{ allowWithoutCurrentLegalConsents?: boolean }>,
  ) {
    exactlyOne(rawHeaders, 'authorization');
    exactlyOne(rawHeaders, 'x-kai-id-token');
    const verified = await this.verifier.verify(bearer(authorization), proof(idToken));
    // The issuer is stored in its own unique-key column. Keep the existing broker's
    // subject hash derivation so the same issuer+sub reuses the established local identity.
    const subjectHash = secretHash(verified.subject, this.subjectPepper);
    const user = await this.identities.resolveAccessIdentity({
      issuer: verified.issuer,
      subjectHash,
      now: this.now(),
    });
    if (user.status !== 'active') throw new AppError('ACCOUNT_NOT_ACTIVE', 403, '当前账号不可用。');
    if (!options?.allowWithoutCurrentLegalConsents && !user.currentLegalConsents) {
      throw new AppError('LEGAL_CONSENT_REQUIRED', 428, '请先确认最新的用户协议与隐私政策。', {
        current: { termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy },
      });
    }
    return {
      principal: {
        userId: user.userId,
        sessionId: `kai-access:${subjectHash.slice(0, 32)}`,
        role: user.role,
      },
    } as const;
  }
}

export function createKaiResourceAccessAuthenticator(
  config: RuntimeConfig,
  identities: KaiAccessIdentityStore,
): KaiResourceAccessAuthenticator | null {
  if (!config.readiness.capabilities.kaiResourceAccess.available || !config.KAI_OIDC_SUBJECT_PEPPER
    || !config.KAI_RESOURCE_ACCESS_TOKEN_FORMAT) return null;
  if (config.KAI_RESOURCE_ACCESS_TOKEN_FORMAT === 'opaque') {
    return new KaiResourceAccessAuthenticator(
      new KaiPairedOpaqueAccessTokenVerifier(), identities, config.KAI_OIDC_SUBJECT_PEPPER,
    );
  }
  return null;
}
