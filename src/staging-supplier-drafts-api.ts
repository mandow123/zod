import { apiRequest } from './api-client';

type StagingEnvelope = Readonly<{
  ok: true;
  environment: 'staging';
  simulation: true;
  requestId: string;
}>;

export type StagingGpuCardType = 'SXM' | 'PCIe' | 'other';
export type StagingRegionCode = 'CN-SH' | 'CN-BJ' | 'CN-GD' | 'CN-ZJ' | 'CN-JS' | 'CN-SC' | 'CN-OTHER';
export type StagingMachineType = 'bare_metal' | 'virtualized';
export type StagingOperatingSystem = 'ubuntu_22_04' | 'ubuntu_24_04' | 'other';

export type StagingSupplierResource = Readonly<{
  name: string | null;
  gpuModel: string | null;
  gpuCardType: StagingGpuCardType | null;
  gpuCount: number | null;
  gpuMemoryGb: number | null;
  regionCode: StagingRegionCode | null;
  city: string | null;
  machineType: StagingMachineType | null;
  cpuModel: string | null;
  cpuCores: number | null;
  memoryGb: number | null;
  storageGb: number | null;
  networkMbps: number | null;
  operatingSystem: StagingOperatingSystem | null;
  capacityGpuHours: string | null;
  fulfillmentNotes: string | null;
}>;

export type StagingSupplierDeliveryPlan = null | Readonly<{
  mode: 'scheduled_window';
  startsAt: string;
  endsAt: string;
  timezone: string;
  leadTimeHours: null;
}> | Readonly<{
  mode: 'preparation_lead_time';
  startsAt: null;
  endsAt: null;
  timezone: null;
  leadTimeHours: number;
}>;

export type StagingSupplierDraftPayload = Readonly<{
  clientDraftId: string;
  resource: StagingSupplierResource;
  deliveryPlan: StagingSupplierDeliveryPlan;
  pricing: Readonly<{ unit: 'KAI_CARD_HOUR_PER_GPU_HOUR'; amount: string | null }>;
  acknowledgements: Readonly<{
    ownershipConfirmed: boolean;
    remoteAccessSafetyAcknowledged: boolean;
  }>;
}>;

export type StagingSupplierDraft = StagingSupplierDraftPayload & Readonly<{
  id: string;
  status: 'draft';
  version: number;
  visibility: 'private';
  purchasable: false;
  completeness: Readonly<{ complete: boolean; missingFields: string[] }>;
  allowedActions: Array<'edit'>;
  createdAt: string;
  updatedAt: string;
  simulation: true;
}>;

const auth = { auth: 'none' as const };
export async function loadStagingSupplierDrafts() {
  const response = await apiRequest<StagingEnvelope & { items: StagingSupplierDraft[]; nextCursor: string | null }>(
    '/mobile/v1/staging/supplier/resource-drafts?limit=50', auth,
  );
  return response.items;
}

export async function loadStagingSupplierDraft(id: string) {
  const response = await apiRequest<StagingEnvelope & { draft: StagingSupplierDraft }>(
    `/mobile/v1/staging/supplier/resource-drafts/${encodeURIComponent(id)}`, auth,
  );
  return response.draft;
}

export async function createStagingSupplierDraft(payload: StagingSupplierDraftPayload, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { draft: StagingSupplierDraft }>(
    '/mobile/v1/staging/supplier/resource-drafts', {
      method: 'POST', auth: 'none', headers: { 'Idempotency-Key': idempotencyKey }, body: payload, retry: false,
    },
  );
  return response.draft;
}

export async function updateStagingSupplierDraft(id: string, expectedVersion: number,
  patch: Omit<StagingSupplierDraftPayload, 'clientDraftId'>, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { draft: StagingSupplierDraft }>(
    `/mobile/v1/staging/supplier/resource-drafts/${encodeURIComponent(id)}`,
    { method: 'PATCH', auth: 'none', headers: { 'Idempotency-Key': idempotencyKey },
      body: { expectedVersion, patch }, retry: false },
  );
  return response.draft;
}
