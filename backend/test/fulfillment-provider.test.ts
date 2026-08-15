import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attestationPayload, ComputeProviderError, SidecarComputeProvider } from '../src/fulfillment/provider.js';
import type { FulfillmentAttestation } from '../src/fulfillment/types.js';

const token = 's'.repeat(40);
const leaseId = '10000000-0000-4000-8000-000000000001';
const orderId = '20000000-0000-4000-8000-000000000001';
const resourceId = '30000000-0000-4000-8000-000000000001';
const bindingId = '30000000-0000-4000-8000-000000000002';
const nodeId = '30000000-0000-4000-8000-000000000003';
const policyDigest = `sha256:${'b'.repeat(64)}`;
const bootId = '40000000-0000-4000-8000-000000000001';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
function signedAttestation(overrides: Partial<FulfillmentAttestation> = {}) {
  const value = { nonce: leaseId, observedAt: new Date().toISOString(), orderId, resourceId,
    bindingId, bindingGeneration: 1, policyDigest, nodeId, capacityUnit: 'GPU时',
    allocatedGpuUuids: ['GPU-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    hardExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`, bootId, eventSequence: 1,
    heartbeatId: 'heartbeat-0001', acceleratorModel: 'NVIDIA H100 SXM5', nodeAcceleratorCount: 8,
    allocatedAcceleratorCount: 1, driverVersion: '580.173.02', memoryTotalMiB: 98_000,
    migMode: 'Disabled', computeMode: 'Default', evidenceDigest: `sha256:${'a'.repeat(64)}`,
    signature: `hmac-sha256:${'0'.repeat(64)}`, ...overrides } as FulfillmentAttestation;
  const signature = `hmac-sha256:${createHmac('sha256', token).update(JSON.stringify(attestationPayload(value))).digest('hex')}`;
  return { ...value, signature };
}

describe('compute sidecar provider contract', () => {
  it('requires a fully bound signed attestation before declaring a lease ready', async () => {
    const attestation = signedAttestation();
    const provider = new SidecarComputeProvider('https://sidecar.internal', token, async () => response({
      providerLeaseId: `kai:${leaseId}`,
      connection: { protocol: 'ssh', host: 'h100.internal', port: 22,
        hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
        knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`, displayName: 'H100 工作区' }, attestation,
    }));
    await expect(provider.provision({ leaseId, orderId, resourceId, bindingId, bindingGeneration: 1, policyDigest, nodeId,
      quantity: '1.000000', capacityUnit: 'GPU时',
      allocatedAcceleratorCount: 1, hardExpiresAt: attestation.hardExpiresAt }))
      .resolves.toMatchObject({ attestation: { nodeAcceleratorCount: 8, allocatedAcceleratorCount: 1 } });
  });

  it('rejects a stale or mismatched attestation', async () => {
    const attestation = signedAttestation({ nonce: '10000000-0000-4000-8000-000000000002',
      observedAt: new Date(Date.now() - 600_000).toISOString() });
    const provider = new SidecarComputeProvider('https://sidecar.internal', token, async () => response({
      providerLeaseId: `kai:${leaseId}`,
      connection: { protocol: 'ssh', host: 'h100.internal', port: 22,
        hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
        knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`, displayName: 'H100 工作区' }, attestation,
    }));
    await expect(provider.provision({ leaseId, orderId, resourceId, bindingId, bindingGeneration: 1, policyDigest, nodeId,
      quantity: '1.000000', capacityUnit: 'GPU时',
      allocatedAcceleratorCount: 1, hardExpiresAt: attestation.hardExpiresAt }))
      .rejects.toMatchObject({ code: 'PROVIDER_ATTESTATION_INVALID' });
  });

  it('exchanges the ticket privately and never returns it or the sidecar uri', async () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString(); let calls = 0;
    const provider = new SidecarComputeProvider('https://sidecar.internal', token, async (url, init) => {
      calls += 1;
      if (calls === 1) return response({ ticket: 't'.repeat(32),
        uri: `https://sidecar.internal/v1/access-sessions/${leaseId}/exchange`, expiresAt });
      expect(init?.headers).toEqual({ authorization: `Bearer ${'t'.repeat(32)}` });
      return response({ protocol: 'ssh', host: 'h100.internal', port: 22, username: 'kai',
        hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
        knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`,
        privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${'a'.repeat(120)}\n-----END OPENSSH PRIVATE KEY-----\n`, expiresAt });
    });
    const result = await provider.createAccessSession({ providerLeaseId: 'provider-lease-0001', sessionId: leaseId,
      ttlSeconds: 300 });
    expect(result).toMatchObject({ protocol: 'ssh', username: 'kai', ticketDigest: expect.any(String) });
    expect(result).not.toHaveProperty('ticket');
    expect(result).not.toHaveProperty('uri');
  });

  it('replays the exact private exchange when the first HTTP response is lost', async () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString(); let calls = 0; const authorizations: string[] = [];
    const provider = new SidecarComputeProvider('https://sidecar.internal', token, async (_url, init) => {
      calls += 1;
      if (calls === 1) return response({ ticket: 't'.repeat(32),
        uri: `https://sidecar.internal/v1/access-sessions/${leaseId}/exchange`, expiresAt });
      authorizations.push((init?.headers as Record<string, string>).authorization ?? '');
      if (calls === 2) throw new Error('response lost after sidecar committed exchange');
      return response({ protocol: 'ssh', host: 'h100.internal', port: 22, username: 'kai',
        hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
        knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`,
        privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${'a'.repeat(120)}\n-----END OPENSSH PRIVATE KEY-----\n`, expiresAt });
    });
    await expect(provider.createAccessSession({ providerLeaseId: 'provider-lease-0001', sessionId: leaseId,
      ttlSeconds: 300 })).resolves.toMatchObject({ protocol: 'ssh', username: 'kai' });
    expect(calls).toBe(3);
    expect(authorizations).toEqual([`Bearer ${'t'.repeat(32)}`, `Bearer ${'t'.repeat(32)}`]);
  });

  it('replays the exact private exchange when a successful response body is interrupted', async () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString(); let calls = 0;
    const provider = new SidecarComputeProvider('https://sidecar.internal', token, async () => {
      calls += 1;
      if (calls === 1) return response({ ticket: 't'.repeat(32),
        uri: `https://sidecar.internal/v1/access-sessions/${leaseId}/exchange`, expiresAt });
      if (calls === 2) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"protocol":"ssh"')); controller.error(new Error('socket reset')); },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      return response({ protocol: 'ssh', host: 'h100.internal', port: 22, username: 'kai',
        hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
        knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`,
        privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${'a'.repeat(120)}\n-----END OPENSSH PRIVATE KEY-----\n`, expiresAt });
    });
    await expect(provider.createAccessSession({ providerLeaseId: 'provider-lease-0001', sessionId: leaseId,
      ttlSeconds: 300 })).resolves.toMatchObject({ protocol: 'ssh', username: 'kai' });
    expect(calls).toBe(3);
  });

  it('rejects access uri outside the private provider origin', async () => {
    const provider = new SidecarComputeProvider('https://sidecar.internal', token, async () => response({
      ticket: 't'.repeat(32), uri: `https://evil.example/v1/access-sessions/${leaseId}/exchange`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }));
    await expect(provider.createAccessSession({ providerLeaseId: 'provider-lease-0001', sessionId: leaseId,
      ttlSeconds: 300 })).rejects.toMatchObject({ code: 'PROVIDER_ACCESS_URI_INVALID' });
  });

  it('classifies server errors as retryable for reconciliation', async () => {
    const provider = new SidecarComputeProvider('https://sidecar.internal', token, async () => response({}, 503));
    await expect(provider.stop({ providerLeaseId: 'provider-lease-0001', operationId: 'stop-000000000001' }))
      .rejects.toEqual(expect.objectContaining<Partial<ComputeProviderError>>({ code: 'PROVIDER_TEMPORARY_ERROR', retryable: true }));
  });
});
