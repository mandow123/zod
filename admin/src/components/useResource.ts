import { useCallback, useEffect, useState } from 'react';
import { AdminApiError } from '../api/client';

type ResourceState<T> =
  | Readonly<{ status: 'loading'; data: null; error: null }>
  | Readonly<{ status: 'ready'; data: T; error: null }>
  | Readonly<{ status: 'error'; data: null; error: string }>;

export function useResource<T>(loader: (signal: AbortSignal) => Promise<T>, dependencyKey: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading', data: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', data: null, error: null });
    void loader(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ status: 'ready', data, error: null }); },
      (cause) => {
        if (controller.signal.aborted) return;
        const error = cause instanceof AdminApiError ? cause.message : '服务返回了无法处理的数据';
        setState({ status: 'error', data: null, error });
      },
    );
    return () => controller.abort();
  }, [dependencyKey, loader, revision]);

  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return { ...state, retry };
}
