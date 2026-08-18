import type { ImportMode, ImportModel } from './importer.js';

export type InquiryStatus = 'submitted' | 'awaiting_supplier' | 'clarification_required'
  | 'supplier_declined' | 'inquiry_expired' | 'user_cancelled' | 'capacity_confirmed' | 'audit_pending';
export type InquiryBillingMode = ImportMode;
export type InquiryUseCase = 'training' | 'inference' | 'rendering' | 'research' | 'other';
export type InquiryEnvironment = 'bare_metal' | 'virtual_machine' | 'container' | 'flexible';
export type InquiryNetwork = 'public_internet' | 'private_network' | 'dedicated_line' | 'flexible';

export type CatalogCandidate = Readonly<{
  id: string;
  model: ImportModel;
  cardType: string;
  region: string;
  modes: readonly InquiryBillingMode[];
  status: 'inquiry_required';
  sourceObservedAt: Date;
  verifiedAt: Date | null;
  supplierSubjectId: string | null;
  createdAt: Date;
}>;

export type InquiryRecord = Readonly<{
  id: string;
  inquiryNumber: string;
  subjectId: string;
  requestedByUserId: string;
  supplierSubjectId: string | null;
  candidate: CatalogCandidate;
  status: InquiryStatus;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  confirmBy: Date;
  gpuCount: number;
  billingMode: InquiryBillingMode;
  allowSubstitutes: boolean;
  maxCreditMicros: bigint;
  useCase: InquiryUseCase;
  description: string;
  environment: InquiryEnvironment;
  network: InquiryNetwork;
  storageGiB: number;
  dataRegion: string;
  termsVersion: string;
  privacyVersion: string;
  inquiryVersion: string;
  acceptedAt: Date;
  cancelledAt: Date | null;
  capacityConfirmedAt: Date | null;
  expiredAt: Date | null;
  statusMessage: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type InquiryClarification = Readonly<{
  id: string;
  message: string;
  kind: 'buyer_response' | 'supplier_request' | 'operator_request';
  createdAt: Date;
}>;
