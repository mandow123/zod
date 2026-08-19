import { Linking } from 'react-native';
import {
  LEGACY_KAI_AUTH_BROWSER_POLICY,
  type KaiAuthBrowserPolicy,
} from './kai-auth-browser-policy';

export function getKaiAuthBrowserPolicy() {
  return LEGACY_KAI_AUTH_BROWSER_POLICY;
}

export async function openKaiAuthBrowser(startUrl: string, _policy: KaiAuthBrowserPolicy) {
  await Linking.openURL(startUrl);
  return null;
}
