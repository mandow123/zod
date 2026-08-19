import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can, PERMISSIONS, type ConsolePermission } from '../auth/permissions';
import { Icon, type IconName } from './Icon';

type NavItem = Readonly<{ to: string; label: string; eyebrow: string; icon: IconName; permission: ConsolePermission }>;

const navigation: readonly NavItem[] = [
  { to: '/', label: '运行总览', eyebrow: 'Overview', icon: 'dashboard', permission: PERMISSIONS.overview },
  { to: '/compute-orders', label: '算力订单', eyebrow: 'Compute', icon: 'compute', permission: PERMISSIONS.computeOrders },
  { to: '/device-orders', label: '设备订单', eyebrow: 'Devices', icon: 'device', permission: PERMISSIONS.deviceOrders },
  { to: '/payouts', label: '提现管理', eyebrow: 'Payouts', icon: 'payout', permission: PERMISSIONS.payouts },
  { to: '/topups', label: '充值记录', eyebrow: 'Topups', icon: 'topup', permission: PERMISSIONS.topups },
];

export function Shell() {
  const { me, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  if (!me) return null;
  const allowed = navigation.filter((item) => can(me.admin.permissions, item.permission));
  const current = navigation.find((item) => item.to === location.pathname)?.label ?? '管理控制台';

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(false);
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch {
      setLogoutError(true);
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`} aria-label="主导航">
        <div className="brand">
          <span className="brand-glyph"><span /></span>
          <div><strong>KAI</strong><small>CONTROL PLANE</small></div>
          <button className="icon-button close-menu" type="button" aria-label="关闭导航" onClick={() => setMenuOpen(false)}><Icon name="close" /></button>
        </div>
        <div className="environment"><i />ADMINISTRATOR WORKSPACE</div>
        <nav>
          {allowed.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} onClick={() => setMenuOpen(false)}>
              <Icon name={item.icon} />
              <span><b>{item.label}</b><small>{item.eyebrow}</small></span>
              <Icon className="nav-arrow" name="arrow" />
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-security"><Icon name="shield" /><div><b>独立安全域</b><span>Session 由安全 Cookie 管理</span></div></div>
        <div className="profile-card">
          <span className="avatar">{me.admin.displayName.slice(0, 1).toUpperCase()}</span>
          <div><b>{me.admin.displayName}</b><span>{me.admin.roles.join(' · ')}</span></div>
          <button className="icon-button" type="button" aria-label="退出登录" disabled={loggingOut} onClick={() => void handleLogout()}><Icon name="logout" /></button>
        </div>
      </aside>
      {menuOpen ? <button className="sidebar-backdrop" type="button" aria-label="关闭导航" onClick={() => setMenuOpen(false)} /> : null}
      <div className="workspace">
        <header className="topbar">
          <button className="icon-button menu-button" type="button" aria-label="打开导航" onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>
          <div><span className="topbar-context">KAI / ADMIN</span><strong>{current}</strong></div>
          <div className="topbar-actions">
            <span className="live-indicator"><i />系统已连接</span>
            <span className="topbar-avatar">{me.admin.displayName.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>
        {logoutError ? <div className="toast" role="alert">退出请求失败，请检查网络后重试。</div> : null}
        <main id="main-content"><Outlet /></main>
      </div>
    </div>
  );
}
