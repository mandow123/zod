import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PATH = '/etc/kai-cloudpay/backend.env';
const DATABASE_TARGET = '/etc/credstore.encrypted/kai-cloudpay-inquiry-probe-database-url';
const PEPPER_TARGET = '/etc/credstore.encrypted/kai-cloudpay-inquiry-probe-audit-pepper';
const DATABASE_CANDIDATE = `${DATABASE_TARGET}.next`;
const PEPPER_CANDIDATE = `${PEPPER_TARGET}.next`;
const TRANSACTION_PATH = '/var/lib/kai-cloudpay-deploy/probe-static-credential-transaction.json';
const TRANSACTION_TEMPORARY = `${TRANSACTION_PATH}.tmp`;
const LOCK_PATH = '/run/kai-cloudpay-probe-static-credentials.lock';
const ROLE = 'kai_cloudpay_probe';
const REQUIRED_TABLES = [
  'schema_migrations', 'orders', 'capacity_reservations', 'kai_credit_orders', 'kai_credit_order_reservations',
  'physical_device_orders', 'vast_external_orders', 'kai_credit_accounts', 'kai_credit_transactions',
  'kai_credit_entries', 'creator_commission_orders', 'creator_commission_accounts',
  'creator_commission_transactions', 'creator_commission_entries', 'streamer_commission_orders',
  'invite_reward_orders', 'reward_accounts', 'reward_transactions', 'reward_entries',
];

if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('PROBE_CREDENTIAL_ROOT_LINUX_REQUIRED');
if (!process.argv.includes('--locked')) {
  const locked = spawnSync('/usr/bin/flock', ['-n', LOCK_PATH, process.execPath, fileURLToPath(import.meta.url), '--locked'], {
    stdio: 'inherit', env: process.env,
  });
  process.exit(locked.status ?? 1);
}

function parseEnvironment(bytes) {
  return Object.fromEntries(bytes.split(/\r?\n/u).filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
    .map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
}

async function run(binary, args, stdin, environment = {}, redactions = []) {
  const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'],
    env: { PATH: '/usr/bin:/usr/sbin:/bin:/sbin', ...environment } });
  let error = '';
  child.stderr.on('data', (chunk) => { error += chunk.toString('utf8').slice(0, 2_048); });
  let stdinError;
  child.stdin.on('error', (candidate) => { stdinError = candidate; });
  child.stdin.end(stdin);
  const status = await new Promise((resolveStatus, reject) => { child.once('error', reject); child.once('close', resolveStatus); });
  if (status !== 0 || (stdinError && stdinError.code !== 'EPIPE')) {
    const detail = redactions.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), error);
    throw new Error(`PROBE_CREDENTIAL_COMMAND_FAILED:${binary}:${detail.replace(/[^A-Za-z0-9 _:.\/[\]-]/gu, '').slice(0, 240)}`);
  }
}

async function runCapture(binary, args, stdin = '', environment = {}) {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/usr/sbin:/bin:/sbin', ...environment } });
  const output = []; let bytes = 0; let stdinError;
  child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes <= 8_192) output.push(chunk); });
  child.stdin.on('error', (error) => { stdinError = error; }); child.stdin.end(stdin);
  const status = await new Promise((resolveStatus, reject) => { child.once('error', reject); child.once('close', resolveStatus); });
  if (status !== 0 || bytes > 8_192 || (stdinError && stdinError.code !== 'EPIPE')) return null;
  return Buffer.concat(output).toString('utf8');
}

async function digest(path) {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); } catch { return null; }
}

