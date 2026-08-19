export const ADMIN_PERMISSIONS = Object.freeze([
  'admin.overview.read',
  'admin.supplier.read',
  'admin.supplier.review',
  'admin.resource.read',
  'admin.resource.evidence.read',
  'admin.resource.review',
  'admin.offer.read',
  'admin.offer.resource-review',
  'admin.offer.price-review',
  'admin.order.read',
  'admin.device.read',
  'admin.device-order.read',
  'admin.fulfillment.read',
  'admin.refund.read',
  'admin.dispute.read',
  'admin.payout.read',
  'admin.topup.read',
  'admin.audit.read',
  'admin.access.read',
  'admin.access.manage',
  'admin.sensitive-access.approve',
] as const);

export const ADMIN_ROLE_CODES = Object.freeze([
  'support_viewer',
  'supplier_reviewer',
  'resource_reviewer',
  'price_reviewer',
  'finance_viewer',
  'audit_viewer',
  'super_admin',
] as const);

export type AdminPermission = typeof ADMIN_PERMISSIONS[number];
export type AdminRoleCode = typeof ADMIN_ROLE_CODES[number];

const permissionSet: ReadonlySet<string> = new Set(ADMIN_PERMISSIONS);
const roleSet: ReadonlySet<string> = new Set(ADMIN_ROLE_CODES);

const rolePermissions: Record<AdminRoleCode, readonly AdminPermission[]> = {
  support_viewer: Object.freeze([
    'admin.overview.read', 'admin.supplier.read', 'admin.resource.read', 'admin.offer.read',
    'admin.order.read', 'admin.device.read', 'admin.device-order.read', 'admin.fulfillment.read',
    'admin.refund.read', 'admin.dispute.read',
  ]),
  supplier_reviewer: Object.freeze([
    'admin.overview.read', 'admin.supplier.read', 'admin.supplier.review',
  ]),
  resource_reviewer: Object.freeze([
    'admin.overview.read', 'admin.supplier.read', 'admin.resource.read', 'admin.resource.evidence.read',
    'admin.resource.review', 'admin.offer.read', 'admin.offer.resource-review',
  ]),
  price_reviewer: Object.freeze([
    'admin.overview.read', 'admin.supplier.read', 'admin.resource.read', 'admin.offer.read',
    'admin.offer.price-review',
  ]),
  finance_viewer: Object.freeze([
    'admin.overview.read', 'admin.payout.read', 'admin.topup.read',
  ]),
  audit_viewer: Object.freeze([
    'admin.overview.read', 'admin.audit.read',
  ]),
  super_admin: Object.freeze([
    'admin.overview.read', 'admin.audit.read', 'admin.access.read', 'admin.access.manage',
    'admin.sensitive-access.approve',
  ]),
};
export const ADMIN_ROLE_PERMISSIONS: Readonly<Record<AdminRoleCode, readonly AdminPermission[]>> =
  Object.freeze(rolePermissions);

export function isAdminRoleCode(value: unknown): value is AdminRoleCode {
  return typeof value === 'string' && roleSet.has(value);
}

export function isAdminPermission(value: unknown): value is AdminPermission {
  return typeof value === 'string' && permissionSet.has(value);
}

function requireRoles(roles: readonly string[]): AdminRoleCode[] {
  if (!roles.every(isAdminRoleCode)) throw new Error('ADMIN_ROLE_UNKNOWN');
  return [...roles];
}

function requirePermissions(permissions: readonly string[]): AdminPermission[] {
  if (!permissions.every(isAdminPermission)) throw new Error('ADMIN_PERMISSION_UNKNOWN');
  return [...permissions];
}

export function permissionsForAdminRoles(roles: readonly string[]): readonly AdminPermission[] {
  const resolved = new Set<AdminPermission>();
  for (const role of requireRoles(roles)) {
    for (const permission of ADMIN_ROLE_PERMISSIONS[role]) resolved.add(permission);
  }
  return Object.freeze([...resolved].sort());
}

export function stableAdminPermissionSnapshot(permissions: readonly string[]): readonly AdminPermission[] {
  return Object.freeze([...new Set(requirePermissions(permissions))].sort());
}

export function stableAdminPermissionDigestInput(permissions: readonly string[]): string {
  return JSON.stringify(stableAdminPermissionSnapshot(permissions));
}
