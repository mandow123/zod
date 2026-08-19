import {
  KAI_AUTH_APP_REDIRECT,
  KAI_AUTH_UNIVERSAL_REDIRECT,
} from './kai-auth-protocol.ts';

export type KaiAuthBrowserPolicy = Readonly<{
  redirectUrl: typeof KAI_AUTH_APP_REDIRECT | typeof KAI_AUTH_UNIVERSAL_REDIRECT;
  preferUniversalLinks: boolean;
}>;

export function resolveIosKaiAuthBrowserPolicy(
  universalLinksEnabled: boolean,
  systemVersion: string | number,
): KaiAuthBrowserPolicy {
  const match = /^(\d+)(?:\.(\d+))?/u.exec(String(systemVersion).trim());
  const major = match ? Number.parseInt(match[1], 10) : Number.NaN;
  const minor = match?.[2] ? Number.parseInt(match[2], 10) : 0;
  const supportsUniversalAuthCallback = major > 17 || (major === 17 && minor >= 4);

  return universalLinksEnabled && supportsUniversalAuthCallback
    ? { redirectUrl: KAI_AUTH_UNIVERSAL_REDIRECT, preferUniversalLinks: true }
    : { redirectUrl: KAI_AUTH_APP_REDIRECT, preferUniversalLinks: false };
}

export const LEGACY_KAI_AUTH_BROWSER_POLICY: KaiAuthBrowserPolicy = Object.freeze({
  redirectUrl: KAI_AUTH_APP_REDIRECT,
  preferUniversalLinks: false,
});
