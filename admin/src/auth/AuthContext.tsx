import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { adminApi, AdminApiError } from '../api/client';
import type { Me } from '../api/contracts';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'expired' | 'error';

type AuthContextValue = Readonly<{
  status: AuthStatus;
  me: Me | null;
  error: string | null;
  retry: () => Promise<void>;
  login: (returnTo?: string) => never;
  logout: () => Promise<void>;
}>;

const AuthContext = createContext<AuthContextValue | null>(null);

function sessionDeadline(me: Me): number | null {
  const candidates = [me.session.idleExpiresAt, me.session.absoluteExpiresAt]
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hadSession = useRef(false);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const current = await adminApi.me();
      hadSession.current = true;
      setMe(current);
      setStatus('authenticated');
    } catch (cause) {
      setMe(null);
      if (cause instanceof AdminApiError && cause.status === 401) {
        setStatus(hadSession.current ? 'expired' : 'anonymous');
        return;
      }
      setStatus('error');
      setError(cause instanceof AdminApiError ? cause.message : '管理员会话校验失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => adminApi.onUnauthorized(() => {
    setMe(null);
    setStatus(hadSession.current ? 'expired' : 'anonymous');
  }), []);

  useEffect(() => {
    if (!me || status !== 'authenticated') return;
    const deadline = sessionDeadline(me);
    if (deadline === null) return;
    const delay = Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647));
    const timer = window.setTimeout(() => {
      setMe(null);
      setStatus('expired');
    }, delay);
    return () => window.clearTimeout(timer);
  }, [me, status]);

  const login = useCallback((returnTo = `${window.location.pathname}${window.location.search}`) => (
    adminApi.login(returnTo)
  ), []);

  const logout = useCallback(async () => {
    await adminApi.logout();
    hadSession.current = false;
    setMe(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<AuthContextValue>(() => ({ status, me, error, retry: load, login, logout }), [status, me, error, load, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AUTH_CONTEXT_UNAVAILABLE');
  return value;
}
