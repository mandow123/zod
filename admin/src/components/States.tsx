import { Icon } from './Icon';

export function LoadingScreen({ label = '正在加载安全工作区' }: { label?: string }) {
  return (
    <div className="state-screen" role="status" aria-live="polite">
      <div className="loading-mark" aria-hidden="true"><span /><span /><span /></div>
      <p>{label}</p>
    </div>
  );
}

export function LoadingRows() {
  return <div className="skeleton-stack" aria-label="正在加载"><span /><span /><span /><span /></div>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span className="empty-orbit" aria-hidden="true" />
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

export function ErrorState({ title = '数据加载失败', detail, onRetry }: { title?: string; detail: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <span className="error-code">ERR</span>
      <div><h3>{title}</h3><p>{detail}</p></div>
      {onRetry ? <button className="button button-secondary" type="button" onClick={onRetry}><Icon name="refresh" />重试</button> : null}
    </div>
  );
}

const positiveStatuses = new Set(['active', 'completed', 'succeeded', 'paid', 'fulfilled', 'approved', 'settled', 'captured']);
const warningStatuses = new Set(['pending', 'submitted', 'reviewing', 'processing', 'paying', 'shipping', 'reserved']);
const criticalStatuses = new Set(['failed', 'rejected', 'cancelled', 'canceled', 'expired', 'blocked']);

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const tone = positiveStatuses.has(normalized) ? 'positive' : warningStatuses.has(normalized) ? 'warning' : criticalStatuses.has(normalized) ? 'critical' : 'neutral';
  return <span className={`status status-${tone}`}><i />{status || 'unknown'}</span>;
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
