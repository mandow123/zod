import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { installErrorHandling } from '../src/errors.js';
import { KaiCloudError, UnavailableKaiCloudPublicApi } from '../src/kai-cloud/client.js';
import { registerKaiCloudVerificationRoutes } from '../src/kai-cloud/routes.js';
import { KaiCloudVerificationService } from '../src/kai-cloud/service.js';
import { KaiCloudWebhookVerifier } from '../src/kai-cloud/webhook.js';

const principal = { userId: '11111111-1111-4111-8111-111111111111', sessionId: 'session', role: 'supplier' } as const;
const subject = { subjectId: '22222222-2222-4222-8222-222222222222', userId: principal.userId,
  kind: 'personal' as const, displayName: '资源方', subjectStatus: 'active' as const, role: 'owner' as const,
  permissions: ['provider.read' as const, 'provider.resource.manage' as const] };
const assetId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-08-20T01:00:00.000Z');
const asset = { assetId, resourceId: '44444444-4444-4444-8444-444444444444', productCode: 'H100',
  region: 'cn-east', specifications: { gpuCount: 8 } };
const upstream = { id: 'verification_123', version: 1, status: 'running' as const, updatedAt: now.toISOString(), failure: null };

function stored(status: 'pending' | 'running' | 'passed' | 'failed' | 'revoked' = 'running') {
  return { id: '55555555-5555-4555-8555-555555555555', assetId, subjectId: subject.subjectId,
    upstreamVerificationId: upstream.id, upstreamVersion: upstream.version, status, startIdempotencyKey: 'verification-request-0001',
    requestPayloadDigest: `sha256:${'a'.repeat(64)}`, failure: status === 'failed' ? { code: 'GPU_MISMATCH', message: 'GPU 配置不一致。' } : null,
    upstreamUpdatedAt: now, lastSyncedAt: now, createdAt: now, updatedAt: now };
}

function fixture(options: { unavailable?: boolean; existing?: ReturnType<typeof stored> | null } = {}) {
  const store = { asset: vi.fn().mockResolvedValue(asset), find: vi.fn().mockResolvedValue(options.existing ?? null),
    save: vi.fn(), applyWebhook: vi.fn().mockResolvedValue({ status: 'updated', verification: stored('passed') }) };
  store.save.mockImplementation(async (input) => ({ ...stored(input.verification.status),
    startIdempotencyKey: input.startIdempotencyKey, requestPayloadDigest: input.requestPayloadDigest,
    upstreamVersion: input.verification.version, upstreamUpdatedAt: new Date(input.verification.updatedAt), failure: input.verification.failure }));
  const api = options.unavailable ? new UnavailableKaiCloudPublicApi() : { available: true,
    createVerification: vi.fn().mockResolvedValue(upstream), getVerification: vi.fn().mockResolvedValue(upstream),
    revokeVerification: vi.fn().mockResolvedValue({ ...upstream, status: 'revoked' }), getDevice: vi.fn() };
  const subjects = { current: vi.fn().mockResolvedValue(subject) }; const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const webhook = new KaiCloudWebhookVerifier('W'.repeat(32), 300, () => now.getTime());
  return { store, api, subjects, audit, service: new KaiCloudVerificationService(store as never, subjects as never,
    api as never, webhook, audit, () => now) };
}

