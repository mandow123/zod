import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { AdminSession, AdminSessionStatus } from './types.js';

type SessionRow = QueryResultRow & {
  id: string; admin_identity_id: string; token_hash: string; previous_token_hash: string | null;
  previous_token_valid_until: Date | null; csrf_token_hash: string; status: AdminSessionStatus;
  authz_version_at_issue: string | number; permission_definition_version: string;
  permission_snapshot_digest: string; created_at: Date; last_seen_at: Date; idle_expires_at: Date;
  absolute_expires_at: Date; rotated_at: Date | null; reauthenticated_at: Date | null;
  revoked_at: Date | null; revocation_reason_code: string | null; created_ip_hash: string;
  last_ip_hash: string; user_agent_hash: string;
};
const columns = `id, admin_identity_id, token_hash, previous_token_hash, previous_token_valid_until,
 csrf_token_hash, status, authz_version_at_issue, permission_definition_version,
 permission_snapshot_digest, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
 rotated_at, reauthenticated_at, revoked_at, revocation_reason_code, created_ip_hash,
 last_ip_hash, user_agent_hash`;
const selectedSessionColumns = columns.split(',').map((column) => `s.${column.trim()}`).join(', ');
function map(row: SessionRow): AdminSession {
  return { id: row.id, adminIdentityId: row.admin_identity_id, tokenHash: row.token_hash,
    previousTokenHash: row.previous_token_hash, previousTokenValidUntil: row.previous_token_valid_until,
    csrfTokenHash: row.csrf_token_hash, status: row.status, authzVersionAtIssue: Number(row.authz_version_at_issue),
    permissionDefinitionVersion: row.permission_definition_version,
    permissionSnapshotDigest: row.permission_snapshot_digest, createdAt: row.created_at,
    lastSeenAt: row.last_seen_at, idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at, rotatedAt: row.rotated_at,
    reauthenticatedAt: row.reauthenticated_at, revokedAt: row.revoked_at,
    revocationReasonCode: row.revocation_reason_code, createdIpHash: row.created_ip_hash,
    lastIpHash: row.last_ip_hash, userAgentHash: row.user_agent_hash };
}

function rethrowStableTokenCollision(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
    throw new Error('ADMIN_SESSION_TOKEN_COLLISION');
  }
  throw error;
}

type CreateSessionInput = Readonly<Omit<AdminSession,
  'previousTokenHash' | 'previousTokenValidUntil' | 'status' | 'rotatedAt' | 'revokedAt' | 'revocationReasonCode'>>;
export type AdminSessionRotationPolicy = Readonly<{ previousTokenGraceMs: number }>;
export const DEFAULT_ADMIN_SESSION_ROTATION_POLICY: AdminSessionRotationPolicy = Object.freeze({
  previousTokenGraceMs: 30_000,
});
const MAX_PREVIOUS_TOKEN_GRACE_MS = 30_000;
export interface AdminSessionStore {
  // This is a persistence-time gate only. The future HTTP authorization layer must recompute
  // currently effective roles and permissions on every request because time-based role expiry
  // does not itself increment authz_version.
  create(input: CreateSessionInput): Promise<AdminSession>;
  findActiveByTokenHash(tokenHash: string, now: Date): Promise<AdminSession | null>;
  updateActivity(input: Readonly<{ sessionId: string; lastSeenAt: Date; idleExpiresAt: Date; lastIpHash: string }>): Promise<AdminSession | null>;
  rotate(input: Readonly<{ sessionId: string; currentTokenHash: string; nextTokenHash: string;
    nextCsrfTokenHash: string; lastSeenAt: Date;
    idleExpiresAt: Date; rotatedAt: Date; lastIpHash: string }>): Promise<AdminSession | null>;
  revoke(input: Readonly<{ sessionId: string; adminIdentityId: string; reasonCode: string; now: Date }>): Promise<boolean>;
  revokeAll(input: Readonly<{ adminIdentityId: string; reasonCode: string; now: Date }>): Promise<number>;
  cleanupExpiredTokenHashes(now: Date): Promise<number>;
}

