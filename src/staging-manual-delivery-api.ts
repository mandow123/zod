import { apiRequest } from './api-client';

type StagingEnvelope = Readonly<{ ok: true; environment: 'staging'; simulation: true; requestId: string }>;
export type StagingSshKeyAlgorithm = 'ssh-ed25519' | 'sk-ssh-ed25519@openssh.com' | 'ecdsa-sha2-nistp256' | 'ssh-rsa';
export type StagingSshPublicKey = Readonly<{
  id: string; clientKeyId: string; label: string; algorithm: StagingSshKeyAlgorithm; fingerprint: string;
  status: 'active' | 'revoked'; version: number; allowedActions: Array<'rename' | 'revoke'>;
  createdAt: string; updatedAt: string; lastUsedAt: string | null; simulation: true;
}>;
export type StagingManualDeliveryRequest = Readonly<{
  id: string; status: 'submitted' | 'key_verified' | 'provisioning' | 'ready' | 'rejected' | 'canceled';
  version: number; key: Pick<StagingSshPublicKey, 'id' | 'label' | 'algorithm' | 'fingerprint'>;
  allowedActions: never[]; createdAt: string; updatedAt: string;
}>;

const auth = { auth: 'none' as const };
export async function loadStagingSshPublicKeys() {
  const response = await apiRequest<StagingEnvelope & { items: StagingSshPublicKey[]; nextCursor: string | null }>(
    '/mobile/v1/staging/access/ssh-public-keys?limit=50', auth,
  );
  return response.items;
}
export async function createStagingSshPublicKey(payload: Readonly<{
  clientKeyId: string; label: string; publicKey: string; ownershipAttested: true;
}>, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { sshPublicKey: StagingSshPublicKey }>(
    '/mobile/v1/staging/access/ssh-public-keys', { method: 'POST', auth: 'none',
      headers: { 'Idempotency-Key': idempotencyKey }, body: payload, retry: false },
  );
  return response.sshPublicKey;
}
export async function renameStagingSshPublicKey(id: string, expectedVersion: number, label: string, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { sshPublicKey: StagingSshPublicKey }>(
    `/mobile/v1/staging/access/ssh-public-keys/${encodeURIComponent(id)}`,
    { method: 'PATCH', auth: 'none', headers: { 'Idempotency-Key': idempotencyKey },
      body: { expectedVersion, label }, retry: false },
  );
  return response.sshPublicKey;
}
export async function revokeStagingSshPublicKey(id: string, expectedVersion: number, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { sshPublicKey: StagingSshPublicKey }>(
    `/mobile/v1/staging/access/ssh-public-keys/${encodeURIComponent(id)}/revoke`,
    { method: 'POST', auth: 'none', headers: { 'Idempotency-Key': idempotencyKey },
      body: { expectedVersion }, retry: false },
  );
  return response.sshPublicKey;
}
export async function submitStagingManualDelivery(orderId: string, expectedOrderVersion: number,
  sshPublicKeyId: string, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { manualDeliveryRequest: StagingManualDeliveryRequest }>(
    `/mobile/v1/staging/compute-orders/${encodeURIComponent(orderId)}/manual-delivery-requests`,
    { method: 'POST', auth: 'none', headers: { 'Idempotency-Key': idempotencyKey },
      body: { expectedOrderVersion, sshPublicKeyId, termsVersion: 'staging-manual-delivery-v1' }, retry: false },
  );
  return response.manualDeliveryRequest;
}
