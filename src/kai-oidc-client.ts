import * as AuthSession from 'expo-auth-session';
import { TokenTypeHint, type TokenResponse } from 'expo-auth-session';
import {
  KAI_OIDC_CLIENT_ID,
  KAI_OIDC_ISSUER,
  KAI_OIDC_SCOPES,
  validKaiAuthRedirectUri,
  validateKaiIdTokenClaims,
} from './kai-auth-protocol';

export type KaiOidcTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: 'Bearer';
  scope: string;
  expiresInSeconds: number;
  subject: string;
}>;

export class KaiOidcRefreshValidationError extends Error {
  readonly name = 'KaiOidcRefreshValidationError';
  constructor(
    message: string,
    public readonly revocationCandidate: Readonly<{ accessToken: string; refreshToken: string }>,
  ) { super(message); }
}

export function isDefinitiveKaiOidcTokenInvalid(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; params?: unknown };
  if (candidate.code === 'invalid_grant') return true;
  return Boolean(candidate.params && typeof candidate.params === 'object'
    && (candidate.params as { error?: unknown }).error === 'invalid_grant');
}

let discoveryInFlight: Promise<AuthSession.DiscoveryDocument> | null = null;

function requiredEndpoint(value: string | undefined, label: string) {
  if (!value) throw new Error(`统一身份没有提供${label}，当前无法安全登录。`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'auth.kai.com'
    || !url.pathname.startsWith('/api/auth/')) {
    throw new Error(`统一身份${label}地址未通过安全校验。`);
  }
  return value;
}

export async function loadKaiOidcDiscovery() {
  discoveryInFlight ??= AuthSession.fetchDiscoveryAsync(KAI_OIDC_ISSUER)
    .then((discovery) => {
      const issuer = discovery.discoveryDocument?.issuer;
      if (issuer !== KAI_OIDC_ISSUER) throw new Error('统一身份服务来源未通过校验。');
      requiredEndpoint(discovery.authorizationEndpoint, '授权');
      requiredEndpoint(discovery.tokenEndpoint, '令牌');
      requiredEndpoint(discovery.revocationEndpoint, '撤销');
      requiredEndpoint(discovery.userInfoEndpoint, '账户资料');
      return discovery;
    })
    .catch((error) => { discoveryInFlight = null; throw error; });
  return discoveryInFlight;
}

function scopeSet(value: string) {
  return new Set(value.split(/\s+/u).filter(Boolean));
}

function validateBaseResponse(response: TokenResponse) {
  if (typeof response.accessToken !== 'string' || response.accessToken.length < 20
    || String(response.tokenType).toLowerCase() !== 'bearer'
    || !Number.isInteger(response.expiresIn) || (response.expiresIn ?? 0) < 30 || (response.expiresIn ?? 0) > 3_600) {
    throw new Error('统一身份返回的登录凭证不完整，请重新登录。');
  }
}

function requireScope(value: string | undefined) {
  if (!value || KAI_OIDC_SCOPES.some((scope) => !scopeSet(value).has(scope))) {
    throw new Error('统一身份没有授予完整的账户权限，请重新登录。');
  }
  return value;
}

export async function exchangeKaiAuthorizationCode(input: Readonly<{
  code: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}>) {
  if (!validKaiAuthRedirectUri(input.redirectUri)) {
    throw new Error('本机登录回调地址未通过安全校验。');
  }
  const discovery = await loadKaiOidcDiscovery();
  const response = await AuthSession.exchangeCodeAsync({
    clientId: KAI_OIDC_CLIENT_ID,
    code: input.code,
    redirectUri: input.redirectUri,
    extraParams: { code_verifier: input.codeVerifier },
  }, discovery);
  validateBaseResponse(response);
  if (typeof response.refreshToken !== 'string' || response.refreshToken.length < 20
    || typeof response.idToken !== 'string' || response.idToken.length < 40) {
    throw new Error('统一身份没有返回可续期的登录凭证，请重新登录。');
  }
  const claims = validateKaiIdTokenClaims(response.idToken, { nonce: input.nonce });
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    idToken: response.idToken,
    tokenType: 'Bearer',
    scope: requireScope(response.scope),
    expiresInSeconds: response.expiresIn as number,
    subject: claims.sub,
  } satisfies KaiOidcTokens;
}

export async function refreshKaiOidcTokens(current: KaiOidcTokens) {
  const discovery = await loadKaiOidcDiscovery();
  const response = await AuthSession.refreshAsync({
    clientId: KAI_OIDC_CLIENT_ID,
    refreshToken: current.refreshToken,
    scopes: [...KAI_OIDC_SCOPES],
  }, discovery);
  const revocationCandidate = {
    accessToken: typeof response.accessToken === 'string' && response.accessToken.length >= 20
      ? response.accessToken : current.accessToken,
    refreshToken: typeof response.refreshToken === 'string' && response.refreshToken.length >= 20
      ? response.refreshToken : current.refreshToken,
  };
  try {
    validateBaseResponse(response);
    if (typeof response.refreshToken !== 'string' || response.refreshToken.length < 20
      || response.refreshToken === current.refreshToken
      || typeof response.idToken !== 'string' || response.idToken.length < 40) {
      throw new Error('统一身份没有完成刷新凭证轮换，登录已安全停止。');
    }
    const claims = validateKaiIdTokenClaims(response.idToken, { subject: current.subject });
    return {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      idToken: response.idToken,
      tokenType: 'Bearer',
      scope: requireScope(response.scope),
      expiresInSeconds: response.expiresIn as number,
      subject: claims.sub,
    } satisfies KaiOidcTokens;
  } catch (error) {
    throw new KaiOidcRefreshValidationError(
      error instanceof Error ? error.message : '刷新凭证未通过安全校验。',
      revocationCandidate,
    );
  }
}

export async function loadKaiUserInfo(accessToken: string, expectedSubject: string) {
  const discovery = await loadKaiOidcDiscovery();
  const profile = await AuthSession.fetchUserInfoAsync({ accessToken }, discovery);
  if (typeof profile.sub !== 'string' || profile.sub !== expectedSubject) {
    throw new Error('统一身份账户资料与登录结果不一致，请重新登录。');
  }
  return profile;
}

export async function revokeKaiOidcTokens(tokens: Readonly<{ refreshToken: string; accessToken: string }>) {
  const discovery = await loadKaiOidcDiscovery();
  const failures: unknown[] = [];
  for (const request of [
    {
      token: tokens.accessToken,
      tokenTypeHint: TokenTypeHint.AccessToken,
    },
    {
      token: tokens.refreshToken,
      tokenTypeHint: TokenTypeHint.RefreshToken,
    },
  ] as const) {
    try {
      await AuthSession.revokeAsync({
      clientId: KAI_OIDC_CLIENT_ID,
        token: request.token,
        tokenTypeHint: request.tokenTypeHint,
      }, discovery);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error('已退出本机，但统一身份凭证撤销未全部确认。');
  }
}
