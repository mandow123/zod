import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function databaseFingerprint(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  return createHash('sha256').update(`${url.hostname}:${url.port || '5432'}${url.pathname}`).digest('hex').slice(0, 24);
}

export function postgresProcessEnvironment(databaseUrl: string, ssl: boolean) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (!url.hostname || !database) throw new Error('DATABASE_URL must include host and database name.');
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: ssl ? 'verify-full' : 'disable',
  };
}

export function safeProcessError(value: string) {
  return value.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[DATABASE_URL_REDACTED]').slice(0, 2_000);
}

export function postgresServerMajor(versionNumber: string) {
  if (!/^\d{6}$/u.test(versionNumber)) throw new Error('POSTGRES_SERVER_VERSION_INVALID');
  return Math.floor(Number(versionNumber) / 10_000);
}

export function postgresToolMajor(command: 'pg_dump' | 'pg_restore') {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command.toUpperCase()}_VERSION_FAILED`);
  const match = /\b(\d+)(?:\.\d+)+\b/u.exec(result.stdout);
  if (!match?.[1]) throw new Error(`${command.toUpperCase()}_VERSION_INVALID`);
  return Number(match[1]);
}
