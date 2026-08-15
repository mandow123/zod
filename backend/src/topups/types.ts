import type { PaymentChannel, PaymentProviderName, VerifiedPaymentEvent } from '../payment/types.js';

export type CreditTopupRecord = Readonly<{
  id: string;
  subjectId: string;
  createdByUserId: string;
  provider: PaymentProviderName;
  providerReference: string;
  providerPaymentId: string | null;
  providerTransactionId: string | null;
  channel: PaymentChannel;
  status: 'created' | 'pending' | 'succeeded' | 'failed' | 'expired' | 'cancelled' | 'manual_review';
  amountCents: number;
  currency: 'CNY';
  creditMicros: bigint;
  conversionCnyMicrosPerCredit: bigint;
  checkoutPayload: string | null;
  expiresAt: Date;
  succeededAt: Date | null;
  reconciliationAttempts: number;
  lastReconciledAt: Date | null;
  reconciliationDeadLetteredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type TopupEventResult =
  | 'succeeded' | 'failed' | 'duplicate' | 'amount_mismatch' | 'unknown_reference'
  | 'provider_transaction_conflict' | 'manual_review';

export type VerifiedTopupEvent = VerifiedPaymentEvent;
