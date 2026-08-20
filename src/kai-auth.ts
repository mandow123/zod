import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform } from 'react-native';
import {
  cancelKaiAuthLoopbackAsync,
  isKaiAuthLoopbackActiveAsync,
  startKaiAuthLoopbackAsync,
  waitForKaiAuthLoopbackCallbackAsync,
  type KaiLoopbackCallback,
} from '../modules/kai-auth-loopback';
import { ApiError, apiRequestWithAccessToken, LOCAL_E2E_DEMO_ENABLED } from './api-client';
import type { LegalDocuments } from './api';
import {
  KAI_OIDC_CLIENT_ID,
  KAI_OIDC_ISSUER,
  KAI_OIDC_SCOPES,
  parseKaiAuthCallback,
  parseKaiAuthCallbackFields,
  validKaiAuthRedirectUri,
  validKaiAuthPending,
} from './kai-auth-protocol';
import {
  exchangeKaiAuthorizationCode,
  isDefinitiveKaiOidcTokenInvalid,
  KaiOidcRefreshValidationError,
  loadKaiOidcDiscovery,
  loadKaiUserInfo,
  refreshKaiOidcTokens,
  revokeKaiOidcTokens,
} from './kai-oidc-client';
import { queueKaiOidcRevocation } from './kai-revocation-queue';
import {
  classifyVerifiedResumeFailure,
  classifyVerifiedStageFailure,
  persistRotatedVerifiedIdentity,
  retireVerifiedIdentityWithFallback,
  runVerifiedBootstrap,
  sameAuthLegalDocuments,
} from './kai-auth-flow-policy';
import {
  clearVerifiedKaiIdentity,
  deviceDescriptor,
  loadVerifiedKaiIdentity,
  saveKaiOidcSession,
  saveVerifiedKaiIdentity,
  type CloudPayUser,
  type VerifiedKaiIdentity,
} from './session';

const PENDING_KEY = 'kai.cloudpay.auth.kai.pending.v2';
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type PendingKaiAuth = Readonly<{
  attemptId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
}>;

export type KaiAuthProgress =
  | Readonly<{ kind: 'verified_pending' }>
  | Readonly<{ kind: 'consent_required'; documents: LegalDocuments }>;

let completionInFlight: Promise<KaiAuthProgress> | null = null;
let completionState: string | null = null;
let lastCompletion: Readonly<{ state: string; progress: KaiAuthProgress }> | null = null;
let consentInFlight: Promise<boolean> | null = null;

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
      || typeof value.redirectUri !== 'string' || !validKaiAuthRedirectUri(value.redirectUri)
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

