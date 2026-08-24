import { apiRequest } from './api-client';
import type { AccountSession } from './account-security-core';
export * from './account-security-core';

export const REMOTE_ACCOUNT_SESSIONS_AVAILABLE = true;
export const PUSH_INSTALLATION_AVAILABLE = true;

export async function listAccountSessions() {
  const response = await apiRequest<{ ok: true; sessions: AccountSession[] }>('/mobile/v1/auth/sessions', {
    auth: 'required', retry: true,
  });
  return response.sessions;
}

export async function revokeAccountSession(sessionId: string) {
  const response = await apiRequest<{ ok: true; revoked: boolean }>(
    `/mobile/v1/auth/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', auth: 'required', retry: false },
  );
  return response.revoked;
}
