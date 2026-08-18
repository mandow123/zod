import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { clearSession, loadSession, updateSessionTokens } from './session';
import { distributionChannel } from './distribution';

const configuredBase = String(Constants.expoConfig?.extra?.cloudPayBaseUrl ?? 'http://10.0.2.2:4156').replace(/\/+$/u, '');
const localE2eSessionToken = typeof Constants.expoConfig?.extra?.localE2eSessionToken === 'string'
  ? Constants.expoConfig.extra.localE2eSessionToken : null;
export const API_BASE_URL = configuredBase;
export const LOCAL_E2E_DEMO_ENABLED = true;

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly requestId: string | null = null,
  ) { super(message); this.name = 'ApiError'; }
}

type RequestOptions = Readonly<{
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown;
  auth?: 'none' | 'optional' | 'required'; headers?: Record<string, string>; retry?: boolean;
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

async function rawRequest<T>(path: string, options: RequestOptions, accessToken?: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET', signal: controller.signal,
      headers: {
        Accept: 'application/json', 'x-request-id': Crypto.randomUUID(),
        'x-kai-distribution-channel': distributionChannel,
        ...(localE2eSessionToken ? { 'x-kai-e2e-session': localE2eSessionToken } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
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
      const response = await rawRequest<{ ok: true; session: {
        accessToken: string; refreshToken: string; accessExpiresInSeconds: number; refreshExpiresAt: string;
      } }>('/mobile/v1/auth/refresh', {
        method: 'POST', auth: 'none', body: { refreshToken: session.refreshToken, deviceId: session.deviceId },
      });
      await updateSessionTokens(response.session);
      return response.session.accessToken;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) await clearSession();
      throw error;
    }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function beginSessionLogout() {
  sessionLogoutInProgress = true;
  try { await refreshInFlight; } catch { /* Local logout still clears the session. */ }
}
export function endSessionLogout() { sessionLogoutInProgress = false; }

export function apiRequestWithAccessToken<T>(path: string, accessToken: string, _idToken: string, options: RequestOptions = {}) {
  if (!accessToken) throw new ApiError('AUTH_REQUIRED', 401, '请先登录。');
  return rawRequest<T>(path, { ...options, auth: 'none' }, accessToken);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}) {
  const auth = options.auth ?? 'none';
  let session = auth === 'none' ? null : await loadSession();
  if (session && new Date(session.accessExpiresAt).getTime() - Date.now() < 30_000) {
    const token = await refreshAccessToken();
    session = token ? await loadSession() : null;
  }
  if (auth === 'required' && !session) throw new ApiError('AUTH_REQUIRED', 401, '请先登录。');
  try {
    return await rawRequest<T>(path, options, session?.accessToken);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && session) {
      const token = await refreshAccessToken();
      if (!token) throw error;
      session = await loadSession();
      return rawRequest<T>(path, options, session?.accessToken);
    }
    throw error;
  }
}
