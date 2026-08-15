export type InvoiceType = 'personal' | 'business';
export type InvoiceStatus = 'requested' | 'processing' | 'issued' | 'failed' | 'cancelled' | 'red_pending' | 'red_issued';

export type InvoiceRecord = Readonly<{
  id: string;
  orderId: string;
  orderNumber: string;
  userId: string;
  invoiceType: InvoiceType;
  titleCiphertext: string;
  taxIdCiphertext: string | null;
  emailCiphertext: string;
  amountCents: number;
  currency: 'CNY';
  status: InvoiceStatus;
  failureReason: string | null;
  invoiceCode: string | null;
  invoiceNumber: string | null;
  documentObjectKey: string | null;
  documentSha256Digest: string | null;
  documentSizeBytes: number | null;
  redInvoiceCode: string | null;
  redInvoiceNumber: string | null;
  redDocumentObjectKey: string | null;
  redDocumentSha256Digest: string | null;
  redDocumentSizeBytes: number | null;
  redIssuedAt: Date | null;
  issuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type InvoiceDocumentUpload = Readonly<{
  id: string;
  invoiceId: string;
  kind: 'blue' | 'red';
  objectKey: string;
  mimeType: 'application/pdf';
  sizeBytes: number;
  sha256Digest: string;
  status: 'pending_upload' | 'verified' | 'rejected';
  expiresAt: Date;
}>;
