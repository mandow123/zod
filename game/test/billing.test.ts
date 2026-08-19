import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BILLING_CATALOG,
  CloudPayBillingService,
  SandboxBillingStore,
  formatCardHours,
  transitionOrder,
  type BillingOrder,
} from '../server/src/billing.ts';
import { PlatformError } from '../server/src/platform.ts';

const withStore = async (run: (path: string, store: SandboxBillingStore) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'doujoy-billing-'));
  const path = join(directory, 'sandbox-orders.json');
  try {
    const store = new SandboxBillingStore(path);
    await store.load();
    await run(path, store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test('catalog uses decimal strings and explicitly forbids game-score conversion', () => {
  assert.equal(formatCardHours('1'), '0.000001');
  assert.equal(formatCardHours('1050000'), '1.050000');
  assert.ok(BILLING_CATALOG.length >= 3);
  for (const product of BILLING_CATALOG) {
    assert.match(product.price.minorAmount, /^\d+$/);
    assert.match(product.price.displayAmount, /^\d+\.\d{6}$/);
    assert.equal(product.price.minorUnit, 'micro-card-hour');
    assert.equal(product.gameScoreConvertible, false);
  }
});

test('disabled mode rejects order creation without touching a payment provider', async () => {
  await withStore(async (_path, store) => {
    const billing = new CloudPayBillingService('disabled', store);
    assert.equal(billing.catalog().enabled, false);
    await assert.rejects(
      () => billing.createOrder('player-1', { productId: 'ai-review', idempotencyKey: 'disabled-request-1' }),
      (error) => error instanceof PlatformError && error.status === 503 && error.code === 'CLOUDPAY_BILLING_DISABLED',
    );
  });
});

test('sandbox orders are idempotent, isolated per player, and persist without floats', async () => {
  await withStore(async (path, store) => {
    const billing = new CloudPayBillingService('sandbox', store);
    const first = await billing.createOrder('player-1', {
      productId: 'ai-review', quantity: 3, idempotencyKey: 'stable-order-key-1',
    });
    assert.equal(first.replayed, false);
    assert.equal(first.order.status, 'reserved');
    assert.equal(first.order.totalMinorAmount, '150000');
    assert.equal(first.order.simulated, true);
    assert.match(first.order.cloudPayOrderRef ?? '', /^sandbox-local:/);

    const replay = await billing.createOrder('player-1', {
      productId: 'ai-review', quantity: 3, idempotencyKey: 'stable-order-key-1',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, first.order.id);

    await assert.rejects(
      () => billing.createOrder('player-1', {
        productId: 'advanced-ai-match', quantity: 3, idempotencyKey: 'stable-order-key-1',
      }),
      (error) => error instanceof PlatformError && error.code === 'IDEMPOTENCY_KEY_REUSED',
    );
    assert.throws(
      () => billing.order('player-2', first.order.id),
      (error) => error instanceof PlatformError && error.status === 404,
    );

    const reloadedStore = new SandboxBillingStore(path);
    await reloadedStore.load();
    const reloaded = new CloudPayBillingService('sandbox', reloadedStore);
    assert.equal(reloaded.order('player-1', first.order.id).totalMinorAmount, '150000');
  });
});

test('order state machine accepts only explicit forward transitions', () => {
  const now = new Date().toISOString();
  const order: BillingOrder = {
    id: 'order-1', userId: 'player-1', productId: 'ai-review', quantity: 1,
    unitMinorAmount: '50000', totalMinorAmount: '50000',
    currency: 'KAI_CARD_HOUR', minorUnit: 'micro-card-hour', status: 'created',
    cloudPayOrderRef: null, mode: 'sandbox', simulated: true,
    createdAt: now, updatedAt: now,
    statusHistory: [{ status: 'created', at: now, reason: 'test' }],
  };
  transitionOrder(order, 'reserved', 'test reserve');
  transitionOrder(order, 'fulfilled', 'test delivery');
  transitionOrder(order, 'settled', 'test settle');
  assert.equal(order.status, 'settled');
  assert.throws(
    () => transitionOrder(order, 'cancelled', 'too late'),
    (error) => error instanceof PlatformError && error.code === 'BILLING_STATUS_TRANSITION_INVALID',
  );
});

test('concurrent requests with one idempotency key create exactly one durable order', async () => {
  await withStore(async (_path, store) => {
    const billing = new CloudPayBillingService('sandbox', store);
    const results = await Promise.all(Array.from({ length: 24 }, () => billing.createOrder('parallel-player', {
      productId: 'advanced-ai-match', quantity: 2, idempotencyKey: 'parallel-stable-key-1',
    })));
    assert.equal(new Set(results.map((result) => result.order.id)).size, 1);
    assert.equal(results.filter((result) => !result.replayed).length, 1);
    assert.equal(results.filter((result) => result.replayed).length, 23);
  });
});

test('failed create persistence does not publish an in-memory order or idempotency confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doujoy-billing-create-failure-'));
  try {
    let writes = 0;
    let failNextWrite = true;
    const store = new SandboxBillingStore(join(directory, 'sandbox-orders.json'), {
      writeSnapshot: async () => {
        writes += 1;
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('INJECTED_DISK_FAILURE');
        }
      },
    });
    await store.load();
    const billing = new CloudPayBillingService('sandbox', store);
    const request = {
      productId: 'ai-review', quantity: 1, idempotencyKey: 'create-failure-stable-key',
    } as const;

    await assert.rejects(() => billing.createOrder('failure-player', request), /INJECTED_DISK_FAILURE/);
    const retry = await billing.createOrder('failure-player', request);
    assert.equal(retry.replayed, false);
    const replay = await billing.createOrder('failure-player', request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, retry.order.id);
    assert.equal(writes, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed cancel persistence leaves the committed order reserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doujoy-billing-cancel-failure-'));
  try {
    let failNextWrite = false;
    const store = new SandboxBillingStore(join(directory, 'sandbox-orders.json'), {
      writeSnapshot: async () => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('INJECTED_CANCEL_DISK_FAILURE');
        }
      },
    });
    await store.load();
    const billing = new CloudPayBillingService('sandbox', store);
    const created = await billing.createOrder('cancel-player', {
      productId: 'room-hosting-60m', idempotencyKey: 'cancel-failure-stable-key',
    });
    failNextWrite = true;
    await assert.rejects(() => billing.cancelOrder('cancel-player', created.order.id), /INJECTED_CANCEL_DISK_FAILURE/);
    assert.equal(billing.order('cancel-player', created.order.id).status, 'reserved');

    const [cancelled, replayed] = await Promise.all([
      billing.cancelOrder('cancel-player', created.order.id),
      billing.cancelOrder('cancel-player', created.order.id),
    ]);
    assert.equal(cancelled.order.status, 'cancelled');
    assert.equal(cancelled.replayed, false);
    assert.equal(replayed.order.status, 'cancelled');
    assert.equal(replayed.replayed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('orders and catalog returned to callers cannot mutate committed billing state', async () => {
  await withStore(async (_path, store) => {
    const billing = new CloudPayBillingService('sandbox', store);
    const created = await billing.createOrder('immutable-player', {
      productId: 'ai-review', idempotencyKey: 'immutable-order-key-1',
    });
    assert.equal(Object.isFrozen(created.order), true);
    assert.equal(Object.isFrozen(created.order.statusHistory), true);
    assert.equal(Object.isFrozen(created.order.statusHistory[0]), true);
    assert.throws(() => { created.order.status = 'settled'; }, TypeError);
    assert.throws(() => { created.order.statusHistory.push({ status: 'failed', at: '', reason: '' }); }, TypeError);
    assert.equal(billing.order('immutable-player', created.order.id).status, 'reserved');

    const catalog = billing.catalog();
    assert.equal(Object.isFrozen(catalog), true);
    assert.equal(Object.isFrozen(catalog.products), true);
    assert.equal(Object.isFrozen(catalog.products[0]), true);
  });
});
