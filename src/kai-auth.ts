import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform } from 'react-native';
import {
  acknowledgePersistedKaiAuthCallbackAsync,
  cancelKaiAuthLoopbackAsync,
  isKaiAuthLoopbackActiveAsync,
  peekPersistedKaiAuthCallbackAsync,
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
  validKaiAuthExchangeRecovery,
  validKaiAuthPending,
} from './kai-auth-protocol';
import {
  exchangeKaiAuthorizationCode,
  isDefinitiveKaiOidcTokenInvalid,
  KaiOidcExchangeValidationError,
  KaiOidcExchangeNetworkError,
  KaiOidcUserInfoError,
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
  classifyAuthorizationExchangeFailure,
  platformPendingReason,
  persistRotatedVerifiedIdentity,
  resolvePlatformUnauthorized,
  retireVerifiedIdentityWithFallback,
  sameAuthLegalDocuments,
  shouldClearPendingAfterKaiAuthStartFailure,
} from './kai-auth-flow-policy';
import {
  clearVerifiedKaiIdentity,
  deviceDescriptor,
  loadVerifiedKaiIdentity,
  saveKaiOidcSession,
  saveVerifiedKaiIdentity,
  updateVerifiedKaiConnectionStatus,
  type CloudPayUser,
  type VerifiedKaiConnectionReason,
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
  phase: 'browser_open' | 'authorization_received' | 'authorization_error' | 'exchanging';
  authorizationCode?: string;
  authorizationError?: 'authorization_failed';
  callbackReceivedAt?: string;
  lastAttemptAt: string;
}>;

export type KaiAuthProgress =
  | Readonly<{
    kind: 'identity_pending';
    reason: 'identity_exchange_retry' | 'identity_authorization_failed';
    lastAttemptAt: string;
  }>
  | Readonly<{
    kind: 'verified_pending';
    reason: VerifiedKaiConnectionReason;
    lastAttemptAt: string;
  }>
  | Readonly<{
    kind: 'consent_required';
    reason: 'legal_consent_required';
    lastAttemptAt: string;
    documents: LegalDocuments;
  }>;

export function kaiAuthProgressMessage(progress: KaiAuthProgress) {
  if (progress.kind === 'identity_pending') {
    if (progress.reason === 'identity_authorization_failed') {
      return 'KAI 登录未完成。可重新验证账号，业务功能仍保持锁定。';
    }
    return '授权结果已安全保存，身份确认时网络中断。可直接重试，业务功能仍保持锁定。';
  }
  if (progress.kind === 'consent_required') {
    return 'KAI 账号已验证。阅读并同意平台当前协议后，才能启用业务功能。';
  }
  const messages: Record<VerifiedKaiConnectionReason, string> = {
    identity_verified: 'KAI 账号已验证，Zod 平台服务待连接。业务功能仍保持锁定。',
    identity_confirmation_unavailable: 'KAI 验证状态已安全保留，身份服务暂时无法再次确认。请稍后重试。',
    platform_network_unavailable: 'KAI 账号已验证，但当前无法连接 Zod 平台。请检查网络后重试。',
    platform_response_invalid: 'KAI 账号已验证，但 Zod 当前返回的不是移动服务数据。请稍后重试。',
    platform_not_accepted: 'KAI 账号仍有效，但 Zod 平台尚未接受此连接。请稍后重试。',
    platform_server_error: 'KAI 账号已验证，但 Zod 平台服务暂时异常。请稍后重试。',
    platform_configuration_pending: 'KAI 账号已验证，但 Zod 平台配置尚未就绪。请稍后重试。',
  };
  return messages[progress.reason];
}

export function kaiAuthLastAttemptLabel(progress: KaiAuthProgress) {
  const attempted = new Date(progress.lastAttemptAt);
  if (!Number.isFinite(attempted.getTime())) return '最近尝试时间待同步';
  const hours = String(attempted.getHours()).padStart(2, '0');
  const minutes = String(attempted.getMinutes()).padStart(2, '0');
  return `最近尝试 ${hours}:${minutes}`;
}