function validLegalDocument(value: unknown): value is { version: string; url: string } {
  if (!value || typeof value !== 'object') return false;
  const document = value as { version?: unknown; url?: unknown };
  if (typeof document.version !== 'string' || !document.version.trim() || document.version.length > 40
    || typeof document.url !== 'string') return false;
  try {
    const url = new URL(document.url);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

function requireLegalDocuments(value: unknown): LegalDocuments {
  if (!value || typeof value !== 'object') throw new Error('平台没有返回可核验的协议，请稍后重试。');
  const documents = value as Partial<LegalDocuments>;
  if (!validLegalDocument(documents.terms) || !validLegalDocument(documents.privacy)) {
    throw new Error('平台没有返回可核验的协议，请稍后重试。');
  }
  return documents as LegalDocuments;
}

class PlatformBootstrapError extends Error {
  readonly name = 'PlatformBootstrapError';
  constructor(public readonly cause: unknown) { super('平台服务待连接。'); }
}

export class KaiLegalDocumentsChangedError extends Error {
  readonly name = 'KaiLegalDocumentsChangedError';
  constructor(public readonly documents: LegalDocuments) {
    super('协议已更新，请重新阅读后确认。');
  }
}

async function retireVerifiedIdentity(identity: VerifiedKaiIdentity) {
  await retireVerifiedIdentityWithFallback({
    revoke: () => revokeKaiOidcTokens(identity),
    queueRevocation: () => queueKaiOidcRevocation(identity),
    clear: clearVerifiedKaiIdentity,
  });
}

async function currentVerifiedIdentity(identity: VerifiedKaiIdentity) {
  if (Date.parse(identity.accessExpiresAt) - Date.now() >= 30_000) return identity;
  let refreshed: Awaited<ReturnType<typeof refreshKaiOidcTokens>>;
  try {
    refreshed = await refreshKaiOidcTokens({
      accessToken: identity.accessToken,
      refreshToken: identity.refreshToken,
      idToken: identity.idToken,
      tokenType: identity.tokenType,
      scope: identity.scope,
      expiresInSeconds: 1,
      subject: identity.oidcSubject,
    });
  } catch (error) {
    if (error instanceof KaiOidcRefreshValidationError) {
      try { await queueKaiOidcRevocation(error.revocationCandidate); }
      catch { throw new Error('新凭证未通过校验且暂时无法安全撤销，本机保留待处理状态。'); }
    }
    throw error;
  }
  return persistRotatedVerifiedIdentity({
    save: () => saveVerifiedKaiIdentity({
      attemptId: identity.attemptId,
      ...refreshed,
      oidcSubject: refreshed.subject,
      accessExpiresInSeconds: refreshed.expiresInSeconds,
    }),
    queueRevocation: () => queueKaiOidcRevocation(refreshed),
  });
}

async function platformBootstrap(identity: VerifiedKaiIdentity) {
  try {
    const profile = await apiRequestWithAccessToken<{ ok: true; user: CloudPayUser }>(
      '/mobile/v1/me', identity.accessToken, identity.idToken, { retry: false },
    );
    const legal = await apiRequestWithAccessToken<{ ok: true; documents: LegalDocuments }>(
      '/mobile/v1/legal', identity.accessToken, identity.idToken, { retry: false },
    );
    return { user: profile.user, documents: requireLegalDocuments(legal.documents) };
  } catch (error) { throw new PlatformBootstrapError(error); }
}

export async function resumeVerifiedKaiAuth(): Promise<KaiAuthProgress | null> {
  const stored = await loadVerifiedKaiIdentity();
  if (!stored) return null;
  const result = await runVerifiedBootstrap({
    stored,
    refresh: currentVerifiedIdentity,
    bootstrap: platformBootstrap,
    classify: (error) => {
      const cause = error instanceof PlatformBootstrapError ? error.cause : error;
      return classifyVerifiedStageFailure({
        stage: error instanceof PlatformBootstrapError ? 'platform' : 'identity',
        ...(cause instanceof ApiError ? { apiStatus: cause.status, apiCode: cause.code } : {}),
        definitiveInvalid: isDefinitiveKaiOidcTokenInvalid(cause),
      });
    },
    retire: retireVerifiedIdentity,
  });
  if (result.kind === 'pending') return { kind: 'verified_pending' };
  if (result.kind === 'reauthenticate') throw new Error('KAI 账号验证已失效，请重新登录。');
  return { kind: 'consent_required', documents: result.value.documents };
}

export async function cancelVerifiedKaiAuth() {
  const identity = await loadVerifiedKaiIdentity();
  if (identity) await retireVerifiedIdentity(identity);
}

async function acceptVerifiedKaiConsentsOnce(documents: LegalDocuments) {
  const stored = await loadVerifiedKaiIdentity();
  if (!stored) throw new Error('KAI 账号验证已过期，请重新登录。');
  let identity = stored;
  try {
    identity = await currentVerifiedIdentity(stored);
    const bootstrap = await platformBootstrap(identity);
    if (!sameAuthLegalDocuments(bootstrap.documents, documents)) {
      throw new KaiLegalDocumentsChangedError(bootstrap.documents);
    }
    const consent = await apiRequestWithAccessToken<{
      ok: true;
      accepted: { termsVersion: string; privacyVersion: string };
      replayed: boolean;
    }>('/mobile/v1/auth/kai/consents', identity.accessToken, identity.idToken, {
      method: 'POST',
      retry: false,
      body: {
        termsVersion: documents.terms.version,
        privacyVersion: documents.privacy.version,
        attemptId: identity.attemptId,
      },
    });
    if (consent.ok !== true
      || consent.accepted.termsVersion !== documents.terms.version
      || consent.accepted.privacyVersion !== documents.privacy.version
      || typeof consent.replayed !== 'boolean') {
      throw new Error('协议同意记录没有完成，平台登录尚未完成。');
    }
    const device = await deviceDescriptor();
    await saveKaiOidcSession({
      accessToken: identity.accessToken,
      refreshToken: identity.refreshToken,
      idToken: identity.idToken,
      scope: identity.scope,
      oidcSubject: identity.oidcSubject,
      accessExpiresInSeconds: Math.max(1, Math.floor((Date.parse(identity.accessExpiresAt) - Date.now()) / 1_000)),
      user: bootstrap.user,
      deviceId: device.deviceId,
    });
    await clearVerifiedKaiIdentity();
    return true;
  } catch (error) {
    const cause = error instanceof PlatformBootstrapError ? error.cause : error;
    const failure = classifyVerifiedResumeFailure({
      ...(cause instanceof ApiError ? { apiStatus: cause.status, apiCode: cause.code } : {}),
      definitiveInvalid: isDefinitiveKaiOidcTokenInvalid(cause),
    });
    if (failure === 'require_reauthentication') {
      await retireVerifiedIdentity(identity);
      throw new Error('KAI 账号验证已失效，请重新登录。');
    }
    throw error;
  }
}

export function acceptVerifiedKaiConsents(documents: LegalDocuments) {
  consentInFlight ??= acceptVerifiedKaiConsentsOnce(documents)
    .finally(() => { consentInFlight = null; });
  return consentInFlight;
}

export async function startKaiAuth() {
  if (LOCAL_E2E_DEMO_ENABLED) throw new Error('本地验收版本请使用本机验证码。');
  if (Platform.OS !== 'android') throw new Error('当前登录回跳仅支持 Android 正式客户端。');
  const existing = await resumeVerifiedKaiAuth();
  if (existing) return existing;
  const interrupted = await loadPending();
  if (interrupted) {
    if (await isKaiAuthLoopbackActiveAsync(interrupted.attemptId)) {
      throw new Error('已有登录窗口正在进行，请先完成当前登录。');
    }
    await clearPending();
    throw new Error('上次登录因客户端中断而失效，请重新点击登录。');
  }
  const discovery = await loadKaiOidcDiscovery();
  const state = randomOpaque();
  const nonce = randomOpaque();
  const attemptId = Crypto.randomUUID();
  let pendingPersisted = false;
  try {
    const listener = await startKaiAuthLoopbackAsync(attemptId, state, KAI_OIDC_ISSUER);
    if (!validKaiAuthRedirectUri(listener.redirectUri)) {
      throw new Error('本机登录监听地址未通过安全校验。');
    }
    const request = new AuthSession.AuthRequest({
      clientId: KAI_OIDC_CLIENT_ID,
      redirectUri: listener.redirectUri,
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
      attemptId,
      state,
      nonce,
      codeVerifier: request.codeVerifier,
      redirectUri: listener.redirectUri,
      createdAt: new Date().toISOString(),
    } satisfies PendingKaiAuth), secureOptions);
    pendingPersisted = true;
    const callback = await openKaiAuthBrowserAndWait(attemptId, authorizationUrl);
    return completeKaiAuthCallback(callback);
  } catch (error) {
    await cancelKaiAuthLoopbackAsync(attemptId).catch(() => undefined);
    if (pendingPersisted) await clearPending();
    throw error;
  }
}

async function openKaiAuthBrowserAndWait(attemptId: string, authorizationUrl: string) {
  let browserWasBackgrounded = false;
  let notifyBrowserReturned: (() => void) | null = null;
  const browserReturned = new Promise<void>((resolve) => { notifyBrowserReturned = resolve; });
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'background' || next === 'inactive') browserWasBackgrounded = true;
    else if (next === 'active' && browserWasBackgrounded) notifyBrowserReturned?.();
  });
  const callback = waitForKaiAuthLoopbackCallbackAsync(attemptId);
  try {
    const browser = WebBrowser.openBrowserAsync(authorizationUrl, {
      showTitle: true,
      enableBarCollapsing: false,
      enableDefaultShareMenuItem: false,
    }).then((opened) => {
      if (opened.type !== 'opened') throw new Error('系统浏览器没有打开，请重试。');
      return new Promise<never>(() => undefined);
    });
    const outcome = await Promise.race([
      callback.then((value) => ({ kind: 'callback' as const, value })),
      browserReturned.then(() => ({ kind: 'browser_returned' as const })),
      browser,
    ]);
    if (outcome.kind === 'callback') return outcome.value;
    if (!await isKaiAuthLoopbackActiveAsync(attemptId)) return callback;
    await cancelKaiAuthLoopbackAsync(attemptId);
    await callback.catch(() => undefined);
    throw new Error(authResultMessage('cancel'));
  } catch (error) {
    await cancelKaiAuthLoopbackAsync(attemptId).catch(() => undefined);
    throw error;
  } finally {
    subscription.remove();
  }
}

