import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { currentSchemaVersion, migrationManifest, verifySchema } from '../src/schema.js';

describe('database schema release gate', () => {
  it('requires every bundled migration with its original checksum while allowing forward-compatible additions', { timeout: 30_000 }, async () => {
    const database = new PGlite();
    await database.exec(`CREATE TABLE schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const migrations = await migrationManifest();
    expect(migrations).toHaveLength(67);
    expect(migrations.at(-1)?.version).toBe(currentSchemaVersion);
    for (const migration of migrations.slice(0, -1)) {
      await database.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
    }
    const query = async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => database.query<Row>(text, values);
    const missing = await verifySchema(query);
    expect(missing.ready).toBe(false);
    expect(missing.missing).toEqual([migrations.at(-1)?.version]);

    const last = migrations.at(-1)!;
    await database.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [last.version, last.checksum]);
    await database.query(`INSERT INTO schema_migrations(version, checksum) VALUES ('9999_forward_compatible.sql', 'future')`);
    expect(await verifySchema(query)).toMatchObject({ ready: true, expected: last.version, applied: '9999_forward_compatible.sql' });

    await database.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [last.version, 'tampered']);
    const mismatched = await verifySchema(query);
    expect(mismatched.ready).toBe(false);
    expect(mismatched.mismatched).toEqual([last.version]);
    await database.close();
  });

  it('keeps an otherwise healthy pod out of service when migrations are missing', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }),
      database: {
        health: async () => true,
        schemaReadiness: async () => ({
          ready: false, expected: '0011_backup_audit.sql', applied: '0010_payment_recovery.sql',
          missing: ['0011_backup_audit.sql'], mismatched: [],
        }),
      },
      logger: false,
    });
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/readiness' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false, capabilities: { database: false },
      database: { connected: true, schema: { ready: false, missing: ['0011_backup_audit.sql'] } },
    });
    expect(response.json().release.blockers).toContain('DATABASE_SCHEMA');
    await app.close();
  });
});
