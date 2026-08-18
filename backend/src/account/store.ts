import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type {
  AccountDeletion, AccountUser, ConsentInput, DeviceDescriptor, OtpPurpose, SessionIdentity,
} from './types.js';
import { deletionBlockersQuery, deletionLegalHoldReason } from './deletion-policy.js';

export type OtpConsumeResult = 'consumed' | 'invalid' | 'expired' | 'locked' | 'already_used';
export type RefreshRotationResult =
  | Readonly<{ status: 'rotated'; identity: SessionIdentity }>
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'reused' }>;
export type KaiConsentAttemptResult = Readonly<{ status: 'created' | 'replayed' | 'conflict' }>;

export interface AccountStore {
  countRecentOtp(destinationHash: string, since: Date): Promise<number>;
  createOtpChallenge(input: Readonly<{ id: string; destinationHash: string; purpose: OtpPurpose; codeHash: string; expiresAt: Date }>): Promise<void>;
  invalidateOtpChallenge(id: string): Promise<void>;
  consumeOtpChallenge(input: Readonly<{ id: string; destinationHash: string; purpose: OtpPurpose; codeHash: string; now: Date }>): Promise<OtpConsumeResult>;
  findUserByPhoneHash(phoneLookupHash: string): Promise<AccountUser | null>;
  findUserById(userId: string): Promise<AccountUser | null>;
  createUser(input: Readonly<{ phoneCiphertext: string; phoneLookupHash: string; displayName: string }>): Promise<AccountUser>;
  recordConsents(userId: string, consents: ConsentInput[], ipHash: string, userAgentHash: string): Promise<void>;
  recordKaiConsents?(input: Readonly<{
    userId: string;
    attemptId: string;
    payloadDigest: string;
    termsVersion: string;
    privacyVersion: string;
    requestId: string;
    ipHash: string;
    userAgentHash: string;
  }>): Promise<KaiConsentAttemptResult>;
  createSession(input: Readonly<{
    sessionId: string; tokenFamily: string; userId: string; refreshTokenId: string; refreshTokenHash: string;
    device: DeviceDescriptor; expiresAt: Date;
  }>): Promise<SessionIdentity>;
  rotateRefreshToken(input: Readonly<{
    currentTokenHash: string; nextTokenId: string; nextTokenHash: string; deviceId: string; expiresAt: Date; now: Date;
  }>): Promise<RefreshRotationResult>;
  getSession(sessionId: string): Promise<SessionIdentity | null>;
  listSessions(userId: string): Promise<Array<Readonly<{ id: string; device: DeviceDescriptor; lastSeenAt: Date; expiresAt: Date; current: boolean }>>>;
  revokeSession(userId: string, sessionId: string, reason: string): Promise<boolean>;
  getActiveDeletion(userId: string): Promise<AccountDeletion | null>;
  hasDeletionBlockers(userId: string): Promise<boolean>;
  requestDeletion(userId: string, reason: string | undefined, blocked: boolean): Promise<AccountDeletion>;
  cancelDeletion(userId: string): Promise<boolean>;
  recordAudit(input: Readonly<{
    actorId: string | null; actorKind: 'user' | 'operator' | 'system' | 'provider'; action: string; entityType: string; entityId: string;
    requestId: string; ipHash: string; payloadDigest: string; metadata?: Record<string, unknown>;
  }>): Promise<void>;
}

type UserRow = QueryResultRow & {
  user_id: string;
  phone_ciphertext: string | null;
  phone_lookup_hash: string | null;
  email_ciphertext: string | null;
  display_name: string;
  role: AccountUser['role'];
  user_status: AccountUser['status'];
  user_created_at: Date;
};

type SessionRow = UserRow & {
  session_id: string;
  token_family: string;
  device_id: string;
  app_version: string;
  platform: DeviceDescriptor['platform'];
  session_expires_at: Date;
  revoked_at: Date | null;
};

function mapUser(row: UserRow): AccountUser {
  return {
    id: row.user_id,
    phoneCiphertext: row.phone_ciphertext,
    phoneLookupHash: row.phone_lookup_hash,
    emailCiphertext: row.email_ciphertext,
    displayName: row.display_name,
    role: row.role,
    status: row.user_status,
    createdAt: new Date(row.user_created_at),
  };
}

