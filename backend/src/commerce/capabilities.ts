export const KAI_CREDIT_COMMERCE_IMPLEMENTATION = Object.freeze({
  resourceAuditGate: true,
  doubleEntryLedger: true,
  verifiedTopups: true,
  creditOrderReservation: true,
  creditOrderDelivery: true,
  creditOrderCapture: true,
  creditOrderDeliveryIssue: true,
  creditOrderDeliveryRework: true,
  creditOrderMutualRefund: true,
  creditOrderDisputeAdjudication: true,
  creditOrderPostAcceptanceRefund: true,
  creditOrderRemedies: true,
  creditSupplierSettlement: true,
  computeFulfillment: true,
  storeBillingPolicy: true,
});

export type KaiCreditCommerceCapability = Readonly<{
  implemented: boolean;
  available: boolean;
  blockers: string[];
}>;

export function kaiCreditCommerceCapability(input: Readonly<{
  verifiedTopupProviderAvailable?: boolean; computeProviderAvailable?: boolean;
}> = {}): KaiCreditCommerceCapability {
  const blockers = [
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.resourceAuditGate ? [] : ['KAI_RESOURCE_AUDIT_GATE_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.doubleEntryLedger ? [] : ['KAI_CREDIT_LEDGER_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.verifiedTopups ? [] : ['KAI_CREDIT_TOPUP_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.verifiedTopups && !input.verifiedTopupProviderAvailable
      ? ['KAI_CREDIT_TOPUP_PROVIDER_NOT_CONFIGURED'] : []),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.creditOrderReservation ? [] : ['KAI_CREDIT_ORDER_RESERVATION_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.creditOrderDelivery ? [] : ['KAI_CREDIT_ORDER_DELIVERY_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.creditOrderCapture ? [] : ['KAI_CREDIT_ORDER_CAPTURE_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.creditOrderDeliveryIssue ? [] : ['KAI_CREDIT_ORDER_DELIVERY_ISSUE_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.creditOrderDeliveryRework ? [] : ['KAI_CREDIT_ORDER_DELIVERY_REWORK_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.creditOrderMutualRefund ? [] : ['KAI_CREDIT_ORDER_MUTUAL_REFUND_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.creditOrderDisputeAdjudication ? [] : ['KAI_CREDIT_ORDER_DISPUTE_ADJUDICATION_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.creditOrderPostAcceptanceRefund ? [] : ['KAI_CREDIT_ORDER_POST_ACCEPTANCE_REFUND_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.creditOrderRemedies ? [] : ['KAI_CREDIT_ORDER_REMEDIES_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.creditSupplierSettlement ? [] : ['KAI_CREDIT_SUPPLIER_SETTLEMENT_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.computeFulfillment ? [] : ['COMPUTE_FULFILLMENT_NOT_IMPLEMENTED']),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.computeFulfillment && !input.computeProviderAvailable
      ? ['COMPUTE_PROVIDER_NOT_CONFIGURED'] : []),
    ...(KAI_CREDIT_COMMERCE_IMPLEMENTATION.storeBillingPolicy ? [] : ['STORE_BILLING_POLICY_UNRESOLVED']),
  ];
  const implemented = Object.values(KAI_CREDIT_COMMERCE_IMPLEMENTATION).every(Boolean);
  return { implemented, available: implemented && blockers.length === 0, blockers };
}
