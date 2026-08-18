import type { AccountSession } from './account-security-core';
export * from './account-security-core';

export const REMOTE_ACCOUNT_SESSIONS_AVAILABLE = false;
export const PUSH_INSTALLATION_AVAILABLE = false;

export async function listAccountSessions(): Promise<AccountSession[]> { return []; }

export async function revokeAccountSession(_sessionId: string): Promise<never> {
  throw new Error('KAI 统一身份暂未提供可核验的远程设备列表。');
}

export const PHONE_REAUTHENTICATION_ENABLED = false;

export async function requestDeletionCode(_phone: string): Promise<{
  challengeId: string; expiresInSeconds: number; resendAfterSeconds: number;
}> {
  throw new Error('账户注销需要由 KAI 统一身份再次确认，当前暂未开放。');
}

export async function verifyDeletionCode(
  _phone: string,
  _challengeId: string,
  _code: string,
): Promise<string> {
  throw new Error('账户注销需要由 KAI 统一身份再次确认，当前暂未开放。');
}
