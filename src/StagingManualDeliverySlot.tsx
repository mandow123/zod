import type { StagingOrderSlotRefresh } from './staging-order-slot-sync';

export function StagingManualDeliverySlot(_props: Readonly<{
  enabled: boolean; orderId: string; onChanged: () => Promise<void> | void;
  refreshSignal: StagingOrderSlotRefresh;
}>) { return null; }
