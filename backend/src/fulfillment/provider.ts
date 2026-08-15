import { z } from 'zod';
import { createHash, createHmac } from 'node:crypto';
import type { FulfillmentAttestation, SafeConnectionDescriptor } from './types.js';
import type { RuntimeConfig } from '../config.js';

export type ProvisionRequest = Readonly<{
  leaseId: string;
  orderId: string;
  resourceId: string;
  bindingId: string;
  bindingGeneration: number;
  policyDigest: string;
  nodeId: string;
  quantity: string;
  capacityUnit: string;
  allocatedAcceleratorCount: number;
  hardExpiresAt: string;
}>;

export type ProvisionResult = Readonly<{
  providerLeaseId: string;
  connection: SafeConnectionDescriptor;
  attestation: FulfillmentAttestation;
}>;

export type AccessSessionResult = Readonly<{
  ticketDigest: string;
  protocol: 'ssh';
  host: string;
  port: number;
  username: 'kai';
  privateKey: string;
  hostKeyFingerprint: string;
  knownHostsEntry: string;
  expiresAt: string;
}>;

export type StopResult = Readonly<{
  providerLeaseId: string;
  operationId: string;
  consumedCapacityMicros: string;
  meteringEvidenceDigest: string;
  stoppedAt: string;
  bootId: string;
  eventSequence: number;
  receiptSignature: string;
}>;

export type LeaseStatusResult = Readonly<
  | { status: 'provisioning' | 'ready' | 'running' | 'stopping'; providerLeaseId: string;
      eventSequence: number; hardExpiresAt: string }
  | { status: 'stopped'; receipt: StopResult }
  | { status: 'failed'; providerLeaseId: string; eventSequence: number; failureCode: string }
>;

export interface ComputeProviderAdapter {
  readonly key: string;
  readonly available: boolean;
  providerLeaseIdFor(leaseId: string): string | null;
  provision(input: ProvisionRequest): Promise<ProvisionResult>;
  createAccessSession(input: Readonly<{
    providerLeaseId: string; sessionId: string; ttlSeconds: number;
  }>): Promise<AccessSessionResult>;
  stop(input: Readonly<{ providerLeaseId: string; operationId: string }>): Promise<StopResult>;
  getLeaseStatus(input: Readonly<{ providerLeaseId: string; operationId: string }>): Promise<LeaseStatusResult>;
}

export class ComputeProviderError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, message: string) {
    super(message);
  }
}

export class UnavailableComputeProvider implements ComputeProviderAdapter {
  readonly key = 'unavailable';
  readonly available = false;
  providerLeaseIdFor(): null { return null; }
  async provision(): Promise<never> { throw new ComputeProviderError('COMPUTE_PROVIDER_UNAVAILABLE', false, 'compute provider unavailable'); }
  async createAccessSession(): Promise<never> { throw new ComputeProviderError('COMPUTE_PROVIDER_UNAVAILABLE', false, 'compute provider unavailable'); }
  async stop(): Promise<never> { throw new ComputeProviderError('COMPUTE_PROVIDER_UNAVAILABLE', false, 'compute provider unavailable'); }
  async getLeaseStatus(): Promise<never> { throw new ComputeProviderError('COMPUTE_PROVIDER_UNAVAILABLE', false, 'compute provider unavailable'); }
}

const connectionSchema = z.object({
  protocol: z.enum(['ssh', 'https', 'jupyter', 'rdp', 'custom']),
  host: z.string().trim().min(1).max(253), port: z.number().int().min(1).max(65_535),
  hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/u),
  knownHostsEntry: z.string().regex(/^\[[^\]\r\n]+\]:\d+ ssh-ed25519 [A-Za-z0-9+/=]+$/u).max(1_024),
  displayName: z.string().trim().min(1).max(120),
}).strict();
const attestationSchema = z.object({
  nonce: z.string().uuid(), observedAt: z.string().datetime({ offset: true }),
  orderId: z.string().uuid(), resourceId: z.string().uuid(),
  bindingId: z.string().uuid(), bindingGeneration: z.number().int().positive(),
  policyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), nodeId: z.string().uuid(),
  capacityUnit: z.literal('GPU时'),
  allocatedGpuUuids: z.array(z.string().regex(/^GPU-[A-Fa-f0-9-]+$/u)).min(1).max(8),
  hardExpiresAt: z.string().datetime({ offset: true }),
  hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/u), bootId: z.string().uuid(),
  eventSequence: z.number().int().positive(),
  heartbeatId: z.string().trim().min(8).max(160), acceleratorModel: z.string().trim().min(2).max(120),
  nodeAcceleratorCount: z.number().int().min(1).max(1024),
  allocatedAcceleratorCount: z.number().int().min(1).max(1024),
  driverVersion: z.string().trim().min(1).max(80),
  memoryTotalMiB: z.number().int().min(90_000).max(200_000), migMode: z.literal('Disabled'),
  computeMode: z.literal('Default'),
  evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  signature: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u),
}).strict();
const stopResultSchema = z.object({
  providerLeaseId: z.string().trim().min(8).max(200), operationId: z.string().trim().min(8).max(200),
  consumedCapacityMicros: z.string().regex(/^(?:0|[1-9]\d{0,23})$/u),
  meteringEvidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  stoppedAt: z.string().datetime({ offset: true }),
  bootId: z.string().uuid(), eventSequence: z.number().int().positive(),
  receiptSignature: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u),
}).strict();

