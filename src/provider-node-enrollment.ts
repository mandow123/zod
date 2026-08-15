import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL, LOCAL_E2E_DEMO_ENABLED, ApiError, apiRequest } from './api-client';
import {
  NodeClaimEnvelopeError, buildNodeClaimEnvelope, serializeNodeClaimEnvelope,
  type NodeClaimEnvelope, type ProviderNodeClaim,
} from './node-claim-envelope';

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const REQUEST_KEY = /^[A-Za-z0-9:_-]{16,120}$/u;

function storageKey(assetId: string) { return `kai.cloudpay.node-claim-request.v1.${assetId.toLowerCase()}`; }

async function requestKey(assetId: string) {
  const key = storageKey(assetId);
  const stored = await SecureStore.getItemAsync(key, secureOptions);
  if (stored && REQUEST_KEY.test(stored)) return stored;
  const created = `node-claim-${Crypto.randomUUID()}`;
  await SecureStore.setItemAsync(key, created, secureOptions);
  return created;
}

export async function clearProviderNodeClaimRequest(assetId: string) {
  await SecureStore.deleteItemAsync(storageKey(assetId), secureOptions);
}

export async function issueProviderNodeClaim(assetId: string): Promise<Readonly<{
  envelope: NodeClaimEnvelope;
  serialized: string;
  replayed: boolean;
}>> { return issueProviderNodeClaimAttempt(assetId, true); }

async function issueProviderNodeClaimAttempt(assetId: string, retryExpired: boolean): Promise<Readonly<{
  envelope: NodeClaimEnvelope;
  serialized: string;
  replayed: boolean;
}>> {
  const idempotencyKey = await requestKey(assetId);
  try {
    const response = await apiRequest<{ ok: true; claim: ProviderNodeClaim }>(
      `/mobile/v1/provider/assets/${encodeURIComponent(assetId)}/node-claims`, {
        method: 'POST', auth: 'required', headers: { 'Idempotency-Key': idempotencyKey }, retry: true,
      },
    );
    const envelope = buildNodeClaimEnvelope(response.claim, API_BASE_URL, Date.now(), LOCAL_E2E_DEMO_ENABLED);
    return { envelope, serialized: serializeNodeClaimEnvelope(envelope), replayed: response.claim.replayed };
  } catch (error) {
    if (retryExpired && error instanceof NodeClaimEnvelopeError && error.code === 'CLAIM_EXPIRED') {
      await clearProviderNodeClaimRequest(assetId);
      return issueProviderNodeClaimAttempt(assetId, false);
    }
    if (error instanceof ApiError && ['NODE_CLAIM_IDEMPOTENCY_CONFLICT', 'NODE_CLAIM_ALREADY_BOUND'].includes(error.code)) {
      await clearProviderNodeClaimRequest(assetId);
    }
    throw error;
  }
}

export async function revokeProviderNodeEnrollment(assetId: string, deploymentId: string) {
  const response = await apiRequest<{ ok: true; revoked: true; replayed: boolean }>(
    `/mobile/v1/provider/assets/${encodeURIComponent(assetId)}/node-enrollments/${encodeURIComponent(deploymentId)}`,
    { method: 'DELETE', auth: 'required', retry: true },
  );
  if (response.revoked !== true) throw new Error('节点断开结果无法确认，请刷新后重试。');
  await clearProviderNodeClaimRequest(assetId);
  return response;
}
