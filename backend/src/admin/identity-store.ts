import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { AdminIdentity, AdminIdentityStatus } from './types.js';

type IdentityRow = QueryResultRow & {
  id: string; issuer: string; subject_hash: string; linked_user_id: string | null;
  display_name: string; email_ciphertext: string | null; email_lookup_hash: string | null;
  status: AdminIdentityStatus; authz_version: string | number; group_snapshot_digest: string | null;
  last_authenticated_at: Date | null; last_group_synced_at: Date | null;
  created_at: Date; updated_at: Date; disabled_at: Date | null; disabled_reason_code: string | null;
};

const identityColumns = `id, issuer, subject_hash, linked_user_id, display_name, email_ciphertext,
  email_lookup_hash, status, authz_version, group_snapshot_digest, last_authenticated_at,
  last_group_synced_at, created_at, updated_at, disabled_at, disabled_reason_code`;

function mapIdentity(row: IdentityRow): AdminIdentity {
  return {
    id: row.id, issuer: row.issuer, subjectHash: row.subject_hash, linkedUserId: row.linked_user_id,
    displayName: row.display_name, emailCiphertext: row.email_ciphertext,
    emailLookupHash: row.email_lookup_hash, status: row.status, authzVersion: Number(row.authz_version),
    groupSnapshotDigest: row.group_snapshot_digest, lastAuthenticatedAt: row.last_authenticated_at,
    lastGroupSyncedAt: row.last_group_synced_at, createdAt: row.created_at, updatedAt: row.updated_at,
    disabledAt: row.disabled_at, disabledReasonCode: row.disabled_reason_code,
  };
}

export interface AdminIdentityStore {
  createOrGet(input: Readonly<{
    id: string; issuer: string; subjectHash: string; linkedUserId: string | null;
    displayName: string; emailCiphertext: string | null; emailLookupHash: string | null; now: Date;
  }>): Promise<Readonly<{ identity: AdminIdentity; created: boolean }>>;
  findById(id: string): Promise<AdminIdentity | null>;
  disableAndRevokeSessions(input: Readonly<{
    adminIdentityId: string; status: 'suspended' | 'offboarded'; reasonCode: string; now: Date;
  }>): Promise<Readonly<{ identity: AdminIdentity; revokedSessionCount: number }>>;
}

async function selectIdentity(client: Pick<PoolClient, 'query'>, id: string, lock = false) {
  const result = await client.query<IdentityRow>(
    `SELECT ${identityColumns} FROM admin_identities WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id],
  );
  return result.rows[0] ? mapIdentity(result.rows[0]) : null;
}

export class PostgresAdminIdentityStore implements AdminIdentityStore {
  constructor(private readonly database: Database) {}

  async createOrGet(input: Parameters<AdminIdentityStore['createOrGet']>[0]) {
    return this.database.transaction(async (client) => {
      const inserted = await client.query<IdentityRow>(
        `INSERT INTO admin_identities(id, issuer, subject_hash, linked_user_id, display_name,
           email_ciphertext, email_lookup_hash, last_authenticated_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8)
         ON CONFLICT (issuer, subject_hash) DO NOTHING
         RETURNING ${identityColumns}`,
        [input.id, input.issuer, input.subjectHash, input.linkedUserId, input.displayName,
          input.emailCiphertext, input.emailLookupHash, input.now],
      );
      if (inserted.rows[0]) return { identity: mapIdentity(inserted.rows[0]), created: true };
      const existing = await client.query<IdentityRow>(
        `UPDATE admin_identities SET display_name = $3, email_ciphertext = $4,
           email_lookup_hash = $5, last_authenticated_at = $6
         WHERE issuer = $1 AND subject_hash = $2 AND status IN ('pending','active')
         RETURNING ${identityColumns}`,
        [input.issuer, input.subjectHash, input.displayName, input.emailCiphertext,
          input.emailLookupHash, input.now],
      );
      if (existing.rows[0]) return { identity: mapIdentity(existing.rows[0]), created: false };
      const disabled = await client.query<IdentityRow>(
        `SELECT ${identityColumns} FROM admin_identities
         WHERE issuer = $1 AND subject_hash = $2 FOR UPDATE`,
        [input.issuer, input.subjectHash],
      );
      if (!disabled.rows[0]) throw new Error('ADMIN_IDENTITY_CONFLICT_NOT_FOUND');
      return { identity: mapIdentity(disabled.rows[0]), created: false };
    });
  }

  async findById(id: string) {
    const result = await this.database.query<IdentityRow>(
      `SELECT ${identityColumns} FROM admin_identities WHERE id = $1`, [id],
    );
    return result.rows[0] ? mapIdentity(result.rows[0]) : null;
  }

  async disableAndRevokeSessions(input: Parameters<AdminIdentityStore['disableAndRevokeSessions']>[0]) {
    return this.database.transaction(async (client) => {
      const current = await selectIdentity(client, input.adminIdentityId, true);
      if (!current) throw new Error('ADMIN_IDENTITY_NOT_FOUND');
      if (current.status === 'offboarded' && input.status !== 'offboarded') {
        throw new Error('ADMIN_IDENTITY_OFFBOARDED_TERMINAL');
      }
      if (current.status === input.status && current.disabledReasonCode === input.reasonCode) {
        return { identity: current, revokedSessionCount: 0 };
      }
      const updated = await client.query<IdentityRow>(
        `UPDATE admin_identities SET status = $2, disabled_at = $3, disabled_reason_code = $4,
           authz_version = authz_version + 1 WHERE id = $1 RETURNING ${identityColumns}`,
        [input.adminIdentityId, input.status, input.now, input.reasonCode],
      );
      const sessions = await client.query(
        `UPDATE admin_sessions SET status = 'revoked', revoked_at = $2,
           revocation_reason_code = 'ADMIN_IDENTITY_DISABLED'
         WHERE admin_identity_id = $1 AND status = 'active'`,
        [input.adminIdentityId, input.now],
      );
      return { identity: mapIdentity(updated.rows[0]!), revokedSessionCount: sessions.rowCount ?? 0 };
    });
  }
}
