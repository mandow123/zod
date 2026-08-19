import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdminSessionMaintenance,
  DEFAULT_ADMIN_SESSION_MAINTENANCE_INTERVAL_MS,
  type AdminMaintenanceLogger,
} from '../src/admin/maintenance.js';

describe('admin session maintenance', () => {
  afterEach(() => vi.useRealTimers());

  it('uses a conservative five-minute default and only starts on its interval', async () => {
    vi.useFakeTimers();
    const cleanupExpiredTokenHashes = vi.fn(async () => 3);
    const maintenance = new AdminSessionMaintenance({ cleanupExpiredTokenHashes });
    maintenance.start();
    maintenance.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_ADMIN_SESSION_MAINTENANCE_INTERVAL_MS - 1);
    expect(cleanupExpiredTokenHashes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cleanupExpiredTokenHashes).toHaveBeenCalledTimes(1);
    maintenance.stop();
  });

  it('stops future scheduled work and permits idempotent stop', async () => {
    vi.useFakeTimers();
    const cleanupExpiredTokenHashes = vi.fn(async () => 0);
    const maintenance = new AdminSessionMaintenance({ cleanupExpiredTokenHashes }, { intervalMs: 10 });
    maintenance.start();
    maintenance.stop();
    maintenance.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(cleanupExpiredTokenHashes).not.toHaveBeenCalled();
  });

  it('is single-flight while a previous cleanup is running', async () => {
    let complete: ((count: number) => void) | undefined;
    const cleanupExpiredTokenHashes = vi.fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => { complete = resolve; }))
      .mockResolvedValueOnce(2);
    const maintenance = new AdminSessionMaintenance({ cleanupExpiredTokenHashes });
    const first = maintenance.runOnce();
    const second = maintenance.runOnce();
    expect(second).toBe(first);
    expect(cleanupExpiredTokenHashes).toHaveBeenCalledTimes(1);
    complete?.(2);
    await expect(first).resolves.toBe(2);
    await expect(maintenance.runOnce()).resolves.toBe(2);
    expect(cleanupExpiredTokenHashes).toHaveBeenCalledTimes(2);
  });

  it('logs a redacted failure and retries successfully on the next pass', async () => {
    const cleanupExpiredTokenHashes = vi.fn()
      .mockRejectedValueOnce(new Error('hash=not-for-log'))
      .mockResolvedValueOnce(4);
    const logger: AdminMaintenanceLogger = { error: vi.fn() };
    const maintenance = new AdminSessionMaintenance({ cleanupExpiredTokenHashes }, { logger });
    await expect(maintenance.runOnce()).resolves.toBe(0);
    expect(logger.error).toHaveBeenCalledWith({ event: 'admin.session_registry_cleanup_failed' });
    expect(JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('not-for-log');
    await expect(maintenance.runOnce()).resolves.toBe(4);
    expect(cleanupExpiredTokenHashes).toHaveBeenCalledTimes(2);
  });

  it('injects the cleanup time without mutating it', async () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const cleanupExpiredTokenHashes = vi.fn(async () => 1);
    const maintenance = new AdminSessionMaintenance({ cleanupExpiredTokenHashes }, { now: () => now });
    await maintenance.runOnce();
    expect(cleanupExpiredTokenHashes).toHaveBeenCalledWith(now);
    expect(now.toISOString()).toBe('2026-08-19T12:00:00.000Z');
  });

  it('rejects unsafe scheduling intervals', () => {
    const sessions = { cleanupExpiredTokenHashes: async () => 0 };
    for (const intervalMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new AdminSessionMaintenance(sessions, { intervalMs })).toThrow('ADMIN_SESSION_MAINTENANCE_INTERVAL_INVALID');
    }
  });
});
