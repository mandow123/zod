import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import type { Database } from '../src/database.js';

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0,
    command: '', oid: 0, rowAsArray: false };
}
export function adminDatabaseAdapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) =>
      pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) =>
      pglite.transaction(async (transaction: Transaction) => work({
        query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)),
      } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}
export async function adminFixture() {
  const pglite = new PGlite();
  for (const name of ['0001_cloudpay_ledger.sql', '0060_admin_identity_rbac_sessions.sql']) {
    await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  }
  return { pglite, database: adminDatabaseAdapter(pglite) };
}
export const h128 = (character: string) => character.repeat(128);
export const h64 = (character: string) => character.repeat(64);
