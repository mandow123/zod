import { useMemo } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { normalizeReturnTo } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import { LoadingScreen } from '../components/States';

export function LoginPage() {
  const { status, login, retry, error } = useAuth();
  const [params] = useSearchParams();
  const returnTo = useMemo(() => normalizeReturnTo(params.get('returnTo') ?? '/'), [params]);
  if (status === 'loading') return <LoadingScreen label="正在确认管理会话" />;
  if (status === 'authenticated') return <Navigate to={returnTo} replace />;

  return (
    <main className="auth-page">
      <div className="auth-grid" aria-hidden="true" />
      <section className="auth-panel">
        <div className="auth-brand"><span className="brand-glyph"><span /></span><div><strong>KAI</strong><small>ADMIN CONTROL PLANE</small></div></div>
        <div className="auth-copy">
          <span className="auth-kicker"><i />RESTRICTED ACCESS</span>
          <h1>管理复杂系统，<br /><em>保持边界清晰。</em></h1>
          <p>通过独立企业身份验证进入 KAI 管理工作区。所有访问均受角色权限、会话限制与审计策略保护。</p>
        </div>
        <div className="auth-trust">
          <span><Icon name="shield" />企业 OIDC</span>
          <span><i />最小权限</span>
          <span><i />完整审计</span>
        </div>
      </section>
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-card-top"><span>AUTHORIZED PERSONNEL ONLY</span><i /></div>
        <div className="login-icon"><Icon name="shield" /></div>
        <h2 id="login-title">管理员登录</h2>
        <p>继续后将跳转至 KAI 企业身份中心。管理会话不会与移动端账号共享。</p>
        {status === 'error' ? (
          <div className="inline-error" role="alert"><b>服务连接失败</b><span>{error}</span><button type="button" onClick={() => void retry()}>重新检查</button></div>
        ) : null}
        <button className="button button-primary login-button" type="button" onClick={() => login(returnTo)}>
          使用企业身份继续 <Icon name="arrow" />
        </button>
        <div className="login-footnote"><Icon name="shield" /><span>登录即表示你理解所有管理操作均可能被记录。</span></div>
      </section>
    </main>
  );
}
