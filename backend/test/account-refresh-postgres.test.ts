import { randomUUID } from 'node:crypto';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresAccountStore } from '../src/account/store.js';
import type { Database } from '../src/database.js';
import { migrationManifest } from '../src/schema.js';

function pgResult<T>(value: Results<T>) {
  return { ...value, rowCount: value.rows.length || value.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => work({
      query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)),
    } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

describe('postgres refresh-token rotation', () => {
  it('rotates under the one-current-token constraint and revokes the family on reuse', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const migration of await migrationManifest()) await pglite.exec(migration.sql);
    const database = adapter(pglite);
    const store = new PostgresAccountStore(database);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const firstTokenId = randomUUID();
    const secondTokenId = randomUUID();
    const expiresAt = new Date('2026-09-14T00:00:00.000Z');
    const rotatedAt = new Date('2026-08-14T00:15:00.000Z');

    await database.query(
      `INSERT INTO users(id, phone_ciphertext, phone_lookup_hash, display_name, role, phone_verified_at)
       VALUES ($1, 'encrypted-phone', 'refresh-test-phone', '资源方', 'supplier', now())`,
      [userId],
    );
    await store.createSession({
      sessionId,
      tokenFamily: familyId,
      userId,
      refreshTokenId: firstTokenId,
      refreshTokenHash: 'refresh-hash-first',
      device: { deviceId: 'android-provider-device', appVersion: '1.0.0', platform: 'android' },
      expiresAt,
    });

    const rotation = await store.rotateRefreshToken({
      currentTokenHash: 'refresh-hash-first',
      nextTokenId: secondTokenId,
      nextTokenHash: 'refresh-hash-second',
      deviceId: 'android-provider-device',
      expiresAt,
      now: rotatedAt,
    });
    expect(rotation.status).toBe('rotated');
    const rotatedTokens = await database.query<{
      id: string; status: string; replaced_by_id: string | null; used_at: Date | null;
    }>(
      `SELECT id, status, replaced_by_id, used_at
       FROM session_refresh_tokens WHERE session_id = $1 ORDER BY created_at, id`,
      [sessionId],
    );
    expect(rotatedTokens.rows).toHaveLength(2);
    expect(rotatedTokens.rows.find((token) => token.id === firstTokenId)).toMatchObject({
      status: 'used', replaced_by_id: secondTokenId,
    });
    expect(rotatedTokens.rows.find((token) => token.id === firstTokenId)?.used_at).not.toBeNull();
    expect(rotatedTokens.rows.find((token) => token.id === secondTokenId)).toMatchObject({
      status: 'current', replaced_by_id: null,
    });
    expect((await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM session_refresh_tokens
       WHERE session_id = $1 AND status = 'current'`, [sessionId],
    )).rows[0]?.count).toBe('1');

    const reuse = await store.rotateRefreshToken({
      currentTokenHash: 'refresh-hash-first',
      nextTokenId: randomUUID(),
      nextTokenHash: 'unused-next-hash',
      deviceId: 'android-provider-device',
      expiresAt,
      now: new Date(rotatedAt.getTime() + 1_000),
    });
    expect(reuse.status).toBe('reused');
    expect((await database.query<{ revoked_at: Date | null; revocation_reason: string | null }>(
      'SELECT revoked_at, revocation_reason FROM mobile_sessions WHERE id = $1', [sessionId],
    )).rows[0]).toMatchObject({ revocation_reason: 'refresh_token_reuse' });
    expect((await database.query<{ status: string }>(
      'SELECT status FROM session_refresh_tokens WHERE id = $1', [secondTokenId],
    )).rows[0]?.status).toBe('revoked');

    await database.close();
  });
});
