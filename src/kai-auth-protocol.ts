export const KAI_OIDC_ISSUER = 'https://auth.kai.com/api/auth';
export const KAI_OIDC_CLIENT_ID = 'xUTgWjuzpAz-JT-wDbTJxh9xoh3ssU7K';
export const KAI_AUTH_APP_REDIRECT = 'https://cloud.kai.com/zod/oauth2redirect/kai';
export const KAI_OIDC_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;
export const KAI_AUTH_CALLBACK_MAX_AGE_MILLISECONDS = 10 * 60 * 1_000;

export type KaiAuthCallback =
  | Readonly<{ kind: 'code'; code: string; state: string }>
  | Readonly<{ kind: 'error'; error: string; state: string }>
  | Readonly<{ kind: 'ignored' }>;

const safeOpaque = /^[A-Za-z0-9._~-]{32,256}$/u;

export function parseKaiAuthCallback(value: string): KaiAuthCallback {
  let url: URL;
  try { url = new URL(value); } catch { return { kind: 'ignored' }; }
  if (url.protocol !== 'https:' || url.hostname !== 'cloud.kai.com'
    || url.pathname !== '/zod/oauth2redirect/kai' || url.username || url.password || url.port) {
    return { kind: 'ignored' };
  }
  const state = url.searchParams.get('state');
  if (!state || !safeOpaque.test(state)) return { kind: 'error', error: 'invalid_callback', state: '' };
  const issuer = url.searchParams.get('iss');
  if (issuer !== KAI_OIDC_ISSUER) return { kind: 'error', error: 'issuer_mismatch', state };
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (code && code.length >= 20 && code.length <= 2_048 && !/[\u0000-\u001f\u007f]/u.test(code) && !error) {
    return { kind: 'code', code, state };
  }
  if (error && /^[a-z_]{3,80}$/u.test(error) && !code) return { kind: 'error', error, state };
  return { kind: 'error', error: 'invalid_callback', state };
}

export function validKaiAuthPending(createdAt: string, now = Date.now()) {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && timestamp <= now
    && now - timestamp <= KAI_AUTH_CALLBACK_MAX_AGE_MILLISECONDS;
}

export type KaiIdTokenClaims = Readonly<{
  iss: string;
  sub: string;
  aud: string | string[];
  nonce?: string;
  exp: number;
  iat: number;
  name?: string;
  email?: string;
}>;

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const bytes = globalThis.atob(padded);
  const escaped = Array.from(bytes, (character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  return decodeURIComponent(escaped);
}

export function parseKaiIdTokenClaims(idToken: string): KaiIdTokenClaims | null {
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const value: unknown = JSON.parse(decodeBase64Url(parts[1] ?? ''));
    if (!value || typeof value !== 'object') return null;
    const claims = value as Partial<KaiIdTokenClaims>;
    const audienceValid = typeof claims.aud === 'string'
      || (Array.isArray(claims.aud) && claims.aud.every((item) => typeof item === 'string'));
    if (typeof claims.iss !== 'string' || typeof claims.sub !== 'string' || !audienceValid
      || typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return null;
    return claims as KaiIdTokenClaims;
  } catch { return null; }
}

export function validateKaiIdTokenClaims(
  idToken: string,
  expected: Readonly<{ nonce?: string; subject?: string; nowMilliseconds?: number }>,
) {
  const claims = parseKaiIdTokenClaims(idToken);
  const nowSeconds = Math.floor((expected.nowMilliseconds ?? Date.now()) / 1_000);
  if (!claims || claims.iss !== KAI_OIDC_ISSUER || claims.sub.length < 1 || claims.sub.length > 500
    || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(KAI_OIDC_CLIENT_ID)
    || claims.exp <= nowSeconds - 5 || claims.iat > nowSeconds + 300
    || (expected.nonce !== undefined && claims.nonce !== expected.nonce)
    || (expected.subject !== undefined && claims.sub !== expected.subject)) {
    throw new Error('统一身份返回的身份信息未通过校验，请重新登录。');
  }
  return claims;
}
