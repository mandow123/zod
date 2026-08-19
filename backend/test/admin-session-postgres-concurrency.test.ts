import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const postgresTestUrl = process.env.ADMIN_POSTGRES_TEST_URL;
const postgresDescribe = postgresTestUrl ? describe : describe.skip;

function hash128(value: string): string {
  return createHash('sha512').update(value).digest('hex');
}

function hash64(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function setSearchPath(client: PoolClient, schema: string): Promise<void> {
  await client.query("SELECT set_config('search_path', $1, false)", [`${schema}, pg_catalog`]);
}

async function insertSession(client: PoolClient, input: {
  identityId: string;
  sessionId: string;
  tokenHash: string;
  now: Date;
}): Promise<void> {
  const absoluteExpiresAt = new Date(input.now.getTime() + 30 * 60_000);
  await client.query(
    `INSERT INTO admin_sessions(
       id, admin_identity_id, token_hash, csrf_token_hash, authz_version_at_issue,
       permission_definition_version, permission_snapshot_digest, created_at, last_seen_at,
       idle_expires_at, absolute_expires_at, created_ip_hash, last_ip_hash, user_agent_hash
     ) VALUES ($1,$2,$3,$4,1,'test-v1',$5,$6,$6,$7,$8,$9,$9,$10)`,
    [
      input.sessionId,
      input.identityId,
      input.tokenHash,
      hash128(`csrf:${input.sessionId}`),
      hash128(`permissions:${input.sessionId}`),
      input.now,
      new Date(input.now.getTime() + 10 * 60_000),
      absoluteExpiresAt,
      hash64(`ip:${input.sessionId}`),
      hash64(`ua:${input.sessionId}`),
    ],
  );
}

async function rotateSession(client: PoolClient, input: {
  sessionId: string;
  currentTokenHash: string;
  nextTokenHash: string;
  rotatedAt: Date;
}): Promise<void> {
  await client.query(
    `UPDATE admin_sessions
        SET token_hash=$2,
            previous_token_hash=$3,
            previous_token_valid_until=$4,
            csrf_token_hash=$5,
            rotated_at=$6,
            last_seen_at=$6,
            idle_expires_at=$7,
            last_ip_hash=$8
      WHERE id=$1 AND token_hash=$3`,
    [
      input.sessionId,
      input.nextTokenHash,
      input.currentTokenHash,
      new Date(input.rotatedAt.getTime() + 10_000),
      hash128(`csrf-rotated:${input.sessionId}`),
      input.rotatedAt,
      new Date(input.rotatedAt.getTime() + 10 * 60_000),
      hash64(`ip-rotated:${input.sessionId}`),
    ],
  );
}

postgresDescribe('admin session token registry real PostgreSQL concurrency', () => {
  let setupPool: Pool;
  let racePool: Pool;
  let schema: string;

  beforeAll(async () => {
    // The URL is intentionally never logged: CI supplies this only to opt into
    // a real PostgreSQL race test. Each invocation owns a random schema.
    setupPool = new Pool({ connectionString: postgresTestUrl, max: 1 });
    racePool = new Pool({ connectionString: postgresTestUrl, max: 2 });
    schema = `admin_session_race_${randomUUID().replaceAll('-', '')}`;
    const setupClient = await setupPool.connect();
    try {
      await setupClient.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await setSearchPath(setupClient, schema);
      await setupClient.query('CREATE TABLE users (id uuid PRIMARY KEY)');
      await setupClient.query(`CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.updated_at = now(); RETURN NEW; END;
      $$`);
      await setupClient.query(`CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'immutable'; END;
      $$`);
      const migration = await readFile(
        fileURLToPath(new URL('../migrations/0058_admin_identity_rbac_sessions.sql', import.meta.url)),
        'utf8',
      );
      await setupClient.query(migration);
    } finally {
      setupClient.release();
    }
  }, 30_000);

  afterAll(async () => {
    if (!setupPool || !racePool || !schema) return;
    const setupClient = await setupPool.connect();
    try {
      await setupClient.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    } finally {
      setupClient.release();
      await racePool.end();
      await setupPool.end();
    }
  });

  async function seedTwoSessions(label: string): Promise<{
    firstSessionId: string;
    secondSessionId: string;
    firstTokenHash: string;
    secondTokenHash: string;
    collidingTokenHash: string;
    rotatedAt: Date;
  }> {
    const now = new Date();
    const firstIdentityId = randomUUID();
    const secondIdentityId = randomUUID();
    const firstSessionId = randomUUID();
    const secondSessionId = randomUUID();
    const firstTokenHash = hash128(`${label}:first`);
    const secondTokenHash = hash128(`${label}:second`);
    const collidingTokenHash = hash128(`${label}:collision`);
    const setupClient = await setupPool.connect();
    try {
      await setSearchPath(setupClient, schema);
      await setupClient.query(
        `INSERT INTO admin_identities(
           id, issuer, subject_hash, display_name, status, authz_version, created_at, updated_at
         ) VALUES
          ($1, 'https://issuer.test', $2, 'First', 'active', 1, $3, $3),
          ($4, 'https://issuer.test', $5, 'Second', 'active', 1, $3, $3)`,
        [firstIdentityId, hash128(`${label}:identity:first`), now, secondIdentityId, hash128(`${label}:identity:second`)],
      );
      await insertSession(setupClient, { identityId: firstIdentityId, sessionId: firstSessionId, tokenHash: firstTokenHash, now });
      await insertSession(setupClient, { identityId: secondIdentityId, sessionId: secondSessionId, tokenHash: secondTokenHash, now });
    } finally {
      setupClient.release();
    }
    return {
      firstSessionId,
      secondSessionId,
      firstTokenHash,
      secondTokenHash,
      collidingTokenHash,
      rotatedAt: new Date(now.getTime() + 1_000),
    };
  }

  async function twoRaceClients(): Promise<[PoolClient, PoolClient]> {
    const first = await racePool.connect();
    const second = await racePool.connect();
    await setSearchPath(first, schema);
    await setSearchPath(second, schema);
    const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    expect(firstPid).toBeTypeOf('number');
    expect(secondPid).toBeTypeOf('number');
    expect(firstPid).not.toBe(secondPid);
    return [first, second];
  }

  async function assertUniqueRegistry(expected: Array<{ tokenHash: string; sessionId: string; kind: 'current' | 'previous' }>): Promise<void> {
    const setupClient = await setupPool.connect();
    try {
      await setSearchPath(setupClient, schema);
      const rows = (await setupClient.query<{
        token_hash: string;
        admin_session_id: string;
        token_kind: 'current' | 'previous';
        occurrences: string;
      }>(`SELECT token_hash, admin_session_id, token_kind, count(*)::text AS occurrences
           FROM admin_session_token_hashes
          WHERE admin_session_id = ANY($1::uuid[])
          GROUP BY token_hash, admin_session_id, token_kind
          ORDER BY token_hash`, [[...new Set(expected.map((entry) => entry.sessionId))]])).rows;
      expect(rows).toHaveLength(expected.length);
      expect(rows.every((row) => row.occurrences === '1')).toBe(true);
      for (const entry of expected) {
        expect(rows).toContainEqual(expect.objectContaining({
          token_hash: entry.tokenHash,
          admin_session_id: entry.sessionId,
          token_kind: entry.kind,
          occurrences: '1',
        }));
      }
    } finally {
      setupClient.release();
    }
  }

  it('serializes a cross-session token collision and atomically rolls back the losing rotation', { timeout: 30_000 }, async () => {
    const fixture = await seedTwoSessions('commit-conflict');
    const [first, second] = await twoRaceClients();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await rotateSession(first, {
        sessionId: fixture.firstSessionId,
        currentTokenHash: fixture.firstTokenHash,
        nextTokenHash: fixture.collidingTokenHash,
        rotatedAt: fixture.rotatedAt,
      });
      const blockedUpdate = rotateSession(second, {
        sessionId: fixture.secondSessionId,
        currentTokenHash: fixture.secondTokenHash,
        nextTokenHash: fixture.collidingTokenHash,
        rotatedAt: fixture.rotatedAt,
      });
      const settledTooSoon = await Promise.race([
        blockedUpdate.then(() => 'settled', () => 'settled'),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 150)),
      ]);
      expect(settledTooSoon).toBe('pending');
      await first.query('COMMIT');
      await expect(blockedUpdate).rejects.toMatchObject({ code: '23505' });
      await second.query('ROLLBACK');

      const verifyClient = await setupPool.connect();
      try {
        await setSearchPath(verifyClient, schema);
        const loser = (await verifyClient.query<{
          token_hash: string;
          previous_token_hash: string | null;
        }>('SELECT token_hash, previous_token_hash FROM admin_sessions WHERE id=$1', [fixture.secondSessionId])).rows[0];
        expect(loser).toEqual({ token_hash: fixture.secondTokenHash, previous_token_hash: null });
      } finally {
        verifyClient.release();
      }
      await assertUniqueRegistry([
        { tokenHash: fixture.firstTokenHash, sessionId: fixture.firstSessionId, kind: 'previous' },
        { tokenHash: fixture.collidingTokenHash, sessionId: fixture.firstSessionId, kind: 'current' },
        { tokenHash: fixture.secondTokenHash, sessionId: fixture.secondSessionId, kind: 'current' },
      ]);
    } finally {
      first.release();
      second.release();
    }
  });

  it('releases a claimed hash on rollback so the other session can rotate to it', { timeout: 30_000 }, async () => {
    const fixture = await seedTwoSessions('rollback-release');
    const [first, second] = await twoRaceClients();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await rotateSession(first, {
        sessionId: fixture.firstSessionId,
        currentTokenHash: fixture.firstTokenHash,
        nextTokenHash: fixture.collidingTokenHash,
        rotatedAt: fixture.rotatedAt,
      });
      const blockedUpdate = rotateSession(second, {
        sessionId: fixture.secondSessionId,
        currentTokenHash: fixture.secondTokenHash,
        nextTokenHash: fixture.collidingTokenHash,
        rotatedAt: fixture.rotatedAt,
      });
      const settledTooSoon = await Promise.race([
        blockedUpdate.then(() => 'settled', () => 'settled'),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 150)),
      ]);
      expect(settledTooSoon).toBe('pending');
      await first.query('ROLLBACK');
      await blockedUpdate;
      await second.query('COMMIT');

      await assertUniqueRegistry([
        { tokenHash: fixture.firstTokenHash, sessionId: fixture.firstSessionId, kind: 'current' },
        { tokenHash: fixture.secondTokenHash, sessionId: fixture.secondSessionId, kind: 'previous' },
        { tokenHash: fixture.collidingTokenHash, sessionId: fixture.secondSessionId, kind: 'current' },
      ]);
    } finally {
      first.release();
      second.release();
    }
  });
});
