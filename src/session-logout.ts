import { beginSessionLogout, endSessionLogout } from './api-client';
import { revokeKaiOidcTokens } from './kai-oidc-client';
import { queueKaiOidcRevocation } from './kai-revocation-queue';
import { clearSession, loadSession } from './session';

export class SessionLogoutError extends Error {
  readonly name = 'SessionLogoutError';
  constructor(message: string, public readonly localSessionCleared: boolean) { super(message); }
}

export async function logoutCurrentSession() {
  await beginSessionLogout();
  let remoteFailure: unknown = null;
  let queued = false;
  let mayClearLocalSession = true;
  try {
    const session = await loadSession();
    if (session) {
      try {
        await revokeKaiOidcTokens(session);
      } catch (error) {
        remoteFailure = error;
        try {
          await queueKaiOidcRevocation(session);
          queued = true;
        } catch {
          queued = false;
          mayClearLocalSession = false;
        }
      }
    }
  } finally {
    try {
      if (mayClearLocalSession) await clearSession();
    } finally { endSessionLogout(); }
  }
  if (remoteFailure) {
    throw new SessionLogoutError(queued
      ? '本机已退出；统一身份凭证将在联网后自动撤销，不会恢复登录。'
      : '退出未完成：本机仍保留当前登录，以便联网后重试并撤销同一登录凭证。',
    mayClearLocalSession);
  }
}
