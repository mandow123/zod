import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { migrationManifest } from './schema.js';

const config = loadConfig(process.env);
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to run migrations.');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
});
const client = await pool.connect();

try {
  await client.query('SELECT pg_advisory_lock(4815162342)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const migrations = await migrationManifest();
  for (const { version: file, sql, checksum } of migrations) {
    const existing = await client.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE version = $1', [file],
    );
    if (existing.rowCount) {
      if (existing.rows[0]?.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${file}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [file, checksum]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(4815162342)').catch(() => undefined);
  client.release();
  await pool.end();
}
