import type { RuntimeConfig } from '../config.js';

export type ExpoPushMessage = Readonly<{
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound?: 'default';
  priority?: 'default' | 'normal' | 'high';
}>;

export type ExpoPushResult = Readonly<{
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: Readonly<{ error?: string }>;
}>;

export interface PushProvider {
  send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushResult[]>;
  receipts(ids: readonly string[]): Promise<Record<string, ExpoPushResult>>;
}

type FetchLike = typeof fetch;

function credentials(config: RuntimeConfig) {
  if (!config.PUSH_CREDENTIALS_JSON) throw new Error('PUSH_CREDENTIALS_JSON is required.');
  const parsed = JSON.parse(config.PUSH_CREDENTIALS_JSON) as { accessToken?: unknown };
  if (typeof parsed.accessToken !== 'string' || parsed.accessToken.trim().length < 32) {
    throw new Error('PUSH_CREDENTIALS_JSON accessToken is required.');
  }
  return { accessToken: parsed.accessToken.trim() };
}

function validResult(value: unknown): value is ExpoPushResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ExpoPushResult>;
  return candidate.status === 'ok' || candidate.status === 'error';
}

export class ExpoPushProvider implements PushProvider {
  private readonly accessToken: string;

  constructor(config: RuntimeConfig, private readonly fetcher: FetchLike = fetch) {
    if (config.PUSH_PROVIDER !== 'expo') throw new Error('PUSH_PROVIDER must be expo.');
    this.accessToken = credentials(config).accessToken;
  }

  async send(messages: readonly ExpoPushMessage[]) {
    if (messages.length < 1 || messages.length > 100) throw new Error('PUSH_BATCH_SIZE_INVALID');
    const value = await this.request('https://exp.host/--/api/v2/push/send', messages);
    const results = Array.isArray(value) ? value : [value];
    if (results.length !== messages.length || !results.every(validResult)) throw new Error('PUSH_PROVIDER_RESPONSE_INVALID');
    return results;
  }

  async receipts(ids: readonly string[]) {
    if (ids.length < 1 || ids.length > 1_000) throw new Error('PUSH_RECEIPT_BATCH_SIZE_INVALID');
    const value = await this.request('https://exp.host/--/api/v2/push/getReceipts', { ids });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PUSH_PROVIDER_RESPONSE_INVALID');
    const entries = Object.entries(value);
    if (!entries.every(([, result]) => validResult(result))) throw new Error('PUSH_PROVIDER_RESPONSE_INVALID');
    return Object.fromEntries(entries) as Record<string, ExpoPushResult>;
  }

  private async request(url: string, body: unknown) {
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(response.status === 429 || response.status >= 500
      ? 'PUSH_PROVIDER_TEMPORARY_FAILURE' : 'PUSH_PROVIDER_REQUEST_REJECTED');
    const envelope = await response.json() as { data?: unknown; errors?: unknown };
    if (envelope.errors || envelope.data === undefined) throw new Error('PUSH_PROVIDER_RESPONSE_INVALID');
    return envelope.data;
  }
}

export function createPushProvider(config: RuntimeConfig): PushProvider | null {
  return config.readiness.capabilities.push.available ? new ExpoPushProvider(config) : null;
}