export class SidecarComputeProvider implements ComputeProviderAdapter {
  readonly key = 'sidecar-v1';
  readonly available = true;

  providerLeaseIdFor(leaseId: string) { return `kai:${leaseId}`; }

  constructor(private readonly baseUrl: string, private readonly bearerToken: string,
    private readonly fetcher: typeof fetch = fetch) {}

  async provision(input: ProvisionRequest) {
    const result = await this.call('/v1/leases', input.leaseId, input);
    const parsed = z.object({
      providerLeaseId: z.string().trim().min(8).max(200), connection: connectionSchema,
      attestation: attestationSchema,
    }).strict().safeParse(result);
    if (!parsed.success) throw new ComputeProviderError('PROVIDER_RESPONSE_INVALID', false, 'invalid provision response');
    const observedAt = new Date(parsed.data.attestation.observedAt);
    const expectedSignature = `hmac-sha256:${createHmac('sha256', this.bearerToken)
      .update(JSON.stringify(attestationPayload(parsed.data.attestation))).digest('hex')}`;
    if (parsed.data.providerLeaseId !== this.providerLeaseIdFor(input.leaseId)
      || parsed.data.attestation.nonce !== input.leaseId
      || parsed.data.attestation.orderId !== input.orderId
      || parsed.data.attestation.resourceId !== input.resourceId
      || parsed.data.attestation.bindingId !== input.bindingId
      || parsed.data.attestation.bindingGeneration !== input.bindingGeneration
      || parsed.data.attestation.policyDigest !== input.policyDigest
      || parsed.data.attestation.nodeId !== input.nodeId
      || parsed.data.attestation.capacityUnit !== input.capacityUnit
      || parsed.data.attestation.hardExpiresAt !== input.hardExpiresAt
      || parsed.data.attestation.hostKeyFingerprint !== parsed.data.connection.hostKeyFingerprint
      || Math.abs(Date.now() - observedAt.getTime()) > 5 * 60_000
      || parsed.data.attestation.allocatedAcceleratorCount !== input.allocatedAcceleratorCount
      || parsed.data.attestation.allocatedGpuUuids.length !== input.allocatedAcceleratorCount
      || parsed.data.attestation.allocatedAcceleratorCount > parsed.data.attestation.nodeAcceleratorCount
      || !/^NVIDIA H100/u.test(parsed.data.attestation.acceleratorModel)
      || parsed.data.attestation.signature !== expectedSignature) {
      throw new ComputeProviderError('PROVIDER_ATTESTATION_INVALID', false, 'stale or mismatched attestation');
    }
    return parsed.data;
  }

  async createAccessSession(input: Readonly<{ providerLeaseId: string; sessionId: string; ttlSeconds: number }>) {
    const result = await this.call(`/v1/leases/${encodeURIComponent(input.providerLeaseId)}/access-sessions`, input.sessionId, {
      sessionId: input.sessionId, ttlSeconds: input.ttlSeconds,
    });
    const issued = z.object({
      ticket: z.string().min(24).max(8_192), uri: z.string().url().max(8_192)
        .refine((value) => new URL(value).protocol === 'https:', 'access uri must use HTTPS'),
      expiresAt: z.string().datetime({ offset: true }),
    }).strict().safeParse(result);
    if (!issued.success) throw new ComputeProviderError('PROVIDER_ACCESS_RESPONSE_INVALID', false, 'invalid access response');
    const exchangeUrl = new URL(issued.data.uri); const providerOrigin = new URL(this.baseUrl).origin;
    if (exchangeUrl.origin !== providerOrigin
      || exchangeUrl.pathname !== `/v1/access-sessions/${encodeURIComponent(input.sessionId)}/exchange`) {
      throw new ComputeProviderError('PROVIDER_ACCESS_URI_INVALID', false, 'access exchange uri left provider origin');
    }
    const expiresAt = new Date(issued.data.expiresAt).getTime();
    if (expiresAt <= Date.now() || expiresAt > Date.now() + (input.ttlSeconds + 60) * 1_000) {
      throw new ComputeProviderError('PROVIDER_ACCESS_EXPIRY_INVALID', false, 'invalid access expiry');
    }
    const credential = await this.exchangeAccess(exchangeUrl, issued.data.ticket);
    if (credential.expiresAt !== issued.data.expiresAt) {
      throw new ComputeProviderError('PROVIDER_ACCESS_EXPIRY_INVALID', false, 'exchange expiry does not match session');
    }
    return { ...credential, ticketDigest: createHash('sha256').update(issued.data.ticket).digest('hex') };
  }

