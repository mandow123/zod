export type RefundStatus =
  | 'requested'
  | 'reviewing'
  | 'approved'
  | 'provider_pending'
  | 'succeeded'
  | 'rejected'
  | 'cancelled'
  | 'failed';

export type RefundRecord = Readonly<{
  id: string;
  orderId: string;
  orderNumber: string;
  requestedBy: string;
  paymentIntentId: string;
  amountCents: number;
  currency: 'CNY';
  reason: string;
  reviewReason: string | null;
  status: RefundStatus;
  providerRefundId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;
