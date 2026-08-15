import * as Crypto from 'expo-crypto';
import type { DocumentPickerAsset } from 'expo-document-picker';
import { File, UploadType } from 'expo-file-system';
import { apiRequest } from './api-client';

export type ResourceEvidenceCategory = 'ownership' | 'configuration' | 'availability';
export type ResourceEvidenceState = 'missing' | 'uploading' | 'checking' | 'ready' | 'needs_replacement';

export type ResourceEvidence = Readonly<{
  id: string;
  category: ResourceEvidenceCategory;
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'application/pdf';
  sizeBytes: number;
  status: 'pending_upload' | 'pending_scan' | 'verified' | 'rejected' | 'scan_failed' | 'deleted';
  result: 'clean' | 'replace_file' | 'checking_delayed' | null;
  createdAt: string;
  uploadedAt: string | null;
  verifiedAt: string | null;
}>;

export type ResourceEvidenceChecklist = Readonly<{
  resourceId: string;
  resourceStatus: 'draft' | 'pending_verification' | 'verified' | 'rejected' | 'suspended' | 'retired';
  review: Readonly<{
    runId: string | null;
    status: 'collecting' | 'under_review' | 'passed' | 'failed' | 'unavailable';
    requestedAt: string | null;
    submittedAt: string | null;
    correctionNote: string | null;
  }>;
  categories: Record<ResourceEvidenceCategory, Readonly<{
    state: ResourceEvidenceState;
    reviewDecision: 'accepted' | 'replace' | null;
    evidence: ResourceEvidence | null;
  }>>;
  readyToSubmit: boolean;
}>;

type UploadGrant = Readonly<{
  url: string;
  method: 'PUT';
  expiresAt: string;
  headers: Record<string, string>;
}>;

const mimeFromExtension: Record<string, ResourceEvidence['mimeType']> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf',
};

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeResourceEvidenceAsset(asset: DocumentPickerAsset) {
  const extension = asset.name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = asset.mimeType === 'image/jpg' ? 'image/jpeg'
    : asset.mimeType && ['image/jpeg', 'image/png', 'application/pdf'].includes(asset.mimeType)
      ? asset.mimeType as ResourceEvidence['mimeType']
      : mimeFromExtension[extension];
  if (!mimeType) throw new Error('请选择 JPG、PNG 或 PDF 文件。');
  if (asset.size !== undefined && (asset.size < 1 || asset.size > 20 * 1024 * 1024)) {
    throw new Error('单份材料不能超过 20MB。');
  }
  return { fileName: asset.name, mimeType };
}

export async function prepareResourceEvidenceAsset(asset: DocumentPickerAsset) {
  const normalized = normalizeResourceEvidenceAsset(asset);
  const file = new File(asset.uri);
  const bytes = await file.bytes();
  if (bytes.byteLength < 1 || bytes.byteLength > 20 * 1024 * 1024) throw new Error('单份材料不能超过 20MB。');
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return {
    file,
    fileName: normalized.fileName,
    mimeType: normalized.mimeType,
    sizeBytes: bytes.byteLength,
    sha256Digest: `sha256:${hex(digest)}`,
  };
}

export async function loadResourceEvidence(resourceId: string) {
  const response = await apiRequest<{ ok: true; checklist: ResourceEvidenceChecklist }>(
    `/mobile/v1/provider/resources/${encodeURIComponent(resourceId)}/evidence`,
    { auth: 'required', retry: true },
  );
  return response.checklist;
}

async function putResourceEvidence(
  resourceId: string,
  evidenceId: string,
  prepared: Awaited<ReturnType<typeof prepareResourceEvidenceAsset>>,
  upload: UploadGrant,
  onProgress?: (value: number) => void,
) {
  const result = await prepared.file.upload(upload.url, {
    httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: upload.headers,
    mimeType: prepared.mimeType, sessionType: 'foreground',
    onProgress: ({ bytesSent, totalBytes }) => onProgress?.(totalBytes > 0 ? bytesSent / totalBytes : 0),
  });
  if (result.status < 200 || result.status >= 300) throw new Error('文件上传失败，请检查网络后重试。');
  const completed = await apiRequest<{ ok: true; evidence: ResourceEvidence }>(
    `/mobile/v1/provider/resources/${encodeURIComponent(resourceId)}/evidence/${encodeURIComponent(evidenceId)}/complete`,
    { method: 'POST', auth: 'required', retry: true },
  );
  return completed.evidence;
}

export async function uploadResourceEvidence(input: Readonly<{
  resourceId: string;
  category: ResourceEvidenceCategory;
  asset: DocumentPickerAsset;
  requestId: string;
  onProgress?: (value: number) => void;
}>) {
  const prepared = await prepareResourceEvidenceAsset(input.asset);
  const created = await apiRequest<{
    ok: true; replayed: boolean; evidence: ResourceEvidence; upload: UploadGrant | null;
  }>(`/mobile/v1/provider/resources/${encodeURIComponent(input.resourceId)}/evidence/uploads`, {
    method: 'POST', auth: 'required', retry: true,
    headers: { 'idempotency-key': input.requestId },
    body: {
      category: input.category, fileName: prepared.fileName, mimeType: prepared.mimeType,
      sizeBytes: prepared.sizeBytes, sha256Digest: prepared.sha256Digest,
    },
  });
  if (!created.upload) return created.evidence;
  return putResourceEvidence(input.resourceId, created.evidence.id, prepared, created.upload, input.onProgress);
}

export async function resumeResourceEvidenceUpload(input: Readonly<{
  resourceId: string;
  evidence: ResourceEvidence;
  asset: DocumentPickerAsset;
  onProgress?: (value: number) => void;
}>) {
  const prepared = await prepareResourceEvidenceAsset(input.asset);
  const renewed = await apiRequest<{ ok: true; upload: UploadGrant }>(
    `/mobile/v1/provider/resources/${encodeURIComponent(input.resourceId)}/evidence/${encodeURIComponent(input.evidence.id)}/upload-grant`,
    {
      method: 'POST', auth: 'required', retry: true,
      body: { sha256Digest: prepared.sha256Digest },
    },
  );
  return putResourceEvidence(input.resourceId, input.evidence.id, prepared, renewed.upload, input.onProgress);
}

export async function discardResourceEvidence(resourceId: string, evidenceId: string) {
  await apiRequest(
    `/mobile/v1/provider/resources/${encodeURIComponent(resourceId)}/evidence/${encodeURIComponent(evidenceId)}/discard`,
    { method: 'POST', auth: 'required', retry: false },
  );
}

export async function submitResourceEvidence(resourceId: string, requestId: string) {
  return apiRequest<{ ok: true; replayed: boolean; runId: string; submittedAt: string }>(
    `/mobile/v1/provider/resources/${encodeURIComponent(resourceId)}/evidence/submit`,
    { method: 'POST', auth: 'required', retry: true, headers: { 'idempotency-key': requestId } },
  );
}
