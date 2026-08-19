import { useCallback } from 'react';
import { adminApi } from '../api/client';
import { ErrorState, EmptyState, formatDateTime, LoadingRows, StatusBadge } from '../components/States';
import { useResource } from '../components/useResource';

export function DashboardPage() {
  const loader = useCallback((signal: AbortSignal) => adminApi.dashboard(signal), []);
  const state = useResource(loader, 'dashboard');
  return (
    <section className="content-page">
      <header className="page-heading">
        <div><span className="eyebrow">SYSTEM PULSE</span><h1>运行总览</h1><p>关键业务状态与近期业务活动。</p></div>
        <span className="as-of">实时读取 · 不缓存</span>
      </header>
      {state.status === 'loading' ? <><div className="metric-grid skeleton-metrics"><span/><span/><span/><span/></div><LoadingRows /></> : null}
      {state.status === 'error' ? <ErrorState detail={state.error} onRetry={state.retry} /> : null}
      {state.status === 'ready' ? (
        <>
          {state.data.metrics.length > 0 ? (
            <div className="metric-grid">
              {state.data.metrics.map((metric) => <article className={`metric-card metric-${metric.tone}`} key={metric.key}><span>{metric.label}</span><strong>{metric.value}</strong><p>{metric.detail ?? '当前周期'}</p><i /></article>)}
            </div>
          ) : <EmptyState title="暂无汇总指标" detail="服务正常，但当前没有可展示的业务指标。" />}
          <section className="panel activity-panel">
            <header><div><span className="eyebrow">BUSINESS ACTIVITY</span><h2>近期业务活动</h2></div><span>只读</span></header>
            {state.data.activity.length === 0 ? <EmptyState title="暂无业务活动" detail="新的订单或资金状态出现后会显示在这里。" /> : (
              <div className="activity-list">
                {state.data.activity.map((item) => <article key={item.id}><span className="activity-dot"/><div><b>{item.title}</b><p>{item.detail ?? '业务状态已更新'}</p></div>{item.status ? <StatusBadge status={item.status}/> : null}<time>{formatDateTime(item.occurredAt)}</time></article>)}
              </div>
            )}
          </section>
        </>
      ) : null}
    </section>
  );
}
