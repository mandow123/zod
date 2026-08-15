export * from './account-security-common';

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
