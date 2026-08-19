import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresAdminP0Store, type AdminP0Store } from '../src/admin/p0-store.js';
import { AdminP0Service } from '../src/admin/p0-service.js';

const CREATED_AT = new Date('2026-08-19T02:00:00.000Z');
const UPDATED_AT = new Date('2026-08-19T03:00:00.000Z');
const ID_1 = '10000000-0000-4000-8000-000000000001';
const ID_2 = '10000000-0000-4000-8000-000000000002';
const ID_3 = '10000000-0000-4000-8000-000000000003';

function fakeStore(): AdminP0Store {
  return {
    overview: vi.fn(async () => ({
      computeOrders: { total: 9, active: 3 },
      deviceOrders: { total: 8, active: 2 },
      payouts: { total: 7, pending: 1 },
      topups: { total: 6, attentionRequired: 1 },
    })),
    listComputeCreditOrders: vi.fn(async () => []),
    listDeviceOrders: vi.fn(async () => []),
    listPayouts: vi.fn(async () => []),
    listTopups: vi.fn(async () => []),
  };
}

function queryResult(rows: readonly Record<string, unknown>[]) {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

describe('AdminP0Service authorization and resource boundary', () => {
  it('requires the exact overview permission', async () => {
    const store = fakeStore();
    const service = new AdminP0Service(store);

    await expect(service.overview({ permissions: [] })).rejects.toMatchObject({
      code: 'ADMIN_PERMISSION_REQUIRED', statusCode: 403,
    });
    await expect(service.overview({ permissions: ['admin.overview.read'] })).resolves.toEqual({
      computeOrders: { total: 9, active: 3 },
      deviceOrders: { total: 8, active: 2 },
      payouts: { total: 7, pending: 1 },
      topups: { total: 6, attentionRequired: 1 },
    });
    expect(store.overview).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['compute-credit-orders', 'admin.order.read', 'listComputeCreditOrders'],
    ['device-orders', 'admin.device-order.read', 'listDeviceOrders'],
    ['payouts', 'admin.payout.read', 'listPayouts'],
    ['topups', 'admin.topup.read', 'listTopups'],
  ] as const)('requires %s to have %s', async (resource, permission, method) => {
    const store = fakeStore();
    const service = new AdminP0Service(store);

    await expect(service.listResource({ permissions: ['admin.overview.read'] }, resource)).rejects.toMatchObject({
      code: 'ADMIN_PERMISSION_REQUIRED', statusCode: 403,
    });
    await expect(service.listResource({ permissions: [permission] }, resource)).resolves.toEqual({
      items: [], nextCursor: null,
    });
    expect(store[method]).toHaveBeenCalledTimes(1);
  });

  it.each(['refunds', 'disputes', 'invoices', 'vast'])('rejects excluded P0 resource %s without touching the store', async (resource) => {
    const store = fakeStore();
    const service = new AdminP0Service(store);

    await expect(service.listResource({ permissions: [
      'admin.order.read', 'admin.payout.read', 'admin.topup.read',
    ] }, resource)).rejects.toMatchObject({ code: 'ADMIN_RESOURCE_NOT_AVAILABLE', statusCode: 404 });
    expect(store.listComputeCreditOrders).not.toHaveBeenCalled();
    expect(store.listDeviceOrders).not.toHaveBeenCalled();
    expect(store.listPayouts).not.toHaveBeenCalled();
    expect(store.listTopups).not.toHaveBeenCalled();
  });

  it('rejects unknown resources with a stable error', async () => {
    const service = new AdminP0Service(fakeStore());
    await expect(service.listResource({ permissions: [] }, 'users')).rejects.toMatchObject({
      code: 'ADMIN_RESOURCE_UNKNOWN', statusCode: 404,
    });
  });
});

describe('AdminP0Service pagination', () => {
  it('uses a strict default and maximum page size', async () => {
    const store = fakeStore();
    const service = new AdminP0Service(store);
    await service.listTopups({ permissions: ['admin.topup.read'] });
    expect(store.listTopups).toHaveBeenCalledWith({ limit: 26, cursor: null });

    for (const limit of [0, -1, 101, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(service.listTopups({ permissions: ['admin.topup.read'] }, { limit })).rejects.toMatchObject({
        code: 'ADMIN_PAGINATION_LIMIT_INVALID', statusCode: 400,
      });
    }
    expect(store.listTopups).toHaveBeenCalledTimes(1);
  });

  it('creates a stable resource-bound keyset cursor and returns JSON-safe timestamps', async () => {
    const store = fakeStore();
    vi.mocked(store.listComputeCreditOrders).mockResolvedValueOnce([
      { id: ID_3, orderNumber: 'KAI-ORDER-3', status: 'ready', quantity: '3.000000', capacityUnit: 'GPU_HOUR',
        totalCreditMicros: '3000000', createdAt: new Date('2026-08-19T03:00:00.000Z'), updatedAt: UPDATED_AT },
      { id: ID_2, orderNumber: 'KAI-ORDER-2', status: 'confirmed', quantity: '2.000000', capacityUnit: 'GPU_HOUR',
        totalCreditMicros: '2000000', createdAt: CREATED_AT, updatedAt: UPDATED_AT },
      { id: ID_1, orderNumber: 'KAI-ORDER-1', status: 'accepted', quantity: '1.000000', capacityUnit: 'GPU_HOUR',
        totalCreditMicros: '1000000', createdAt: new Date('2026-08-18T03:00:00.000Z'), updatedAt: UPDATED_AT },
    ]);
    const service = new AdminP0Service(store);

    const first = await service.listComputeCreditOrders({ permissions: ['admin.order.read'] }, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.items[1]).toMatchObject({
      id: ID_2, createdAt: '2026-08-19T02:00:00.000Z', updatedAt: '2026-08-19T03:00:00.000Z',
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toContain('subjectId');

    vi.mocked(store.listComputeCreditOrders).mockResolvedValueOnce([]);
    await service.listComputeCreditOrders({ permissions: ['admin.order.read'] }, {
      limit: 2, cursor: first.nextCursor,
    });
    expect(store.listComputeCreditOrders).toHaveBeenLastCalledWith({
      limit: 3,
      cursor: { createdAt: CREATED_AT, id: ID_2 },
    });

    await expect(service.listTopups({ permissions: ['admin.topup.read'] }, {
      cursor: first.nextCursor,
    })).rejects.toMatchObject({ code: 'ADMIN_PAGINATION_CURSOR_INVALID', statusCode: 400 });
  });

  it.each([
    '', 'not-base64!', 'e30',
    Buffer.from(JSON.stringify([1, 'topups', '2026-08-19', ID_1])).toString('base64url'),
    Buffer.from(JSON.stringify([1, 'topups', CREATED_AT.toISOString(), 'not-a-uuid'])).toString('base64url'),
    `${Buffer.from(JSON.stringify([1, 'topups', CREATED_AT.toISOString(), ID_1])).toString('base64url')}=`,
  ])('rejects malformed cursor %s', async (cursor) => {
    const service = new AdminP0Service(fakeStore());
    await expect(service.listTopups({ permissions: ['admin.topup.read'] }, { cursor })).rejects.toMatchObject({
      code: 'ADMIN_PAGINATION_CURSOR_INVALID', statusCode: 400,
    });
  });
});

describe('PostgresAdminP0Store', () => {
  it('uses stable keyset ordering and selects no identity, payment reference, address, or encrypted fields', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(queryResult([{ id: ID_1, order_number: 'KAI-ORDER-1', status: 'ready',
        quantity: '1.000000', capacity_unit: 'GPU_HOUR', total_credit_micros: '1000000',
        created_at: CREATED_AT, updated_at: UPDATED_AT }]))
      .mockResolvedValueOnce(queryResult([{ id: ID_1, order_number: 'DEVICE-ORDER-1', status: 'shipping',
        quantity: 1, gross_credit_micros: '1000000', created_at: CREATED_AT, updated_at: UPDATED_AT }]))
      .mockResolvedValueOnce(queryResult([{ id: ID_1, payout_number: 'PAYOUT-000001', status: 'submitted',
        credit_micros: '1000000', payment_amount_cents: '100', created_at: CREATED_AT, updated_at: UPDATED_AT }]))
      .mockResolvedValueOnce(queryResult([{ id: ID_1, provider: 'alipay', status: 'manual_review', amount_cents: '100',
        currency: 'CNY', credit_micros: '1000000', reversed_amount_cents: '0', reversed_credit_micros: '0',
        created_at: CREATED_AT, updated_at: UPDATED_AT }]));
    const database = { query } as unknown as Database;
    const store = new PostgresAdminP0Store(database);
    const cursor = { createdAt: CREATED_AT, id: ID_2 };

    await store.listComputeCreditOrders({ limit: 26, cursor });
    await store.listDeviceOrders({ limit: 26, cursor });
    await store.listPayouts({ limit: 26, cursor });
    await store.listTopups({ limit: 26, cursor });

    for (const [sql, values] of query.mock.calls as [string, unknown[]][]) {
      expect(sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(sql).toContain('id < $2::uuid');
      expect(values).toEqual([CREATED_AT, ID_2, 26]);
      expect(sql).not.toMatch(/subject_id|user_id|listing_snapshot|shipping_address|tracking_|recipient_reference|company_payment|payout_account|provider_reference|payment_id|transaction_id|checkout_payload/iu);
    }
  });

  it('maps overview counts and fails closed on unsafe count values', async () => {
    const good = queryResult([{ compute_total: '9', compute_active: '3', device_total: '8', device_active: '2',
      payout_total: '7', payout_pending: '1', topup_total: '6', topup_attention: '1' }]);
    const query = vi.fn().mockResolvedValueOnce(good).mockResolvedValueOnce(queryResult([{
      ...good.rows[0], topup_total: '9007199254740992',
    }]));
    const store = new PostgresAdminP0Store({ query } as unknown as Database);

    await expect(store.overview()).resolves.toEqual({
      computeOrders: { total: 9, active: 3 }, deviceOrders: { total: 8, active: 2 },
      payouts: { total: 7, pending: 1 }, topups: { total: 6, attentionRequired: 1 },
    });
    await expect(store.overview()).rejects.toThrow('ADMIN_P0_COUNT_OUT_OF_RANGE');
  });

  it('rejects invalid store pagination before querying Postgres', async () => {
    const query = vi.fn();
    const store = new PostgresAdminP0Store({ query } as unknown as Database);
    await expect(store.listPayouts({ limit: 0, cursor: null })).rejects.toThrow('ADMIN_P0_STORE_LIMIT_INVALID');
    await expect(store.listPayouts({ limit: 102, cursor: null })).rejects.toThrow('ADMIN_P0_STORE_LIMIT_INVALID');
    await expect(store.listPayouts({ limit: 25, cursor: { createdAt: new Date('invalid'), id: ID_1 } }))
      .rejects.toThrow('ADMIN_P0_STORE_CURSOR_INVALID');
    expect(query).not.toHaveBeenCalled();
  });
});
