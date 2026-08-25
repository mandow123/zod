import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { apiRequest } from './api-client';

export type KaiCloudVerificationStatus = 'not_started' | 'pending' | 'running' | 'passed' | 'failed' | 'revoked';
export type KaiCloudVerificationState = Readonly<{
  available: boolean;
  status: KaiCloudVerificationStatus;
  syncState: 'current' | 'stale' | 'unavailable';
  failure: null | Readonly<{ code: string; message: string }>;
  updatedAt: string | null;
  blocker?: string;
}>;

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/u;
function key(assetId: string, operation: 'start' | 'revoke') {
  return `kai.cloudpay.kai-cloud-verification.v1.${operation}.${assetId.toLowerCase()}`;
}
async function requestKey(assetId: string, operation: 'start' | 'revoke') {
  const storageKey = key(assetId, operation); const stored = await SecureStore.getItemAsync(storageKey, secureOptions);
  if (stored && KEY_PATTERN.test(stored)) return stored;
  const created = `kai-cloud-${operation}-${Crypto.randomUUID()}`;
  await SecureStore.setItemAsync(storageKey, created, secureOptions); return created;
}
async function clearKey(assetId: string, operation: 'start' | 'revoke') {
  await SecureStore.deleteItemAsync(key(assetId, operation), secureOptions);
}

export async function loadKaiCloudVerification(assetId: string) {
  const response = await apiRequest<{ ok: true; verification: KaiCloudVerificationState }>(
    `/mobile/v1/provider/assets/${encodeURIComponent(assetId)}/kai-cloud-verification`,
    { auth: 'required', retry: true },
  );
  return response.verification;
}

export async function startKaiCloudVerification(assetId: string) {
  const idempotencyKey = await requestKey(assetId, 'start');
  const response = await apiRequest<{ ok: true; replayed: boolean; verification: KaiCloudVerificationState }>(
    `/mobile/v1/provider/assets/${encodeURIComponent(assetId)}/kai-cloud-verification`, {
      method: 'POST', auth: 'required', headers: { 'Idempotency-Key': idempotencyKey }, retry: true,
    },
  );
  await clearKey(assetId, 'start'); return response.verification;
}

export async function revokeKaiCloudVerification(assetId: string) {
  const idempotencyKey = await requestKey(assetId, 'revoke');
  const response = await apiRequest<{ ok: true; replayed: boolean; verification: KaiCloudVerificationState }>(
    `/mobile/v1/provider/assets/${encodeURIComponent(assetId)}/kai-cloud-verification`, {
      method: 'DELETE', auth: 'required', headers: { 'Idempotency-Key': idempotencyKey }, retry: true,
    },
  );
  await Promise.all([clearKey(assetId, 'start'), clearKey(assetId, 'revoke')]); return response.verification;
}

export function kaiCloudVerificationCopy(value: KaiCloudVerificationState) {
  if (!value.available || value.syncState === 'unavailable') return {
    label: '服务尚未开放', detail: '当前无法向 KAI Cloud 核对状态，缓存结果不会被当作当前已验证。', tone: 'warning' as const,
  };
  if (value.syncState === 'stale') return { label: '状态待同步', detail: '暂时无法取得最新验证结果，已保留上次状态，请稍后刷新。', tone: 'warning' as const };
  return ({
    not_started: { label: '尚未开始', detail: '发起后将由 KAI Cloud 核对资源与在线节点。', tone: 'muted' as const },
    pending: { label: '等待验证', detail: '验证请求已登记，正在等待处理。', tone: 'warning' as const },
    running: { label: '正在验证', detail: 'KAI Cloud 正在核对资源和节点状态。', tone: 'warning' as const },
    passed: { label: '在线验证通过', detail: 'KAI Cloud 已确认本轮在线验证。', tone: 'success' as const },
    failed: { label: '验证未通过', detail: value.failure?.message ?? '请根据提示修复后重新验证。', tone: 'danger' as const },
    revoked: { label: '验证已撤销', detail: '旧验证已经撤销，可以按需重新发起。', tone: 'muted' as const },
  })[value.status];
}