async function atomicJournal(value) {
  await mkdir(dirname(TRANSACTION_PATH), { recursive: true, mode: 0o700 });
  await rm(TRANSACTION_TEMPORARY, { force: true });
  await writeFile(TRANSACTION_TEMPORARY, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(TRANSACTION_TEMPORARY, TRANSACTION_PATH);
}

function parseTransaction(value) {
  if (!value || value.schemaVersion !== 1 || !['prepared', 'database_password_committed'].includes(value.phase)
    || value.role !== ROLE || !Number.isFinite(Date.parse(value.preparedAt))
    || value.database?.candidate !== DATABASE_CANDIDATE || value.database?.target !== DATABASE_TARGET
    || !/^[0-9a-f]{64}$/u.test(value.database?.sha256 ?? '')
    || value.pepper?.candidate !== PEPPER_CANDIDATE || value.pepper?.target !== PEPPER_TARGET
    || !/^[0-9a-f]{64}$/u.test(value.pepper?.sha256 ?? '')) {
    throw new Error('PROBE_STATIC_CREDENTIAL_TRANSACTION_INVALID');
  }
  return value;
}

async function decrypt(path, name) {
  const output = await runCapture('/usr/bin/systemd-creds', ['decrypt', `--name=${name}`, path, '-']);
  const value = output?.trim();
  if (!value || value.length < 32 || value.length > 4_096) throw new Error('PROBE_STATIC_CREDENTIAL_RECOVERY_DECRYPT_FAILED');
  return value;
}

function parseProbeDatabaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1'
    || decodeURIComponent(url.username) !== ROLE || decodeURIComponent(url.password).length < 32
    || url.searchParams.get('sslmode') !== 'disable') throw new Error('PROBE_STATIC_CREDENTIAL_RECOVERY_URL_INVALID');
  return url;
}

async function databaseLoginWorks(url) {
  const password = decodeURIComponent(url.password);
  const output = await runCapture('/usr/bin/psql', ['--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
    '--set', 'ON_ERROR_STOP=1', '--host', url.hostname, '--port', url.port || '5432',
    '--username', decodeURIComponent(url.username), '--dbname', decodeURIComponent(url.pathname.slice(1)),
    '--command', 'SELECT 1'], '', { PGPASSWORD: password });
  return output?.trim() === '1';
}

async function sourceWithDigest(candidate, target, expected) {
  if (await digest(target) === expected) return target;
  if (await digest(candidate) === expected) return candidate;
  throw new Error('PROBE_STATIC_CREDENTIAL_RECOVERY_ARTIFACT_MISSING');
}

async function finalizeTransaction(transaction) {
  for (const item of [transaction.database, transaction.pepper]) {
    if (await digest(item.target) === item.sha256) continue;
    if (await digest(item.candidate) !== item.sha256) throw new Error('PROBE_STATIC_CREDENTIAL_RECOVERY_ARTIFACT_MISSING');
    await rename(item.candidate, item.target);
  }
  await rm(TRANSACTION_PATH);
}

