import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { migrationManifest } from '../src/schema.js';

function restoreInvariantSql(source: string) {
  const match = source.match(/const invariants = await pool\.query<[\s\S]*?>\(`(SELECT[\s\S]*?)`\);/u);
  if (!match?.[1]) throw new Error('RESTORE_INVARIANT_SQL_NOT_FOUND');
  return match[1];
}

describe('restored database invariant gate', () => {
  it('parses and executes every restore invariant against the complete current schema', { timeout: 30_000 }, async () => {
    const database = new PGlite();
    for (const migration of await migrationManifest()) await database.exec(migration.sql);

    const source = await readFile(fileURLToPath(new URL('../src/backups/restore.ts', import.meta.url)), 'utf8');
    const result = await database.query<Record<string, string>>(restoreInvariantSql(source));
    const checks = result.rows[0];

    expect(checks).toBeDefined();
    expect(Object.keys(checks ?? {})).toEqual(expect.arrayContaining([
      'kai_credit_delivery_invalid',
      'kai_credit_delivery_issue_invalid',
      'kai_credit_dispute_adjudication_invalid',
      'kai_credit_post_acceptance_refund_invalid',
      'kai_credit_post_acceptance_adjudication_invalid',
    ]));
    expect(Object.values(checks ?? {}).every((value) => Number(value) === 0)).toBe(true);
    await database.close();
  });
});
