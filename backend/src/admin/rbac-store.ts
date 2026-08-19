import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { isAdminRoleCode, type AdminRoleCode } from './permissions.js';
import type { AdminRoleAssignment, AdminRoleAssignmentSource, AdminRoleAssignmentStatus } from './types.js';

type RoleRow = QueryResultRow & {
  id: string; admin_identity_id: string; role_code: string; source: AdminRoleAssignmentSource;
  source_reference_digest: string | null; status: AdminRoleAssignmentStatus; valid_from: Date;
  expires_at: Date | null; granted_by_admin_id: string | null; grant_reason_code: string | null;
  ticket_reference: string | null; created_at: Date; revoked_at: Date | null;
  revoked_by_admin_id: string | null; revocation_reason_code: string | null;
};
const columns = `id, admin_identity_id, role_code, source, source_reference_digest, status,
 valid_from, expires_at, granted_by_admin_id, grant_reason_code, ticket_reference, created_at,
 revoked_at, revoked_by_admin_id, revocation_reason_code`;
function requireRole(value: string): AdminRoleCode {
  if (!isAdminRoleCode(value)) throw new Error('ADMIN_ROLE_UNKNOWN');
  return value;
}
function map(row: RoleRow): AdminRoleAssignment {
  return { id: row.id, adminIdentityId: row.admin_identity_id, roleCode: requireRole(row.role_code),
    source: row.source, sourceReferenceDigest: row.source_reference_digest, status: row.status,
    validFrom: row.valid_from, expiresAt: row.expires_at, grantedByAdminId: row.granted_by_admin_id,
    grantReasonCode: row.grant_reason_code, ticketReference: row.ticket_reference,
    createdAt: row.created_at, revokedAt: row.revoked_at, revokedByAdminId: row.revoked_by_admin_id,
    revocationReasonCode: row.revocation_reason_code };
}
function roleSet(rows: readonly RoleRow[]): Set<AdminRoleCode> {
  return new Set(rows.map((row) => requireRole(row.role_code)));
}
function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
function assignmentKey(roleCode: AdminRoleCode, digest: string | null): string {
  return `${roleCode}\u0000${digest ?? ''}`;
}
async function activeRows(client: Pick<PoolClient, 'query'>, identityId: string, now: Date) {
  const result = await client.query<RoleRow>(
    `SELECT ${columns} FROM admin_role_assignments
     WHERE admin_identity_id = $1 AND status = 'active' AND valid_from <= $2
       AND (expires_at IS NULL OR expires_at > $2) ORDER BY role_code, created_at`,
    [identityId, now],
  );
  return result.rows;
}

export type OidcAdminRole = Readonly<{
  roleCode: string;
  sourceReferenceDigest: string | null;
  expiresAt: Date | null;
}>;
export interface AdminRbacStore {
  activeAssignments(adminIdentityId: string, now: Date): Promise<readonly AdminRoleAssignment[]>;
  activeRoles(adminIdentityId: string, now: Date): Promise<readonly AdminRoleCode[]>;
  syncOidcRoles(input: Readonly<{
    adminIdentityId: string; roles: readonly OidcAdminRole[]; groupSnapshotDigest: string;
    now: Date;
  }>): Promise<Readonly<{
    changed: boolean; authzVersion: number; roles: readonly AdminRoleCode[]; revokedSessionCount: number;
  }>>;
}

