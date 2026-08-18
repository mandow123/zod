import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { apiRequestWithAccessToken, LOCAL_E2E_DEMO_ENABLED } from './api-client';
import {
  KAI_AUTH_APP_REDIRECT,
  KAI_OIDC_CLIENT_ID,
  KAI_OIDC_SCOPES,
  parseKaiAuthCallback,
  validKaiAuthPending,
} from './kai-auth-protocol';
import { exchangeKaiAuthorizationCode, loadKaiOidcDiscovery, loadKaiUserInfo, revokeKaiOidcTokens } from './kai-oidc-client';
import { deviceDescriptor, saveKaiOidcSession, type CloudPayUser } from './session';

const PENDING_KEY = 'kai.cloudpay.auth.kai.pending.v2';
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type PendingKaiAuth = Readonly<{
  attemptId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  termsVersion: string;
  privacyVersion: string;
  createdAt: string;
}>;

let completionInFlight: Promise<boolean> | null = null;
let completionState: string | null = null;
let lastCompletedState: string | null = null;

WebBrowser.maybeCompleteAuthSession();

function randomOpaque() {
  return `${Crypto.randomUUID()}${Crypto.randomUUID()}`.replace(/-/gu, '');
}

async function loadPending() {
  const raw = await SecureStore.getItemAsync(PENDING_KEY, secureOptions);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingKaiAuth>;
    if (typeof value.attemptId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value.attemptId)
      || typeof value.state !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/u.test(value.state)
      || typeof value.nonce !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/u.test(value.nonce)
      || typeof value.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/u.test(value.codeVerifier)
      || typeof value.termsVersion !== 'string' || value.termsVersion.trim().length < 1 || value.termsVersion.length > 120
      || typeof value.privacyVersion !== 'string' || value.privacyVersion.trim().length < 1 || value.privacyVersion.length > 120
      || typeof value.createdAt !== 'string' || !validKaiAuthPending(value.createdAt)) return null;
    return value as PendingKaiAuth;
  } catch { return null; }
}

async function clearPending() {
  await SecureStore.deleteItemAsync(PENDING_KEY, secureOptions);
}

function authResultMessage(type: string, code?: string) {
  if (type === 'cancel' || type === 'dismiss' || code === 'access_denied') return '登录已取消。';
  if (type === 'locked') return '已有登录窗口正在进行，请先完成当前登录。';
  return '统一身份登录没有完成，请重试。';
}

export async function startKaiAuth(consents: Readonly<{ termsVersion: string; privacyVersion: string }>) {
  if (LOCAL_E2E_DEMO_ENABLED) throw new Error('本地验收版本请使用本机验证码。');
  if (!consents.termsVersion.trim() || !consents.privacyVersion.trim()
    || consents.termsVersion.length > 120 || consents.privacyVersion.length > 120) {
    throw new Error('请先阅读并同意当前版本的用户协议和隐私政策。');
  }
  const discovery = await loadKaiOidcDiscovery();
  const state = randomOpaque();
  const nonce = randomOpaque();
  const request = new AuthSession.AuthRequest({
    clientId: KAI_OIDC_CLIENT_ID,
    redirectUri: KAI_AUTH_APP_REDIRECT,
    responseType: AuthSession.ResponseType.Code,
    scopes: [...KAI_OIDC_SCOPES],
    usePKCE: true,
    codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
    state,
    extraParams: { nonce },
  });
  const authorizationUrl = await request.makeAuthUrlAsync(discovery);
  if (!request.codeVerifier || !/^[A-Za-z0-9._~-]{43,128}$/u.test(request.codeVerifier)) {
    throw new Error('本机没有生成有效的登录安全校验，请重试。');
  }
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify({
    attemptId: Crypto.randomUUID(),
    state,
    nonce,
    codeVerifier: request.codeVerifier,
    termsVersion: consents.termsVersion.trim(),
    privacyVersion: consents.privacyVersion.trim(),
    createdAt: new Date().toISOString(),
  } satisfies PendingKaiAuth), secureOptions);
  let result: AuthSession.AuthSessionResult;
  try {
    result = await request.promptAsync(discovery, { url: authorizationUrl });
  } catch (error) {
    await clearPending();
    throw error;
  }
  if (result.type !== 'success') {
    await clearPending();
    throw new Error(authResultMessage(result.type, result.type === 'error' ? result.error?.code : undefined));
  }
  return completeKaiAuth(result.url);
}

export function isKaiAuthCallback(url: string) {
  return parseKaiAuthCallback(url).kind !== 'ignored';
}

export async function completeKaiAuth(url: string) {
  const callback = parseKaiAuthCallback(url);
  if (callback.kind === 'ignored') return false;
  if (completionInFlight && completionState === callback.state) return completionInFlight;
  if (lastCompletedState === callback.state) return true;
  const pending = await loadPending();
  if (!pending) {
    await clearPending();
    throw new Error('本机登录请求已过期，请重新登录。');
  }
  if (!callback.state || callback.state !== pending.state) {
    throw new Error('登录返回与本机发起的请求不一致，请回到原登录窗口重试。');
  }
  if (callback.kind === 'error') {
    await clearPending();
    throw new Error(authResultMessage('error', callback.error));
  }
  completionState = callback.state;
  completionInFlight = (async () => {
    let tokens: Awaited<ReturnType<typeof exchangeKaiAuthorizationCode>> | null = null;
    try {
      tokens = await exchangeKaiAuthorizationCode({
        code: callback.code,
        codeVerifier: pending.codeVerifier,
        nonce: pending.nonce,
      });
      await loadKaiUserInfo(tokens.accessToken, tokens.subject);
      const profile = await apiRequestWithAccessToken<{ ok: true; user: CloudPayUser }>(
        '/mobile/v1/me', tokens.accessToken, tokens.idToken, { retry: false },
      );
      const consent = await apiRequestWithAccessToken<{
        ok: true;
        accepted: { termsVersion: string; privacyVersion: string };
        replayed: boolean;
      }>('/mobile/v1/auth/kai/consents', tokens.accessToken, tokens.idToken, {
        method: 'POST',
        retry: false,
        body: {
          termsVersion: pending.termsVersion,
          privacyVersion: pending.privacyVersion,
          attemptId: pending.attemptId,
        },
      });
      if (consent.ok !== true
        || consent.accepted.termsVersion !== pending.termsVersion
        || consent.accepted.privacyVersion !== pending.privacyVersion
        || typeof consent.replayed !== 'boolean') {
        throw new Error('协议同意记录没有完成，登录未保存，请重试。');
      }
      const device = await deviceDescriptor();
      await saveKaiOidcSession({
        ...tokens,
        accessExpiresInSeconds: tokens.expiresInSeconds,
        oidcSubject: tokens.subject,
        user: profile.user,
        deviceId: device.deviceId,
      });
      lastCompletedState = callback.state;
      return true;
    } catch (error) {
      if (tokens) await revokeKaiOidcTokens(tokens).catch(() => undefined);
      throw error;
    } finally {
      await clearPending();
    }
  })().finally(() => { completionInFlight = null; completionState = null; });
  return completionInFlight;
}