function mapSession(row: SessionRow): SessionIdentity {
  return {
    sessionId: row.session_id,
    tokenFamily: row.token_family,
    user: mapUser(row),
    device: { deviceId: row.device_id, appVersion: row.app_version, platform: row.platform },
    expiresAt: new Date(row.session_expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

const sessionSelect = `
  SELECT s.id AS session_id, s.token_family, s.device_id, s.app_version, s.platform,
    s.expires_at AS session_expires_at, s.revoked_at,
    u.id AS user_id, u.phone_ciphertext, u.phone_lookup_hash, u.email_ciphertext, u.display_name,
    u.role, u.status AS user_status, u.created_at AS user_created_at
  FROM mobile_sessions s JOIN users u ON u.id = s.user_id`;

export class PostgresAccountStore implements AccountStore {
  constructor(private readonly database: Database) {}

  async countRecentOtp(destinationHash: string, since: Date) {
    const result = await this.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM otp_challenges WHERE destination_hash = $1 AND created_at >= $2',
      [destinationHash, since],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async createOtpChallenge(input: { id: string; destinationHash: string; purpose: OtpPurpose; codeHash: string; expiresAt: Date }) {
    await this.database.query(
      `INSERT INTO otp_challenges(id, destination_hash, purpose, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.id, input.destinationHash, input.purpose, input.codeHash, input.expiresAt],
    );
  }

  async invalidateOtpChallenge(id: string) {
    await this.database.query('UPDATE otp_challenges SET consumed_at = now(), attempts = 10 WHERE id = $1', [id]);
  }

  async consumeOtpChallenge(input: { id: string; destinationHash: string; purpose: OtpPurpose; codeHash: string; now: Date }): Promise<OtpConsumeResult> {
    return this.database.transaction(async (client) => {
      const current = await client.query<{
        destination_hash: string; purpose: OtpPurpose; code_hash: string; attempts: number; expires_at: Date; consumed_at: Date | null;
      }>('SELECT destination_hash, purpose, code_hash, attempts, expires_at, consumed_at FROM otp_challenges WHERE id = $1 FOR UPDATE', [input.id]);
      const challenge = current.rows[0];
      if (!challenge || challenge.destination_hash !== input.destinationHash || challenge.purpose !== input.purpose) return 'invalid';
      if (challenge.consumed_at) return 'already_used';
      if (challenge.attempts >= 5) return 'locked';
      if (new Date(challenge.expires_at) <= input.now) return 'expired';
      if (challenge.code_hash !== input.codeHash) {
        await client.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [input.id]);
        return challenge.attempts + 1 >= 5 ? 'locked' : 'invalid';
      }
      await client.query('UPDATE otp_challenges SET consumed_at = $2 WHERE id = $1', [input.id, input.now]);
      return 'consumed';
    });
  }

  async findUserByPhoneHash(phoneLookupHash: string) {
    const result = await this.database.query<UserRow>(
      `SELECT id AS user_id, phone_ciphertext, phone_lookup_hash, email_ciphertext, display_name, role,
        status AS user_status, created_at AS user_created_at
       FROM users WHERE phone_lookup_hash = $1 AND status <> 'anonymized'`,
      [phoneLookupHash],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async findUserById(userId: string) {
    const result = await this.database.query<UserRow>(
      `SELECT id AS user_id, phone_ciphertext, phone_lookup_hash, email_ciphertext, display_name, role,
        status AS user_status, created_at AS user_created_at
       FROM users WHERE id = $1`, [userId],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async createUser(input: { phoneCiphertext: string; phoneLookupHash: string; displayName: string }) {
    const id = randomUUID();
    try {
      const result = await this.database.query<UserRow>(
        `INSERT INTO users(id, phone_ciphertext, phone_lookup_hash, display_name, phone_verified_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING id AS user_id, phone_ciphertext, phone_lookup_hash, email_ciphertext, display_name, role,
           status AS user_status, created_at AS user_created_at`,
        [id, input.phoneCiphertext, input.phoneLookupHash, input.displayName],
      );
      return mapUser(result.rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      const existing = await this.findUserByPhoneHash(input.phoneLookupHash);
      if (!existing) throw error;
      return existing;
    }
  }

  async recordConsents(userId: string, consents: ConsentInput[], ipHash: string, userAgentHash: string) {
    await this.database.transaction(async (client) => {
      for (const consent of consents) {
        await client.query(
          `INSERT INTO legal_consents(id, user_id, document_kind, document_version, ip_hash, user_agent_hash)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [randomUUID(), userId, consent.kind, consent.version, ipHash, userAgentHash],
        );
      }
    });
  }

  async recordKaiConsents(
    input: Parameters<NonNullable<AccountStore['recordKaiConsents']>>[0],
  ): Promise<KaiConsentAttemptResult> {
    return this.database.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO kai_auth_consent_attempts(id, user_id, attempt_id, payload_digest)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, attempt_id) DO NOTHING
         RETURNING id`,
        [randomUUID(), input.userId, input.attemptId, input.payloadDigest],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<{ payload_digest: string }>(
          `SELECT payload_digest FROM kai_auth_consent_attempts
           WHERE user_id = $1 AND attempt_id = $2 FOR UPDATE`,
          [input.userId, input.attemptId],
        );
        return { status: existing.rows[0]?.payload_digest === input.payloadDigest ? 'replayed' : 'conflict' };
      }
      for (const [kind, version] of [['terms', input.termsVersion], ['privacy', input.privacyVersion]] as const) {
        await client.query(
          `INSERT INTO legal_consents(id, user_id, document_kind, document_version, ip_hash, user_agent_hash)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [randomUUID(), input.userId, kind, version, input.ipHash, input.userAgentHash],
        );
      }
      await client.query(
        `INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id,
           request_id, ip_hash, payload_digest, metadata)
         VALUES ($1, $2::uuid, 'user', 'KAI_DIRECT_LEGAL_CONSENT_ACCEPTED', 'USER', $2::text, $3, $4, $5,
           jsonb_build_object('termsVersion', $6::text, 'privacyVersion', $7::text))`,
        [randomUUID(), input.userId, input.requestId, input.ipHash, input.payloadDigest,
          input.termsVersion, input.privacyVersion],
      );
      return { status: 'created' };
    });
  }

  async createSession(input: {
    sessionId: string; tokenFamily: string; userId: string; refreshTokenId: string; refreshTokenHash: string;
    device: DeviceDescriptor; expiresAt: Date;
  }) {
    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO mobile_sessions(id, user_id, token_family, device_id, app_version, platform, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [input.sessionId, input.userId, input.tokenFamily, input.device.deviceId, input.device.appVersion, input.device.platform, input.expiresAt],
      );
      await client.query(
        `INSERT INTO session_refresh_tokens(id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
        [input.refreshTokenId, input.sessionId, input.refreshTokenHash, input.expiresAt],
      );
      const result = await client.query<SessionRow>(`${sessionSelect} WHERE s.id = $1`, [input.sessionId]);
      return mapSession(result.rows[0]!);
    });
  }

  async rotateRefreshToken(input: {
    currentTokenHash: string; nextTokenId: string; nextTokenHash: string; deviceId: string; expiresAt: Date; now: Date;
  }): Promise<RefreshRotationResult> {
    return this.database.transaction(async (client) => {
      const tokenResult = await client.query<{
        token_id: string; token_status: 'current' | 'used' | 'revoked'; token_expires_at: Date;
        session_id: string; token_family: string; device_id: string; session_expires_at: Date; revoked_at: Date | null;
      }>(`SELECT rt.id AS token_id, rt.status AS token_status, rt.expires_at AS token_expires_at,
          s.id AS session_id, s.token_family, s.device_id, s.expires_at AS session_expires_at, s.revoked_at
        FROM session_refresh_tokens rt JOIN mobile_sessions s ON s.id = rt.session_id
        WHERE rt.token_hash = $1 FOR UPDATE OF rt, s`, [input.currentTokenHash]);
      const token = tokenResult.rows[0];
      if (!token) return { status: 'invalid' };
      if (token.token_status !== 'current') {
        await this.revokeFamily(client, token.token_family, 'refresh_token_reuse', input.now);
        return { status: 'reused' };
      }
      if (token.revoked_at || token.device_id !== input.deviceId || new Date(token.token_expires_at) <= input.now || new Date(token.session_expires_at) <= input.now) {
        return { status: 'invalid' };
      }
      // Retire the locked token before creating its replacement. The database
      // permits exactly one `current` refresh token per session, so inserting
      // first would make every legitimate first rotation fail with 23505.
      // These statements stay in one transaction: a failed replacement insert
      // rolls this update back and never strands the session without a token.
      await client.query(
        `UPDATE session_refresh_tokens SET status = 'used', used_at = $2 WHERE id = $1`,
        [token.token_id, input.now],
      );
      await client.query(
        `INSERT INTO session_refresh_tokens(id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
        [input.nextTokenId, token.session_id, input.nextTokenHash, input.expiresAt],
      );
      await client.query(
        `UPDATE session_refresh_tokens SET replaced_by_id = $2 WHERE id = $1`,
        [token.token_id, input.nextTokenId],
      );
      await client.query('UPDATE mobile_sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1', [token.session_id, input.now, input.expiresAt]);
      const result = await client.query<SessionRow>(`${sessionSelect} WHERE s.id = $1`, [token.session_id]);
      return { status: 'rotated', identity: mapSession(result.rows[0]!) };
    });
  }

  private async revokeFamily(client: PoolClient, tokenFamily: string, reason: string, now: Date) {
    await client.query(
      `UPDATE mobile_sessions SET revoked_at = COALESCE(revoked_at, $2), revocation_reason = $3 WHERE token_family = $1`,
      [tokenFamily, now, reason],
    );
    await client.query(
      `UPDATE session_refresh_tokens SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2)
       WHERE session_id IN (SELECT id FROM mobile_sessions WHERE token_family = $1) AND status = 'current'`,
      [tokenFamily, now],
    );
  }

  async getSession(sessionId: string) {
    const result = await this.database.query<SessionRow>(`${sessionSelect} WHERE s.id = $1`, [sessionId]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async listSessions(userId: string) {
    const result = await this.database.query<{
      id: string; device_id: string; app_version: string; platform: DeviceDescriptor['platform']; last_seen_at: Date; expires_at: Date;
    }>(`SELECT id, device_id, app_version, platform, last_seen_at, expires_at FROM mobile_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [userId]);
    return result.rows.map((row) => ({
      id: row.id,
      device: { deviceId: row.device_id, appVersion: row.app_version, platform: row.platform },
      lastSeenAt: new Date(row.last_seen_at),
      expiresAt: new Date(row.expires_at),
      current: false,
    }));
  }

  async revokeSession(userId: string, sessionId: string, reason: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE mobile_sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = $3
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
        [sessionId, userId, reason],
      );
      if (!result.rowCount) return false;
      await client.query(
        `UPDATE session_refresh_tokens SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
         WHERE session_id = $1 AND status = 'current'`, [sessionId],
      );
      return true;
    });
  }

  async getActiveDeletion(userId: string) {
    const result = await this.database.query<{
      id: string; status: AccountDeletion['status']; cooling_off_until: Date; requested_at: Date; legal_hold_reason: string | null;
    }>(`SELECT id, status, cooling_off_until, requested_at, legal_hold_reason FROM account_deletion_requests
       WHERE user_id = $1 AND status IN ('requested', 'cooling_off', 'blocked_by_legal_hold', 'processing')
       ORDER BY requested_at DESC LIMIT 1`, [userId]);
    const row = result.rows[0];
    return row ? {
      id: row.id, status: row.status, coolingOffUntil: new Date(row.cooling_off_until),
      requestedAt: new Date(row.requested_at), legalHoldReason: row.legal_hold_reason,
    } : null;
  }

  async hasDeletionBlockers(userId: string) {
    const result = await this.database.query<{ blocked: boolean }>(
      deletionBlockersQuery, [userId],
    );
    return result.rows[0]?.blocked === true;
  }

  async requestDeletion(userId: string, reason: string | undefined, blocked: boolean) {
    const existing = await this.getActiveDeletion(userId);
    if (existing) return existing;
    const id = randomUUID();
    const status: AccountDeletion['status'] = blocked ? 'blocked_by_legal_hold' : 'cooling_off';
    const legalHoldReason = blocked ? deletionLegalHoldReason : null;
    const result = await this.database.transaction(async (client) => {
      const created = await client.query<{
        id: string; status: AccountDeletion['status']; cooling_off_until: Date; requested_at: Date; legal_hold_reason: string | null;
      }>(`INSERT INTO account_deletion_requests(id, user_id, status, reason, cooling_off_until, legal_hold_reason)
         VALUES ($1, $2, $3, $4, now() + interval '7 days', $5)
         RETURNING id, status, cooling_off_until, requested_at, legal_hold_reason`,
      [id, userId, status, reason ?? null, legalHoldReason]);
      await client.query(`UPDATE users SET status = 'deletion_pending' WHERE id = $1`, [userId]);
      return created.rows[0]!;
    });
    return {
      id: result.id, status: result.status, coolingOffUntil: new Date(result.cooling_off_until),
      requestedAt: new Date(result.requested_at), legalHoldReason: result.legal_hold_reason,
    };
  }

  async cancelDeletion(userId: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE account_deletion_requests SET status = 'cancelled', cancelled_at = now()
         WHERE user_id = $1 AND status IN ('requested', 'cooling_off', 'blocked_by_legal_hold') RETURNING id`, [userId],
      );
      if (!result.rowCount) return false;
      await client.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'deletion_pending'`, [userId]);
      return true;
    });
  }

  async recordAudit(input: {
    actorId: string | null; actorKind: 'user' | 'system'; action: string; entityType: string; entityId: string;
    requestId: string; ipHash: string; payloadDigest: string; metadata?: Record<string, unknown>;
  }) {
    await this.database.query(
      `INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id,
        request_id, ip_hash, payload_digest, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [randomUUID(), input.actorId, input.actorKind, input.action, input.entityType, input.entityId,
        input.requestId, input.ipHash, input.payloadDigest, JSON.stringify(input.metadata ?? {})],
    );
  }
}
