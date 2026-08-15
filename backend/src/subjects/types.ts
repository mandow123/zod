export type SubjectKind = 'personal' | 'organization';
export type SubjectRole = 'owner' | 'admin' | 'provider_manager' | 'provider_operator' | 'viewer';
export type SubjectPermission =
  | 'subject.manage'
  | 'credits.read'
  | 'credits.redeem'
  | 'orders.read'
  | 'orders.buy'
  | 'orders.dispute.manage'
  | 'provider.read'
  | 'provider.profile.manage'
  | 'provider.resource.manage'
  | 'provider.offer.manage'
  | 'provider.listing.manage'
  | 'provider.order.manage'
  | 'provider.refund.approve';

export type SubjectMembership = Readonly<{
  subjectId: string;
  kind: SubjectKind;
  displayName: string;
  subjectStatus: 'active' | 'suspended' | 'closed';
  role: SubjectRole;
}>;

export type SubjectContext = SubjectMembership & Readonly<{
  userId: string;
  permissions: SubjectPermission[];
}>;

const rolePermissions: Record<SubjectRole, SubjectPermission[]> = {
  owner: ['subject.manage', 'credits.read', 'credits.redeem', 'orders.read', 'orders.buy', 'orders.dispute.manage', 'provider.read', 'provider.profile.manage', 'provider.resource.manage', 'provider.offer.manage', 'provider.listing.manage', 'provider.order.manage', 'provider.refund.approve'],
  admin: ['subject.manage', 'credits.read', 'credits.redeem', 'orders.read', 'orders.buy', 'orders.dispute.manage', 'provider.read', 'provider.profile.manage', 'provider.resource.manage', 'provider.offer.manage', 'provider.listing.manage', 'provider.order.manage', 'provider.refund.approve'],
  provider_manager: ['orders.read', 'orders.dispute.manage', 'provider.read', 'provider.profile.manage', 'provider.resource.manage', 'provider.offer.manage', 'provider.listing.manage', 'provider.order.manage', 'provider.refund.approve'],
  provider_operator: ['orders.read', 'orders.dispute.manage', 'provider.read', 'provider.resource.manage', 'provider.offer.manage', 'provider.listing.manage', 'provider.order.manage'],
  viewer: ['orders.read', 'provider.read'],
};

export function permissionsFor(role: SubjectRole) {
  return [...rolePermissions[role]];
}

export interface SubjectAccess {
  current(userId: string, permission: SubjectPermission): Promise<SubjectContext>;
}
