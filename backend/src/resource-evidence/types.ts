export type ResourceEvidenceCategory = 'ownership' | 'configuration' | 'availability';
export type ResourceEvidenceStatus = 'pending_upload' | 'pending_scan' | 'verified' | 'rejected' | 'scan_failed' | 'deleted';

export type ResourceEvidenceRecord = Readonly<{
  id: string;
  resourceId: string;
  supplierId: string;
  submittedBy: string;
  category: ResourceEvidenceCategory;
  objectKey: string;
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'application/pdf';
  sizeBytes: number;
  sha256Digest: string;
  status: ResourceEvidenceStatus;
  scanResult: string | null;
  retentionUntil: Date;
  createdAt: Date;
  uploadedAt: Date | null;
  verifiedAt: Date | null;
  rejectedAt: Date | null;
}>;

export type ResourceEvidenceChecklist = Readonly<{
  resourceId: string;
  resourceStatus: 'draft' | 'pending_verification' | 'verified' | 'rejected' | 'suspended' | 'retired';
  review: Readonly<{
    runId: string | null;
    status: 'collecting' | 'under_review' | 'passed' | 'failed' | 'unavailable';
    requestedAt: Date | null;
    submittedAt: Date | null;
    correctionNote: string | null;
  }>;
  categories: Record<ResourceEvidenceCategory, Readonly<{
    state: 'missing' | 'uploading' | 'checking' | 'ready' | 'needs_replacement';
    reviewDecision: 'accepted' | 'replace' | null;
    evidence: ResourceEvidenceRecord | null;
  }>>;
  readyToSubmit: boolean;
}>;
