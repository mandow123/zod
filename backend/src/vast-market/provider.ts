import type { VastInstance, VastLaunchConfiguration, VastOffer } from './types.js';
import type { RuntimeConfig } from '../config.js';

export type VastProviderErrorCode =
  | 'VAST_UNAVAILABLE'
  | 'VAST_UNAUTHORIZED'
  | 'VAST_RATE_LIMITED'
  | 'VAST_OFFER_UNAVAILABLE'
  | 'VAST_TEMPORARY_ERROR'
  | 'VAST_TIMEOUT'
  | 'VAST_INVALID_RESPONSE';

export class VastProviderError extends Error {
  constructor(public readonly code: VastProviderErrorCode, public readonly retryable: boolean,
    public readonly outcomeUnknown: boolean, message: string) {
    super(message);
    this.name = 'VastProviderError';
  }
}

export type VastSearchInput = Readonly<{
  gpuName?: string;
  region?: string;
  minimumReliability?: number;
  limit?: number;
  offerId?: string;
}>;

export interface VastAiProvider {
  readonly available: boolean;
  search(input: VastSearchInput): Promise<VastOffer[]>;
  getOffer(offerId: string): Promise<VastOffer | null>;
  createInstance(input: Readonly<{
    offerId: string;
    label: string;
    configuration: VastLaunchConfiguration;
  }>): Promise<Readonly<{ contractId: string }>>;
  listInstances(): Promise<VastInstance[]>;
}

type Http = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Sleeper = (milliseconds: number) => Promise<void>;

export class VastAiClient implements VastAiProvider {
  readonly available = true;

  constructor(private readonly baseUrl: string, private readonly apiKey: string,
    private readonly http: Http = fetch, private readonly timeoutMs = 8_000,
    private readonly maxSafeAttempts = 3, private readonly sleep: Sleeper = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))) {}

  async search(input: VastSearchInput) {
    const body: Record<string, unknown> = {
      limit: Math.min(Math.max(input.limit ?? 30, 1), 50),
      type: 'ondemand',
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      order: [['dph_total', 'asc']],
      ...(input.gpuName ? { gpu_name: { eq: input.gpuName } } : {}),
      ...(input.region ? { geolocation: { in: [input.region] } } : {}),
      ...(input.minimumReliability === undefined ? {} : { reliability: { gte: input.minimumReliability } }),
      ...(input.offerId ? { id: { eq: Number(input.offerId) } } : {}),
    };
    const payload = await this.request('/api/v0/bundles/', {
      method: 'POST', body: JSON.stringify(body),
    }, true, false);
    const offers = isObject(payload) && Array.isArray(payload.offers) ? payload.offers : null;
    if (!offers) throw new VastProviderError('VAST_INVALID_RESPONSE', false, false, 'Vast offer response is invalid.');
    return offers.flatMap((value) => {
      const offer = parseOffer(value);
      return offer ? [offer] : [];
    });
  }

  async getOffer(offerId: string) {
    const [offer] = await this.search({ offerId, limit: 1 });
    return offer?.offerId === offerId ? offer : null;
  }

  async createInstance(input: Readonly<{ offerId: string; label: string; configuration: VastLaunchConfiguration }>) {
    const payload = await this.request(`/api/v0/asks/${encodeURIComponent(input.offerId)}/`, {
      method: 'PUT', body: JSON.stringify({
        client_id: 'me', image: input.configuration.image, disk: input.configuration.diskGb,
        runtype: input.configuration.runtype, label: input.label,
      }),
    }, false, true);
    if (!isObject(payload) || payload.success !== true || !positiveIdentifier(payload.new_contract)) {
      throw new VastProviderError('VAST_INVALID_RESPONSE', false, true,
        'Vast accepted the request but did not return a contract id.');
    }
    return { contractId: String(payload.new_contract) };
  }

  async listInstances() {
    const values: unknown[] = []; let afterToken: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit:'100',...(afterToken ? { after_token:afterToken } : {}) });
      const payload = await this.request(`/api/v1/instances/?${query}`, { method: 'GET' }, true, false);
      if (!isObject(payload) || !Array.isArray(payload.instances)) {
        throw new VastProviderError('VAST_INVALID_RESPONSE', false, false, 'Vast instance response is invalid.');
      }
      values.push(...payload.instances);
      afterToken = typeof payload.next_token === 'string' && payload.next_token ? payload.next_token : null;
      if (!afterToken) break;
      if (page === 19) throw new VastProviderError('VAST_INVALID_RESPONSE',false,false,'Vast pagination did not terminate.');
    }
    return values.flatMap((value) => {
      if (!isObject(value) || !positiveIdentifier(value.id)) return [];
      return [{
        contractId: String(value.id),
        label: typeof value.label === 'string' ? value.label : null,
        offerId: positiveIdentifier(value.ask_contract_id) ? String(value.ask_contract_id)
          : positiveIdentifier(value.bundle_id) ? String(value.bundle_id) : null,
        status: typeof value.actual_status === 'string' ? value.actual_status : null,
      }];
    });
  }

  private async request(path: string, init: RequestInit, safeToRetry: boolean, mutation: boolean): Promise<unknown> {
    const attempts = safeToRetry ? this.maxSafeAttempts : 1;
    let lastError: VastProviderError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.http(new URL(path, this.baseUrl), {
          ...init,
          headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json',
            ...(init.body ? { 'content-type': 'application/json' } : {}) },
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
        const contentType = response.headers.get('content-type') ?? '';
        const declaredLength = Number(response.headers.get('content-length') ?? 0);
        if (!contentType.toLowerCase().includes('application/json') || declaredLength > 65_536) {
          if (!response.ok) throw classifyStatus(response.status,{},mutation);
          throw new VastProviderError('VAST_INVALID_RESPONSE',false,mutation,'Vast response headers are invalid.');
        }
        const body = await readLimitedBody(response,65_536,mutation);
        const payload = body ? parseJson(body, mutation) : {};
        if (response.ok) return payload;
        const error = classifyStatus(response.status, payload, mutation);
        if (!error.retryable || attempt === attempts) throw error;
        lastError = error;
      } catch (error) {
        const classified = error instanceof VastProviderError ? error : new VastProviderError(
          isTimeout(error) ? 'VAST_TIMEOUT' : 'VAST_TEMPORARY_ERROR', true, mutation,
          isTimeout(error) ? 'Vast request timed out.' : 'Vast request failed.',
        );
        if (!classified.retryable || attempt === attempts) throw classified;
        lastError = classified;
      }
      await this.sleep(Math.min(100 * 2 ** (attempt - 1), 500));
    }
    throw lastError ?? new VastProviderError('VAST_TEMPORARY_ERROR', true, mutation, 'Vast request failed.');
  }
}

