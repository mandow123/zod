import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CloudPayBillingService, SandboxBillingStore, sandboxWarning, type CloudPayMode } from './billing.ts';
import { DouJoyPlatform, PlatformError } from './platform.ts';
import { JsonGameStore } from './store.ts';
import { SlidingWindowLimiter } from './security.ts';

const port = Number(process.env.DOUJOY_PORT ?? 4310);
const dataPath = process.env.DOUJOY_DATA_PATH ?? resolve(fileURLToPath(new URL('../data/state.json', import.meta.url)));
const corsOrigin = process.env.DOUJOY_CORS_ORIGIN ?? (process.env.NODE_ENV === 'production' ? '' : '*');
const turnTimeoutMs = Number(process.env.DOUJOY_TURN_TIMEOUT_MS ?? 45_000);
const botThinkMinMs = Number(process.env.DOUJOY_BOT_THINK_MIN_MS ?? 1_200);
const botThinkMaxMs = Number(process.env.DOUJOY_BOT_THINK_MAX_MS ?? 2_200);
const backupCount = Number(process.env.DOUJOY_BACKUP_COUNT ?? 3);
const waitTimeoutMaxMs = Number(process.env.DOUJOY_WAIT_TIMEOUT_MAX_MS ?? 25_000);
const cloudPayMode = process.env.DOUJOY_CLOUDPAY_MODE ?? 'disabled';
const cloudPaySandboxDataPath = process.env.DOUJOY_CLOUDPAY_SANDBOX_DATA_PATH
  ?? resolve(dirname(dataPath), 'cloudpay-sandbox-orders.json');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('DOUJOY_PORT_INVALID');
if (!corsOrigin) throw new Error('DOUJOY_CORS_ORIGIN_REQUIRED_IN_PRODUCTION');
if (!Number.isInteger(turnTimeoutMs) || turnTimeoutMs < 10_000 || turnTimeoutMs > 120_000) throw new Error('DOUJOY_TURN_TIMEOUT_MS_INVALID');
if (!Number.isInteger(botThinkMinMs) || !Number.isInteger(botThinkMaxMs)
  || botThinkMinMs < 500 || botThinkMaxMs > 10_000 || botThinkMinMs > botThinkMaxMs) {
  throw new Error('DOUJOY_BOT_THINK_RANGE_INVALID');
}
if (!Number.isInteger(backupCount) || backupCount < 1 || backupCount > 10) throw new Error('DOUJOY_BACKUP_COUNT_INVALID');
if (!Number.isInteger(waitTimeoutMaxMs) || waitTimeoutMaxMs < 100 || waitTimeoutMaxMs > 30_000) throw new Error('DOUJOY_WAIT_TIMEOUT_MAX_MS_INVALID');
if (!['disabled', 'sandbox'].includes(cloudPayMode)) throw new Error('DOUJOY_CLOUDPAY_MODE_INVALID');
if (cloudPayMode === 'sandbox' && resolve(cloudPaySandboxDataPath) === resolve(dataPath)) {
  throw new Error('DOUJOY_CLOUDPAY_SANDBOX_DATA_PATH_MUST_BE_ISOLATED');
}
const store = new JsonGameStore(dataPath, { backupCount });
await store.load();
if (store.recoverySource()) console.warn(`DouJoy store recovered from ${store.recoverySource()}`);
const platform = new DouJoyPlatform(store, turnTimeoutMs, botThinkMinMs, botThinkMaxMs);
const sandboxBillingStore = new SandboxBillingStore(cloudPaySandboxDataPath);
if (cloudPayMode === 'sandbox') await sandboxBillingStore.load();
const billing = new CloudPayBillingService(cloudPayMode as CloudPayMode, sandboxBillingStore);
const requestLimiter = new SlidingWindowLimiter();
const guestLimiter = new SlidingWindowLimiter();
const pendingWaitsByUser = new Map<string, number>();
const pendingWaitsByAddress = new Map<string, number>();

function json(response: import('node:http').ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': corsOrigin,
    'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-request-id',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-site',
  });
  response.end(JSON.stringify(body));
}

