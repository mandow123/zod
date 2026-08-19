import { type ReactNode, useCallback, useState } from 'react';
import type { ListQuery, Page } from '../api/contracts';
import { Icon } from '../components/Icon';
import { ErrorState, EmptyState, LoadingRows } from '../components/States';
import { useResource } from '../components/useResource';

export type Column<T> = Readonly<{
  key: string;
  label: string;
  render: (item: T) => ReactNode;
  numeric?: boolean;
}>;

type ListPageProps<T> = Readonly<{
  eyebrow: string;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDetail: string;
  columns: readonly Column<T>[];
  rowKey: (item: T) => string;
  load: (query: ListQuery, signal: AbortSignal) => Promise<Page<T>>;
}>;

export function ListPage<T>({ eyebrow, title, description, emptyTitle, emptyDetail, columns, rowKey, load }: ListPageProps<T>) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const dependencyKey = cursor ?? 'first-page';
  const loader = useCallback((signal: AbortSignal) => load({
    ...(cursor ? { cursor } : {}),
    limit: 50,
  }, signal), [load, cursor]);
  const state = useResource(loader, dependencyKey);

  function next(nextCursor: string) {
    setHistory((items) => [...items, cursor]);
    setCursor(nextCursor);
  }

  function previous() {
    setHistory((items) => {
      const copy = [...items];
      setCursor(copy.pop());
      return copy;
    });
  }

  return (
    <section className="content-page">
      <header className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div><span className="as-of">最多 50 条 / 页</span></header>
      <section className="panel list-panel">
        {state.status === 'loading' ? <LoadingRows /> : null}
        {state.status === 'error' ? <ErrorState detail={state.error} onRetry={state.retry} /> : null}
        {state.status === 'ready' && state.data.items.length === 0 ? <EmptyState title={emptyTitle} detail={emptyDetail} /> : null}
        {state.status === 'ready' && state.data.items.length > 0 ? (
          <>
            <div className="table-scroll">
              <table><thead><tr>{columns.map((column) => <th key={column.key} className={column.numeric ? 'numeric' : undefined}>{column.label}</th>)}</tr></thead><tbody>{state.data.items.map((item) => <tr key={rowKey(item)}>{columns.map((column) => <td key={column.key} data-label={column.label} className={column.numeric ? 'numeric' : undefined}>{column.render(item)}</td>)}</tr>)}</tbody></table>
            </div>
            <footer className="pagination"><span>当前页 {state.data.items.length} 条</span><div><button className="button button-quiet" type="button" disabled={history.length === 0} onClick={previous}>上一页</button><button className="button button-secondary" type="button" disabled={!state.data.nextCursor} onClick={() => state.data.nextCursor && next(state.data.nextCursor)}>下一页 <Icon name="arrow"/></button></div></footer>
          </>
        ) : null}
      </section>
    </section>
  );
}
