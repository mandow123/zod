import Constants from 'expo-constants';
import { API_BASE_URL } from './api-client';
import { localE2EOtpForPhone } from './local-e2e-auth';
import { loadStagingPrincipalToken } from './staging-principal';

const sessionToken = String(Constants.expoConfig?.extra?.localE2eSessionToken ?? '');
const stagingDemo = Constants.expoConfig?.extra?.stagingDemoEnabled === true;

async function localGet<T>(resource: 'otp' | 'demo-catalog') {
  const effectiveSessionToken = stagingDemo ? await loadStagingPrincipalToken() : sessionToken;
  const validSession = stagingDemo
    ? /^[A-Za-z0-9._~-]{43,200}$/u.test(effectiveSessionToken ?? '')
    : /^[A-Za-z0-9_-]{43,120}$/u.test(effectiveSessionToken ?? '');
  if (!validSession) throw new Error('LOCAL_E2E_SESSION_REQUIRED');
  const response = await fetch(`${API_BASE_URL}/__e2e/${resource}`, {
    headers: {
      Accept: 'application/json',
      'x-kai-e2e-session': effectiveSessionToken!,
      ...(stagingDemo ? { 'X-Zod-Client-Environment': 'staging' } : {}),
    },
  });
  if (stagingDemo && response.headers.get('X-Zod-Environment') !== 'staging') {
    throw new Error('STAGING_RESPONSE_MISMATCH');
  }
  if (!response.ok) throw new Error('LOCAL_E2E_REQUEST_FAILED');
  return await response.json() as T;
}

export async function loadLocalE2EOtp(phone: string) {
  return localE2EOtpForPhone(phone, await localGet<unknown>('otp'));
}

export function loadLocalE2EDemoCatalog<T>() {
  return localGet<T>('demo-catalog');
}