export class PendingKaiAuthIntegrityError extends Error {
  readonly name = 'PendingKaiAuthIntegrityError';
  constructor() { super('本机保存的登录请求无法安全读取，原始状态已保留，请联系支持。'); }
}

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
    const phase = value.phase ?? 'browser_open';
    const lastAttemptAt = value.lastAttemptAt ?? value.createdAt;
    if (typeof value.attemptId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value.attemptId)
      || typeof value.state !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/u.test(value.state)
      || typeof value.nonce !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/u.test(value.nonce)
      || typeof value.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/u.test(value.codeVerifier)
      || typeof value.redirectUri !== 'string' || !validKaiAuthRedirectUri(value.redirectUri)
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || !['browser_open', 'authorization_received', 'authorization_error', 'exchanging'].includes(phase)
      || typeof lastAttemptAt !== 'string' || !Number.isFinite(Date.parse(lastAttemptAt))
      || (['authorization_received', 'exchanging'].includes(phase) && (typeof value.authorizationCode !== 'string'
        || value.authorizationCode.length < 20 || value.authorizationCode.length > 2_048
        || /[\u0000-\u001f\u007f]/u.test(value.authorizationCode)
        || typeof value.callbackReceivedAt !== 'string' || !Number.isFinite(Date.parse(value.callbackReceivedAt))))
      || (phase === 'authorization_error' && (value.authorizationError !== 'authorization_failed'
        || typeof value.callbackReceivedAt !== 'string' || !Number.isFinite(Date.parse(value.callbackReceivedAt))))) {
      throw new PendingKaiAuthIntegrityError();
    }
    if (!validKaiAuthPending(value.createdAt)) {
      await clearPending();
      return null;
    }
    return { ...value, phase, lastAttemptAt } as PendingKaiAuth;
  } catch (error) {
    if (error instanceof PendingKaiAuthIntegrityError) throw error;
    throw new PendingKaiAuthIntegrityError();
  }
}

async function savePending(pending: PendingKaiAuth) {
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(pending), secureOptions);
  return pending;
}

async function clearPending() {
  await SecureStore.deleteItemAsync(PENDING_KEY, secureOptions);
}