async function recoverPending() {
  let transaction;
  try { transaction = parseTransaction(JSON.parse(await readFile(TRANSACTION_PATH, 'utf8'))); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const newDatabaseSource = await sourceWithDigest(
    transaction.database.candidate, transaction.database.target, transaction.database.sha256);
  const newDatabaseWorks = await databaseLoginWorks(parseProbeDatabaseUrl(await decrypt(newDatabaseSource, 'kai-probe-database-url')));
  if (newDatabaseWorks) {
    await finalizeTransaction(transaction);
    return { recovered: true, phase: transaction.phase === 'prepared' ? 'database_commit_inferred' : transaction.phase };
  }
  if (transaction.phase === 'database_password_committed') {
    throw new Error('PROBE_STATIC_CREDENTIAL_RECOVERY_DATABASE_UNCONFIRMED');
  }
  if (await digest(DATABASE_TARGET) === transaction.database.sha256) {
    throw new Error('PROBE_STATIC_CREDENTIAL_RECOVERY_DATABASE_UNCONFIRMED');
  }
  const oldDatabaseWorks = await databaseLoginWorks(parseProbeDatabaseUrl(await decrypt(DATABASE_TARGET, 'kai-probe-database-url')));
  if (!oldDatabaseWorks) throw new Error('PROBE_STATIC_CREDENTIAL_RECOVERY_DATABASE_AMBIGUOUS');
  await Promise.all([rm(DATABASE_CANDIDATE, { force: true }), rm(PEPPER_CANDIDATE, { force: true })]);
  await rm(TRANSACTION_PATH);
  return { recovered: true, phase: 'prepared_rolled_back' };
}

async function encryptedTemporary(temporary, credentialName, value) {
  await rm(temporary, { force: true });
  try {
    await run('/usr/bin/systemd-creds', ['encrypt', '--with-key=host', `--name=${credentialName}`, '-', temporary], `${value}\n`);
    await chmod(temporary, 0o600);
    const info = await stat(temporary);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600 || info.size < 32) {
      throw new Error('PROBE_ENCRYPTED_CREDENTIAL_INVALID');
    }
    return temporary;
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

const env = parseEnvironment(await readFile(ENV_PATH, 'utf8'));
const applicationUrl = new URL(env.DATABASE_URL ?? '');
if (applicationUrl.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost'].includes(applicationUrl.hostname)
  || !applicationUrl.pathname || applicationUrl.pathname === '/') throw new Error('LOCAL_APPLICATION_DATABASE_REQUIRED');
const databaseName = decodeURIComponent(applicationUrl.pathname.slice(1));
const applicationUser = decodeURIComponent(applicationUrl.username);
const applicationPassword = decodeURIComponent(applicationUrl.password);
if (!/^[A-Za-z0-9_.-]{1,63}$/u.test(databaseName) || !/^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/u.test(applicationUser)
  || applicationPassword.length < 16) throw new Error('APPLICATION_DATABASE_CREDENTIAL_INVALID');

const recovered = await recoverPending();
if (recovered) {
  process.stdout.write(`${JSON.stringify({ ok: true, role: ROLE, credentials: 2, encryptedWithHostKey: true, ...recovered })}\n`);
  process.exit(0);
}

const password = randomBytes(36).toString('base64url');
const pepper = randomBytes(48).toString('base64url');
const escapedPassword = password.replaceAll("'", "''");
const tableList = REQUIRED_TABLES.map((table) => `public.${table}`).join(', ');
const sql = `BEGIN;
DO $provision$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${ROLE}') THEN
    CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 2 PASSWORD '${escapedPassword}';
  ELSE
    ALTER ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 2 PASSWORD '${escapedPassword}';
  END IF;
END $provision$;
ALTER ROLE ${ROLE} SET statement_timeout='15s';
ALTER ROLE ${ROLE} SET lock_timeout='3s';
ALTER ROLE ${ROLE} SET idle_in_transaction_session_timeout='15s';
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM ${ROLE}', current_database()) \\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ${ROLE}', current_database()) \\gexec
REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${ROLE};
GRANT USAGE ON SCHEMA public TO ${ROLE};
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${ROLE};
GRANT SELECT ON ${tableList} TO ${ROLE};
GRANT INSERT ON public.audit_events TO ${ROLE};
COMMIT;
`;

const generatedProbeUrl = new URL(applicationUrl.href);
generatedProbeUrl.username = ROLE; generatedProbeUrl.password = password; generatedProbeUrl.hostname = '127.0.0.1';
generatedProbeUrl.searchParams.set('sslmode', 'disable');
await mkdir(dirname(DATABASE_TARGET), { recursive: true, mode: 0o700 });
const [databaseTemporary, pepperTemporary] = await Promise.all([
  encryptedTemporary(DATABASE_CANDIDATE, 'kai-probe-database-url', generatedProbeUrl.href),
  encryptedTemporary(PEPPER_CANDIDATE, 'kai-probe-audit-pepper', pepper),
]);
const preparedAt = new Date().toISOString();
const transaction = { schemaVersion: 1, phase: 'prepared', role: ROLE, preparedAt,
  database: { candidate: databaseTemporary, target: DATABASE_TARGET, sha256: await digest(databaseTemporary) },
  pepper: { candidate: pepperTemporary, target: PEPPER_TARGET, sha256: await digest(pepperTemporary) } };
parseTransaction(transaction);
await atomicJournal(transaction);
await run('/usr/bin/psql', ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--host', applicationUrl.hostname,
  '--port', applicationUrl.port || '5432', '--username', applicationUser, '--dbname', databaseName], sql,
{ PGPASSWORD: applicationPassword }, [applicationPassword, password]);
const committed = { ...transaction, phase: 'database_password_committed', committedAt: new Date().toISOString() };
await atomicJournal(committed);
await finalizeTransaction(committed);
process.stdout.write(`${JSON.stringify({ ok: true, role: ROLE, credentials: 2, encryptedWithHostKey: true })}\n`);