describe('KAI Cloud verification service', () => {
  it('checks current-subject permission, sends only mapped resource facts, persists state, and audits start', async () => {
    const f = fixture(); const result = await f.service.start(principal, assetId, 'verification-request-0001',
      { requestId: 'request-1', ip: '127.0.0.1' });
    expect(result).toMatchObject({ replayed: false, verification: { status: 'running', syncState: 'current' } });
    expect(f.subjects.current).toHaveBeenCalledWith(principal.userId, 'provider.resource.manage');
    expect(f.api.createVerification).toHaveBeenCalledWith({ organizationReference: subject.subjectId,
      resourceReference: asset.resourceId, productCode: 'H100', region: 'cn-east', specifications: { gpuCount: 8 },
      idempotencyKey: 'verification-request-0001' });
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'KAI_CLOUD_VERIFICATION_STARTED' }));
  });

  it('fails closed when unconfigured and keeps a cached non-passed status when refresh fails', async () => {
    const unavailable = fixture({ unavailable: true });
    await expect(unavailable.service.start(principal, assetId, 'verification-request-0001',
      { requestId: 'request-1', ip: '127.0.0.1' })).rejects.toMatchObject({
      code: 'KAI_CLOUD_PUBLIC_API_UNAVAILABLE', statusCode: 503 });
    const stale = fixture({ existing: stored('running') });
    (stale.api.getVerification as ReturnType<typeof vi.fn>).mockRejectedValue(
      new KaiCloudError('KAI_CLOUD_UNAVAILABLE', true, false, 'offline'));
    await expect(stale.service.get(principal, assetId)).resolves.toMatchObject({
      status: 'running', syncState: 'stale', blocker: 'KAI_CLOUD_UNAVAILABLE' });
  });

  it('never presents a cached pass as current while unavailable and reconciles terminal cache when available', async () => {
    const unavailable = fixture({ unavailable: true, existing: stored('passed') });
    await expect(unavailable.service.get(principal, assetId)).resolves.toMatchObject({
      available: false, status: 'passed', syncState: 'unavailable' });

    const reconcile = fixture({ existing: stored('passed') });
    (reconcile.api.getVerification as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...upstream, version: 2, status: 'failed', failure: { code: 'NODE_OFFLINE', message: '节点已离线。' },
    });
    await expect(reconcile.service.get(principal, assetId)).resolves.toMatchObject({
      status: 'failed', syncState: 'current', failure: { code: 'NODE_OFFLINE' } });

    const regression = fixture({ existing: stored('running') });
    (regression.api.getVerification as ReturnType<typeof vi.fn>).mockResolvedValue({ ...upstream, version: 0 });
    await expect(regression.service.get(principal, assetId)).resolves.toMatchObject({
      status: 'running', syncState: 'stale', blocker: 'KAI_CLOUD_VERSION_REGRESSION' });
  });

  it('replays an identical start without a second upstream mutation', async () => {
    const f = fixture();
    const first = await f.service.start(principal, assetId, 'verification-request-0001',
      { requestId: 'request-1', ip: '127.0.0.1' });
    const saved = await f.store.save.mock.results[0]!.value;
    f.store.find.mockResolvedValue(saved);
    const replay = await f.service.start(principal, assetId, 'verification-request-0001',
      { requestId: 'request-2', ip: '127.0.0.1' });
    expect(first.replayed).toBe(false); expect(replay.replayed).toBe(true);
    expect(f.api.createVerification).toHaveBeenCalledTimes(1);
  });

  it('makes start and revoke idempotent and refuses a second active verification', async () => {
    const replay = fixture({ existing: stored('running') });
    await expect(replay.service.start(principal, assetId, 'verification-request-0001',
      { requestId: 'request-1', ip: '127.0.0.1' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    await expect(replay.service.start(principal, assetId, 'verification-request-0002',
      { requestId: 'request-1', ip: '127.0.0.1' })).rejects.toMatchObject({ code: 'KAI_CLOUD_VERIFICATION_ACTIVE' });
    const revoked = fixture({ existing: stored('revoked') });
    await expect(revoked.service.revoke(principal, assetId, 'verification-revoke-0001',
      { requestId: 'request-1', ip: '127.0.0.1' })).resolves.toMatchObject({ replayed: true });
  });

  it('verifies webhook signatures, rejects replay conflicts, and never needs a user session', async () => {
    const f = fixture({ existing: stored('running') }); const timestamp = String(Math.floor(now.getTime() / 1_000));
    const rawBody = JSON.stringify({ id: 'event_123', version: 1, type: 'resource.verification.updated', occurredAt: now.toISOString(),
      data: { verification: { ...upstream, status: 'passed' } } });
    const signature = `sha256=${createHmac('sha256', 'W'.repeat(32)).update(`${timestamp}.${rawBody}`).digest('hex')}`;
    await expect(f.service.acceptWebhook({ deliveryId: 'delivery-0001', timestamp, signature, rawBody }))
      .resolves.toMatchObject({ accepted: true, matched: true });
    f.store.applyWebhook.mockResolvedValue('delivery_conflict');
    await expect(f.service.acceptWebhook({ deliveryId: 'delivery-0001', timestamp, signature, rawBody }))
      .rejects.toMatchObject({ code: 'KAI_CLOUD_WEBHOOK_REPLAY_CONFLICT' });
  });
});

describe('KAI Cloud verification routes', () => {
  it('authenticates mobile routes, preserves no-store, and exposes the signed webhook separately', async () => {
    const app = Fastify(); installErrorHandling(app); const accounts = { authenticate: vi.fn().mockResolvedValue({ principal }) };
    const service = { get: vi.fn().mockResolvedValue({ available: false, status: 'not_started', syncState: 'current', failure: null, updatedAt: null }),
      start: vi.fn(), revoke: vi.fn(), acceptWebhook: vi.fn().mockResolvedValue({ accepted: true, replayed: false, matched: true }) };
    await registerKaiCloudVerificationRoutes(app, accounts as never, service as never);
    const mobile = await app.inject({ method: 'GET', url: `/mobile/v1/provider/assets/${assetId}/kai-cloud-verification`,
      headers: { authorization: 'Bearer access' } });
    expect(mobile.statusCode).toBe(200); expect(mobile.headers['cache-control']).toBe('no-store, private');
    expect(accounts.authenticate).toHaveBeenCalledWith('Bearer access');
    const webhook = await app.inject({ method: 'POST', url: '/integrations/kai-cloud/public/v1/events',
      headers: { 'content-type': 'application/json', 'x-kai-delivery-id': 'delivery-0001',
        'x-kai-timestamp': '1787187600', 'x-kai-signature': `sha256=${'a'.repeat(64)}` }, payload: { type: 'test' } });
    expect(webhook.statusCode).toBe(202); expect(accounts.authenticate).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
