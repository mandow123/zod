import type { RuntimeConfig } from '../config.js';
import type { KaiCloudDeviceStatus, KaiCloudPublicApi, KaiCloudVerification, KaiCloudVerificationStatus } from './types.js';

export type KaiCloudErrorCode = 'KAI_CLOUD_UNAVAILABLE' | 'KAI_CLOUD_UNAUTHORIZED' | 'KAI_CLOUD_NOT_FOUND'
  | 'KAI_CLOUD_CONFLICT' | 'KAI_CLOUD_RATE_LIMITED' | 'KAI_CLOUD_TIMEOUT' | 'KAI_CLOUD_INVALID_RESPONSE';

export class KaiCloudError extends Error {
  constructor(public readonly code: KaiCloudErrorCode, public readonly retryable: boolean,
    public readonly outcomeUnknown: boolean, message: string) {
    super(message); this.name = 'KaiCloudError';
  }
}

type Http = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Token = Readonly<{ value: string; expiresAt: number }>;

export class KaiCloudPublicClient implements KaiCloudPublicApi {
  readonly available = true;
  private token: Token | null = null;

  constructor(private readonly baseUrl: string, private readonly tokenUrl: string,
    private readonly clientId: string, private readonly clientSecret: string,
    private readonly http: Http = fetch, private readonly timeoutMs = 8_000,
    private readonly now: () => number = Date.now) {}

