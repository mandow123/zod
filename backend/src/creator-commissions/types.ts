export type CreatorCommissionPolicy = Readonly<{
  version: string;
  commissionBasisPoints: number;
  attributionTtlDays: number;
  refundObservationDays: number;
}>;

export type ReferralProviderSource = 'first_party' | 'douyin' | 'tiktok';
export type CommissionOrderKind = 'credit_order' | 'device_order' | 'vast_order';
export type CommissionOrderStatus = 'attributed' | 'refund_observation' | 'pending' | 'available' | 'reversed' | 'transferred';
