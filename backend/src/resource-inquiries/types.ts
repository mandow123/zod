import type { ImportMode, ImportModel } from './importer.js';
import type { SupplierCatalogKind,SupplierCatalogSpecifications } from '../supplier-inquiry-catalog/types.js';

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
  candidate: CatalogCandidate | null;
  supplierResource: null | Readonly<{
    resourceId:string;version:number;catalogKind:SupplierCatalogKind;title:string;legalReviewRequired:boolean;
    supplier:Readonly<{id:'supplier-shanghai-honghuan';legalName:'上海鸿欢网络科技有限公司';displayName:'上海鸿欢';
      logo:Readonly<{httpsUrl:string;version:string;authorizationStatus:'unverified';provenance:'user_provided'}>;
      disclosureStatus:'platform_imported_unverified'}>;
    specifications:SupplierCatalogSpecifications;
    quantity:Readonly<{unit:'instance'|'server';min:number;max:number;allowedValues:readonly number[]|null}>;
    referencePrice:Readonly<{currency:'KAI_CARD_HOUR';precision:2;status:'reference_only';hourlyAmount:string|null;
      dailyAmount:string|null;monthlyAmount:string|null;validUntil:string}>;
    source:Readonly<{observedAt:'2026-08-19';kind:'USER_PROVIDED_SUPPLIER_QUOTE';
      label:'资料来源：用户提供的供应商报价';verificationStatus:'unverified'}>;
    requestedQuantity:number;
  }>;
  status: InquiryStatus;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  confirmBy: Date;
  gpuCount: number | null;
  requestedQuantity:number | null;
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