async function acknowledgeAndClearPending(pending: Pick<PendingKaiAuth, 'attemptId' | 'state'>) {
  await acknowledgePersistedKaiAuthCallbackAsync(pending.attemptId, pending.state);
  await clearPending();
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

function progressForVerifiedIdentity(identity: VerifiedKaiIdentity): Extract<KaiAuthProgress, { kind: 'verified_pending' }> {
  return {
    kind: 'verified_pending',
    reason: identity.connectionReason ?? 'identity_verified',
    lastAttemptAt: identity.lastAttemptAt ?? identity.verifiedAt,
  };
}

function verifiedReasonForPlatformFailure(cause: unknown): VerifiedKaiConnectionReason {
  return platformPendingReason({
    ...(cause instanceof ApiError ? { apiStatus: cause.status, apiCode: cause.code } : {}),
    identityConfirmationUnavailable: cause instanceof KaiOidcUserInfoError && cause.status === 0,
  });
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
      verifiedAt: identity.verifiedAt,
      connectionReason: identity.connectionReason,
      lastAttemptAt: identity.lastAttemptAt,
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

function callbackReceivedAtIso(receivedAt: number) {
  const iso = new Date(receivedAt).toISOString();
  if (!validKaiAuthExchangeRecovery(iso)) {
    throw new Error('本机授权结果已过期，请重新登录。');
  }
  return iso;
}

async function adoptKaiAuthCallback(
  pending: PendingKaiAuth,
  callback: ReturnType<typeof parseKaiAuthCallback>,
  receivedAt: number,
  acknowledgeNative: boolean,
) {
  if (callback.kind === 'ignored' || !callback.state || callback.state !== pending.state) {
    throw new Error('登录返回与本机发起的请求不一致，请回到原登录窗口重试。');
  }
  const callbackReceivedAt = callbackReceivedAtIso(receivedAt);
  if (callback.kind === 'error') {
    const failed = await savePending({
      ...pending,
      phase: 'authorization_error',
      authorizationError: 'authorization_failed',
      authorizationCode: undefined,
      callbackReceivedAt,
      lastAttemptAt: callbackReceivedAt,
    });
    if (acknowledgeNative) {
      await acknowledgePersistedKaiAuthCallbackAsync(pending.attemptId, pending.state);
    }
    return failed;
  }
  const received = await savePending({
    ...pending,
    phase: 'authorization_received',
    authorizationCode: callback.code,
    authorizationError: undefined,
    callbackReceivedAt,
    lastAttemptAt: callbackReceivedAt,
  });
  return received;
}

async function recoverPersistedKaiAuthCallback(pending: PendingKaiAuth) {
  const recovered = await peekPersistedKaiAuthCallbackAsync(pending.attemptId);
  if (!recovered) return pending;
  if (recovered.attemptId !== pending.attemptId || recovered.state !== pending.state
    || !Number.isFinite(recovered.receivedAt)) {
    throw new Error('本机保存的登录返回与当前请求不一致，原始状态已保留。');
  }
  if (pending.phase === 'authorization_error') {
    await acknowledgePersistedKaiAuthCallbackAsync(pending.attemptId, pending.state);
    return pending;
  }
  if (pending.phase !== 'browser_open') {
    const callback = parseKaiAuthCallbackFields(recovered);
    if (callback.kind !== 'code' || callback.code !== pending.authorizationCode) {
      throw new Error('本机保存的登录返回与待交换授权不一致，原始状态已保留。');
    }
    return pending;
  }
  return adoptKaiAuthCallback(
    pending,
    parseKaiAuthCallbackFields(recovered),
    recovered.receivedAt,
    true,
  );
}

export async function resumeVerifiedKaiAuth(): Promise<KaiAuthProgress | null> {
  const stored = await loadVerifiedKaiIdentity();
  if (!stored) {
    const loaded = await loadPending();
    const pending = loaded ? await recoverPersistedKaiAuthCallback(loaded) : null;
    if (pending?.phase === 'authorization_error') {
      return {
        kind: 'identity_pending', reason: 'identity_authorization_failed', lastAttemptAt: pending.lastAttemptAt,
      };
    }
    if (!pending || pending.phase === 'browser_open' || !pending.callbackReceivedAt
      || !validKaiAuthExchangeRecovery(pending.callbackReceivedAt)) return null;
    return completePendingAuthorization(pending);
  }
  const completedPending = await loadPending();
  if (completedPending) await acknowledgeAndClearPending(completedPending);
  let identity = stored;
  try {
    identity = await currentVerifiedIdentity(stored);
  } catch (error) {
    const failure = classifyVerifiedStageFailure({
      stage: 'identity',
      ...(error instanceof ApiError ? { apiStatus: error.status, apiCode: error.code } : {}),
      definitiveInvalid: isDefinitiveKaiOidcTokenInvalid(error),
    });
    if (failure === 'require_reauthentication') {
      await retireVerifiedIdentity(identity);
      throw new Error('KAI 账号验证已失效，请重新登录。');
    }
    if (failure === 'retain_pending') {
      const retained = await updateVerifiedKaiConnectionStatus(identity, 'identity_confirmation_unavailable');
      return progressForVerifiedIdentity(retained);
    }
    throw error;
  }
  try {
    const bootstrap = await platformBootstrap(identity);
    return {
      kind: 'consent_required',
      reason: 'legal_consent_required',
      lastAttemptAt: new Date().toISOString(),
      documents: bootstrap.documents,
    };
  } catch (error) {
    const cause = error instanceof PlatformBootstrapError ? error.cause : error;
    if (cause instanceof ApiError && cause.status === 401) {
      const resolution = await resolvePlatformUnauthorized({
        identity,
        confirmIdentity: (current) => loadKaiUserInfo(current.accessToken, current.oidcSubject).then(() => undefined),
        definitiveInvalid: isDefinitiveKaiOidcTokenInvalid,
        retire: retireVerifiedIdentity,
      });
      if (resolution === 'reauthenticate') throw new Error('KAI 账号验证已失效，请重新登录。');
      const retained = await updateVerifiedKaiConnectionStatus(identity,
        resolution === 'retain_platform_not_accepted' ? 'platform_not_accepted' : 'identity_confirmation_unavailable');
      return progressForVerifiedIdentity(retained);
    }
    const reason = verifiedReasonForPlatformFailure(cause);
    const retained = await updateVerifiedKaiConnectionStatus(identity, reason);
    return progressForVerifiedIdentity(retained);
  }
}

export async function loadKaiAuthProgress(): Promise<KaiAuthProgress | null> {
  const verified = await loadVerifiedKaiIdentity();
  if (verified) return progressForVerifiedIdentity(verified);
  const loaded = await loadPending();
  const pending = loaded ? await recoverPersistedKaiAuthCallback(loaded) : null;
  if (pending?.phase === 'authorization_error') {
    return {
      kind: 'identity_pending', reason: 'identity_authorization_failed', lastAttemptAt: pending.lastAttemptAt,
    };
  }
  if (!pending || pending.phase === 'browser_open' || !pending.callbackReceivedAt) return null;
  if (!validKaiAuthExchangeRecovery(pending.callbackReceivedAt)) {
    await acknowledgeAndClearPending(pending);
    return null;
  }
  return { kind: 'identity_pending', reason: 'identity_exchange_retry', lastAttemptAt: pending.lastAttemptAt };
}

export async function cancelVerifiedKaiAuth() {
  const identity = await loadVerifiedKaiIdentity();
  if (identity) await retireVerifiedIdentity(identity);
  const pending = await loadPending();
  if (pending) {
    await cancelKaiAuthLoopbackAsync(pending.attemptId).catch(() => undefined);
    await acknowledgePersistedKaiAuthCallbackAsync(pending.attemptId, pending.state);
    await clearPending();
  }
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
    if (cause instanceof ApiError && cause.status === 401) {
      const resolution = await resolvePlatformUnauthorized({
        identity,
        confirmIdentity: (current) => loadKaiUserInfo(current.accessToken, current.oidcSubject).then(() => undefined),
        definitiveInvalid: isDefinitiveKaiOidcTokenInvalid,
        retire: retireVerifiedIdentity,
      });
      if (resolution === 'reauthenticate') throw new Error('KAI 账号验证已失效，请重新登录。');
      if (resolution === 'retain_identity_confirmation_unavailable') {
        await updateVerifiedKaiConnectionStatus(identity, 'identity_confirmation_unavailable');
        throw new Error('KAI 账号仍保留验证状态，身份服务暂时无法确认，请稍后重试。');
      }
      await updateVerifiedKaiConnectionStatus(identity, 'platform_not_accepted');
      throw new Error('KAI 账号仍有效，但 Zod 平台尚未接受连接，请稍后重试。');
    }
    const failure = classifyVerifiedResumeFailure({
      ...(cause instanceof ApiError ? { apiStatus: cause.status, apiCode: cause.code } : {}),
      definitiveInvalid: isDefinitiveKaiOidcTokenInvalid(cause),
    });
    if (failure === 'require_reauthentication') {
      await retireVerifiedIdentity(identity);
      throw new Error('KAI 账号验证已失效，请重新登录。');
    }
    if (cause instanceof ApiError || error instanceof PlatformBootstrapError) {
      await updateVerifiedKaiConnectionStatus(identity, verifiedReasonForPlatformFailure(cause));
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
  if (existing?.kind === 'identity_pending' && existing.reason === 'identity_authorization_failed') {
    const failed = await loadPending();
    if (failed) {
      await acknowledgePersistedKaiAuthCallbackAsync(failed.attemptId, failed.state);
      await clearPending();
    }
  } else if (existing) return existing;
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
  let callbackReceived = false;
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
    const createdAt = new Date().toISOString();
    await savePending({
      attemptId,
      state,
      nonce,
      codeVerifier: request.codeVerifier,
      redirectUri: listener.redirectUri,
      createdAt,
      phase: 'browser_open',
      lastAttemptAt: createdAt,
    });
    pendingPersisted = true;
    const callback = await openKaiAuthBrowserAndWait(attemptId, authorizationUrl);
    callbackReceived = true;
    return completeKaiAuthCallback(callback);
  } catch (error) {
    await cancelKaiAuthLoopbackAsync(attemptId).catch(() => undefined);
    if (pendingPersisted && !callbackReceived) {
      try {
        const current = await loadPending();
        if (shouldClearPendingAfterKaiAuthStartFailure({
          callbackReceived,
          attemptId,
          currentAttemptId: current?.attemptId,
          currentPhase: current?.phase,
        })) {
          await clearPending();
        }
      } catch {
        // Preserve unreadable or partially updated state for the explicit recovery path.
      }
    }
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
  return completeParsedKaiAuth(parseKaiAuthCallback(url), Date.now(), false);
}

async function completeKaiAuthCallback(fields: KaiLoopbackCallback) {
  if (!Number.isFinite(fields.receivedAt)) {
    throw new Error('本机登录返回缺少安全时间戳，请重新登录。');
  }
  return completeParsedKaiAuth(parseKaiAuthCallbackFields(fields), fields.receivedAt as number, true);
}

async function completeParsedKaiAuth(
  callback: ReturnType<typeof parseKaiAuthCallback>,
  receivedAt: number,
  acknowledgeNative: boolean,
) {
  if (callback.kind === 'ignored') return false;
  if (completionInFlight && completionState === callback.state) return completionInFlight;
  if (lastCompletion?.state === callback.state) return lastCompletion.progress;
  const pending = await loadPending();
  if (!pending) {
    await clearPending();
    throw new Error('本机登录请求已过期，请重新登录。');
  }
  const received = await adoptKaiAuthCallback(pending, callback, receivedAt, acknowledgeNative);
  if (callback.kind === 'error') throw new Error(authResultMessage('error', callback.error));
  completionState = callback.state;
  completionInFlight = completePendingAuthorization(received)
    .then((progress) => {
      lastCompletion = { state: callback.state, progress };
      return progress;
    })
    .finally(() => { completionInFlight = null; completionState = null; });
  return completionInFlight;
}

function isRetryableExchangeNetworkFailure(error: unknown) {
  if (error instanceof KaiOidcExchangeNetworkError) return true;
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ERR_NETWORK' || code === 'NETWORK_ERROR';
}

async function completePendingAuthorization(pending: PendingKaiAuth): Promise<KaiAuthProgress> {
  if (!pending.authorizationCode || !pending.callbackReceivedAt
    || !validKaiAuthExchangeRecovery(pending.callbackReceivedAt)) {
    await acknowledgeAndClearPending(pending);
    throw new Error('本机授权结果已过期，请重新登录。');
  }
  const authorizationCode = pending.authorizationCode;
  const callbackReceivedAt = pending.callbackReceivedAt;
  const lastAttemptAt = new Date().toISOString();
  const exchanging = await savePending({ ...pending, phase: 'exchanging', lastAttemptAt });
  let tokens: Awaited<ReturnType<typeof exchangeKaiAuthorizationCode>> | null = null;
  let verifiedSaved = false;
  try {
    tokens = await exchangeKaiAuthorizationCode({
      code: authorizationCode,
      codeVerifier: exchanging.codeVerifier,
      nonce: exchanging.nonce,
      redirectUri: exchanging.redirectUri,
    });
    await loadKaiUserInfo(tokens.accessToken, tokens.subject);
    await saveVerifiedKaiIdentity({
      attemptId: exchanging.attemptId,
      ...tokens,
      oidcSubject: tokens.subject,
      accessExpiresInSeconds: tokens.expiresInSeconds,
      connectionReason: 'identity_verified',
      lastAttemptAt,
    });
    verifiedSaved = true;
    await acknowledgeAndClearPending(exchanging);
    const progress = await resumeVerifiedKaiAuth();
    return progress ?? {
      kind: 'verified_pending', reason: 'identity_verified', lastAttemptAt,
    };
  } catch (error) {
    if (error instanceof KaiOidcExchangeValidationError) {
      if (!error.revocationCandidate) {
        throw new Error('KAI 返回的凭证无法安全校验或撤销，本机保留授权状态，请联系支持。');
      }
      await retireVerifiedIdentityWithFallback({
        revoke: () => revokeKaiOidcTokens(error.revocationCandidate as NonNullable<typeof error.revocationCandidate>),
        queueRevocation: () => queueKaiOidcRevocation(
          error.revocationCandidate as NonNullable<typeof error.revocationCandidate>,
        ),
        clear: () => acknowledgeAndClearPending(exchanging),
      });
      throw new Error('KAI 返回的凭证未通过安全校验，已安排安全撤销，请重新验证账号。');
    }
    const failure = classifyAuthorizationExchangeFailure({
      retryableNetwork: !tokens && isRetryableExchangeNetworkFailure(error),
      definitiveInvalid: isDefinitiveKaiOidcTokenInvalid(error),
      recoveryWindowValid: validKaiAuthExchangeRecovery(callbackReceivedAt),
    });
    if (failure === 'retain_encrypted_authorization') {
      const retryAt = new Date().toISOString();
      await savePending({ ...exchanging, phase: 'authorization_received', lastAttemptAt: retryAt });
      return { kind: 'identity_pending', reason: 'identity_exchange_retry', lastAttemptAt: retryAt };
    }
    if (verifiedSaved) {
      throw new Error('账号已验证，本机登录状态尚未完成安全收口，请重新打开 App 继续。');
    }
    if (tokens && !verifiedSaved) {
      await retireVerifiedIdentityWithFallback({
        revoke: () => revokeKaiOidcTokens(tokens as NonNullable<typeof tokens>),
        queueRevocation: () => queueKaiOidcRevocation(tokens as NonNullable<typeof tokens>),
        clear: async () => undefined,
      });
    }
    await acknowledgeAndClearPending(exchanging);
    if (failure === 'restart_authorization') {
      throw new Error('KAI 授权结果已失效，请重新验证账号。');
    }
    throw error;
  }
}
