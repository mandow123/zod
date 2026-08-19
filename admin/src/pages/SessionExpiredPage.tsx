import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import { LoadingScreen } from '../components/States';

export function SessionExpiredPage() {
  const { status, login } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <LoadingScreen />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  const returnTo = typeof location.state === 'object' && location.state && 'returnTo' in location.state && typeof location.state.returnTo === 'string'
    ? location.state.returnTo
    : '/';
  return (
    <main className="centered-page">
      <section className="message-card">
        <span className="message-icon warning"><Icon name="shield" /></span>
        <span className="message-code">SESSION / 401</span>
        <h1>管理会话已失效</h1>
        <p>为保护管理数据，会话在空闲、权限变化或达到绝对期限后自动结束。重新验证身份即可继续。</p>
        <button className="button button-primary" type="button" onClick={() => login(returnTo)}>重新验证身份 <Icon name="arrow" /></button>
      </section>
    </main>
  );
}
