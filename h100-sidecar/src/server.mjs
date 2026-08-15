import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { loadSidecarConfig } from './config.mjs';
import { DockerRuntime } from './docker.mjs';
import { OutboundNodeClient } from './node-client.mjs';
import { constantTimeToken } from './security.mjs';
import { H100SidecarService, SidecarError } from './service.mjs';
import { StateStore } from './state.mjs';

const config = loadSidecarConfig();
const nodeClient = new OutboundNodeClient(config);
await nodeClient.start();
const service = new H100SidecarService(config, new StateStore(config.stateDirectory, config), new DockerRuntime(config));
await service.initialize();
const tls = { key: await readFile(config.tlsKeyFile), cert: await readFile(config.tlsCertFile), minVersion: 'TLSv1.2' };

const server = https.createServer(tls, async (request, response) => {
  const started = Date.now(); const requestId = randomUUID(); let status = 500;
  try {
    const remoteAddress = normalizeAddress(request.socket.remoteAddress);
    if (!config.allowedBackendIps.includes(remoteAddress)) throw new SidecarError(403, 'SOURCE_IP_FORBIDDEN');
    const url = new URL(request.url ?? '/', config.publicOrigin); const path = url.pathname;
    if (request.method === 'GET' && path === '/health') {
      status = 200; return send(response, status, { ok: true, service: 'kai-h100-sidecar', apiVersion: 'v1',
        nodeReadiness: nodeClient.readiness });
    }
    if (request.method !== 'POST') throw new SidecarError(404, 'ROUTE_NOT_FOUND');
    const rawBody = await readBody(request);
    if (path.startsWith('/v1/access-sessions/') && path.endsWith('/exchange')) {
      const sessionId = decodeURIComponent(path.slice('/v1/access-sessions/'.length, -'/exchange'.length));
      const ticket = bearer(request.headers.authorization);
      const result = await service.exchange(sessionId, ticket); status = 200; return send(response, status, result);
    }
    verifyProviderRequest(request, path, rawBody, config);
    const body = parseJson(rawBody);
    if (path === '/v1/leases') {
      if (!nodeClient.isReady()) throw new SidecarError(503, 'NODE_NOT_READY');
      const result = await service.provision(body); status = 200; return send(response, status, result);
    }
    const access = path.match(/^\/v1\/leases\/(.+)\/access-sessions$/u);
    if (access) {
      const result = await service.createAccess(decodeURIComponent(access[1]), body);
      status = 200; return send(response, status, result);
    }
    const stop = path.match(/^\/v1\/leases\/(.+)\/stop$/u);
    if (stop) {
      const result = await service.stop(decodeURIComponent(stop[1]), body?.operationId);
      status = 200; return send(response, status, result);
    }
    const leaseStatus = path.match(/^\/v1\/leases\/(.+)\/status$/u);
    if (leaseStatus) {
      const result = await service.status(decodeURIComponent(leaseStatus[1]));
      status = 200; return send(response, status, result);
    }
    throw new SidecarError(404, 'ROUTE_NOT_FOUND');
  } catch (error) {
    status = error instanceof SidecarError ? error.status : 500;
    send(response, status, { ok: false, error: { code: error instanceof SidecarError ? error.code : 'INTERNAL_ERROR', requestId } });
  } finally {
    const path = (() => { try { return new URL(request.url ?? '/', config.publicOrigin).pathname; } catch { return 'invalid'; } })();
    process.stdout.write(`${JSON.stringify({ level: status >= 500 ? 'error' : 'info', requestId,
      method: request.method, path, status, durationMs: Date.now() - started })}\n`);
  }
});

server.requestTimeout = 35_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
server.listen(config.port, config.host, () => process.stdout.write(`${JSON.stringify({ level: 'info', event: 'listening',
  host: config.host, port: config.port })}\n`));

let shutdownPromise = null;
async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
  process.stdout.write(`${JSON.stringify({ level: 'info', event: 'shutdown', signal })}\n`);
    server.closeIdleConnections?.();
    let graceful = true;
    try {
      await Promise.race([new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SERVER_CLOSE_TIMEOUT')), 190_000))]);
    } catch (error) {
      graceful = false; server.closeAllConnections?.();
      process.stderr.write(`${JSON.stringify({ level: 'error', event: 'server_close_forced',
        code: error instanceof Error ? error.message : 'UNKNOWN' })}\n`);
    } finally {
      try { await nodeClient.close(); } finally { await service.close(); }
    }
    process.exitCode = graceful ? 0 : 1;
  })();
  return shutdownPromise;
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
nodeClient.loopPromise.catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'node_client_fatal',
    code: error?.code ?? 'NODE_CLIENT_FAILED' })}\n`);
  void shutdown('NODE_CLIENT_FATAL');
});

function verifyProviderRequest(request, path, rawBody, runtime) {
  const authorization = bearer(request.headers.authorization);
  const candidates = [runtime.providerToken, runtime.previousProviderToken].filter(Boolean);
  if (!constantTimeToken(authorization, candidates)) throw new SidecarError(401, 'PROVIDER_AUTH_INVALID');
  const timestamp = String(request.headers['x-kai-timestamp'] ?? ''); const time = new Date(timestamp).getTime();
  const idempotencyKey = String(request.headers['idempotency-key'] ?? '');
  const signature = String(request.headers['x-kai-signature'] ?? '');
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 60_000 || !/^[A-Za-z0-9:_-]{8,200}$/u.test(idempotencyKey)) {
    throw new SidecarError(401, 'PROVIDER_REQUEST_FRESHNESS_INVALID');
  }
  const expected = candidates.map((token) => createHmac('sha256', token)
    .update(`${timestamp}\n${idempotencyKey}\n${path}\n${rawBody}`).digest('hex'));
  if (!constantTimeToken(signature, expected)) throw new SidecarError(401, 'PROVIDER_REQUEST_SIGNATURE_INVALID');
}
function bearer(value) {
  const match = typeof value === 'string' ? value.match(/^Bearer ([A-Za-z0-9._~+\/-]{16,8192})$/u) : null;
  if (!match) throw new SidecarError(401, 'BEARER_REQUIRED'); return match[1];
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', (chunk) => { size += chunk.length; if (size > 65_536) { reject(new SidecarError(413, 'BODY_TOO_LARGE')); request.destroy(); }
      else chunks.push(chunk); });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); request.on('error', reject);
  });
}
function parseJson(value) { try { return JSON.parse(value || '{}'); } catch { throw new SidecarError(400, 'JSON_INVALID'); } }
function send(response, status, value) {
  if (response.headersSent) return; const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff' }); response.end(body);
}
function normalizeAddress(value) { return String(value ?? '').replace(/^::ffff:/u, ''); }
