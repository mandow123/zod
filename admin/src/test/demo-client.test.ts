import { describe, expect, it, vi } from 'vitest';
import { adminApi } from '../api/demo-client';

describe('online administrator demo client', () => {
  it('serves the complete console without network access', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    const me = await adminApi.me();
    const dashboard = await adminApi.dashboard();
    const [compute, devices, payouts, topups] = await Promise.all([
      adminApi.computeOrders({ limit: 20 }),
      adminApi.deviceOrders({ limit: 20 }),
      adminApi.payouts({ limit: 20 }),
      adminApi.topups({ limit: 20 }),
    ]);

    expect(me.admin.displayName).toBe('本地演示管理员');
    expect(dashboard.metrics).toHaveLength(4);
    expect([compute, devices, payouts, topups].every((page) => page.items.length > 0)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
