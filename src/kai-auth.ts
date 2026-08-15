import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Linking } from 'react-native';
import { apiRequest, API_BASE_URL, LOCAL_E2E_DEMO_ENABLED } from './api-client';
import {
  createKaiAuthStartUrl,
  parseKaiAuthCallback,
  validKaiAuthPending,
} from './kai-auth-protocol';
import { deviceDescriptor, saveSession, type CloudPayUser } from './session';

const PENDING_KEY = 'kai.cloudpay.auth.kai.pending.v1';
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type PendingKaiAuth = Readonly<{ codeVerifier: string; createdAt: string }>;

function base64Url(value: string) {
  return value.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

async function codeChallenge(verifier: string) {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return base64Url(digest);
}

async function loadPending() {
  const raw = await SecureStore.getItemAsync(PENDING_KEY, secureOptions);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingKaiAuth>;
    if (typeof value.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/u.test(value.codeVerifier)
      || typeof value.createdAt !== 'string' || !validKaiAuthPending(value.createdAt)) return null;
    return value as PendingKaiAuth;
  } catch { return null; }
}

export async function startKaiAuth(consents: Readonly<{ termsVersion: string; privacyVersion: string }>) {
  if (LOCAL_E2E_DEMO_ENABLED) throw new Error('本地验收版本请使用本机验证码。');
  const codeVerifier = `${Crypto.randomUUID()}${Crypto.randomUUID()}`;
  const challenge = await codeChallenge(codeVerifier);
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify({
    codeVerifier,
    createdAt: new Date().toISOString(),
  } satisfies PendingKaiAuth), secureOptions);
  try {
    await Linking.openURL(createKaiAuthStartUrl(API_BASE_URL, challenge, consents));
  } catch (error) {
    await SecureStore.deleteItemAsync(PENDING_KEY, secureOptions);
    throw error;
  }
}

export function isKaiAuthCallback(url: string) {
  return parseKaiAuthCallback(url).kind !== 'ignored';
}

export async function completeKaiAuth(url: string) {
  const callback = parseKaiAuthCallback(url);
  if (callback.kind === 'ignored') return false;
  if (callback.kind === 'error') {
    await SecureStore.deleteItemAsync(PENDING_KEY, secureOptions);
    throw new Error(callback.error === 'authentication_cancelled'
      ? '登录已取消。' : '统一身份登录没有完成，请重试。');
  }
  const pending = await loadPending();
  if (!pending) {
    await SecureStore.deleteItemAsync(PENDING_KEY, secureOptions);
    throw new Error('本机登录请求已过期，请重新登录。');
  }
  const device = await deviceDescriptor();
  try {
    const response = await apiRequest<{ ok: true; result: {
      kind: 'session';
      accessToken: string;
      refreshToken: string;
      accessExpiresInSeconds: number;
      refreshExpiresAt: string;
      user: CloudPayUser;
    } }>('/mobile/v1/auth/kai/exchange', {
      method: 'POST', retry: false,
      body: { code: callback.code, codeVerifier: pending.codeVerifier, device },
    });
    await saveSession({ ...response.result, deviceId: device.deviceId });
    return true;
  } finally {
    await SecureStore.deleteItemAsync(PENDING_KEY, secureOptions);
  }
}
