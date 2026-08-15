import * as SecureStore from 'expo-secure-store';
import type { ProviderWorkspace } from './api';
import type { CreditListing, OfferTemplate, OfferWizardDraft } from './publishing';

const CACHE_KEY = 'kai.cloudpay.provider-read-model.v1';
const CACHE_VERSION = 1;
const MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 180_000;
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type ProviderProgressCache = Readonly<{
  drafts: OfferWizardDraft[];
  offers: OfferTemplate[];
  listings: CreditListing[];
}>;

export type ProviderReadCache = Readonly<{
  version: 1;
  accountId: string;
  subjectId: string;
  savedAt: string;
  workspace: ProviderWorkspace | null;
  progress: ProviderProgressCache | null;
}>;

let writeQueue: Promise<void> = Promise.resolve();

function validCache(value: unknown): value is ProviderReadCache {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Partial<ProviderReadCache>;
  return cache.version === CACHE_VERSION
    && typeof cache.accountId === 'string' && cache.accountId.length > 0
    && typeof cache.subjectId === 'string' && cache.subjectId.length > 0
    && typeof cache.savedAt === 'string' && Number.isFinite(Date.parse(cache.savedAt))
    && (cache.workspace === null || (typeof cache.workspace === 'object' && cache.workspace !== null))
    && (cache.progress === null || Boolean(cache.progress
      && Array.isArray(cache.progress.drafts)
      && Array.isArray(cache.progress.offers)
      && Array.isArray(cache.progress.listings)));
}

async function readCache() {
  const raw = await SecureStore.getItemAsync(CACHE_KEY, secureOptions);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!validCache(value) || Date.now() - Date.parse(value.savedAt) > MAX_CACHE_AGE_MS) return null;
    return value;
  } catch {
    return null;
  }
}

export async function loadProviderReadCache(accountId: string, subjectId?: string | null) {
  const cache = await readCache();
  if (!cache || cache.accountId !== accountId || (subjectId && cache.subjectId !== subjectId)) return null;
  return cache;
}

function enqueueWrite(work: () => Promise<void>) {
  writeQueue = writeQueue.then(work, work).catch(() => undefined);
  return writeQueue;
}

async function savePart(input: Readonly<{
  accountId: string;
  subjectId: string;
  workspace?: ProviderWorkspace;
  progress?: ProviderProgressCache;
}>) {
  await enqueueWrite(async () => {
    const current = await readCache();
    const sameIdentity = current?.accountId === input.accountId && current.subjectId === input.subjectId;
    let next: ProviderReadCache = {
      version: CACHE_VERSION,
      accountId: input.accountId,
      subjectId: input.subjectId,
      savedAt: new Date().toISOString(),
      workspace: input.workspace ?? (sameIdentity ? current.workspace : null),
      progress: input.progress ?? (sameIdentity ? current.progress : null),
    };
    let serialized = JSON.stringify(next);
    if (new TextEncoder().encode(serialized).byteLength > MAX_CACHE_BYTES) {
      next = { ...next, progress: null };
      serialized = JSON.stringify(next);
    }
    await SecureStore.setItemAsync(CACHE_KEY, serialized, secureOptions);
  });
}

export function saveProviderWorkspaceCache(accountId: string, subjectId: string, workspace: ProviderWorkspace) {
  return savePart({ accountId, subjectId, workspace });
}

export function saveProviderProgressCache(accountId: string, subjectId: string, progress: ProviderProgressCache) {
  return savePart({ accountId, subjectId, progress });
}

export async function clearProviderReadCache() {
  await enqueueWrite(() => SecureStore.deleteItemAsync(CACHE_KEY, secureOptions));
}
