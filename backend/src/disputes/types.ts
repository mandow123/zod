export type DisputeCategory = 'not_delivered' | 'spec_mismatch' | 'service_unavailable' | 'billing' | 'unauthorized' | 'other';
export type DisputeStatus = 'open' | 'evidence_pending' | 'reviewing' | 'resolved_buyer' | 'resolved_supplier' | 'closed';
export type EvidenceStatus = 'pending_upload' | 'pending_scan' | 'scan_failed' | 'verified' | 'rejected' | 'deleted';

export type DisputeRecord = Readonly<{
  id: string;
  orderId: string;
  orderNumber: string;
  buyerId: string;
  supplierUserId: string;
  openedBy: string;
  category: DisputeCategory;
  reason: string;
  status: DisputeStatus;
  resolution: string | null;
  resolutionRefundId: string | null;
  evidenceDeadline: Date;
  buyerEvidenceCompletedAt: Date | null;
  supplierEvidenceCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type EvidenceRecord = Readonly<{
  id: string;
  disputeId: string;
  submittedBy: string;
  objectKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256Digest: string;
  status: EvidenceStatus;
  scanResult: string | null;
  createdAt: Date;
  uploadedAt: Date | null;
  verifiedAt: Date | null;
}>;
