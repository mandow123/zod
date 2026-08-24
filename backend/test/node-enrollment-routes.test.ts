import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { installErrorHandling } from '../src/errors.js';
import { registerNodeEnrollmentRoutes } from '../src/node-enrollment/routes.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const assetId = '11111111-1111-4111-8111-111111111111'; const claimId = '22222222-2222-4222-8222-222222222222';
const nodeId = '33333333-3333-4333-8333-333333333333'; const bootId = '44444444-4444-4444-8444-444444444444';
const deploymentId = '55555555-5555-4555-8555-555555555555';
const rawInventory = [{ uuid: 'GPU-AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', model: 'NVIDIA H100',
  memoryTotalMiB: 97_871, driverVersion: '580.173.02', cudaVersion: '13.0', migMode: 'Disabled', computeMode: 'Default' }];
const evidence = { observedAt: '2026-08-15T01:00:00.000Z', agentVersion: '1.0.0', inventory: rawInventory,
  inventoryDigest: `sha256:${'a'.repeat(64)}`, runtimeDigest: `sha256:${'b'.repeat(64)}`,
  policyDigest: `sha256:${'c'.repeat(64)}`, signature: `ed25519:${'D'.repeat(88)}` };

async function fixture() {
  const app = Fastify(); installErrorHandling(app);
  const accounts = { authenticate: vi.fn().mockResolvedValue({ principal: { userId: assetId, sessionId: 's', role: 'supplier' } }) };
  const service = { issueClaim: vi.fn().mockResolvedValue({ replayed: false, deploymentId: assetId,
    deploymentGeneration: 1, claimId, claimGeneration: 1, claimToken: 'T'.repeat(43), challenge: 'C'.repeat(43),
    expectedPolicyDigest: `sha256:${'e'.repeat(64)}`, expiresAt: '2026-08-15T01:10:00.000Z' }),
  revoke: vi.fn().mockResolvedValue({ revoked: true }), consume: vi.fn().mockResolvedValue({ replayed: false,
    nodeId, bindingId: assetId, deploymentId: claimId }), heartbeat: vi.fn().mockResolvedValue({ replayed: false,
    nodeId, sequence: '1', observedAt: evidence.observedAt, readiness: 'ready' }) };
  await registerNodeEnrollmentRoutes(app, accounts as never, service as never); return { app, accounts, service };
}

describe('node enrollment routes', () => {
  it('is wired through the production app builder only when the service is present', async () => {
    const f = await fixture();
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: f.accounts as never, nodeEnrollmentService: f.service as never, logger: false });
    const response = await app.inject({ method: 'POST', url: `/mobile/v1/provider/assets/${assetId}/node-claims`,
      headers: { authorization: 'Bearer access', 'idempotency-key': 'claim-request-0001' } });
    expect(response.statusCode).toBe(201);
    await app.close(); await f.app.close();
  });

  it('authenticates provider claim issuance and returns the token only in that response', async () => {
    const f = await fixture(); const response = await f.app.inject({ method: 'POST',
      url: `/mobile/v1/provider/assets/${assetId}/node-claims`, headers: { authorization: 'Bearer access',
        'idempotency-key': 'claim-request-0001' } });
    expect(response.statusCode).toBe(201); expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.json().claim.claimToken).toBe('T'.repeat(43));
    expect(response.json().claim.consumePath).toBe(`/node/v1/claims/${claimId}/consume`);
    expect(f.accounts.authenticate).toHaveBeenCalledWith('Bearer access', undefined, expect.any(Array)); await f.app.close();
  });

  it('takes claim token only from NodeClaim authorization and never echoes secrets', async () => {
    const f = await fixture(); const response = await f.app.inject({ method: 'POST', url: `/node/v1/claims/${claimId}/consume`,
      headers: { authorization: `NodeClaim ${'T'.repeat(43)}` }, payload: { publicKey: `ed25519:${'A'.repeat(44)}`, ...evidence } });
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.body).not.toContain('signature'); expect(response.body).not.toContain('T'.repeat(43));
    expect(response.json().node.heartbeatPath).toBe(`/node/v1/nodes/${nodeId}/heartbeats`);
    expect(f.service.consume.mock.calls[0]?.[0]).not.toHaveProperty('now');
    expect(f.service.consume.mock.calls[0]?.[0].claimToken).toBe('T'.repeat(43)); await f.app.close();
  });

  it('targets one immutable deployment when disconnecting an enrolled node', async () => {
    const f = await fixture(); const response = await f.app.inject({ method: 'DELETE',
      url: `/mobile/v1/provider/assets/${assetId}/node-enrollments/${deploymentId}`,
      headers: { authorization: 'Bearer access' } });
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store, private');
    expect(f.service.revoke).toHaveBeenCalledWith(expect.objectContaining({ userId: assetId }), assetId, deploymentId,
      expect.objectContaining({ requestId: expect.any(String) }));
    const obsolete = await f.app.inject({ method: 'DELETE',
      url: `/mobile/v1/provider/assets/${assetId}/node-enrollment`, headers: { authorization: 'Bearer access' } });
    expect(obsolete.statusCode).toBe(404); await f.app.close();
  });

  it('rejects unknown heartbeat fields and does not echo signed input', async () => {
    const f = await fixture(); const rejected = await f.app.inject({ method: 'POST',
      url: `/node/v1/nodes/${nodeId}/heartbeats`, payload: { bootId, sequence: '1', ...evidence, userId: assetId } });
    expect(rejected.statusCode).toBe(400); expect(rejected.headers['cache-control']).toBe('no-store, private');
    const accepted = await f.app.inject({ method: 'POST', url: `/node/v1/nodes/${nodeId}/heartbeats`,
      payload: { bootId, sequence: '1', ...evidence } });
    expect(accepted.statusCode).toBe(200); expect(accepted.headers['cache-control']).toBe('no-store, private');
    expect(accepted.body).not.toContain('signature'); expect(f.service.heartbeat.mock.calls[0]?.[0]).not.toHaveProperty('now');
    await f.app.close();
  });

  it('acknowledges consumed drift evidence so the sidecar can advance its journal', async () => {
    const f = await fixture(); f.service.heartbeat.mockResolvedValue({ replayed: false, accepted: true,
      nodeId, sequence: '2', observedAt: evidence.observedAt, readiness: 'checking', blocker: 'runtime_mismatch' });
    const response = await f.app.inject({ method: 'POST', url: `/node/v1/nodes/${nodeId}/heartbeats`,
      payload: { bootId, sequence: '2', ...evidence } });
    expect(response.statusCode).toBe(202);
    expect(response.json().heartbeat).toMatchObject({ accepted: true, readiness: 'checking',
      blocker: 'runtime_mismatch', sequence: '2' });
    await f.app.close();
  });
});