export class PostgresAdminSessionStore implements AdminSessionStore {
  private readonly rotationPolicy: AdminSessionRotationPolicy;
  constructor(private readonly database: Database, rotationPolicy: AdminSessionRotationPolicy = DEFAULT_ADMIN_SESSION_ROTATION_POLICY) {
    if (!Number.isSafeInteger(rotationPolicy.previousTokenGraceMs)
        || rotationPolicy.previousTokenGraceMs <= 0
        || rotationPolicy.previousTokenGraceMs > MAX_PREVIOUS_TOKEN_GRACE_MS) {
      throw new Error('ADMIN_SESSION_ROTATION_GRACE_INVALID');
    }
    this.rotationPolicy = Object.freeze({ ...rotationPolicy });
  }
  async create(input: CreateSessionInput) {
    let result;
    try {
      result = await this.database.query<SessionRow>(
      `INSERT INTO admin_sessions(${columns})
       SELECT $1,$2,$3,NULL,NULL,$4,'active',$5,$6,$7,$8,$9,$10,$11,NULL,$12,NULL,NULL,$13,$14,$15
       FROM admin_identities WHERE id = $2 AND status = 'active' AND authz_version = $5
       AND EXISTS (SELECT 1 FROM admin_role_assignments r WHERE r.admin_identity_id = $2
         AND r.status = 'active' AND r.valid_from <= $8 AND (r.expires_at IS NULL OR r.expires_at > $8))
       AND NOT EXISTS (SELECT 1 FROM admin_sessions existing WHERE existing.previous_token_hash = $3)
       RETURNING ${columns}`,
      [input.id,input.adminIdentityId,input.tokenHash,input.csrfTokenHash,input.authzVersionAtIssue,
        input.permissionDefinitionVersion,input.permissionSnapshotDigest,input.createdAt,input.lastSeenAt,
        input.idleExpiresAt,input.absoluteExpiresAt,input.reauthenticatedAt,input.createdIpHash,input.lastIpHash,
        input.userAgentHash],
      );
    } catch (error) {
      rethrowStableTokenCollision(error);
    }
    if (!result.rows[0]) throw new Error('ADMIN_IDENTITY_AUTHZ_NOT_ACTIVE');
    return map(result.rows[0]);
  }
  async findActiveByTokenHash(tokenHash: string, now: Date) {
    const result = await this.database.query<SessionRow>(
      `SELECT ${selectedSessionColumns} FROM admin_sessions s
       JOIN admin_identities i ON i.id = s.admin_identity_id
       WHERE s.status = 'active' AND i.status = 'active' AND i.authz_version = s.authz_version_at_issue
       AND idle_expires_at > $2 AND absolute_expires_at > $2
       AND (token_hash = $1 OR (previous_token_hash = $1 AND previous_token_valid_until > $2))
       LIMIT 1`, [tokenHash, now],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async updateActivity(input: Parameters<AdminSessionStore['updateActivity']>[0]) {
    const result = await this.database.query<SessionRow>(
      `UPDATE admin_sessions SET
         last_ip_hash = CASE WHEN $2 >= last_seen_at THEN $4 ELSE last_ip_hash END,
         last_seen_at = GREATEST(last_seen_at, $2),
         idle_expires_at = LEAST(absolute_expires_at, GREATEST(idle_expires_at, $3))
       WHERE id = $1 AND status = 'active' AND idle_expires_at > $2 AND absolute_expires_at > $2
       AND EXISTS (SELECT 1 FROM admin_identities i WHERE i.id = admin_sessions.admin_identity_id
         AND i.status = 'active' AND i.authz_version = admin_sessions.authz_version_at_issue)
       RETURNING ${columns}`,
      [input.sessionId,input.lastSeenAt,input.idleExpiresAt,input.lastIpHash],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async rotate(input: Parameters<AdminSessionStore['rotate']>[0]) {
    if (input.currentTokenHash === input.nextTokenHash) throw new Error('ADMIN_SESSION_ROTATION_TOKEN_REUSED');
    try {
      return await this.database.transaction(async (client) => {
      const found = await client.query<SessionRow>(
        `SELECT ${columns} FROM admin_sessions WHERE id = $1 AND token_hash = $2 FOR UPDATE`,
        [input.sessionId,input.currentTokenHash],
      );
      const current = found.rows[0];
      if (!current || current.status !== 'active' || new Date(current.idle_expires_at) <= input.rotatedAt ||
          new Date(current.absolute_expires_at) <= input.rotatedAt) return null;
      if (current.previous_token_valid_until
        && new Date(current.previous_token_valid_until) > input.rotatedAt) {
        throw new Error('ADMIN_SESSION_ROTATION_GRACE_ACTIVE');
      }
      const collision = await client.query(
        `SELECT 1 FROM admin_sessions WHERE id <> $1 AND
         (token_hash IN ($2,$3) OR previous_token_hash IN ($2,$3)) LIMIT 1`,
        [input.sessionId,input.currentTokenHash,input.nextTokenHash],
      );
      if (collision.rows[0]) throw new Error('ADMIN_SESSION_ROTATION_TOKEN_COLLISION');
      const absoluteExpiresAt = new Date(current.absolute_expires_at);
      const policyGraceEnd = new Date(input.rotatedAt.getTime() + this.rotationPolicy.previousTokenGraceMs);
      const previousTokenValidUntil = policyGraceEnd < absoluteExpiresAt ? policyGraceEnd : absoluteExpiresAt;
      const result = await client.query<SessionRow>(
        `UPDATE admin_sessions SET previous_token_hash = token_hash, previous_token_valid_until = $3,
           token_hash = $4, csrf_token_hash = $5,
           last_ip_hash = CASE WHEN $6 >= last_seen_at THEN $9 ELSE last_ip_hash END,
           last_seen_at = GREATEST(last_seen_at, $6),
           idle_expires_at = LEAST(absolute_expires_at, GREATEST(idle_expires_at, $7)),
           rotated_at = $8 WHERE id = $1 AND token_hash = $2 AND status = 'active'
           AND EXISTS (SELECT 1 FROM admin_identities i WHERE i.id = admin_sessions.admin_identity_id
             AND i.status = 'active' AND i.authz_version = admin_sessions.authz_version_at_issue)
           RETURNING ${columns}`,
        [input.sessionId,input.currentTokenHash,previousTokenValidUntil,input.nextTokenHash,
          input.nextCsrfTokenHash,input.lastSeenAt,input.idleExpiresAt,input.rotatedAt,input.lastIpHash],
      );
      return result.rows[0] ? map(result.rows[0]) : null;
      });
    } catch (error) {
      rethrowStableTokenCollision(error);
    }
  }
  async revokeAll(input: Parameters<AdminSessionStore['revokeAll']>[0]) {
    const result = await this.database.query(
      `UPDATE admin_sessions SET status = 'revoked', revoked_at = $2, revocation_reason_code = $3
       WHERE admin_identity_id = $1 AND status = 'active'`,
      [input.adminIdentityId,input.now,input.reasonCode],
    );
    return result.rowCount ?? 0;
  }
  async revoke(input: Parameters<AdminSessionStore['revoke']>[0]) {
    const result = await this.database.query(
      `UPDATE admin_sessions SET status = 'revoked', revoked_at = $3, revocation_reason_code = $4
       WHERE id = $1 AND admin_identity_id = $2 AND status = 'active'`,
      [input.sessionId,input.adminIdentityId,input.now,input.reasonCode],
    );
    return (result.rowCount ?? 0) === 1;
  }
  async cleanupExpiredTokenHashes(now: Date) {
    if (!Number.isFinite(now.getTime())) throw new Error('ADMIN_SESSION_CLEANUP_TIME_INVALID');
    const result = await this.database.query(
      'DELETE FROM admin_session_token_hashes WHERE valid_until <= $1', [now],
    );
    return result.rowCount ?? 0;
  }
}
