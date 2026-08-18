import { apiRequest } from './api-client';
export { validateInquiryInput } from './inquiry-form';

export type InquiryModel = 'H100' | 'H200' | 'B300';
export type InquiryBillingMode = 'hourly' | 'monthly';
export type ResourceInquiryStatus = 'submitted' | 'awaiting_supplier' | 'clarification_required'
  | 'supplier_declined' | 'inquiry_expired' | 'user_cancelled' | 'capacity_confirmed' | 'audit_pending';

export type InquiryCatalogCandidate = Readonly<{
  candidateId: string;
  model: InquiryModel;
  cardType: string;
  region: string;
  modes: InquiryBillingMode[];
  status: 'inquiry_required';
  sourceObservedAt: string;
  lastVerifiedAt: string | null;
  verification: Readonly<{ status: 'awaiting_supplier_confirmation'; message: '资料待供应方确认' }>;
  supplier: Readonly<{ displayName: '待认领供应方'; claimed: false }>;
  terms: 'inquiry-required';
}>;

export type ResourceInquirySummary = Readonly<{
  id: string;
  inquiryNumber: string;
  candidate: Readonly<{ candidateId: string; model: InquiryModel; cardType: string; region: string }>;
  status: ResourceInquiryStatus;
  startsAt: string;
  endsAt: string;
  confirmBy: string;
  timeZone: string;
  gpuCount: number;
  billingMode: InquiryBillingMode;
  createdAt: string;
  updatedAt: string;
  version: number;
  assignment: Readonly<{ status: 'unassigned' | 'assigned' }>;
  allowedActions: Array<'cancel' | 'provide_clarification'>;
}>;

export type InquiryClarification = Readonly<{ id: string; kind: 'supplier_request' | 'buyer_response'; message: string; createdAt: string }>;

export type ResourceInquiry = ResourceInquirySummary & Readonly<{
  useCase: 'training' | 'inference' | 'rendering' | 'research' | 'other';
  description: string;
  requirements: Readonly<{
    environment: 'bare_metal' | 'virtual_machine' | 'container' | 'flexible';
    network: 'public_internet' | 'private_network' | 'dedicated_line' | 'flexible';
    storageGiB: number;
    dataRegion: string;
  }>;
  allowSubstitutes: boolean;
  maxCreditAmount: string;
  statusMessage: string | null;
  terms: Readonly<{
    termsVersion: string;
    privacyVersion: string;
    inquiryVersion: string;
    acceptedAt: string;
  }>;
  clarifications: InquiryClarification[];
  cancelledAt: string | null;
}>;

export type CreateResourceInquiryInput = Readonly<{
  candidateId: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  gpuCount: number;
  billingMode: InquiryBillingMode;
  useCase: ResourceInquiry['useCase'];
  description: string;
  environment: ResourceInquiry['requirements']['environment'];
  network: ResourceInquiry['requirements']['network'];
  storageGiB: number;
  dataRegion: string;
  allowSubstitutes: boolean;
  confirmBy: string;
  maxCreditAmount: string;
  terms: Readonly<{ termsVersion: string; privacyVersion: string; inquiryVersion: string }>;
}>;

type CatalogResponse = Readonly<{ ok: true; items: InquiryCatalogCandidate[]; nextCursor: string | null }>;
type InquiriesResponse = Readonly<{ ok: true; inquiries: ResourceInquirySummary[]; nextCursor: string | null }>;

export function loadInquiryCatalog(input: Readonly<{
  model?: InquiryModel | null; region?: string | null; query?: string; cursor?: string | null; limit?: number;
}> = {}) {
  const params = new URLSearchParams({ limit: String(input.limit ?? 20) });
  if (input.model) params.set('model', input.model);
  if (input.region) params.set('region', input.region);
  if (input.query?.trim()) params.set('query', input.query.trim());
  if (input.cursor) params.set('cursor', input.cursor);
  return apiRequest<CatalogResponse>(`/mobile/v1/inquiry-catalog?${params.toString()}`, { retry: true });
}

export async function loadInquiryCandidate(candidateId: string) {
  const response = await apiRequest<Readonly<{ ok: true; candidate: InquiryCatalogCandidate }>>(
    `/mobile/v1/inquiry-catalog/${encodeURIComponent(candidateId)}`, { retry: true },
  );
  return response.candidate;
}

export async function createResourceInquiry(input: CreateResourceInquiryInput, idempotencyKey: string) {
  const response = await apiRequest<Readonly<{ ok: true; replayed: boolean; inquiry: ResourceInquiry }>>(
    '/mobile/v1/resource-inquiries', {
      method: 'POST', auth: 'required', retry: false, body: input,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
  return response;
}

export function loadResourceInquiries(input: Readonly<{
  status?: ResourceInquiryStatus | null; cursor?: string | null; limit?: number;
}> = {}) {
  const params = new URLSearchParams({ limit: String(input.limit ?? 20) });
  if (input.status) params.set('status', input.status);
  if (input.cursor) params.set('cursor', input.cursor);
  return apiRequest<InquiriesResponse>(`/mobile/v1/resource-inquiries?${params.toString()}`, {
    auth: 'required', retry: true,
  });
}

export async function loadResourceInquiry(inquiryId: string) {
  const response = await apiRequest<Readonly<{ ok: true; inquiry: ResourceInquiry }>>(
    `/mobile/v1/resource-inquiries/${encodeURIComponent(inquiryId)}`, { auth: 'required', retry: true },
  );
  return response.inquiry;
}

export async function addInquiryClarification(inquiryId: string, message: string, expectedVersion: number, idempotencyKey: string) {
  const response = await apiRequest<Readonly<{
    ok: true; replayed: boolean; inquiry: ResourceInquiry; clarification: InquiryClarification;
  }>>(`/mobile/v1/resource-inquiries/${encodeURIComponent(inquiryId)}/clarifications`, {
    method: 'POST', auth: 'required', retry: false, body: { message, expectedVersion },
    headers: { 'idempotency-key': idempotencyKey },
  });
  return response.inquiry;
}

export async function cancelResourceInquiry(inquiryId: string, expectedVersion: number, idempotencyKey: string) {
  const response = await apiRequest<Readonly<{ ok: true; replayed: boolean; inquiry: ResourceInquiry }>>(
    `/mobile/v1/resource-inquiries/${encodeURIComponent(inquiryId)}/cancel`, {
      method: 'POST', auth: 'required', retry: false, body: { expectedVersion },
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
  return response.inquiry;
}

export const inquiryStatusLabel: Record<ResourceInquiryStatus, string> = {
  submitted: '询期已提交',
  awaiting_supplier: '等待供应方确认',
  clarification_required: '需要补充信息',
  supplier_declined: '供应方未能承接',
  inquiry_expired: '询期已过期',
  user_cancelled: '已取消',
  capacity_confirmed: '供应方已确认容量',
  audit_pending: '平台审核中',
};
