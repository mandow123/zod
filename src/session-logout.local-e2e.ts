import { apiRequest, beginSessionLogout, endSessionLogout } from './api-client';
import { clearSession, loadSession } from './session';

export async function logoutCurrentSession() {
  await beginSessionLogout();
  try {
    if (await loadSession()) {
      await apiRequest<{ ok: true; revoked: boolean }>('/mobile/v1/auth/logout', {
        method: 'POST', auth: 'required', retry: false,
      });
    }
  } finally {
    try { await clearSession(); } finally { endSessionLogout(); }
  }
}
