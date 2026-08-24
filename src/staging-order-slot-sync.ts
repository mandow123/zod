export type StagingOrderSlotOrigin = 'order-action' | 'manual-delivery';

export type StagingOrderSlotRefresh = Readonly<{
  revision: number;
  orderId: string | null;
  origin: StagingOrderSlotOrigin | null;
}>;

export const initialStagingOrderSlotRefresh: StagingOrderSlotRefresh = {
  revision: 0, orderId: null, origin: null,
};

export function nextStagingOrderSlotRefresh(
  current: StagingOrderSlotRefresh,
  orderId: string,
  origin: StagingOrderSlotOrigin,
): StagingOrderSlotRefresh {
  return { revision: current.revision + 1, orderId, origin };
}

export function shouldReloadStagingOrderSlot(
  refresh: StagingOrderSlotRefresh,
  observedRevision: number,
  orderId: string,
) {
  return refresh.orderId === orderId && refresh.revision > observedRevision;
}
