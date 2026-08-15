import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueryResultRow } from 'pg';

export type MigrationDefinition = Readonly<{ version: string; checksum: string; sql: string }>;

let cachedManifest: Promise<MigrationDefinition[]> | null = null;

export function migrationManifest() {
  cachedManifest ??= (async () => {
    const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    if (!files.length) throw new Error('MIGRATION_MANIFEST_EMPTY');
    return Promise.all(files.map(async (version) => {
      const sql = await readFile(join(directory, version), 'utf8');
      return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }));
  })();
  return cachedManifest;
}

export async function verifySchema(query: <Row extends QueryResultRow>(text: string, values?: unknown[]) => Promise<{ rows: Row[] }>) {
  try {
    const expected = await migrationManifest();
    const result = await query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(result.rows.map((row) => [row.version, row.checksum]));
    const missing = expected.filter((migration) => !applied.has(migration.version)).map((migration) => migration.version);
    const mismatched = expected.filter((migration) => {
      const checksum = applied.get(migration.version);
      return checksum !== undefined && checksum !== migration.checksum;
    }).map((migration) => migration.version);
    return {
      ready: missing.length === 0 && mismatched.length === 0,
      expected: expected.at(-1)?.version ?? null,
      applied: result.rows.map((row) => row.version).sort().at(-1) ?? null,
      missing,
      mismatched,
    };
  } catch (error) {
    return {
      ready: false, expected: null, applied: null, missing: [] as string[], mismatched: [] as string[],
      error: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'DATABASE_SCHEMA_UNAVAILABLE',
    };
  }
}
