import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { LEGAL_VERSIONS, type AccountUser } from './types.js';

export type KaiOidcTransaction = Readonly<{
  id: string;
  nonceHash: string;
  pkceVerifierCiphertext: string;
  appRedirectUri: string;
  appCodeChallenge: string;
  termsVersion: string;
  privacyVersion: string;
}>;

export type KaiAppLoginCodeResult =
  | Readonly<{ status: 'consumed'; userId: string }>
  | Readonly<{ status: 'invalid' | 'expired' | 'already_used' | 'pkce_mismatch' }>;

export interface KaiIdentityStore {
  createTransaction(input: Readonly<{
    id: string;
    stateHash: string;
    nonceHash: string;
    pkceVerifierCiphertext: string;
    appRedirectUri: string;
    appCodeChallenge: string;
    termsVersion: string;
    privacyVersion: string;
    expiresAt: Date;
  }>): Promise<void>;
  consumeTransaction(stateHash: string, now: Date): Promise<KaiOidcTransaction | null>;
  resolveIdentity(input: Readonly<{
    issuer: string;
    subjectHash: string;
    displayName: string;
    emailCiphertext: string | null;
    emailVerified: boolean;
    termsVersion: string;
    privacyVersion: string;
    ipHash: string;
    userAgentHash: string;
    now: Date;
  }>): Promise<string>;
  createAppLoginCode(input: Readonly<{
    id: string;
    transactionId: string;
    userId: string;
    codeHash: string;
    appCodeChallenge: string;
    expiresAt: Date;
  }>): Promise<void>;
  consumeAppLoginCode(input: Readonly<{
    codeHash: string;
    appCodeChallenge: string;
    now: Date;
  }>): Promise<KaiAppLoginCodeResult>;
}

export type KaiAccessIdentity = Readonly<{
  userId: string;
  role: AccountUser['role'];
  status: AccountUser['status'];
  currentLegalConsents: boolean;
}>;

export interface KaiAccessIdentityStore {
  resolveAccessIdentity(input: Readonly<{
    issuer: string;
    subjectHash: string;
    now: Date;
  }>): Promise<KaiAccessIdentity>;
}

type TransactionRow = QueryResultRow & {
  id: string;
  nonce_hash: string;
  pkce_verifier_ciphertext: string;
  app_redirect_uri: string;
  app_code_challenge: string;
  terms_version: string;
  privacy_version: string;
};

function mapTransaction(row: TransactionRow): KaiOidcTransaction {
  return {
    id: row.id,
    nonceHash: row.nonce_hash,
    pkceVerifierCiphertext: row.pkce_verifier_ciphertext,
    appRedirectUri: row.app_redirect_uri,
    appCodeChallenge: row.app_code_challenge,
    termsVersion: row.terms_version,
    privacyVersion: row.privacy_version,
  };
}

export class PostgresKaiIdentityStore implements KaiIdentityStore, KaiAccessIdentityStore {
  constructor(private readonly database: Database) {}

