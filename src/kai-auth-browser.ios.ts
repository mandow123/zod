import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { interpretKaiAuthSessionResult, type KaiAuthSessionResult } from './kai-auth-browser-result';
import {
  resolveIosKaiAuthBrowserPolicy,
  type KaiAuthBrowserPolicy,
} from './kai-auth-browser-policy';

export const KAI_AUTH_BROWSER_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;

export function getKaiAuthBrowserPolicy() {
  return resolveIosKaiAuthBrowserPolicy(
    Constants.expoConfig?.extra?.kaiAuthUniversalLinksEnabled === true,
    Platform.Version,
  );
}

export async function openKaiAuthBrowser(startUrl: string, policy: KaiAuthBrowserPolicy) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<KaiAuthSessionResult>((resolve) => {
    timeout = setTimeout(() => {
      try { WebBrowser.dismissAuthSession(); } catch { /* The session may already be closing. */ }
      resolve({ type: 'timeout' });
    }, KAI_AUTH_BROWSER_TIMEOUT_MILLISECONDS);
  });
  try {
    const result = await Promise.race([
      WebBrowser.openAuthSessionAsync(startUrl, policy.redirectUrl, {
        preferUniversalLinks: policy.preferUniversalLinks,
      }),
      timedOut,
    ]);
    return interpretKaiAuthSessionResult(result as KaiAuthSessionResult);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
