import type { AdminPermission } from '../api/contracts';

export const PERMISSIONS = Object.freeze({
  overview: 'admin.overview.read',
  computeOrders: 'admin.order.read',
  deviceOrders: 'admin.device-order.read',
  payouts: 'admin.payout.read',
  topups: 'admin.topup.read',
} as const satisfies Record<string, AdminPermission>);

export type ConsolePermission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

export function can(permissions: readonly AdminPermission[], permission: ConsolePermission): boolean {
  return permissions.includes(permission);
}
