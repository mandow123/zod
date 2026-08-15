import { apiRequest } from './api-client';
import type { LegalDocuments } from './api';
import { deviceDescriptor, saveSession, type CloudPayUser } from './session';

export async function requestLoginCode(phone: string, purpose: 'login' | 'register') {
  const response = await apiRequest<{
    ok: true;
    challenge: { challengeId: string; expiresInSeconds: number; resendAfterSeconds: number };
  }>('/mobile/v1/auth/otp/request', { method: 'POST', retry: false, body: { phone, purpose } });
  return response.challenge;
}

export async function verifyLoginCode(input: Readonly<{
  phone: string;
  challengeId: string;
  code: string;
  purpose: 'login' | 'register';
  displayName?: string;
  documents?: LegalDocuments;
}>) {
  const device = await deviceDescriptor();
  const response = await apiRequest<{ ok: true; result: {
    kind: 'session';
    accessToken: string;
    refreshToken: string;
    accessExpiresInSeconds: number;
    refreshExpiresAt: string;
    user: CloudPayUser;
  } }>('/mobile/v1/auth/otp/verify', {
    method: 'POST',
    retry: false,
    body: {
      phone: input.phone,
      challengeId: input.challengeId,
      code: input.code,
      purpose: input.purpose,
      device,
      ...(input.displayName ? { displayName: input.displayName.trim() } : {}),
      ...(input.purpose === 'register' && input.documents ? {
        consents: [
          { kind: 'terms', version: input.documents.terms.version },
          { kind: 'privacy', version: input.documents.privacy.version },
        ],
      } : {}),
    },
  });
  await saveSession({ ...response.result, deviceId: device.deviceId });
  return response.result.user;
}