  async stop(input: Readonly<{ providerLeaseId: string; operationId: string }>) {
    const result = await this.call(`/v1/leases/${encodeURIComponent(input.providerLeaseId)}/stop`, input.operationId, {
      operationId: input.operationId,
    });
    const parsed = stopResultSchema.safeParse(result);
    if (!parsed.success) throw new ComputeProviderError('PROVIDER_METERING_RESPONSE_INVALID', false, 'invalid stop response');
    this.verifyStopReceipt(parsed.data, input.providerLeaseId, input.operationId);
    return parsed.data;
  }

  async getLeaseStatus(input: Readonly<{ providerLeaseId: string; operationId: string }>) {
    const result = await this.call(`/v1/leases/${encodeURIComponent(input.providerLeaseId)}/status`, input.operationId, {});
    const parsed = z.discriminatedUnion('status', [
      z.object({ status: z.enum(['provisioning', 'ready', 'running', 'stopping']),
        providerLeaseId: z.string().trim().min(8).max(200), eventSequence: z.number().int().positive(),
        hardExpiresAt: z.string().datetime({ offset: true }) }).strict(),
      z.object({ status: z.literal('stopped'), receipt: stopResultSchema }).strict(),
      z.object({ status: z.literal('failed'), providerLeaseId: z.string().trim().min(8).max(200),
        eventSequence: z.number().int().positive(), failureCode: z.string().trim().min(3).max(120) }).strict(),
    ]).safeParse(result);
    if (!parsed.success) throw new ComputeProviderError('PROVIDER_STATUS_RESPONSE_INVALID', false, 'invalid lease status response');
    if (parsed.data.status === 'stopped') {
      this.verifyStopReceipt(parsed.data.receipt, input.providerLeaseId);
    } else if (parsed.data.providerLeaseId !== input.providerLeaseId) {
      throw new ComputeProviderError('PROVIDER_STATUS_BINDING_INVALID', false, 'mismatched lease status');
    }
    return parsed.data;
  }

  private verifyStopReceipt(value: StopResult, providerLeaseId: string, operationId?: string) {
    const expectedSignature = `hmac-sha256:${createHmac('sha256', this.bearerToken)
      .update(JSON.stringify(stopReceiptPayload(value))).digest('hex')}`;
    if (value.providerLeaseId !== providerLeaseId || (operationId !== undefined && value.operationId !== operationId)
      || value.receiptSignature !== expectedSignature || new Date(value.stoppedAt).getTime() > Date.now() + 30_000) {
      throw new ComputeProviderError('PROVIDER_METERING_BINDING_INVALID', false, 'mismatched stop receipt');
    }
  }