export function isKaiAuthCallback(url: string) {
  return parseKaiAuthCallback(url).kind !== 'ignored';
}

export async function completeKaiAuth(url: string) {
  return completeParsedKaiAuth(parseKaiAuthCallback(url));
}

async function completeKaiAuthCallback(fields: KaiLoopbackCallback) {
  return completeParsedKaiAuth(parseKaiAuthCallbackFields(fields));
}

async function completeParsedKaiAuth(callback: ReturnType<typeof parseKaiAuthCallback>) {
  if (callback.kind === 'ignored') return false;
  if (completionInFlight && completionState === callback.state) return completionInFlight;
  if (lastCompletion?.state === callback.state) return lastCompletion.progress;
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
    let verifiedSaved = false;
    try {
      tokens = await exchangeKaiAuthorizationCode({
        code: callback.code,
        codeVerifier: pending.codeVerifier,
        nonce: pending.nonce,
        redirectUri: pending.redirectUri,
      });
      await loadKaiUserInfo(tokens.accessToken, tokens.subject);
      await saveVerifiedKaiIdentity({
        attemptId: pending.attemptId,
        ...tokens,
        oidcSubject: tokens.subject,
        accessExpiresInSeconds: tokens.expiresInSeconds,
      });
      verifiedSaved = true;
      const progress = await resumeVerifiedKaiAuth() ?? { kind: 'verified_pending' } as const;
      lastCompletion = { state: callback.state, progress };
      return progress;
    } catch (error) {
      if (tokens && !verifiedSaved) {
        await retireVerifiedIdentityWithFallback({
          revoke: () => revokeKaiOidcTokens(tokens as NonNullable<typeof tokens>),
          queueRevocation: () => queueKaiOidcRevocation(tokens as NonNullable<typeof tokens>),
          clear: async () => undefined,
        });
      }
      throw error;
    } finally {
      await clearPending();
    }
  })().finally(() => { completionInFlight = null; completionState = null; });
  return completionInFlight;
}