async function body(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new PlatformError(413, 'BODY_TOO_LARGE', '请求内容过大。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
  catch { throw new PlatformError(400, 'INVALID_JSON', '请求格式不正确。'); }
}

function waitInput(url: URL) {
  const rawVersion = url.searchParams.get('version');
  const version = rawVersion === null ? Number.NaN : Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new PlatformError(400, 'VERSION_REQUIRED', '缺少有效的状态版本。');
  }
  const rawTimeout = url.searchParams.get('timeoutMs');
  const requestedTimeout = rawTimeout === null ? waitTimeoutMaxMs : Number(rawTimeout);
  if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1) {
    throw new PlatformError(400, 'WAIT_TIMEOUT_INVALID', '等待时长无效。');
  }
  return { version, timeoutMs: Math.min(requestedTimeout, waitTimeoutMaxMs) };
}

function acquireWait(clientAddress: string, userId: string) {
  const userCount = pendingWaitsByUser.get(userId) ?? 0;
  const addressCount = pendingWaitsByAddress.get(clientAddress) ?? 0;
  if (userCount >= 2 || addressCount >= 8) throw new PlatformError(429, 'WAIT_LIMITED', '同步连接过多，请稍后重试。');
  pendingWaitsByUser.set(userId, userCount + 1);
  pendingWaitsByAddress.set(clientAddress, addressCount + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const nextUserCount = (pendingWaitsByUser.get(userId) ?? 1) - 1;
    const nextAddressCount = (pendingWaitsByAddress.get(clientAddress) ?? 1) - 1;
    if (nextUserCount <= 0) pendingWaitsByUser.delete(userId); else pendingWaitsByUser.set(userId, nextUserCount);
    if (nextAddressCount <= 0) pendingWaitsByAddress.delete(clientAddress); else pendingWaitsByAddress.set(clientAddress, nextAddressCount);
  };
}