  private async call(path: string, idempotencyKey: string, body: unknown) {
    let response: Response;
    try {
      const serialized = JSON.stringify(body); const timestamp = new Date().toISOString();
      const signature = createHmac('sha256', this.bearerToken)
        .update(`${timestamp}\n${idempotencyKey}\n${path}\n${serialized}`).digest('hex');
      response = await this.fetcher(new URL(path, this.baseUrl), {
        method: 'POST', headers: {
          authorization: `Bearer ${this.bearerToken}`, 'content-type': 'application/json',
          'idempotency-key': idempotencyKey, 'x-kai-timestamp': timestamp, 'x-kai-signature': signature,
        }, body: serialized, signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
    } catch {
      throw new ComputeProviderError('PROVIDER_NETWORK_ERROR', true, 'provider request failed');
    }
    if (!response.ok) throw new ComputeProviderError(
      response.status === 404 ? 'PROVIDER_NOT_FOUND'
        : response.status >= 500 ? 'PROVIDER_TEMPORARY_ERROR' : 'PROVIDER_REJECTED', response.status >= 500,
      `provider responded ${response.status}`,
    );
    const contentType = response.headers.get('content-type') ?? '';
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (!contentType.toLowerCase().includes('application/json') || declaredLength > 65_536) {
      throw new ComputeProviderError('PROVIDER_RESPONSE_INVALID', false, 'provider response headers are invalid');
    }
    const bodyText = await readLimitedBody(response, 65_536);
    try { return JSON.parse(bodyText) as unknown; }
    catch { throw new ComputeProviderError('PROVIDER_RESPONSE_INVALID', false, 'provider response is not JSON'); }
  }

  private async exchangeAccess(url: URL, ticket: string) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(url, { method: 'POST', headers: { authorization: `Bearer ${ticket}` },
          body: '', signal: AbortSignal.timeout(15_000), redirect: 'error' });
      } catch {
        if (attempt === 0) continue;
        throw new ComputeProviderError('PROVIDER_ACCESS_EXCHANGE_NETWORK_ERROR', true, 'private exchange failed');
      }
      if (!response.ok) {
        const retryable = response.status >= 500;
        await response.body?.cancel().catch(() => undefined);
        if (retryable && attempt === 0) continue;
        throw new ComputeProviderError(retryable ? 'PROVIDER_ACCESS_EXCHANGE_TEMPORARY_ERROR'
          : 'PROVIDER_ACCESS_EXCHANGE_REJECTED', retryable, 'private exchange rejected');
      }
      if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
        throw new ComputeProviderError('PROVIDER_ACCESS_EXCHANGE_REJECTED', false, 'private exchange rejected');
      }
      let body: string;
      try { body = await readLimitedBody(response, 32_768); }
      catch (error) {
        if (error instanceof ComputeProviderError) throw error;
        if (attempt === 0) continue;
        throw new ComputeProviderError('PROVIDER_ACCESS_EXCHANGE_NETWORK_ERROR', true, 'private exchange response failed');
      }
      let decoded: unknown;
      try { decoded = JSON.parse(body); } catch {
        throw new ComputeProviderError('PROVIDER_ACCESS_CREDENTIAL_INVALID', false, 'credential response is not JSON');
      }
      const parsed = z.object({ protocol: z.literal('ssh'), host: z.string().trim().min(1).max(253),
        port: z.number().int().min(1).max(65_535), username: z.literal('kai'),
        hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/u),
        knownHostsEntry: z.string().regex(/^\[[^\]\r\n]+\]:\d+ ssh-ed25519 [A-Za-z0-9+/=]+$/u).max(1_024),
        privateKey: z.string().min(100).max(16_384)
          .refine((value) => value.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')
            && value.trimEnd().endsWith('-----END OPENSSH PRIVATE KEY-----'), 'private key must be OpenSSH'),
        expiresAt: z.string().datetime({ offset: true }) }).strict().safeParse(decoded);
      if (!parsed.success || new Date(parsed.data.expiresAt).getTime() <= Date.now()) {
        throw new ComputeProviderError('PROVIDER_ACCESS_CREDENTIAL_INVALID', false, 'invalid credential response');
      }
      return parsed.data;
    }
    throw new ComputeProviderError('PROVIDER_ACCESS_EXCHANGE_NETWORK_ERROR', true, 'private exchange failed');
  }
}

async function readLimitedBody(response: Response, limit: number) {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel(); throw new ComputeProviderError('PROVIDER_RESPONSE_INVALID', false, 'provider response is too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((value) => Buffer.from(value))).toString('utf8');
}

export function attestationPayload(value: FulfillmentAttestation) {
  return {
    nonce: value.nonce, observedAt: value.observedAt, orderId: value.orderId, resourceId: value.resourceId,
    bindingId: value.bindingId, bindingGeneration: value.bindingGeneration,
    policyDigest: value.policyDigest, nodeId: value.nodeId, capacityUnit: value.capacityUnit,
    allocatedGpuUuids: value.allocatedGpuUuids, hardExpiresAt: value.hardExpiresAt,
    hostKeyFingerprint: value.hostKeyFingerprint, bootId: value.bootId, eventSequence: value.eventSequence,
    heartbeatId: value.heartbeatId, acceleratorModel: value.acceleratorModel,
    nodeAcceleratorCount: value.nodeAcceleratorCount, allocatedAcceleratorCount: value.allocatedAcceleratorCount,
    driverVersion: value.driverVersion, memoryTotalMiB: value.memoryTotalMiB,
    migMode: value.migMode, computeMode: value.computeMode, evidenceDigest: value.evidenceDigest,
  };
}
export function stopReceiptPayload(value: StopResult) {
  const { receiptSignature: _signature, ...payload } = value; return payload;
}

export function createComputeProvider(config: RuntimeConfig): ComputeProviderAdapter {
  if (config.COMPUTE_PROVIDER === 'sidecar-v1' && config.COMPUTE_PROVIDER_URL && config.COMPUTE_PROVIDER_TOKEN
    && config.readiness.capabilities.computeProvider.available) {
    return new SidecarComputeProvider(config.COMPUTE_PROVIDER_URL, config.COMPUTE_PROVIDER_TOKEN);
  }
  return new UnavailableComputeProvider();
}
