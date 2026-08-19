import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLE_PERMISSIONS, isAdminPermission, isAdminRoleCode, permissionsForAdminRoles,
  stableAdminPermissionDigestInput, stableAdminPermissionSnapshot,
} from '../src/admin/permissions.js';

describe('admin permission definitions', () => {
  it('keeps every role exact and super_admin outside business and finance powers', () => {
    expect(ADMIN_ROLE_PERMISSIONS.support_viewer).toEqual([
      'admin.overview.read','admin.supplier.read','admin.resource.read','admin.offer.read',
      'admin.order.read','admin.device.read','admin.device-order.read','admin.fulfillment.read',
      'admin.refund.read','admin.dispute.read',
    ]);
    expect(ADMIN_ROLE_PERMISSIONS.supplier_reviewer).toEqual([
      'admin.overview.read','admin.supplier.read','admin.supplier.review',
    ]);
    expect(ADMIN_ROLE_PERMISSIONS.resource_reviewer).toEqual([
      'admin.overview.read','admin.supplier.read','admin.resource.read','admin.resource.evidence.read',
      'admin.resource.review','admin.offer.read','admin.offer.resource-review',
    ]);
    expect(ADMIN_ROLE_PERMISSIONS.price_reviewer).toEqual([
      'admin.overview.read','admin.supplier.read','admin.resource.read','admin.offer.read','admin.offer.price-review',
    ]);
    expect(ADMIN_ROLE_PERMISSIONS.finance_viewer).toEqual([
      'admin.overview.read','admin.payout.read','admin.topup.read',
    ]);
    expect(ADMIN_ROLE_PERMISSIONS.audit_viewer).toEqual(['admin.overview.read','admin.audit.read']);
    expect(ADMIN_ROLE_PERMISSIONS.super_admin).toEqual([
      'admin.overview.read','admin.audit.read','admin.access.read','admin.access.manage',
      'admin.sensitive-access.approve',
    ]);
    expect(ADMIN_ROLE_PERMISSIONS.super_admin).not.toEqual(expect.arrayContaining([
      'admin.supplier.review','admin.resource.review','admin.offer.resource-review',
      'admin.offer.price-review','admin.payout.read','admin.topup.read',
    ]));
  });
  it('produces a stable deduplicated union and digest input', () => {
    const first = permissionsForAdminRoles(['audit_viewer','finance_viewer','audit_viewer']);
    const second = permissionsForAdminRoles(['finance_viewer','audit_viewer']);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
    expect(stableAdminPermissionSnapshot([...first].reverse())).toEqual(first);
    expect(stableAdminPermissionDigestInput([...first].reverse())).toBe(JSON.stringify(first));
  });
  it('fails closed for unknown roles and permissions', () => {
    expect(isAdminRoleCode('root')).toBe(false);
    expect(isAdminPermission('admin.*')).toBe(false);
    expect(() => permissionsForAdminRoles(['root'])).toThrow('ADMIN_ROLE_UNKNOWN');
    expect(() => stableAdminPermissionSnapshot(['admin.*'])).toThrow('ADMIN_PERMISSION_UNKNOWN');
  });
});
