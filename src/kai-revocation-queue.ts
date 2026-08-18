import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import { revokeKaiOidcTokens } from './kai-oidc-client';

const REVOCATION_QUEUE_KEY = 'kai.zod.auth.pending-revocations.v1';
const MAX_PENDING_REVOCATIONS = 8;
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type PendingRevocation = Readonly<{
  id: string;
  accessToken: string;
  refreshToken: string;
  createdAt: string;
}>;

export class KaiRevocationQueueIntegrityError extends Error {
  readonly name = 'KaiRevocationQueueIntegrityError';
}

let queueLock: Promise<void> = Promise.resolve();
let retryInFlight: Promise<void> | null = null;

function withQueueLock<T>(operation: () => Promise<T>) {
  const result = queueLock.then(operation, operation);
  queueLock = result.then(() => undefined, () => undefined);
  return result;
}

function validTask(value: unknown): value is PendingRevocation {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<PendingRevocation>;
  return typeof task.id === 'string' && /^[0-9a-f-]{36}$/iu.test(task.id)
    && typeof task.accessToken === 'string' && task.accessToken.length >= 20
    && typeof task.refreshToken === 'string' && task.refreshToken.length >= 20
    && typeof task.createdAt === 'string' && Number.isFinite(Date.parse(task.createdAt));
}

async function readQueue() {
  const raw = await SecureStore.getItemAsync(REVOCATION_QUEUE_KEY, secureOptions);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(validTask)) {
      throw new KaiRevocationQueueIntegrityError('本机撤销任务无法安全读取，已保留原始数据。');
    }
    return parsed;
  } catch (error) {
    if (error instanceof KaiRevocationQueueIntegrityError) throw error;
    throw new KaiRevocationQueueIntegrityError('本机撤销任务无法安全读取，已保留原始数据。');
  }
}

async function writeQueue(tasks: readonly PendingRevocation[]) {
  if (tasks.length === 0) {
    await SecureStore.deleteItemAsync(REVOCATION_QUEUE_KEY, secureOptions);
    return;
  }
  await SecureStore.setItemAsync(REVOCATION_QUEUE_KEY, JSON.stringify(tasks), secureOptions);
}

export function queueKaiOidcRevocation(tokens: Readonly<{ accessToken: string; refreshToken: string }>) {
  return withQueueLock(async () => {
    const now = Date.now();
    const current = await readQueue();
    const duplicate = current.some((task) => task.refreshToken === tokens.refreshToken);
    if (duplicate) return;
    if (current.length >= MAX_PENDING_REVOCATIONS) {
      throw new Error('远程撤销队列已满，不能安全保存新的撤销任务。');
    }
    const task: PendingRevocation = {
      id: Crypto.randomUUID(),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      createdAt: new Date(now).toISOString(),
    };
    await writeQueue([...current, task]);
  });
}

export function retryPendingKaiOidcRevocations() {
  retryInFlight ??= withQueueLock(async () => {
    const pending = await readQueue();
    if (pending.length === 0) {
      await writeQueue([]);
      return;
    }
    const remaining: PendingRevocation[] = [];
    for (const task of pending) {
      try {
        await revokeKaiOidcTokens(task);
      } catch {
        remaining.push(task);
      }
    }
    await writeQueue(remaining);
  }).finally(() => { retryInFlight = null; });
  return retryInFlight;
}

export function startKaiOidcRevocationRetry(onRetryError?: (message: string) => void) {
  const retryWhenOnline = (state: Network.NetworkState) => {
    if (state.isConnected === true && state.isInternetReachable !== false) {
      void retryPendingKaiOidcRevocations().catch((error: unknown) => {
        onRetryError?.(error instanceof Error
          ? error.message : '本机撤销任务暂时无法处理，原任务已保留。');
      });
    }
  };
  void Network.getNetworkStateAsync().then(retryWhenOnline).catch(() => undefined);
  const subscription = Network.addNetworkStateListener(retryWhenOnline);
  return () => subscription.remove();
}