  async createVerification(input: Parameters<KaiCloudPublicApi['createVerification']>[0]) {
    return this.verification('/api/public/v1/resource-verifications', {
      method: 'POST', headers: { 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({ organizationReference: input.organizationReference,
        resourceReference: input.resourceReference,
        resource: { productCode: input.productCode, region: input.region, specifications: input.specifications } }),
    }, false, true);
  }

  async getVerification(id: string) {
    return this.verification(`/api/public/v1/resource-verifications/${encodeURIComponent(id)}`,
      { method: 'GET' }, true, false);
  }

  async revokeVerification(id: string, idempotencyKey: string) {
    return this.verification(`/api/public/v1/resource-verifications/${encodeURIComponent(id)}/revoke`,
      { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: '{}' }, false, true);
  }

  async getDevice(id: string) {
    const payload = await this.request(`/api/public/v1/devices/${encodeURIComponent(id)}`, { method: 'GET' }, true, false);
    if (!object(payload) || !object(payload.record)) throw invalid(false);
    const record = payload.record;
    const statuses = ['registering', 'checking', 'ready', 'offline', 'revoked'] as const;
    if (!safeId(record.id) || !statuses.includes(record.status as typeof statuses[number])
      || !timestamp(record.updatedAt) || !(record.lastHeartbeatAt === null || timestamp(record.lastHeartbeatAt))) throw invalid(false);
    return { id: record.id, status: record.status as KaiCloudDeviceStatus['status'],
      lastHeartbeatAt: record.lastHeartbeatAt as string | null, updatedAt: record.updatedAt };
  }

  private async verification(path: string, init: RequestInit, safeToRetry: boolean, mutation: boolean) {
    const payload = await this.request(path, init, safeToRetry, mutation);
    if (!object(payload) || !object(payload.record)) throw invalid(mutation);
    const record = payload.record; const statuses: KaiCloudVerificationStatus[] = ['pending','running','passed','failed','revoked'];
    if (!safeId(record.id) || !Number.isSafeInteger(record.version) || Number(record.version) < 1
      || !statuses.includes(record.status as KaiCloudVerificationStatus) || !timestamp(record.updatedAt)) {
      throw invalid(mutation);
    }
    let failure: KaiCloudVerification['failure'] = null;
    if (record.failure !== null && record.failure !== undefined) {
      if (!object(record.failure) || !errorCode(record.failure.code) || !safeMessage(record.failure.message)) throw invalid(mutation);
      failure = { code: record.failure.code, message: record.failure.message };
    }
    return { id: record.id, version: Number(record.version), status: record.status as KaiCloudVerificationStatus, updatedAt: record.updatedAt, failure };
  }

  private async request(path: string, init: RequestInit, safeToRetry: boolean, mutation: boolean): Promise<unknown> {
    const attempts = safeToRetry ? 2 : 1; let last: KaiCloudError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const token = await this.accessToken();
        const response = await this.http(new URL(path, this.baseUrl), { ...init, redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json', authorization: `Bearer ${token}`,
            ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
        const payload = await responseJson(response, mutation);
        if (response.ok) return payload;
        if (response.status === 401) this.token = null;
        const classified = statusError(response.status, mutation);
        if (!classified.retryable || attempt === attempts) throw classified;
        last = classified;
      } catch (reason) {
        const classified = reason instanceof KaiCloudError ? reason
          : new KaiCloudError(timeout(reason) ? 'KAI_CLOUD_TIMEOUT' : 'KAI_CLOUD_UNAVAILABLE', true, mutation,
            timeout(reason) ? 'KAI Cloud request timed out.' : 'KAI Cloud request failed.');
        if (!classified.retryable || attempt === attempts) throw classified;
        last = classified;
      }
    }
    throw last ?? new KaiCloudError('KAI_CLOUD_UNAVAILABLE', true, mutation, 'KAI Cloud is unavailable.');
  }

  private async accessToken() {
    if (this.token && this.token.expiresAt - 30_000 > this.now()) return this.token.value;
    let response: Response;
    try {
      response = await this.http(this.tokenUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}` },
        body: new URLSearchParams({ grant_type: 'client_credentials',
          scope: 'resource:read verification:write' }).toString() });
    } catch (reason) {
      throw new KaiCloudError(timeout(reason) ? 'KAI_CLOUD_TIMEOUT' : 'KAI_CLOUD_UNAVAILABLE', true, false,
        timeout(reason) ? 'KAI Cloud token request timed out.' : 'KAI Cloud token request failed.');
    }
    const payload = await responseJson(response, false);
    if (!response.ok) throw statusError(response.status, false);
    if (!object(payload) || typeof payload.access_token !== 'string' || payload.access_token.length < 16
      || payload.token_type !== 'Bearer' || !Number.isInteger(payload.expires_in) || Number(payload.expires_in) < 60
      || typeof payload.scope !== 'string') throw invalid(false);
    const granted = new Set(payload.scope.split(' '));
    if (!['resource:read','verification:write'].every((scope) => granted.has(scope))) {
      throw new KaiCloudError('KAI_CLOUD_UNAUTHORIZED', false, false, 'KAI Cloud token scope is incomplete.');
    }
    this.token = { value: payload.access_token, expiresAt: this.now() + Number(payload.expires_in) * 1_000 };
    return this.token.value;
  }
}

export class UnavailableKaiCloudPublicApi implements KaiCloudPublicApi {
  readonly available = false;
  private error() { return new KaiCloudError('KAI_CLOUD_UNAVAILABLE', false, false, 'KAI Cloud public API is not configured.'); }
  createVerification(): Promise<KaiCloudVerification> { return Promise.reject(this.error()); }
  getVerification(): Promise<KaiCloudVerification> { return Promise.reject(this.error()); }
  revokeVerification(): Promise<KaiCloudVerification> { return Promise.reject(this.error()); }
  getDevice(): Promise<KaiCloudDeviceStatus> { return Promise.reject(this.error()); }
}

export function createKaiCloudPublicApi(config: RuntimeConfig): KaiCloudPublicApi {
  return config.readiness.capabilities.kaiCloudPublicApi.available && config.KAI_CLOUD_PUBLIC_API_URL
    && config.KAI_CLOUD_PUBLIC_TOKEN_URL && config.KAI_CLOUD_PUBLIC_CLIENT_ID && config.KAI_CLOUD_PUBLIC_CLIENT_SECRET
    ? new KaiCloudPublicClient(config.KAI_CLOUD_PUBLIC_API_URL, config.KAI_CLOUD_PUBLIC_TOKEN_URL,
      config.KAI_CLOUD_PUBLIC_CLIENT_ID, config.KAI_CLOUD_PUBLIC_CLIENT_SECRET)
    : new UnavailableKaiCloudPublicApi();
}

function statusError(status: number, mutation: boolean) {
  if (status === 401 || status === 403) return new KaiCloudError('KAI_CLOUD_UNAUTHORIZED', false, false, 'KAI Cloud authentication failed.');
  if (status === 404) return new KaiCloudError('KAI_CLOUD_NOT_FOUND', false, false, 'KAI Cloud record was not found.');
  if (status === 409) return new KaiCloudError('KAI_CLOUD_CONFLICT', false, false, 'KAI Cloud state conflict.');
  if (status === 429) return new KaiCloudError('KAI_CLOUD_RATE_LIMITED', true, mutation, 'KAI Cloud rate limit reached.');
  if (status >= 500) return new KaiCloudError('KAI_CLOUD_UNAVAILABLE', true, mutation, 'KAI Cloud is temporarily unavailable.');
  return invalid(mutation);
}
function invalid(mutation: boolean) { return new KaiCloudError('KAI_CLOUD_INVALID_RESPONSE', false, mutation, 'KAI Cloud response is invalid.'); }
async function responseJson(response: Response, mutation: boolean) {
  const type = response.headers.get('content-type') ?? '';
  const length = Number(response.headers.get('content-length') ?? 0);
  if (!type.toLowerCase().includes('application/json') || length > 65_536) throw invalid(mutation);
  const text = await response.text(); if (text.length > 65_536) throw invalid(mutation);
  try { return text ? JSON.parse(text) as unknown : {}; } catch { throw invalid(mutation); }
}
function object(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/u.test(value); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function errorCode(value: unknown): value is string { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(value); }
function safeMessage(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 240; }
function timeout(reason: unknown) { return reason instanceof Error && ['AbortError','TimeoutError'].includes(reason.name); }
