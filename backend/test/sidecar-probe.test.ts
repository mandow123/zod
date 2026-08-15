import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { compareProbeSignatures, probeOrigin } from '../deploy/aws-ubuntu/verify-sidecar.mjs';

const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function fixtureOrigin(readinessReady = true) {
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (path === '/mobile/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'kai-cloudpay-backend', apiVersion: 'mobile/v1' }));
      return;
    }
    if (path === '/mobile/v1/readiness') {
      response.writeHead(readinessReady ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: readinessReady, service: 'kai-cloudpay-backend',
        deployment: { ready: readinessReady, blockers: readinessReady ? [] : ['DATABASE'] },
        release: { ready: readinessReady, blockers: readinessReady ? [] : ['DATABASE'] } }));
      return;
    }
    const legal = { '/privacy': '隐私政策', '/terms': '用户协议', '/account/delete': '删除 CloudPay 账户' }[path];
    if (legal) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<html>KAI CloudPay ${legal}</html>`);
      return;
    }
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED' } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('private sidecar provider cutover probe', () => {
  it('accepts a ready backend only when every provider and legal route has the expected identity', async () => {
    const probe = await probeOrigin(await fixtureOrigin());
    expect(probe.ok).toBe(true);
    expect(probe.records).toHaveLength(10);
    expect(probe.failures).toEqual([]);
  });

  it('rejects a healthy process whose release readiness is still closed', async () => {
    const probe = await probeOrigin(await fixtureOrigin(false));
    expect(probe.ok).toBe(false);
    expect(probe.failures).toContain('/mobile/v1/readiness: deployment or release is not ready');
  });

  it('requires loopback and private edge to expose the same route signatures', async () => {
    const loopback = await probeOrigin(await fixtureOrigin());
    const edge = structuredClone(loopback);
    const listingSignature = edge.signatures['/mobile/v1/provider/listings'];
    expect(listingSignature).toBeDefined();
    listingSignature!.status = 404;
    expect(compareProbeSignatures(loopback, edge)).toEqual(['/mobile/v1/provider/listings']);
  });
});
