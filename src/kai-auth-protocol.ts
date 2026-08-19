export const KAI_AUTH_APP_REDIRECT = 'kaicloudpay://auth/kai/callback';
export const KAI_AUTH_UNIVERSAL_REDIRECT = 'https://cloudpay.kai.com/mobile/auth/kai/callback';
export const KAI_AUTH_CALLBACK_MAX_AGE_MILLISECONDS = 10 * 60 * 1_000;

export type KaiAuthCallback =
  | Readonly<{ kind: 'code'; code: string }>
  | Readonly<{ kind: 'error'; error: string }>
  | Readonly<{ kind: 'ignored' }>;

export function parseKaiAuthCallback(value: string): KaiAuthCallback {
  let url: URL;
  try { url = new URL(value); } catch { return { kind: 'ignored' }; }
  if (!isKaiAuthCallbackUrl(value)) return { kind: 'ignored' };
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (code && /^[A-Za-z0-9_-]{43,128}$/u.test(code) && !error) return { kind: 'code', code };
  if (error && /^[a-z_]{3,80}$/u.test(error) && !code) return { kind: 'error', error };
  return { kind: 'error', error: 'invalid_callback' };
}

export function isKaiAuthCallbackUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const customScheme = url.protocol === 'kaicloudpay:' && url.hostname === 'auth'
    && url.pathname === '/kai/callback';
  const universalLink = url.protocol === 'https:' && url.hostname === 'cloudpay.kai.com'
    && url.pathname === '/mobile/auth/kai/callback';
  return (customScheme || universalLink) && !url.username && !url.password && !url.port && !url.hash;
}

export function createKaiAuthStartUrl(apiBaseUrl: string, appCodeChallenge: string, consents: Readonly<{
  termsVersion: string;
  privacyVersion: string;
}>, appRedirect = KAI_AUTH_APP_REDIRECT) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(appCodeChallenge)) throw new Error('Invalid App PKCE challenge.');
  if (![KAI_AUTH_APP_REDIRECT, KAI_AUTH_UNIVERSAL_REDIRECT].includes(appRedirect)) {
    throw new Error('Invalid App authentication redirect.');
  }
  const url = new URL('/mobile/v1/auth/kai/start', `${apiBaseUrl.replace(/\/+$/u, '')}/`);
  url.search = new URLSearchParams({
    appRedirect,
    appChallenge: appCodeChallenge,
    appChallengeMethod: 'S256',
    termsVersion: consents.termsVersion,
    privacyVersion: consents.privacyVersion,
  }).toString();
  return url.toString();
}

export function validKaiAuthPending(createdAt: string, now = Date.now()) {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && timestamp <= now
    && now - timestamp <= KAI_AUTH_CALLBACK_MAX_AGE_MILLISECONDS;
}
