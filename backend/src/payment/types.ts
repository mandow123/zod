export type PaymentProviderName = 'alipay' | 'wechat';
export type PaymentChannel = 'app' | 'h5';

export type PaymentIntentRecord = Readonly<{
  id: string;
  orderId: string;
  orderNumber: string;
  buyerId: string;
  provider: PaymentProviderName;
  providerReference: string;
  providerPaymentId: string | null;
  channel: PaymentChannel;
  status: 'created' | 'pending' | 'succeeded' | 'failed' | 'expired' | 'cancelled' | 'refunding' | 'refunded';
  amountCents: number;
  currency: 'CNY';
  checkoutPayload: string | null;
  expiresAt: Date;
  reconciliationAttempts: number;
  lastReconciledAt: Date | null;
  reconciliationDeadLetteredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type VerifiedPaymentEvent = Readonly<{
  provider: PaymentProviderName;
  eventId: string;
  providerReference: string;
  providerTransactionId: string;
  status: 'succeeded' | 'failed';
  amountCents: number;
  currency: string;
  payloadDigest: string;
  normalizedPayload: Record<string, unknown>;
}>;

export type ProviderCheckout = Readonly<{
  providerPaymentId: string;
  checkoutPayload: string;
}>;

export type ProviderRefundRequest = Readonly<{
  refundReference: string;
  providerReference: string;
  amountCents: number;
  originalAmountCents: number;
  currency: 'CNY';
  reason: string;
}>;

export type ProviderRefundResult = Readonly<{
  providerRefundId: string;
  status: 'pending' | 'succeeded' | 'failed';
}>;

export type VerifiedRefundEvent = Readonly<{
  provider: PaymentProviderName;
  eventId: string;
  refundReference: string;
  providerRefundId: string;
  status: 'pending' | 'succeeded' | 'failed';
  amountCents: number;
  originalAmountCents: number;
  currency: string;
  payloadDigest: string;
  normalizedPayload: Record<string, unknown>;
}>;

export type PaymentEventResult =
  | 'succeeded'
  | 'failed'
  | 'duplicate'
  | 'amount_mismatch'
  | 'unknown_reference'
  | 'refund_required';

export type PaymentQueryResult =
  | Readonly<{ status: 'pending'; providerStatus: string; payloadDigest: string }>
  | Readonly<{ status: 'settled'; event: VerifiedPaymentEvent }>;
