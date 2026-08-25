import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

type RunningServer = { child: ChildProcess; baseUrl: string; directory: string };

async function startServer(mode?: 'disabled' | 'sandbox'): Promise<RunningServer> {
  const directory = await mkdtemp(join(tmpdir(), `doujoy-billing-http-${mode ?? 'default'}-`));
  const port = 4800 + Math.floor(Math.random() * 500);
  const { DOUJOY_CLOUDPAY_MODE: _inheritedCloudPayMode, ...baseEnvironment } = process.env;
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve('server/src/server.ts')], {
    cwd: resolve('.'),
    env: {
      ...baseEnvironment,
      DOUJOY_PORT: String(port),
      DOUJOY_DATA_PATH: join(directory, 'game-state.json'),
      DOUJOY_CLOUDPAY_SANDBOX_DATA_PATH: join(directory, 'billing-sandbox.json'),
      ...(mode ? { DOUJOY_CLOUDPAY_MODE: mode } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolveReady, reject) => {
    let diagnostics = '';
    const timer = setTimeout(() => reject(new Error(`SERVER_START_TIMEOUT: ${diagnostics}`)), 10_000);
    child.stdout?.on('data', (chunk) => {
      diagnostics += String(chunk);
      if (diagnostics.includes('DouJoy server listening')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`SERVER_EXITED_${code}: ${diagnostics}`));
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${port}`, directory };
}

async function stopServer(server: RunningServer) {
  server.child.kill();
  await rm(server.directory, { recursive: true, force: true });
}

async function guest(baseUrl: string, name: string) {
  return fetch(`${baseUrl}/v1/sessions/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  }).then((response) => response.json()) as Promise<{ token: string }>;
}

test('billing catalog requires authentication and disabled mode fails closed', async () => {
  const server = await startServer();
  try {
    const unauthorized = await fetch(`${server.baseUrl}/v1/billing/catalog`);
    assert.equal(unauthorized.status, 401);
    const session = await guest(server.baseUrl, '计费权限测试');
    const catalogResponse = await fetch(`${server.baseUrl}/v1/billing/catalog`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    const catalog = await catalogResponse.json() as { catalog: { enabled: boolean; gameScoreConversion: string } };
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalog.catalog.enabled, false);
    assert.equal(catalog.catalog.gameScoreConversion, 'forbidden');

    const orderResponse = await fetch(`${server.baseUrl}/v1/billing/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
        'idempotency-key': 'disabled-http-order-1',
      },
      body: JSON.stringify({ productId: 'ai-review' }),
    });
    const order = await orderResponse.json() as { error: { code: string } };
    assert.equal(orderResponse.status, 503);
    assert.equal(order.error.code, 'CLOUDPAY_BILLING_DISABLED');
  } finally {
    await stopServer(server);
  }
});

test('sandbox HTTP flow marks simulation, enforces idempotency, ownership and cancellation', async () => {
  const server = await startServer('sandbox');
  try {
    const owner = await guest(server.baseUrl, '订单所有者');
    const stranger = await guest(server.baseUrl, '其他玩家');
    const headers = {
      authorization: `Bearer ${owner.token}`,
      'content-type': 'application/json',
      'idempotency-key': 'sandbox-http-order-1',
    };
    const firstResponse = await fetch(`${server.baseUrl}/v1/billing/orders`, {
      method: 'POST', headers, body: JSON.stringify({ productId: 'ai-review', quantity: 2 }),
    });
    const first = await firstResponse.json() as {
      order: { id: string; status: string; totalMinorAmount: string };
      replayed: boolean;
      sandbox: { simulated: boolean; warning: string };
    };
    assert.equal(firstResponse.status, 201);
    assert.equal(first.order.status, 'reserved');
    assert.equal(first.order.totalMinorAmount, '100000');
    assert.equal(first.replayed, false);
    assert.equal(first.sandbox.simulated, true);
    assert.match(first.sandbox.warning, /没有调用 cloudpay\.kai\.com/);

    const replayResponse = await fetch(`${server.baseUrl}/v1/billing/orders`, {
      method: 'POST', headers, body: JSON.stringify({ productId: 'ai-review', quantity: 2 }),
    });
    const replay = await replayResponse.json() as { order: { id: string }; replayed: boolean };
    assert.equal(replayResponse.status, 200);
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, first.order.id);

    const reusedResponse = await fetch(`${server.baseUrl}/v1/billing/orders`, {
      method: 'POST', headers, body: JSON.stringify({ productId: 'advanced-ai-match', quantity: 2 }),
    });
    const reused = await reusedResponse.json() as { error: { code: string } };
    assert.equal(reusedResponse.status, 409);
    assert.equal(reused.error.code, 'IDEMPOTENCY_KEY_REUSED');

    const forbiddenRead = await fetch(`${server.baseUrl}/v1/billing/orders/${first.order.id}`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(forbiddenRead.status, 404);

    const cancelResponse = await fetch(`${server.baseUrl}/v1/billing/orders/${first.order.id}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${owner.token}` },
    });
    const cancelled = await cancelResponse.json() as { order: { status: string }; replayed: boolean };
    assert.equal(cancelResponse.status, 200);
    assert.equal(cancelled.order.status, 'cancelled');
    assert.equal(cancelled.replayed, false);

    const repeatedCancel = await fetch(`${server.baseUrl}/v1/billing/orders/${first.order.id}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${owner.token}` },
    }).then((response) => response.json()) as { replayed: boolean };
    assert.equal(repeatedCancel.replayed, true);
  } finally {
    await stopServer(server);
  }
});
