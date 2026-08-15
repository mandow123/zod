import { apiRequest } from './api-client';

export * from './account-security-common';

export const PHONE_REAUTHENTICATION_ENABLED = true;

export async function requestDeletionCode(phone: string) {
  const response = await apiRequest<{
    ok: true; challenge: { challengeId: string; expiresInSeconds: number; resendAfterSeconds: number };
  }>('/mobile/v1/auth/otp/request', {
    method: 'POST', retry: false, body: { phone, purpose: 'delete_account' },
  });
  return response.challenge;
}

export async function verifyDeletionCode(phone: string, challengeId: string, code: string) {
  const response = await apiRequest<{ ok: true; result: {
    kind: 'reauthentication'; reauthenticationToken: string; expiresInSeconds: number;
  } }>('/mobile/v1/auth/otp/verify', {
    method: 'POST', retry: false, body: { phone, challengeId, code, purpose: 'delete_account' },
  });
  return response.result.reauthenticationToken;
}
