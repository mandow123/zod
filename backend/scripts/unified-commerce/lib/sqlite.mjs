import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export async function sqliteJson(databasePath, sql) {
  const databaseUri = pathToFileURL(databasePath); databaseUri.searchParams.set('immutable', '1');
  const { stdout, stderr } = await execute('sqlite3', ['-readonly', '-json', databaseUri.href,
    `PRAGMA query_only=ON;${sql}`], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
  if (stderr.trim()) throw new Error('UNIFIED_SQLITE_READ_FAILED');
  const body = stdout.trim();
  return body ? JSON.parse(body) : [];
}

export function quoteIdentifier(value) {
  if (!identifier.test(value)) throw new Error('UNIFIED_SQLITE_IDENTIFIER_INVALID');
  return `"${value}"`;
}

export const sensitiveColumn = (name) => /(?:account|email|name|claim|license|path|checkout|url|password|secret|key|token|session|phone|address|merchant|provider_txn|callback|signature|cookie)/iu.test(name);

export async function schemaInventory(databasePath) {
  const tables = await sqliteJson(databasePath, `SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  const result = [];
  for (const { name } of tables) {
    const columns = await sqliteJson(databasePath, `PRAGMA table_info(${quoteIdentifier(name)});`);
    const indexes = await sqliteJson(databasePath, `PRAGMA index_list(${quoteIdentifier(name)});`);
    const foreignKeys = await sqliteJson(databasePath, `PRAGMA foreign_key_list(${quoteIdentifier(name)});`);
    const [{ count }] = await sqliteJson(databasePath, `SELECT count(*) count FROM ${quoteIdentifier(name)};`);
    result.push({ name, columns, indexes, foreignKeys, rowCount: Number(count) });
  }
  return result;
}
