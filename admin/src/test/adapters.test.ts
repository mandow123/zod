import { describe, expect, it } from 'vitest';
import { adaptComputeOrders, adaptDashboard, adaptDeviceOrders, adaptMe, adaptPayouts, adaptTopups } from '../api/adapters';

describe('admin API adapters', () => {
  it('normalizes the approved me contract and keeps authorization data explicit', () => {
    expect(adaptMe({
      ok: true,
      admin: {
        displayName: '值班管理员',
        roles: ['support_viewer'],
        permissions: ['admin.overview.read', 'admin.order.read'],
        authzVersion: 4,
      },
      session: {
        createdAt: '2026-08-19T00:00:00.000Z',
        idleExpiresAt: '2026-08-19T00:30:00.000Z',
        absoluteExpiresAt: '2026-08-19T08:00:00.000Z',
        reauthenticatedAt: null,
      },
      csrfToken: 'csrf-memory-only',
    })).toEqual({
      admin: {
        displayName: '值班管理员',
        email: null,
        roles: ['support_viewer'],
        permissions: ['admin.overview.read', 'admin.order.read'],
        authzVersion: 4,
      },
      session: {
        createdAt: '2026-08-19T00:00:00.000Z',
        idleExpiresAt: '2026-08-19T00:30:00.000Z',
        absoluteExpiresAt: '2026-08-19T08:00:00.000Z',
        reauthenticatedAt: null,
      },
      csrfToken: 'csrf-memory-only',
    });
  });

  it('rejects me responses without roles, permissions, or CSRF', () => {
    expect(() => adaptMe({ admin: { roles: [], permissions: [] }, session: {}, csrfToken: '' })).toThrow('ADMIN_API_INVALID_ME');
  });

  it('normalizes all four P0 dashboard metrics without placeholder values', () => {
    const result = adaptDashboard({
      ok: true,
      metrics: {
        computeOrders: { total: 7, active: 2 },
        deviceOrders: { total: 5, active: 1 },
        payouts: { total: 3, pending: 2 },
        topups: { total: 11, attentionRequired: 4 },
      },
      activity: [{ id: 'event-1', resource: 'compute-order', displayId: 'KCO-001', status: 'ready', occurredAt: '2026-08-19T01:00:00.000Z' }],
    });
    expect(result.metrics).toEqual([
      expect.objectContaining({ key: 'computeOrders', value: '7', detail: '活跃 2' }),
      expect.objectContaining({ key: 'deviceOrders', value: '5', detail: '活跃 1' }),
      expect.objectContaining({ key: 'payouts', value: '3', detail: '待处理 2' }),
      expect.objectContaining({ key: 'topups', value: '11', detail: '需关注 4' }),
    ]);
    expect(result.metrics.some((item) => item.value === '—')).toBe(false);
    expect(result.activity[0]).toMatchObject({
      id: 'event-1', title: '算力订单 · KCO-001', detail: '业务状态已更新', status: 'ready',
    });
  });

  it('maps only the real P0 list fields', () => {
    expect(adaptComputeOrders({
      ok: true,
      items: [{ id: 'order-1', orderNumber: 'KAI-100', status: 'pending', quantity: '2.5', capacityUnit: 'hour', totalCreditMicros: '12500000', createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:30:00.000Z' }],
      nextCursor: 'cursor-2',
    })).toEqual({
      items: [{ id: 'order-1', orderNumber: 'KAI-100', status: 'pending', quantity: '2.5', capacityUnit: 'hour', totalCreditMicros: '12500000', createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:30:00.000Z' }],
      nextCursor: 'cursor-2',
    });
    expect(adaptDeviceOrders({ items: [{ id: 'device-1', orderNumber: 'DEVICE-100', status: 'reserved', quantity: 2, grossCreditMicros: '24000000', createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:30:00.000Z' }] }).items[0]).toEqual({ id: 'device-1', orderNumber: 'DEVICE-100', status: 'reserved', quantity: '2', grossCreditMicros: '24000000', createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:30:00.000Z' });
    expect(adaptPayouts({ items: [{ id: 'payout-1', payoutNumber: 'PAYOUT-100', status: 'pending', creditMicros: '10000000', paymentAmountCents: '1002', createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:30:00.000Z' }] }).items[0]).toEqual({ id: 'payout-1', payoutNumber: 'PAYOUT-100', status: 'pending', creditMicros: '10000000', paymentAmountCents: '1002', createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:30:00.000Z' });
    expect(adaptTopups({ items: [{ id: 'topup-1', provider: 'alipay', status: 'succeeded', amountCents: '10000', currency: 'CNY', creditMicros: '9980000', reversedAmountCents: '0', reversedCreditMicros: '0', createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:30:00.000Z' }] }).items[0]).toEqual({ id: 'topup-1', provider: 'alipay', status: 'succeeded', amountCents: '10000', currency: 'CNY', creditMicros: '9980000', reversedAmountCents: '0', reversedCreditMicros: '0', createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:30:00.000Z' });
  });
});