  async createTransaction(input: Parameters<KaiIdentityStore['createTransaction']>[0]) {
    await this.database.query(
      `INSERT INTO kai_oidc_transactions(id, state_hash, nonce_hash, pkce_verifier_ciphertext,
         app_redirect_uri, app_code_challenge, terms_version, privacy_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [input.id, input.stateHash, input.nonceHash, input.pkceVerifierCiphertext,
        input.appRedirectUri, input.appCodeChallenge, input.termsVersion, input.privacyVersion, input.expiresAt],
    );
  }

  async consumeTransaction(stateHash: string, now: Date) {
    return this.database.transaction(async (client) => {
      const result = await client.query<TransactionRow & { expires_at: Date; consumed_at: Date | null }>(
        `SELECT id, nonce_hash, pkce_verifier_ciphertext, app_redirect_uri, app_code_challenge,
           terms_version, privacy_version, expires_at, consumed_at
         FROM kai_oidc_transactions WHERE state_hash = $1 FOR UPDATE`, [stateHash],
      );
      const transaction = result.rows[0];
      if (!transaction || transaction.consumed_at || new Date(transaction.expires_at) <= now) return null;
      await client.query(
        'UPDATE kai_oidc_transactions SET consumed_at = $2 WHERE id = $1',
        [transaction.id, now],
      );
      return mapTransaction(transaction);
    });
  }

  async resolveIdentity(input: Parameters<KaiIdentityStore['resolveIdentity']>[0]) {
    const existing = await this.touchExistingIdentity(input);
    if (existing) return existing;

    try {
      return await this.database.transaction(async (client) => {
        const userId = randomUUID();
        await client.query(
          `INSERT INTO users(id, phone_ciphertext, phone_lookup_hash, email_ciphertext,
             email_lookup_hash, display_name, email_verified_at, federated_principal)
           VALUES ($1, NULL, NULL, $2, NULL, $3, $4, true)`,
          [userId, input.emailCiphertext, input.displayName,
            input.emailCiphertext && input.emailVerified ? input.now : null],
        );
        await client.query(
          `INSERT INTO kai_oidc_identities(id, user_id, issuer, subject_hash, last_authenticated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), userId, input.issuer, input.subjectHash, input.now],
        );
        await client.query(
          `INSERT INTO legal_consents(id, user_id, document_kind, document_version, ip_hash, user_agent_hash)
           VALUES ($1, $3, 'terms', $4, $6, $7), ($2, $3, 'privacy', $5, $6, $7)`,
          [randomUUID(), randomUUID(), userId, input.termsVersion, input.privacyVersion,
            input.ipHash, input.userAgentHash],
        );
        return userId;
      });
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      const raced = await this.touchExistingIdentity(input);
      if (!raced) throw error;
      return raced;
    }
  }

  private async touchExistingIdentity(input: Parameters<KaiIdentityStore['resolveIdentity']>[0]) {
    return this.database.transaction(async (client) => {
      const found = await client.query<{ user_id: string }>(
        `SELECT user_id FROM kai_oidc_identities
         WHERE issuer = $1 AND subject_hash = $2 FOR UPDATE`,
        [input.issuer, input.subjectHash],
      );
      const userId = found.rows[0]?.user_id;
      if (!userId) return null;
      await client.query(
        `UPDATE kai_oidc_identities SET last_authenticated_at = $3
         WHERE issuer = $1 AND subject_hash = $2`,
        [input.issuer, input.subjectHash, input.now],
      );
      await client.query(
        `INSERT INTO legal_consents(id, user_id, document_kind, document_version, ip_hash, user_agent_hash)
         VALUES ($1, $3, 'terms', $4, $6, $7), ($2, $3, 'privacy', $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), randomUUID(), userId, input.termsVersion, input.privacyVersion,
          input.ipHash, input.userAgentHash],
      );
      return userId;
    });
  }

  async resolveAccessIdentity(input: Parameters<KaiAccessIdentityStore['resolveAccessIdentity']>[0]) {
    const existing = await this.touchExistingAccessIdentity(input);
    if (existing) return existing;
    try {
      return await this.database.transaction(async (client) => {
        const userId = randomUUID();
        await client.query(
          `INSERT INTO users(id, phone_ciphertext, phone_lookup_hash, email_ciphertext,
             email_lookup_hash, display_name, federated_principal)
           VALUES ($1, NULL, NULL, NULL, NULL, 'KAI 用户', true)`,
          [userId],
        );
        await client.query(
          `INSERT INTO kai_oidc_identities(id, user_id, issuer, subject_hash, last_authenticated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), userId, input.issuer, input.subjectHash, input.now],
        );
        return { userId, role: 'member', status: 'active', currentLegalConsents: false } as const;
      });
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      const raced = await this.touchExistingAccessIdentity(input);
      if (!raced) throw error;
      return raced;
    }
  }

  private async touchExistingAccessIdentity(input: Parameters<KaiAccessIdentityStore['resolveAccessIdentity']>[0]) {
    const found = await this.database.query<{
      user_id: string;
      role: AccountUser['role'];
      status: AccountUser['status'];
      current_legal_consents: boolean;
    }>(
      `SELECT i.user_id, u.role, u.status,
         (EXISTS (SELECT 1 FROM legal_consents c
           WHERE c.user_id = i.user_id AND c.document_kind = 'terms' AND c.document_version = $3)
          AND EXISTS (SELECT 1 FROM legal_consents c
           WHERE c.user_id = i.user_id AND c.document_kind = 'privacy' AND c.document_version = $4))
           AS current_legal_consents
       FROM kai_oidc_identities i
       JOIN users u ON u.id = i.user_id
       WHERE i.issuer = $1 AND i.subject_hash = $2`,
      [input.issuer, input.subjectHash, LEGAL_VERSIONS.terms, LEGAL_VERSIONS.privacy],
    );
    const row = found.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      role: row.role,
      status: row.status,
      currentLegalConsents: row.current_legal_consents,
    };
  }

  async createAppLoginCode(input: Parameters<KaiIdentityStore['createAppLoginCode']>[0]) {
    await this.database.query(
      `INSERT INTO kai_oidc_app_login_codes(id, transaction_id, user_id, code_hash,
         app_code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.id, input.transactionId, input.userId, input.codeHash, input.appCodeChallenge, input.expiresAt],
    );
  }

  async consumeAppLoginCode(input: Parameters<KaiIdentityStore['consumeAppLoginCode']>[0]): Promise<KaiAppLoginCodeResult> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        id: string;
        user_id: string;
        app_code_challenge: string;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT id, user_id, app_code_challenge, expires_at, consumed_at
         FROM kai_oidc_app_login_codes WHERE code_hash = $1 FOR UPDATE`, [input.codeHash],
      );
      const code = result.rows[0];
      if (!code) return { status: 'invalid' };
      if (code.consumed_at) return { status: 'already_used' };
      if (new Date(code.expires_at) <= input.now) return { status: 'expired' };
      if (code.app_code_challenge !== input.appCodeChallenge) return { status: 'pkce_mismatch' };
      await client.query(
        'UPDATE kai_oidc_app_login_codes SET consumed_at = $2 WHERE id = $1',
        [code.id, input.now],
      );
      return { status: 'consumed', userId: code.user_id };
    });
  }
}
