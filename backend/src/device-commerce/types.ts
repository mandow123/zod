export const SPARK_PRODUCT_ID = '02672000-0000-4000-8000-000000000200';
export type DeviceOrderStatus = 'reserved' | 'confirmed' | 'shipping' | 'received' | 'cancelled' | 'expired';

export type DeviceProduct = Readonly<{
  id: string; sku: string; title: string; supplierDisplayName: string; supplierSubjectId: string | null;
  activationStatus: 'pending_activation' | 'active' | 'suspended'; inventoryTotal: number;
  inventoryReserved: number; inventorySold: number; listPriceCnyMicros: bigint; salePriceCnyMicros: bigint;
  unitCreditMicros: bigint; discountBasisPoints: number; expectedShipDays: number;
  specifications: Record<string, unknown>;
}>;
export type DeviceOrder = Readonly<{
  id: string; orderNumber: string; buyerSubjectId: string; supplierSubjectId: string; createdByUserId: string;
  productId: string; status: DeviceOrderStatus; quantity: number; unitCreditMicros: bigint; grossCreditMicros: bigint;
  serviceFeeCreditMicros: bigint | null; supplierNetCreditMicros: bigint | null;
  reservationTransactionId: string; resolutionTransactionId: string | null; reservationExpiresAt: Date;
  confirmedAt: Date | null; shippedAt: Date | null; receivedAt: Date | null; resolvedAt: Date | null;
  logisticsProvider: string | null; createdAt: Date; updatedAt: Date;
}>;
export type DeviceAsset = Readonly<{
  id: string; orderId: string; ownerSubjectId: string; productId: string; title: string;
  quantity: number; status: 'owned'; acquiredAt: Date;
}>;