export class UnavailableVastAiProvider implements VastAiProvider {
  readonly available = false;
  private unavailable() { return new VastProviderError('VAST_UNAVAILABLE', false, false, 'Vast.ai is not configured.'); }
  search(): Promise<VastOffer[]> { return Promise.reject(this.unavailable()); }
  getOffer(): Promise<VastOffer | null> { return Promise.reject(this.unavailable()); }
  createInstance(): Promise<Readonly<{ contractId: string }>> { return Promise.reject(this.unavailable()); }
  listInstances(): Promise<VastInstance[]> { return Promise.reject(this.unavailable()); }
}

export function createVastAiProvider(config: RuntimeConfig): VastAiProvider {
  return config.readiness.capabilities.vastAi.available && config.VAST_API_KEY
    ? new VastAiClient(config.VAST_API_URL,config.VAST_API_KEY)
    : new UnavailableVastAiProvider();
}

function parseOffer(value: unknown): VastOffer | null {
  if (!isObject(value) || !positiveIdentifier(value.id) || typeof value.gpu_name !== 'string'
    || !positiveNumber(value.num_gpus) || !positiveNumber(value.gpu_ram) || !positiveNumber(value.dph_total)
    || typeof value.geolocation !== 'string' || !finiteNumber(value.reliability)
    || value.verification !== 'verified' || value.rentable !== true || value.rented !== false || value.is_bid !== false) return null;
  const providerCostMicrosPerHour = decimalToMicros(value.dph_total);
  if (providerCostMicrosPerHour <= 0n) return null;
  return {
    offerId: String(value.id), gpuName: value.gpu_name, gpuCount: Math.trunc(value.num_gpus),
    gpuMemoryMb: Math.trunc(value.gpu_ram), region: value.geolocation, reliability: value.reliability,
    providerCostMicrosPerHour, updatedAt: new Date(),
  };
}

function decimalToMicros(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.ceil(value * 1_000_000 - Number.EPSILON));
}

function classifyStatus(status: number, payload: unknown, mutation: boolean) {
  const providerCode = isObject(payload) && typeof payload.error === 'string' ? payload.error : '';
  if (status === 401 || status === 403 || (status === 404 && providerCode !== 'no_such_ask')) {
    return new VastProviderError('VAST_UNAUTHORIZED', false, false, 'Vast authentication failed.');
  }
  if (status === 400 || status === 404 || status === 409) {
    return new VastProviderError('VAST_OFFER_UNAVAILABLE', false, false, 'The Vast offer is no longer rentable.');
  }
  if (status === 429) return new VastProviderError('VAST_RATE_LIMITED', true, mutation, 'Vast rate limit reached.');
  if (status >= 500) return new VastProviderError('VAST_TEMPORARY_ERROR', true, mutation, 'Vast is temporarily unavailable.');
  return new VastProviderError('VAST_INVALID_RESPONSE', false, mutation, 'Unexpected Vast response.');
}

function parseJson(value: string, mutation: boolean) {
  try { return JSON.parse(value) as unknown; } catch {
    throw new VastProviderError('VAST_INVALID_RESPONSE', false, mutation, 'Vast response is not valid JSON.');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveIdentifier(value: unknown) {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    || (typeof value === 'string' && /^[1-9]\d*$/u.test(value));
}
function finiteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function positiveNumber(value: unknown): value is number { return finiteNumber(value) && value > 0; }
function isTimeout(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

async function readLimitedBody(response: Response,limit: number,mutation: boolean) {
  if (!response.body) return '';
  const reader=response.body.getReader(); const decoder=new TextDecoder(); let size=0; let result='';
  try {
    while (true) {
      const { done,value }=await reader.read(); if (done) break;
      size+=value.byteLength;
      if (size>limit) throw new VastProviderError('VAST_INVALID_RESPONSE',false,mutation,'Vast response is too large.');
      result+=decoder.decode(value,{ stream:true });
    }
    return result+decoder.decode();
  } finally { reader.releaseLock(); }
}
