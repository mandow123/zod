import type { CloudPayOrder } from './api';
import type { StagingOrderSlotRefresh } from './staging-order-slot-sync';

export function StagingOrderActionsSlot(_props: Readonly<{
  enabled: boolean;
  orderId: string;
  onOrderUpdated: (order: CloudPayOrder, statusLabel: string) => void;
  onChanged: () => Promise<void> | void;
  refreshSignal: StagingOrderSlotRefresh;
}>) { return null; }