export class PostgresAdminRbacStore implements AdminRbacStore {
  constructor(private readonly database: Database) {}
  async activeAssignments(adminIdentityId: string, now: Date) {
    const result = await this.database.query<RoleRow>(
      `SELECT ${columns} FROM admin_role_assignments
       WHERE admin_identity_id = $1 AND status = 'active' AND valid_from <= $2
         AND (expires_at IS NULL OR expires_at > $2) ORDER BY role_code, created_at`,
      [adminIdentityId, now],
    );
    return result.rows.map(map);
  }
  async activeRoles(adminIdentityId: string, now: Date) {
    const assignments = await this.activeAssignments(adminIdentityId, now);
    return Object.freeze([...new Set(assignments.map((item) => item.roleCode))].sort());
  }
  async syncOidcRoles(input: Parameters<AdminRbacStore['syncOidcRoles']>[0]) {
    const desired = input.roles.map((role) => ({ ...role, roleCode: requireRole(role.roleCode) }));
    const desiredKeys = new Set<string>();
    for (const role of desired) {
      const key = assignmentKey(role.roleCode, role.sourceReferenceDigest);
      if (desiredKeys.has(key)) throw new Error('ADMIN_OIDC_ROLE_DUPLICATE');
      if (role.expiresAt && role.expiresAt <= input.now) throw new Error('ADMIN_OIDC_ROLE_ALREADY_EXPIRED');
      desiredKeys.add(key);
    }
    return this.database.transaction(async (client) => {
      const identity = await client.query<{
        authz_version: string | number; group_snapshot_digest: string | null; status: 'pending' | 'active';
      }>(
        `SELECT authz_version, group_snapshot_digest, status FROM admin_identities
         WHERE id = $1 AND status IN ('pending','active') FOR UPDATE`, [input.adminIdentityId],
      );
      const lockedIdentity = identity.rows[0];
      if (!lockedIdentity) throw new Error('ADMIN_IDENTITY_NOT_ADMISSIBLE');
      if (lockedIdentity.status === 'pending' && desired.length === 0) {
        throw new Error('ADMIN_IDENTITY_ADMISSION_ROLE_REQUIRED');
      }
      const before = await activeRows(client, input.adminIdentityId, input.now);
      const expired = await client.query(
        `UPDATE admin_role_assignments SET status = 'expired'
         WHERE admin_identity_id = $1 AND status = 'active' AND expires_at <= $2`,
        [input.adminIdentityId, input.now],
      );
      const oidc = await client.query<RoleRow>(
        `SELECT ${columns} FROM admin_role_assignments
         WHERE admin_identity_id = $1 AND source = 'oidc' AND status = 'active' FOR UPDATE`,
        [input.adminIdentityId],
      );
      let assignmentChanged = (expired.rowCount ?? 0) > 0;
      for (const row of oidc.rows) {
        if (!desiredKeys.has(assignmentKey(requireRole(row.role_code), row.source_reference_digest))) {
          await client.query(
            `UPDATE admin_role_assignments SET status = 'revoked', revoked_at = $2,
             revocation_reason_code = 'OIDC_ROLE_REMOVED' WHERE id = $1`, [row.id,input.now],
          );
          assignmentChanged = true;
        }
      }
      const currentKeys = new Set(oidc.rows.map((row) =>
        assignmentKey(requireRole(row.role_code), row.source_reference_digest)));
      for (const role of desired) {
        const key = assignmentKey(role.roleCode, role.sourceReferenceDigest);
        if (currentKeys.has(key)) {
          const updated = await client.query(
            `UPDATE admin_role_assignments SET expires_at = $2 WHERE admin_identity_id = $1
             AND role_code = $3 AND source = 'oidc'
             AND COALESCE(source_reference_digest,'') = COALESCE($4,'') AND status = 'active'
             AND expires_at IS DISTINCT FROM $2`,
            [input.adminIdentityId,role.expiresAt,role.roleCode,role.sourceReferenceDigest],
          );
          assignmentChanged ||= (updated.rowCount ?? 0) > 0;
        } else {
          await client.query(
            `INSERT INTO admin_role_assignments(id,admin_identity_id,role_code,source,
             source_reference_digest,status,valid_from,expires_at,created_at)
             VALUES ($1,$2,$3,'oidc',$4,'active',$5,$6,$5)`,
            [randomUUID(),input.adminIdentityId,role.roleCode,role.sourceReferenceDigest,input.now,role.expiresAt],
          );
          assignmentChanged = true;
        }
      }
      const after = await activeRows(client, input.adminIdentityId, input.now);
      const beforeRoles = roleSet(before);
      const afterRoles = roleSet(after);
      const changed = assignmentChanged || !sameSet(beforeRoles, afterRoles);
      const admitted = lockedIdentity.status === 'pending';
      const authzChanged = admitted || changed;
      const authzVersion = Number(lockedIdentity.authz_version) + (authzChanged ? 1 : 0);
      await client.query(
        `UPDATE admin_identities SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
         group_snapshot_digest = $2, last_group_synced_at = $3, authz_version = $4 WHERE id = $1`,
        [input.adminIdentityId,input.groupSnapshotDigest,input.now,authzVersion],
      );
      let revokedSessionCount = 0;
      if (authzChanged) {
        const revoked = await client.query(
          `UPDATE admin_sessions SET status = 'revoked', revoked_at = $2,
           revocation_reason_code = 'ADMIN_AUTHZ_CHANGED'
           WHERE admin_identity_id = $1 AND status = 'active'`, [input.adminIdentityId,input.now],
        );
        revokedSessionCount = revoked.rowCount ?? 0;
      }
      return { changed: authzChanged, authzVersion, roles: Object.freeze([...afterRoles].sort()), revokedSessionCount };
    });
  }
}
