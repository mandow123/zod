export const KAI_AUTH_APP_REDIRECT = 'kaicloudpay://auth/kai/callback';
export const KAI_AUTH_CALLBACK_MAX_AGE_MILLISECONDS = 10 * 60 * 1_000;

export type KaiAuthCallback =
  | Readonly<{ kind: 'code'; code: string }>
  | Readonly<{ kind: 'error'; error: string }>
  | Readonly<{ kind: 'ignored' }>;

export function parseKaiAuthCallback(value: string): KaiAuthCallback {
  let url: URL;
  try { url = new URL(value); } catch { return { kind: 'ignored' }; }
  if (url.protocol !== 'kaicloudpay:' || url.hostname !== 'auth'
    || url.pathname !== '/kai/callback' || url.username || url.password || url.port) {
    return { kind: 'ignored' };
  }
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (code && /^[A-Za-z0-9_-]{43,128}$/u.test(code) && !error) return { kind: 'code', code };
  if (error && /^[a-z_]{3,80}$/u.test(error) && !code) return { kind: 'error', error };
  return { kind: 'error', error: 'invalid_callback' };
}

export function createKaiAuthStartUrl(apiBaseUrl: string, appCodeChallenge: string, consents: Readonly<{
  termsVersion: string;
  privacyVersion: string;
}>) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(appCodeChallenge)) throw new Error('Invalid App PKCE challenge.');
  const url = new URL('/mobile/v1/auth/kai/start', `${apiBaseUrl.replace(/\/+$/u, '')}/`);
  url.search = new URLSearchParams({
    appRedirect: KAI_AUTH_APP_REDIRECT,
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
