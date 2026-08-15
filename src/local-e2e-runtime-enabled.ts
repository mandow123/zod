import Constants from 'expo-constants';
import { API_BASE_URL } from './api-client';
import { localE2EOtpForPhone } from './local-e2e-auth';

const sessionToken = String(Constants.expoConfig?.extra?.localE2eSessionToken ?? '');

async function localGet<T>(resource: 'otp' | 'demo-catalog') {
  if (!/^[A-Za-z0-9_-]{43,120}$/u.test(sessionToken)) throw new Error('LOCAL_E2E_SESSION_REQUIRED');
  const response = await fetch(`${API_BASE_URL}/__e2e/${resource}`, {
    headers: { Accept: 'application/json', 'x-kai-e2e-session': sessionToken },
  });
  if (!response.ok) throw new Error('LOCAL_E2E_REQUEST_FAILED');
  return await response.json() as T;
}

export async function loadLocalE2EOtp(phone: string) {
  return localE2EOtpForPhone(phone, await localGet<unknown>('otp'));
}

export function loadLocalE2EDemoCatalog<T>() {
  return localGet<T>('demo-catalog');
}
