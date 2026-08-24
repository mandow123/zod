import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DATABASE_TARGET = '/etc/credstore.encrypted/kai-cloudpay-inquiry-probe-database-url';
const PEPPER_TARGET = '/etc/credstore.encrypted/kai-cloudpay-inquiry-probe-audit-pepper';
const DEFAULT_REPORT = '/var/lib/kai-cloudpay-deploy/probe-static-credentials-verified.json';
const ROLE = 'kai_cloudpay_probe';
const REQUIRED_TABLES = [
  'schema_migrations', 'orders', 'capacity_reservations', 'kai_credit_orders', 'kai_credit_order_reservations',
  'physical_device_orders', 'vast_external_orders', 'kai_credit_accounts', 'kai_credit_transactions',
  'kai_credit_entries', 'creator_commission_orders', 'creator_commission_accounts',
  'creator_commission_transactions', 'creator_commission_entries', 'streamer_commission_orders',
  'invite_reward_orders', 'reward_accounts', 'reward_transactions', 'reward_entries',
];

if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('PROBE_CREDENTIAL_ROOT_LINUX_REQUIRED');
const values = process.argv.slice(2);
const reportIndex = values.indexOf('--report');
const reportPath = resolve(reportIndex >= 0 ? values[reportIndex + 1] ?? '' : DEFAULT_REPORT);
if ((values.length !== 0 && (values.length !== 2 || reportIndex !== 0)) || !reportPath.startsWith('/var/lib/kai-cloudpay-deploy/')) {
  throw new Error('PROBE_STATIC_CREDENTIAL_REPORT_PATH_INVALID');
}

async function run(binary, args, stdin = '', environment = {}, redactions = []) {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/usr/sbin:/bin:/sbin', ...environment } });
  const output = []; let outputBytes = 0; let error = '';
  child.stdout.on('data', (chunk) => { outputBytes += chunk.length; if (outputBytes <= 65_536) output.push(chunk); });
  child.stderr.on('data', (chunk) => { error += chunk.toString('utf8').slice(0, 2_048); });
  let stdinError; child.stdin.on('error', (candidate) => { stdinError = candidate; }); child.stdin.end(stdin);
  const status = await new Promise((resolveStatus, reject) => { child.once('error', reject); child.once('close', resolveStatus); });
  if (status !== 0 || outputBytes > 65_536 || (stdinError && stdinError.code !== 'EPIPE')) {
    const detail = redactions.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), error);
    throw new Error(`PROBE_VERIFY_COMMAND_FAILED:${binary}:${detail.replace(/[^A-Za-z0-9 _:.\/[\]-]/gu, '').slice(0, 240)}`);
  }
  return Buffer.concat(output).toString('utf8');
}

async function decrypt(path, credentialName) {
  const value = (await run('/usr/bin/systemd-creds', ['decrypt', `--name=${credentialName}`, path, '-'])).trim();
  if (value.length < 32 || value.length > 4_096) throw new Error('PROBE_DECRYPTED_CREDENTIAL_INVALID');
  return value;
}

for (const path of [DATABASE_TARGET, PEPPER_TARGET]) {
  const info = await stat(path);
  if (!info.isFile() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o777) !== 0o600 || info.size < 32) {
    throw new Error('PROBE_ENCRYPTED_CREDENTIAL_PERMISSIONS_INVALID');
  }
}
const [databaseValue, pepper] = await Promise.all([
  decrypt(DATABASE_TARGET, 'kai-probe-database-url'), decrypt(PEPPER_TARGET, 'kai-probe-audit-pepper'),
]);
if (pepper.length < 32) throw new Error('PROBE_AUDIT_PEPPER_INVALID');
const databaseUrl = new URL(databaseValue);
const password = decodeURIComponent(databaseUrl.password); const username = decodeURIComponent(databaseUrl.username);
if (databaseUrl.protocol !== 'postgresql:' || databaseUrl.hostname !== '127.0.0.1' || username !== ROLE
  || password.length < 32 || databaseUrl.searchParams.get('sslmode') !== 'disable') throw new Error('PROBE_DATABASE_URL_INVALID');
const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
const tableValues = REQUIRED_TABLES.map((table) => `('${table}')`).join(',');
const auditId = randomUUID();
const sql = `WITH required(name) AS (VALUES ${tableValues})
SELECT CASE WHEN current_user='${ROLE}'
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolcanlogin AND NOT rolsuper
    AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND rolconnlimit=2)
  AND has_database_privilege(current_user,current_database(),'CONNECT')
  AND has_schema_privilege(current_user,'public','USAGE') AND NOT has_schema_privilege(current_user,'public','CREATE')
  AND (SELECT bool_and(has_table_privilege(current_user,'public.'||name,'SELECT')) FROM required)
  AND (SELECT bool_and(NOT has_table_privilege(current_user,'public.'||name,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) FROM required)
  AND has_table_privilege(current_user,'public.audit_events','INSERT')
  AND NOT has_table_privilege(current_user,'public.audit_events','SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  THEN 'PASS' ELSE 'FAIL' END;
BEGIN;
INSERT INTO audit_events(id,actor_id,actor_kind,action,entity_type,entity_id,payload_digest,metadata)
VALUES('${auditId}',NULL,'system','PROBE_STATIC_CREDENTIAL_TRANSACTION_ROLLBACK','PRODUCTION_READINESS_PROBE',
  '${auditId}','sha256:${'0'.repeat(64)}','{"rolledBack":true}'::jsonb);
ROLLBACK;
`;
const result = await run('/usr/bin/psql', ['--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1',
  '--host', databaseUrl.hostname, '--port', databaseUrl.port || '5432', '--username', username, '--dbname', databaseName],
sql, { PGPASSWORD: password }, [password, databaseValue, pepper]);
if (result.trim() !== 'PASS') throw new Error('PROBE_STATIC_PRIVILEGE_MATRIX_INVALID');
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), ok: true, role: ROLE,
  selectTables: REQUIRED_TABLES.length, auditInsertRollback: true, forbiddenCommerceMutationPrivileges: false,
  encryptedCredentials: 2, credentialSha256: {
    database: createHash('sha256').update(await readFile(DATABASE_TARGET)).digest('hex'),
    auditPepper: createHash('sha256').update(await readFile(PEPPER_TARGET)).digest('hex'),
  } };
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
const reportTemporary = `${reportPath}.${process.pid}.tmp`;
await rm(reportTemporary, { force: true });
await writeFile(reportTemporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
await rename(reportTemporary, reportPath);
process.stdout.write(`${JSON.stringify({ ok: true, role: ROLE, selectTables: REQUIRED_TABLES.length,
  auditInsertRollback: true, forbiddenCommerceMutationPrivileges: false, encryptedCredentials: 2,
  report: reportPath })}\n`);
