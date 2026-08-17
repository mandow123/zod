import type { DeviceOrder } from './device-commerce';

export type DeviceAction = NonNullable<DeviceOrder['actions']>[number];

export function availableDeviceOrderActions(order: DeviceOrder): DeviceAction[] {
  if (!order.side || !order.actions) return [];
  return [...order.actions];
}
