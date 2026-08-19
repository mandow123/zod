import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { can, PERMISSIONS, type ConsolePermission } from './auth/permissions';
import { Shell } from './components/Shell';
import { ErrorState, LoadingScreen } from './components/States';
import { DashboardPage } from './pages/DashboardPage';
import { ComputeOrdersPage, DeviceOrdersPage, PayoutsPage, TopupsPage } from './pages/DomainPages';
import { LoginPage } from './pages/LoginPage';
import { SessionExpiredPage } from './pages/SessionExpiredPage';
import { UnauthorizedPage } from './pages/UnauthorizedPage';

function RequireSession({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'loading') return <LoadingScreen />;
  if (auth.status === 'error') {
    return <main className="centered-page"><ErrorState title="无法验证管理会话" detail={auth.error ?? '管理员服务暂时不可用'} onRetry={() => void auth.retry()} /></main>;
  }
  if (auth.status === 'expired') return <Navigate to="/session-expired" state={{ returnTo: `${location.pathname}${location.search}` }} replace />;
  if (auth.status !== 'authenticated' || !auth.me) {
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }
  return children;
}

function RequirePermission({ permission, children }: { permission: ConsolePermission; children: ReactNode }) {
  const { me } = useAuth();
  return me && can(me.admin.permissions, permission) ? children : <Navigate to="/unauthorized" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/session-expired" element={<SessionExpiredPage />} />
      <Route path="/" element={<RequireSession><Shell /></RequireSession>}>
        <Route index element={<RequirePermission permission={PERMISSIONS.overview}><DashboardPage /></RequirePermission>} />
        <Route path="compute-orders" element={<RequirePermission permission={PERMISSIONS.computeOrders}><ComputeOrdersPage /></RequirePermission>} />
        <Route path="device-orders" element={<RequirePermission permission={PERMISSIONS.deviceOrders}><DeviceOrdersPage /></RequirePermission>} />
        <Route path="payouts" element={<RequirePermission permission={PERMISSIONS.payouts}><PayoutsPage /></RequirePermission>} />
        <Route path="topups" element={<RequirePermission permission={PERMISSIONS.topups}><TopupsPage /></RequirePermission>} />
        <Route path="unauthorized" element={<UnauthorizedPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
