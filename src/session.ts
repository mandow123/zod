import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { clearProviderReadCache } from './provider-read-cache';
import { parsePreservingStoredValue } from './kai-auth-flow-policy';

const SESSION_KEY = 'kai.cloudpay.session.v1';
const VERIFIED_IDENTITY_KEY = 'kai.cloudpay.auth.verified-identity.v1';
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

export type VerifiedKaiIdentity = Readonly<{
  status: 'verified_pending_consent';
  attemptId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: 'Bearer';
  scope: string;
  oidcSubject: string;
  accessExpiresAt: string;
  verifiedAt: string;
  connectionReason?: VerifiedKaiConnectionReason;
  lastAttemptAt?: string;
}>;

export type VerifiedKaiConnectionReason =
  | 'identity_verified'
  | 'identity_confirmation_unavailable'
  | 'platform_network_unavailable'
  | 'platform_response_invalid'
  | 'platform_not_accepted'
  | 'platform_server_error'
  | 'platform_configuration_pending';

const verifiedKaiConnectionReasons: readonly VerifiedKaiConnectionReason[] = [
  'identity_verified',
  'identity_confirmation_unavailable',
  'platform_network_unavailable',
  'platform_response_invalid',
  'platform_not_accepted',
  'platform_server_error',
  'platform_configuration_pending',
];

export class VerifiedKaiIdentityIntegrityError extends Error {
  readonly name = 'VerifiedKaiIdentityIntegrityError';
  constructor() { super('本机保存的 KAI 验证状态无法安全读取，原始状态已保留，请联系支持。'); }
}

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

function validVerifiedIdentity(value: unknown): value is VerifiedKaiIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<VerifiedKaiIdentity>;
  return identity.status === 'verified_pending_consent'
    && typeof identity.attemptId === 'string' && /^[0-9a-f-]{36}$/iu.test(identity.attemptId)
    && typeof identity.accessToken === 'string' && identity.accessToken.length > 20
    && typeof identity.refreshToken === 'string' && identity.refreshToken.length > 20
    && typeof identity.idToken === 'string' && identity.idToken.length > 40
    && identity.tokenType === 'Bearer' && typeof identity.scope === 'string'
    && typeof identity.oidcSubject === 'string' && identity.oidcSubject.length > 0
    && typeof identity.accessExpiresAt === 'string' && Number.isFinite(Date.parse(identity.accessExpiresAt))
    && typeof identity.verifiedAt === 'string' && Number.isFinite(Date.parse(identity.verifiedAt))
    && (identity.connectionReason === undefined
      || verifiedKaiConnectionReasons.includes(identity.connectionReason))
    && (identity.lastAttemptAt === undefined
      || (typeof identity.lastAttemptAt === 'string' && Number.isFinite(Date.parse(identity.lastAttemptAt))));
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

export async function loadVerifiedKaiIdentity() {
  const raw = await SecureStore.getItemAsync(VERIFIED_IDENTITY_KEY, secureOptions);
  if (!raw) return null;
  try {
    return parsePreservingStoredValue(raw, validVerifiedIdentity);
  } catch {
    throw new VerifiedKaiIdentityIntegrityError();
  }
}

export async function saveVerifiedKaiIdentity(input: Readonly<{
  attemptId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  scope: string;
  oidcSubject: string;
  accessExpiresInSeconds: number;
  verifiedAt?: string;
  connectionReason?: VerifiedKaiConnectionReason;
  lastAttemptAt?: string;
}>) {
  const now = new Date().toISOString();
  const identity: VerifiedKaiIdentity = {
    status: 'verified_pending_consent',
    attemptId: input.attemptId,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    idToken: input.idToken,
    tokenType: 'Bearer',
    scope: input.scope,
    oidcSubject: input.oidcSubject,
    accessExpiresAt: new Date(Date.now() + input.accessExpiresInSeconds * 1_000).toISOString(),
    verifiedAt: input.verifiedAt ?? now,
    connectionReason: input.connectionReason ?? 'identity_verified',
    lastAttemptAt: input.lastAttemptAt ?? now,
  };
  await SecureStore.setItemAsync(VERIFIED_IDENTITY_KEY, JSON.stringify(identity), secureOptions);
  return identity;
}

export async function updateVerifiedKaiConnectionStatus(
  identity: VerifiedKaiIdentity,
  connectionReason: VerifiedKaiConnectionReason,
  lastAttemptAt = new Date().toISOString(),
) {
  const updated: VerifiedKaiIdentity = { ...identity, connectionReason, lastAttemptAt };
  await SecureStore.setItemAsync(VERIFIED_IDENTITY_KEY, JSON.stringify(updated), secureOptions);
  return updated;
}

export async function clearVerifiedKaiIdentity() {
  await SecureStore.deleteItemAsync(VERIFIED_IDENTITY_KEY, secureOptions);
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
    SecureStore.deleteItemAsync(VERIFIED_IDENTITY_KEY, secureOptions),
    clearProviderReadCache(),
  ]);
}
