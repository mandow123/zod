import type { AdminPermission, AdminRoleCode } from './permissions.js';

export type AdminIdentityStatus = 'pending' | 'active' | 'suspended' | 'offboarded';
export type AdminRoleAssignmentSource = 'oidc' | 'manual';
export type AdminRoleAssignmentStatus = 'active' | 'revoked' | 'expired';
export type AdminSessionStatus = 'active' | 'revoked' | 'expired';
export type AdminLoginTransactionStatus = 'started' | 'consumed' | 'failed' | 'expired';
export type AdminAuditOutcome = 'succeeded' | 'denied' | 'failed';

export type AdminIdentity = Readonly<{
  id: string;
  issuer: string;
  subjectHash: string;
  linkedUserId: string | null;
  displayName: string;
  emailCiphertext: string | null;
  emailLookupHash: string | null;
  status: AdminIdentityStatus;
  authzVersion: number;
  groupSnapshotDigest: string | null;
  lastAuthenticatedAt: Date | null;
  lastGroupSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
  disabledReasonCode: string | null;
}>;

export type AdminRoleAssignment = Readonly<{
  id: string;
  adminIdentityId: string;
  roleCode: AdminRoleCode;
  source: AdminRoleAssignmentSource;
  sourceReferenceDigest: string | null;
  status: AdminRoleAssignmentStatus;
  validFrom: Date;
  expiresAt: Date | null;
  grantedByAdminId: string | null;
  grantReasonCode: string | null;
  ticketReference: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  revokedByAdminId: string | null;
  revocationReasonCode: string | null;
}>;

export type AdminSession = Readonly<{
  id: string;
  adminIdentityId: string;
  tokenHash: string;
  previousTokenHash: string | null;
  previousTokenValidUntil: Date | null;
  csrfTokenHash: string;
  status: AdminSessionStatus;
  authzVersionAtIssue: number;
  permissionDefinitionVersion: string;
  permissionSnapshotDigest: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  rotatedAt: Date | null;
  reauthenticatedAt: Date | null;
  revokedAt: Date | null;
  revocationReasonCode: string | null;
  createdIpHash: string;
  lastIpHash: string;
  userAgentHash: string;
}>;

export type AdminLoginTransaction = Readonly<{
  id: string;
  stateHash: string;
  browserBindingHash: string;
  nonceHash: string;
  pkceVerifierCiphertext: string;
  returnPath: string;
  status: AdminLoginTransactionStatus;
  expiresAt: Date;
  consumedAt: Date | null;
  createdIpHash: string;
  userAgentHash: string;
  failureCode: string | null;
  createdAt: Date;
}>;

export type AdminAuditMetadata = Readonly<{
  roleCodes?: readonly AdminRoleCode[];
  revokedSessionCount?: number;
  status?: string;
  failureCode?: string;
  source?: AdminRoleAssignmentSource | 'system';
  changed?: boolean;
}>;

export type AdminAuditEvent = Readonly<{
  id: string;
  occurredAt: Date;
  adminIdentityId: string | null;
  adminSessionId: string | null;
  effectivePermissions: readonly AdminPermission[];
  permissionSnapshotDigest: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string;
  ticketReference: string | null;
  reasonCode: string | null;
  reasonDigest: string | null;
  idempotencyKeyHash: string | null;
  beforeStateDigest: string | null;
  afterStateDigest: string | null;
  ipHash: string | null;
  userAgentHash: string | null;
  outcome: AdminAuditOutcome;
  errorCode: string | null;
  sensitiveAccess: boolean;
  metadata: AdminAuditMetadata;
}>;