async function longPoll<T extends object>(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  clientAddress: string,
  userId: string,
  wait: (signal: AbortSignal) => Promise<T | null>,
) {
  const release = acquireWait(clientAddress, userId);
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once('aborted', abort);
  response.once('close', abort);
  if (request.aborted || response.destroyed) controller.abort();
  try {
    const result = await wait(controller.signal);
    if (result === null || controller.signal.aborted || response.destroyed) return;
    json(response, 200, { ok: true, ...result });
  } finally {
    request.off('aborted', abort);
    response.off('close', abort);
    release();
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') return json(response, 204, null);
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const clientAddress = request.socket.remoteAddress ?? 'unknown';
    const rate = requestLimiter.consume(clientAddress, 180, 60_000);
    if (!rate.allowed) throw new PlatformError(429, 'RATE_LIMITED', `请求过于频繁，请在 ${rate.retryAfterSeconds} 秒后重试。`);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, { ok: true, service: 'doujoy', tokenMode: 'play-only' });
    }
    if (request.method === 'POST' && url.pathname === '/v1/sessions/guest') {
      const guestRate = guestLimiter.consume(clientAddress, 12, 60 * 60_000);
      if (!guestRate.allowed) throw new PlatformError(429, 'GUEST_RATE_LIMITED', '创建游客账号过于频繁，请稍后再试。');
      const input = await body(request);
      return json(response, 201, { ok: true, ...(await platform.guest(typeof input.name === 'string' ? input.name : undefined)) });
    }
    const user = platform.authenticate(request.headers.authorization);
    if (request.method === 'GET' && url.pathname === '/v1/billing/catalog') {
      return json(response, 200, { ok: true, catalog: billing.catalog() });
    }
    if (request.method === 'POST' && url.pathname === '/v1/billing/orders') {
      const input = await body(request);
      const result = await billing.createOrder(user.id, {
        productId: typeof input.productId === 'string' ? input.productId : '',
        quantity: typeof input.quantity === 'number' ? input.quantity : undefined,
        idempotencyKey: typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key'] : undefined,
      });
      return json(response, result.replayed ? 200 : 201, { ok: true, ...result, sandbox: sandboxWarning });
    }
    const billingOrderMatch = url.pathname.match(/^\/v1\/billing\/orders\/([^/]+)(?:\/(cancel))?$/);
    if (billingOrderMatch && request.method === 'GET' && !billingOrderMatch[2]) {
      return json(response, 200, { ok: true, order: billing.order(user.id, billingOrderMatch[1]!), sandbox: sandboxWarning });
    }
    if (billingOrderMatch && request.method === 'POST' && billingOrderMatch[2] === 'cancel') {
      return json(response, 200, { ok: true, ...(await billing.cancelOrder(user.id, billingOrderMatch[1]!)), sandbox: sandboxWarning });
    }
    if (request.method === 'GET' && url.pathname === '/v1/me') return json(response, 200, { ok: true, profile: platform.profile(user.id) });
    if (request.method === 'GET' && url.pathname === '/v1/resume') return json(response, 200, { ok: true, ...(await platform.resume(user.id)) });
    if (request.method === 'POST' && url.pathname === '/v1/games/quick') return json(response, 201, { ok: true, game: await platform.quickGame(user.id) });
    if (request.method === 'POST' && url.pathname === '/v1/relief') return json(response, 200, { ok: true, ...(await platform.relief(user.id)) });
    if (request.method === 'GET' && url.pathname === '/v1/history') return json(response, 200, { ok: true, ...platform.history(user.id) });
    if (request.method === 'POST' && url.pathname === '/v1/reports') {
      const input = await body(request);
      return json(response, 201, { ok: true, report: await platform.report(user.id, {
        gameId: typeof input.gameId === 'string' ? input.gameId : '',
        reason: typeof input.reason === 'string' ? input.reason : '',
        detail: typeof input.detail === 'string' ? input.detail : undefined,
      }) });
    }
    if (request.method === 'POST' && url.pathname === '/v1/rooms') return json(response, 201, { ok: true, room: await platform.createRoom(user.id) });
    if (request.method === 'POST' && url.pathname === '/v1/rooms/join') {
      const input = await body(request);
      return json(response, 200, { ok: true, room: await platform.joinRoom(user.id, typeof input.code === 'string' ? input.code : '') });
    }
    const roomMatch = url.pathname.match(/^\/v1\/rooms\/([^/]+)(?:\/(start|leave|wait))?$/);
    if (roomMatch && request.method === 'GET' && !roomMatch[2]) return json(response, 200, { ok: true, room: platform.room(roomMatch[1]!, user.id) });
    if (roomMatch && request.method === 'GET' && roomMatch[2] === 'wait') {
      const input = waitInput(url);
      return await longPoll(request, response, clientAddress, user.id, (signal) => platform.waitRoom(roomMatch[1]!, user.id, input.version, input.timeoutMs, signal));
    }
    if (roomMatch && request.method === 'POST' && roomMatch[2] === 'start') return json(response, 200, { ok: true, ...(await platform.startRoom(roomMatch[1]!, user.id)) });
    if (roomMatch && request.method === 'POST' && roomMatch[2] === 'leave') return json(response, 200, { ok: true, ...(await platform.leaveRoom(roomMatch[1]!, user.id)) });
    const gameMatch = url.pathname.match(/^\/v1\/games\/([^/]+)(?:\/(bid|play|pass|wait|abandon))?$/);
    if (gameMatch && request.method === 'GET' && !gameMatch[2]) return json(response, 200, { ok: true, game: await platform.refreshedView(gameMatch[1]!, user.id) });
    if (gameMatch && request.method === 'GET' && gameMatch[2] === 'wait') {
      const input = waitInput(url);
      return await longPoll(request, response, clientAddress, user.id, (signal) => platform.waitGame(gameMatch[1]!, user.id, input.version, input.timeoutMs, signal));
    }
    if (gameMatch && request.method === 'POST' && gameMatch[2] === 'abandon') {
      return json(response, 200, { ok: true, ...(await platform.abandonGame(gameMatch[1]!, user.id)) });
    }
    if (gameMatch && request.method === 'POST' && gameMatch[2]) {
      const input = await body(request);
      const result = await platform.action({
        gameId: gameMatch[1]!, userId: user.id,
        requestId: String(request.headers['x-request-id'] ?? input.requestId ?? ''),
        expectedSequence: typeof input.expectedSequence === 'number' ? input.expectedSequence : -1,
        kind: gameMatch[2] as 'bid' | 'play' | 'pass',
        score: typeof input.score === 'number' ? input.score : undefined,
        cardIds: Array.isArray(input.cardIds) ? input.cardIds.filter((id): id is string => typeof id === 'string') : undefined,
      });
      return json(response, 200, { ok: true, ...result });
    }
    throw new PlatformError(404, 'NOT_FOUND', '接口不存在。');
  } catch (error) {
    if (error instanceof PlatformError) return json(response, error.status, { ok: false, error: { code: error.code, message: error.message } });
    console.error(error);
    return json(response, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用。' } });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`DouJoy server listening on http://0.0.0.0:${port}`);
  console.log('Token mode: play-only; purchase/withdraw/transfer/redeem are disabled');
  console.log(`CloudPay card-hour billing mode: ${cloudPayMode}`);
});
