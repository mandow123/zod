import { describe, expect, it, vi } from 'vitest';
import { NodeEnrollmentService } from '../src/node-enrollment/service.js';
import type { AccountPrincipal } from '../src/account/types.js';

const principal: AccountPrincipal = { userId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'session', role: 'supplier' };
const subject = { subjectId: '22222222-2222-4222-8222-222222222222', userId: principal.userId,
  kind: 'personal' as const, displayName: '资源方', subjectStatus: 'active' as const, role: 'owner' as const,
  permissions: ['provider.resource.manage' as const] };
const context = { requestId: 'request-1', ip: '127.0.0.1' };
const assetId = '33333333-3333-4333-8333-333333333333';
const deploymentId = '44444444-4444-4444-8444-444444444444';

function fixture() {
  const store = { issueClaim: vi.fn(), consumeClaim: vi.fn(), recordHeartbeat: vi.fn(), revokeDeployment: vi.fn() };
  const subjects = { current: vi.fn().mockResolvedValue(subject) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const now = new Date('2026-08-15T01:00:00.000Z');
  return { store, subjects, audit, now, service: new NodeEnrollmentService(store as never, subjects, audit, () => now) };
}

describe('node enrollment service', () => {
  it('generates server-owned claim material and recovers the exact token on idempotent replay', async () => {
    const f = fixture(); let saved: Parameters<typeof f.store.issueClaim>[0] | undefined;
    f.store.issueClaim.mockImplementation(async (input) => {
      if (!saved) saved = input;
      return { status: saved === input ? 'issued' : 'replayed', deploymentId: saved.deploymentId,
        deploymentGeneration: 1, claimId: saved.claimId, claimGeneration: 1, claimToken: saved.claimToken,
        challenge: saved.challenge, expectedPolicyDigest: `sha256:${'a'.repeat(64)}`, expiresAt: saved.expiresAt };
    });
    const first = await f.service.issueClaim(principal, '33333333-3333-4333-8333-333333333333',
      'claim-request-0001', context);
    const replay = await f.service.issueClaim(principal, '33333333-3333-4333-8333-333333333333',
      'claim-request-0001', context);
    expect(first.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.expiresAt).toBe('2026-08-15T01:10:00.000Z');
    expect(replay).toMatchObject({ replayed: true, claimId: first.claimId, claimToken: first.claimToken });
    expect(f.subjects.current).toHaveBeenCalledWith(principal.userId, 'provider.resource.manage');
    expect(saved?.requestPayloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('uses server time, never accepts caller identity, and maps store rejections to AppError', async () => {
    const f = fixture(); f.store.consumeClaim.mockResolvedValue({ status: 'invalid' });
    await expect(f.service.consume({ claimId: '33333333-3333-4333-8333-333333333333', claimToken: 'A'.repeat(43),
      publicKey: `ed25519:${'A'.repeat(44)}`, observedAt: f.now.toISOString(), agentVersion: '1.0.0', inventory: [],
      inventoryDigest: `sha256:${'a'.repeat(64)}`, runtimeDigest: `sha256:${'b'.repeat(64)}`,
      policyDigest: `sha256:${'c'.repeat(64)}`, signature: `ed25519:${'B'.repeat(88)}` }, context))
      .rejects.toMatchObject({ code: 'NODE_CLAIM_INVALID', statusCode: 401 });
    expect(f.store.consumeClaim.mock.calls[0]?.[0].now).toEqual(f.now);
    f.store.recordHeartbeat.mockResolvedValue({ status: 'runtime_mismatch' });
    await expect(f.service.heartbeat({ nodeId: '33333333-3333-4333-8333-333333333333',
      bootId: '44444444-4444-4444-8444-444444444444', sequence: '1', observedAt: f.now.toISOString(),
      agentVersion: '1.0.0', inventory: [], inventoryDigest: `sha256:${'a'.repeat(64)}`,
      runtimeDigest: `sha256:${'b'.repeat(64)}`, policyDigest: `sha256:${'c'.repeat(64)}`,
      signature: `ed25519:${'B'.repeat(88)}` }, context)).resolves.toMatchObject({
        accepted: true, readiness: 'checking', blocker: 'runtime_mismatch', sequence: '1',
      });
  });

  it('checks provider permission and blocks revoke while obligations exist', async () => {
    const f = fixture(); f.store.revokeDeployment.mockResolvedValue({ status: 'obligations_active' });
    await expect(f.service.revoke(principal, assetId, deploymentId, context))
      .rejects.toMatchObject({ code: 'NODE_ENROLLMENT_IN_USE', statusCode: 409 });
    expect(f.subjects.current).toHaveBeenCalledWith(principal.userId, 'provider.resource.manage');
    expect(f.store.revokeDeployment).toHaveBeenCalledWith({
      subjectId: subject.subjectId, assetId, deploymentId, now: f.now,
    });
  });

  it('makes a lost revoke response safe to replay', async () => {
    const f = fixture(); f.store.revokeDeployment.mockResolvedValue({ status: 'already_revoked' });
    await expect(f.service.revoke(principal, assetId, deploymentId, context))
      .resolves.toEqual({ revoked: true, replayed: true });
  });
});
