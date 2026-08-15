import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ComputeProviderError, type ComputeProviderAdapter } from '../src/fulfillment/provider.js';
import { FulfillmentService } from '../src/fulfillment/service.js';
import type { FulfillmentStore } from '../src/fulfillment/store.js';
import type { FulfillmentRecord } from '../src/fulfillment/types.js';

const config = loadConfig({ AUDIT_PEPPER: 'a'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') });
const record: FulfillmentRecord = {
  id: '10000000-0000-4000-8000-000000000001', orderId: '20000000-0000-4000-8000-000000000001',
  buyerSubjectId: '30000000-0000-4000-8000-000000000001', supplierSubjectId: '40000000-0000-4000-8000-000000000001',
  resourceId: '50000000-0000-4000-8000-000000000001', providerKey: 'sidecar-v1', providerLeaseId: null,
  provisionalProviderLeaseId: null,
  allocatedAcceleratorCount: 1, resourceSlotLimit: 8,
  status: 'provisioning', connection: null, attestationDigest: null, failureCode: null, failureRetryable: null,
  createdAt: new Date(), provisioningAt: new Date(), readyAt: null, runningAt: null, stoppingAt: null,
  hardExpiresAt: new Date(Date.now() + 3_600_000), provisioningDeadlineAt: new Date(Date.now() + 300_000),
  stoppedAt: null, failedAt: null, updatedAt: new Date(),
};
const binding = {
  bindingId: '60000000-0000-4000-8000-000000000001', bindingGeneration: 1,
  policyDigest: `sha256:${'e'.repeat(64)}`, nodeId: '70000000-0000-4000-8000-000000000001',
};
const subjects = { current: async () => ({ userId: 'user', subjectId: record.supplierSubjectId, kind: 'personal' as const,
  displayName: '提供方', subjectStatus: 'active' as const, role: 'owner' as const, permissions: ['provider.order.manage' as const] }) };

describe('fulfillment service reconciliation safety', () => {
  it('refunds an explicitly failed ready lease but never blindly refunds a running lease', async () => {
    const ready = { ...record, id: '10000000-0000-4000-8000-000000000011', status: 'ready' as const,
      providerLeaseId: 'provider-ready-failed' };
    const running = { ...record, id: '10000000-0000-4000-8000-000000000012', status: 'running' as const,
      providerLeaseId: 'provider-running-failed', runningAt: new Date() };
    const failedIds: string[] = [];
    const store = {
      listActive: async () => [ready, running],
      markFailed: async (input: { fulfillmentId: string }) => {
        failedIds.push(input.fulfillmentId);
        return { ...ready, status: 'failed' as const };
      },
    } as unknown as FulfillmentStore;
    const provider = {
      key: 'sidecar-v1', available: true,
      getLeaseStatus: async (input: { providerLeaseId: string }) => ({
        status: 'failed' as const, providerLeaseId: input.providerLeaseId, eventSequence: 2,
        failureCode: 'ACCESS_TARGET_UNAVAILABLE_BEFORE_START',
      }),
    } as unknown as ComputeProviderAdapter;
    const service = new FulfillmentService(store, subjects, provider, config);
    expect(await service.reconcileActive(20)).toBe(2);
    expect(failedIds).toEqual([ready.id]);
  });

  it('keeps a ready lease out of running when private access exchange fails', async () => {
    let recorded = 0;
    const ready = {
      ...record, status: 'ready' as const, providerLeaseId: 'provider-lease-access-failure',
      connection: { protocol: 'ssh' as const, host: 'h100.internal', port: 22,
        hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
        knownHostsEntry: `[h100.internal]:22 ssh-ed25519 ${'A'.repeat(44)}`, displayName: 'H100 工作区' },
      attestationDigest: `sha256:${'d'.repeat(64)}`,
    };
    const store = {
      beginAccess: async () => ready,
      recordAccess: async () => { recorded += 1; return { ...ready, status: 'running' as const }; },
    } as unknown as FulfillmentStore;
    const provider = {
      key: 'sidecar-v1', available: true,
      createAccessSession: async () => { throw new ComputeProviderError('PROVIDER_NETWORK_ERROR', true, 'exchange failed'); },
    } as unknown as ComputeProviderAdapter;
    const service = new FulfillmentService(store, subjects, provider, config);
    await expect(service.createAccessSession({ userId: 'buyer' } as never, ready.orderId,
      'access-session-key-0001', { requestId: 'request', ip: '127.0.0.1' }))
      .rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    expect(recorded).toBe(0);
    expect(ready.status).toBe('ready');
  });

  it('converts purchased GPU-hours using allocated GPUs, not all GPUs in the node', async () => {
    const now = new Date('2026-08-14T04:00:00.000Z');
    const planned = {
      ...record,
      provisioningAt: now,
      hardExpiresAt: new Date(now.getTime() + 3_600_000),
      provisioningDeadlineAt: new Date(now.getTime() + 300_000),
    };
    let expiresAtMs = 0;
    const store = {
      beginProvision: async () => ({ status: 'started' as const, record: planned, quantity: '1.000000', capacityUnit: 'GPU时', binding }),
      recordProvisionalLease: async () => planned,
      markReady: async (input: { hardExpiresAt: Date }) => { expiresAtMs = input.hardExpiresAt.getTime();
        return { ...record, status: 'ready' as const, hardExpiresAt: input.hardExpiresAt }; },
    } as unknown as FulfillmentStore;
    const provider = { key: 'sidecar-v1', available: true,
      providerLeaseIdFor: (leaseId: string) => `kai:${leaseId}`, provision: async () => ({
      providerLeaseId: 'provider-lease-0001',
      connection: { protocol: 'ssh' as const, host: 'h100.internal', port: 22, displayName: 'H100 工作区' },
      attestation: { nonce: record.id, observedAt: now.toISOString(), heartbeatId: 'heartbeat-0001',
        acceleratorModel: 'NVIDIA H100 SXM5', nodeAcceleratorCount: 8, allocatedAcceleratorCount: 1,
        driverVersion: '580.173.02', evidenceDigest: `sha256:${'d'.repeat(64)}` },
    }) } as unknown as ComputeProviderAdapter;
    const service = new FulfillmentService(store, subjects, provider, config, () => now);
    await service.onOrderConfirmed(record.orderId);
    expect(expiresAtMs).toBe(now.getTime() + 3_600_000);
  });

  it('does not refund a retryable or ambiguous provider timeout', async () => {
    let failed = 0;
    const store = {
      beginProvision: async () => ({ status: 'started' as const, record, quantity: '1.000000', capacityUnit: 'GPU时', binding }),
      recordProvisionalLease: async () => ({ ...record, provisionalProviderLeaseId: `kai:${record.id}` }),
      markFailed: async () => { failed += 1; return { ...record, status: 'failed' as const }; },
    } as unknown as FulfillmentStore;
    const provider = {
      key: 'sidecar-v1', available: true,
      providerLeaseIdFor: (leaseId: string) => `kai:${leaseId}`,
      provision: async () => { throw new ComputeProviderError('PROVIDER_NETWORK_ERROR', true, 'timeout'); },
    } as unknown as ComputeProviderAdapter;
    const service = new FulfillmentService(store, subjects, provider, config);
    await expect(service.onOrderConfirmed(record.orderId)).rejects.toMatchObject({ code: 'COMPUTE_PROVIDER_CLEANUP_PENDING' });
    expect(failed).toBe(0);
  });

  it('refunds after an explicit non-retryable provider rejection', async () => {
    let failed = 0;
    const store = {
      beginProvision: async () => ({ status: 'started' as const, record, quantity: '1.000000', capacityUnit: 'GPU时', binding }),
      recordProvisionalLease: async () => ({ ...record, provisionalProviderLeaseId: `kai:${record.id}` }),
      markFailed: async () => { failed += 1; return { ...record, status: 'failed' as const }; },
    } as unknown as FulfillmentStore;
    const provider = {
      key: 'sidecar-v1', available: true,
      providerLeaseIdFor: (leaseId: string) => `kai:${leaseId}`,
      provision: async () => { throw new ComputeProviderError('PROVIDER_REJECTED', false, 'rejected'); },
      stop: async () => { throw new ComputeProviderError('PROVIDER_NOT_FOUND', false, 'not found'); },
    } as unknown as ComputeProviderAdapter;
    const service = new FulfillmentService(store, subjects, provider, config);
    await expect(service.onOrderConfirmed(record.orderId)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    expect(failed).toBe(1);
  });

  it('keeps cleanup pending after a failed stop, then retries the same lease and refunds once', async () => {
    let current = record; let first = true; let failed = 0; const stopAttempts: string[] = [];
    const store = {
      beginProvision: async () => first
        ? ({ status: 'started' as const, record: current, quantity: '1.000000', capacityUnit: 'GPU时', binding })
        : current.status === 'provisioning'
          ? ({ status: 'cleanup_required' as const, record: current, quantity: '1.000000', capacityUnit: 'GPU时', binding })
          : ({ status: 'existing' as const, record: current, quantity: '1.000000', capacityUnit: 'GPU时', binding }),
      recordProvisionalLease: async (input: { providerLeaseId: string }) => {
        current = { ...current, provisionalProviderLeaseId: input.providerLeaseId }; return current;
      },
      markReady: async () => { first = false; throw new Error('COMPUTE_BINDING_CHANGED_BEFORE_READY'); },
      markFailed: async () => { failed += 1; current = { ...current, status: 'failed' as const }; return current; },
    } as unknown as FulfillmentStore;
    const provider = {
      key: 'sidecar-v1', available: true, providerLeaseIdFor: (leaseId: string) => `kai:${leaseId}`,
      provision: async () => ({ providerLeaseId: `kai:${record.id}`, connection: {} as never, attestation: {} as never }),
      stop: async (input: { providerLeaseId: string; operationId: string }) => {
        stopAttempts.push(`${input.providerLeaseId}|${input.operationId}`);
        if (stopAttempts.length === 1) throw new ComputeProviderError('PROVIDER_NETWORK_ERROR', true, 'timeout');
        return {} as never;
      },
    } as unknown as ComputeProviderAdapter;
    const service = new FulfillmentService(store, subjects, provider, config);
    await expect(service.onOrderConfirmed(record.orderId)).rejects.toMatchObject({ code: 'COMPUTE_PROVIDER_CLEANUP_PENDING' });
    expect(failed).toBe(0);
    await expect(service.onOrderConfirmed(record.orderId)).rejects.toMatchObject({ code: 'COMPUTE_NODE_NOT_READY' });
    expect(failed).toBe(1);
    await expect(service.onOrderConfirmed(record.orderId)).rejects.toMatchObject({ code: 'FULFILLMENT_NOT_PROVISIONABLE' });
    expect(failed).toBe(1);
    expect(stopAttempts).toEqual([
      `kai:${record.id}|stop:${record.id}`,
      `kai:${record.id}|stop:${record.id}`,
    ]);
  });

  it('rejects and releases a lease shorter than five minutes before calling the provider', async () => {
    let providerCalls = 0; let failed = 0;
    const store = {
      beginProvision: async () => ({ status: 'started' as const, record, quantity: '0.010000', capacityUnit: 'GPU时', binding }),
      markFailed: async () => { failed += 1; return { ...record, status: 'failed' as const }; },
    } as unknown as FulfillmentStore;
    const provider = { key: 'sidecar-v1', available: true,
      providerLeaseIdFor: (leaseId: string) => `kai:${leaseId}`,
      provision: async () => { providerCalls += 1; throw new Error('must not call'); } } as unknown as ComputeProviderAdapter;
    const service = new FulfillmentService(store, subjects, provider, config);
    await expect(service.onOrderConfirmed(record.orderId)).rejects.toMatchObject({ code: 'COMPUTE_LEASE_DURATION_TOO_SHORT' });
    expect(providerCalls).toBe(0); expect(failed).toBe(1);
  });
});
