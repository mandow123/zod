import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import {
  KaiOidcRefreshValidationError,
  isDefinitiveKaiOidcTokenInvalid,
  refreshKaiOidcTokens,
  revokeKaiOidcTokens,
} from './kai-oidc-client';
import { queueKaiOidcRevocation } from './kai-revocation-queue';
import { clearSession, loadSession, updateKaiOidcSessionTokens } from './session';
import { distributionChannel } from './distribution';

const configuredBase = String(Constants.expoConfig?.extra?.cloudPayBaseUrl ?? 'https://cloudpay.kai.com').replace(/\/+$/u, '');
const allowInsecureApiForLocalE2e = Constants.expoConfig?.extra?.allowInsecureApiForLocalE2e === true;
const localE2eSessionToken = typeof Constants.expoConfig?.extra?.localE2eSessionToken === 'string'
  ? Constants.expoConfig.extra.localE2eSessionToken : null;
if (!/^https:\/\//u.test(configuredBase) && !__DEV__ && !allowInsecureApiForLocalE2e) throw new Error('CloudPay API must use HTTPS.');
export const API_BASE_URL = configuredBase;
export const LOCAL_E2E_DEMO_ENABLED = allowInsecureApiForLocalE2e && Boolean(localE2eSessionToken);

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly requestId: string | null = null,
  ) { super(message); this.name = 'ApiError'; }
}

type RequestOptions = Readonly<{
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  auth?: 'none' | 'optional' | 'required';
  headers?: Record<string, string>;
  retry?: boolean;
}>;

let refreshInFlight: Promise<string | null> | null = null;
let sessionLogoutInProgress = false;

async function parseResponse<T>(response: Response): Promise<T> {
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new ApiError('RESPONSE_INVALID', response.status, '服务返回了无法识别的数据。'); }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; requestId?: string } }).error;
    throw new ApiError(error?.code ?? `HTTP_${response.status}`, response.status, error?.message ?? '服务暂时不可用。', error?.requestId ?? null);
  }
  return payload as T;
}

async function rawRequest<T>(path: string, options: RequestOptions, accessToken?: string, idToken?: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET', signal: controller.signal,
      headers: {
        Accept: 'application/json', 'x-request-id': Crypto.randomUUID(),
        'x-kai-distribution-channel': distributionChannel,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(idToken ? { 'X-KAI-ID-Token': idToken } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return await parseResponse<T>(response);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ApiError('NETWORK_TIMEOUT', 0, '连接超时，请检查网络后重试。');
    throw new ApiError('NETWORK_UNAVAILABLE', 0, '当前网络不可用，请稍后重试。');
  } finally { clearTimeout(timeout); }
}

async function refreshAccessToken() {
  if (sessionLogoutInProgress) return null;
  refreshInFlight ??= (async () => {
    const session = await loadSession();
    if (!session || sessionLogoutInProgress) return null;
    try {
      const response = await refreshKaiOidcTokens({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        idToken: session.idToken,
        tokenType: 'Bearer',
        scope: session.scope,
        expiresInSeconds: Math.max(1, Math.floor((Date.parse(session.accessExpiresAt) - Date.now()) / 1_000)),
        subject: session.oidcSubject,
      });
      const updated = await updateKaiOidcSessionTokens({
        ...response,
        oidcSubject: response.subject,
        accessExpiresInSeconds: response.expiresInSeconds,
      });
      return updated?.accessToken ?? null;
    } catch (error) {
      if (error instanceof KaiOidcRefreshValidationError) {
        try {
          await queueKaiOidcRevocation(error.revocationCandidate);
          await clearSession();
        } catch {
          throw new Error('登录刷新未完成，本机仍保留原登录以便安全重试。');
        }
      } else if (isDefinitiveKaiOidcTokenInvalid(error)) {
        await clearSession();
      }
      throw error;
    }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function retireRejectedPairedSession() {
  const current = await loadSession();
  if (!current) return;
  try {
    await revokeKaiOidcTokens(current);
  } catch {
    try {
      await queueKaiOidcRevocation(current);
    } catch {
      throw new ApiError(
        'AUTH_REVOCATION_PERSIST_FAILED',
        0,
        '登录状态无法安全撤销，本机仍保留当前登录；请联网后重试。',
      );
    }
  }
  await clearSession();
}

async function handlePairedRequestFailure(error: unknown): Promise<never> {
  if (error instanceof ApiError && error.status === 401) await retireRejectedPairedSession();
  throw error;
}

export async function beginSessionLogout() {
  sessionLogoutInProgress = true;
  try { await refreshInFlight; } catch { /* Logout continues and clears the local session. */ }
}

export function endSessionLogout() {
  sessionLogoutInProgress = false;
}

export function apiRequestWithAccessToken<T>(
  path: string,
  accessToken: string,
  idToken: string,
  options: RequestOptions = {},
) {
  if (!accessToken || accessToken.length < 20 || !idToken || idToken.length < 40) {
    throw new ApiError('AUTH_REQUIRED', 401, '请先登录。');
  }
  return rawRequest<T>(path, { ...options, auth: 'none' }, accessToken, idToken);
}

function sessionIdToken(session: Awaited<ReturnType<typeof loadSession>>) { return session?.idToken; }

export async function apiRequest<T>(path: string, options: RequestOptions = {}) {
  const auth = options.auth ?? 'none';
  let session = auth === 'none' ? null : await loadSession();
  if (session && new Date(session.accessExpiresAt).getTime() - Date.now() < 30_000) {
    const token = await refreshAccessToken();
    session = token ? await loadSession() : null;
  }
  if (auth === 'required' && !session) throw new ApiError('AUTH_REQUIRED', 401, '请先登录。');
  const execute = () => rawRequest<T>(path, options, session?.accessToken, sessionIdToken(session));
  try {
    return await execute();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && session) {
      const latestSession = await loadSession();
      if (latestSession && latestSession.accessToken !== session.accessToken) {
        session = latestSession;
        try {
          return await rawRequest<T>(path, options, session.accessToken, sessionIdToken(session));
        } catch (latestError) {
          return handlePairedRequestFailure(latestError);
        }
      }
      const token = await refreshAccessToken();
      if (!token) throw error;
      session = await loadSession();
      try {
        return await rawRequest<T>(path, options, session?.accessToken, sessionIdToken(session));
      } catch (retryError) {
        return handlePairedRequestFailure(retryError);
      }
    }
    const shouldRetry = options.retry ?? (options.method === undefined || options.method === 'GET');
    if (shouldRetry
      && error instanceof ApiError && (error.status === 0 || [502, 503, 504].includes(error.status))) {
      return rawRequest<T>(path, options, session?.accessToken, sessionIdToken(session));
    }
    throw error;
  }
}
