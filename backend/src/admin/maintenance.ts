import type { AdminSessionStore } from './session-store.js';

/** A deliberately narrow logger contract: cleanup errors must never expose token material. */
export interface AdminMaintenanceLogger {
  error(event: Readonly<{ event: 'admin.session_registry_cleanup_failed' }>): void;
}

export type AdminSessionMaintenanceOptions = Readonly<{
  /** Five minutes keeps the registry tidy without adding load to request handling. */
  intervalMs?: number;
  now?: () => Date;
  logger?: AdminMaintenanceLogger;
}>;

export const DEFAULT_ADMIN_SESSION_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1_000;

const NOOP_LOGGER: AdminMaintenanceLogger = Object.freeze({ error: () => undefined });

/**
 * Runs non-security-critical registry cleanup outside the request path. It intentionally does
 * not start a cleanup synchronously: startup must not create duplicate concurrent work, and a
 * failed pass is retried on the next interval. The underlying Store owns the bounded SQL work.
 */
export class AdminSessionMaintenance {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly logger: AdminMaintenanceLogger;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> | undefined;

  constructor(
    private readonly sessions: Pick<AdminSessionStore, 'cleanupExpiredTokenHashes'>,
    options: AdminSessionMaintenanceOptions = {},
  ) {
    const intervalMs = options.intervalMs ?? DEFAULT_ADMIN_SESSION_MAINTENANCE_INTERVAL_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('ADMIN_SESSION_MAINTENANCE_INTERVAL_INVALID');
    }
    this.intervalMs = intervalMs;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** Starts future maintenance only; repeated starts are idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stops future timer work. An already-started database call is allowed to finish safely. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * A single-flight pass, also useful for an explicit graceful-shutdown or operations trigger.
   * It never passes errors to a timer callback; the next invocation can retry after failure.
   */
  runOnce(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    const pass = this.sessions.cleanupExpiredTokenHashes(now)
      .catch(() => {
        try {
          this.logger.error({ event: 'admin.session_registry_cleanup_failed' });
        } catch {
          // Observability must not take down the maintenance scheduler.
        }
        return 0;
      })
      .finally(() => { this.inFlight = undefined; });
    this.inFlight = pass;
    return pass;
  }
}
