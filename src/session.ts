import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { clearProviderReadCache } from './provider-read-cache';

const SESSION_KEY = 'kai.cloudpay.session.v1';
const DEVICE_KEY = 'kai.cloudpay.device.v1';
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type CloudPayUser = Readonly<{
  id: string;
  displayName: string;
  phone: string | null;
  email?: string | null;
  role: 'member' | 'supplier' | 'operator' | 'admin';
  status: 'pending' | 'active' | 'suspended' | 'deletion_pending' | 'anonymized';
  createdAt: string;
}>;

export type StoredSession = Readonly<{
  authProvider: 'kai_oidc';
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: 'Bearer';
  scope: string;
  oidcSubject: string;
  accessExpiresAt: string;
  refreshExpiresAt: null;
  deviceId: string;
  user: CloudPayUser;
}>;

function validSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<StoredSession>;
  return session.authProvider === 'kai_oidc'
    && typeof session.accessToken === 'string' && session.accessToken.length > 20
    && typeof session.refreshToken === 'string' && session.refreshToken.length > 20
    && typeof session.accessExpiresAt === 'string' && Number.isFinite(Date.parse(session.accessExpiresAt))
    && typeof session.idToken === 'string' && session.idToken.length > 40
    && session.tokenType === 'Bearer' && typeof session.scope === 'string'
    && typeof session.oidcSubject === 'string' && session.oidcSubject.length > 0
    && session.refreshExpiresAt === null
    && typeof session.deviceId === 'string' && session.deviceId.length >= 8
    && Boolean(session.user && typeof session.user.id === 'string' && typeof session.user.displayName === 'string');
}

export async function deviceDescriptor() {
  let deviceId = await SecureStore.getItemAsync(DEVICE_KEY, secureOptions);
  if (!deviceId) {
    deviceId = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_KEY, deviceId, secureOptions);
  }
  return {
    deviceId,
    appVersion: Constants.expoConfig?.version ?? '1.0.0',
    platform: Platform.OS === 'ios' ? 'ios' as const : 'android' as const,
  };
}

export async function loadSession() {
  const raw = await SecureStore.getItemAsync(SESSION_KEY, secureOptions);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!validSession(value)) {
      await clearSession();
      return null;
    }
    return value;
  } catch {
    await clearSession();
    return null;
  }
}

export async function saveSession(input: Readonly<{
  accessToken: string; refreshToken: string; accessExpiresInSeconds: number; refreshExpiresAt: string;
  user: CloudPayUser; deviceId?: string;
}>) {
  void input;
  throw new Error('旧登录会话仅允许在本地验收构建中保存。');
}

export async function saveKaiOidcSession(input: Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string;
  scope: string;
  oidcSubject: string;
  accessExpiresInSeconds: number;
  user: CloudPayUser;
  deviceId?: string;
}>) {
  const device = input.deviceId ? { deviceId: input.deviceId } : await deviceDescriptor();
  const session: StoredSession = {
    authProvider: 'kai_oidc',
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    idToken: input.idToken,
    tokenType: 'Bearer',
    scope: input.scope,
    oidcSubject: input.oidcSubject,
    accessExpiresAt: new Date(Date.now() + input.accessExpiresInSeconds * 1_000).toISOString(),
    refreshExpiresAt: null,
    deviceId: device.deviceId,
    user: input.user,
  };
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), secureOptions);
  return session;
}

export async function updateSessionTokens(input: Readonly<{
  accessToken: string; refreshToken: string; accessExpiresInSeconds: number; refreshExpiresAt: string;
}>) {
  void input;
  return null;
}

export async function updateKaiOidcSessionTokens(input: Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string;
  scope: string;
  oidcSubject: string;
  accessExpiresInSeconds: number;
}>) {
  const current = await loadSession();
  if (!current || current.authProvider !== 'kai_oidc') return null;
  return saveKaiOidcSession({ ...input, deviceId: current.deviceId, user: current.user });
}

export async function updateSessionUser(user: CloudPayUser) {
  const current = await loadSession();
  if (!current) return null;
  const updated = { ...current, user };
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(updated), secureOptions);
  return updated;
}

export async function clearSession() {
  await Promise.all([
    SecureStore.deleteItemAsync(SESSION_KEY, secureOptions),
    clearProviderReadCache(),
  ]);
}
