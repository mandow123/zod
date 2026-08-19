export type ChangeWaitResult = 'changed' | 'timeout' | 'aborted';

type PendingWait = {
  finish: (result: ChangeWaitResult) => void;
};

/**
 * Process-local change notification for long-poll requests.
 *
 * Persistent game/room versions remain the source of truth. The generation
 * counter only closes the race between reading a resource and registering a
 * waiter, so a mutation can never be missed between those two operations.
 */
export class ChangeBroker {
  private readonly generations = new Map<string, number>();
  private readonly waits = new Map<string, Set<PendingWait>>();

  generation(resource: string) {
    return this.generations.get(resource) ?? 0;
  }

  notify(resource: string) {
    this.generations.set(resource, this.generation(resource) + 1);
    const pending = this.waits.get(resource);
    if (!pending) return;
    for (const wait of [...pending]) wait.finish('changed');
  }

  wait(resource: string, generation: number, timeoutMs: number, signal?: AbortSignal): Promise<ChangeWaitResult> {
    if (signal?.aborted) return Promise.resolve('aborted');
    if (this.generation(resource) !== generation) return Promise.resolve('changed');

    return new Promise((resolve) => {
      let settled = false;
      const waits = this.waits.get(resource) ?? new Set<PendingWait>();
      let timer: ReturnType<typeof setTimeout>;
      const pending: PendingWait = { finish: () => undefined };
      const onAbort = () => finish('aborted');
      const finish = (result: ChangeWaitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        waits.delete(pending);
        if (waits.size === 0) this.waits.delete(resource);
        resolve(result);
      };
      pending.finish = finish;
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      timer.unref?.();

      waits.add(pending);
      this.waits.set(resource, waits);
      signal?.addEventListener('abort', onAbort, { once: true });

      // No asynchronous work occurs above, but retaining this second check
      // makes the no-missed-wakeup invariant explicit if registration changes.
      if (this.generation(resource) !== generation) finish('changed');
    });
  }

  pendingCount(resource?: string) {
    if (resource) return this.waits.get(resource)?.size ?? 0;
    let count = 0;
    for (const waits of this.waits.values()) count += waits.size;
    return count;
  }
}
