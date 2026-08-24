import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PRIVATE_IP = '172.31.31.78';
const ENV_PATH = '/etc/kai-cloudpay/backend.env';
const PROBE_STATIC_VERIFY_REPORT = '/var/lib/kai-cloudpay-deploy/probe-static-credentials-verified.json';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const requiredUnits = ['cloudpay-mobile-backend.service', 'cloudpay-mobile-migrate.service',
  'cloudpay-mobile-backup.service', 'cloudpay-mobile-backup.timer', 'cloudpay-mobile-edge.socket',
  'cloudpay-mobile-edge.service', 'cloudpay-mobile-edge-firewall.service',
  'cloudpay-mobile-paired-probe.service', 'cloudpay-mobile-paired-probe.timer',
  'cloudpay-mobile-paired-probe-revoke.service'];
const values = process.argv.slice(2);
const reportIndex = values.indexOf('--report');
const reportValue = reportIndex >= 0 ? values[reportIndex + 1] : undefined;
if (values.length !== 2 || !reportValue) {
  process.stderr.write('Usage: node preflight-sidecar.mjs --report /absolute/host-preflight.json\n');
  process.exit(2);
}
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });
check('linux_root_operator', process.platform === 'linux' && process.getuid?.() === 0, 'root on Linux required');
const [major, minor] = process.versions.node.split('.').map(Number);
check('pinned_node_runtime', major > 22 || (major === 22 && minor >= 18), process.versions.node);
let addresses = '';
try { addresses = execFileSync('/usr/sbin/ip', ['-4', '-o', 'addr', 'show'], { encoding: 'utf8' }); } catch {}
check('mobile_sidecar_private_identity', addresses.includes(` ${PRIVATE_IP}/`), PRIVATE_IP);
let probeAccount='';
try{probeAccount=execFileSync('/usr/bin/getent',['passwd','kai-cloudpay-probe'],{encoding:'utf8'}).trim();}catch{}
check('dedicated_probe_account',/^[^:]+:[^:]*:\d+:\d+:[^:]*:[^:]*:\/(?:usr\/sbin\/nologin|bin\/false)$/u.test(probeAccount),
  'kai-cloudpay-probe has no login shell');
let envBytes;
let envInfo;
try { [envBytes, envInfo] = await Promise.all([readFile(ENV_PATH, 'utf8'), stat(ENV_PATH)]); } catch {}
check('production_environment_permissions', envInfo?.uid === 0 && (envInfo.mode & 0o777) === 0o600, 'root:root 0600');
const env = Object.fromEntries((envBytes ?? '').split(/\r?\n/u).filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
  .map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
check('inquiry_only_profile_locked', env.NODE_ENV === 'production' && env.MOBILE_API_PROFILE === 'inquiry_only'
  && env.HONGHUAN_SUPPLIER_CATALOG_MODE === 'inquiry', 'production/inquiry_only/inquiry');
check('loopback_application_locked', env.HOST === '127.0.0.1' && env.PORT === '4100'
  && env.PUBLIC_ORIGIN === 'https://cloudpay.kai.com' && env.TRUST_PROXY_HOPS === '1',
  '127.0.0.1:4100 / canonical HTTPS origin / exactly one trusted socket proxy hop');
let databaseHost;
try { databaseHost = new URL(env.DATABASE_URL).hostname; } catch {}
check('postgres_loopback_only', ['127.0.0.1', 'localhost'].includes(databaseHost), databaseHost ?? 'invalid DATABASE_URL');
check('local_backup_locked', env.BACKUP_LOCAL_DIRECTORY === '/var/lib/kai-cloudpay-backup'
  && Boolean(env.BACKUP_ENCRYPTION_KEY) && Boolean(env.BACKUP_KEY_ID), '/var/lib/kai-cloudpay-backup / AES key configured');
let backupInfo;
try { backupInfo = await stat('/var/lib/kai-cloudpay-backup'); } catch {}
check('backup_workspace_locked', backupInfo?.isDirectory() && (backupInfo.mode & 0o777) === 0o700,
  backupInfo ? (backupInfo.mode & 0o777).toString(8) : 'missing');
const probeCredentialPaths=['/etc/credstore.encrypted/kai-cloudpay-inquiry-refresh-state',
  '/etc/credstore.encrypted/kai-cloudpay-inquiry-probe-database-url',
  '/etc/credstore.encrypted/kai-cloudpay-inquiry-probe-audit-pepper'];
let probeCredentialsReady=true;
for(const path of probeCredentialPaths){try{const info=await stat(path);if(!info.isFile()||info.uid!==0||(info.mode&0o777)!==0o600)probeCredentialsReady=false;}catch{probeCredentialsReady=false;}}
check('machine_encrypted_probe_credentials',probeCredentialsReady,'three root-owned 0600 systemd encrypted credentials');
let staticVerifyReport,staticVerifyInfo,databaseCredentialDigest,pepperCredentialDigest;
try {
  [staticVerifyReport,staticVerifyInfo,databaseCredentialDigest,pepperCredentialDigest]=await Promise.all([
    readFile(PROBE_STATIC_VERIFY_REPORT,'utf8').then(JSON.parse),stat(PROBE_STATIC_VERIFY_REPORT),
    readFile(probeCredentialPaths[1]).then((bytes)=>sha256(bytes)),
    readFile(probeCredentialPaths[2]).then((bytes)=>sha256(bytes)),
  ]);
} catch {}
const staticVerifyAge=Date.now()-Date.parse(staticVerifyReport?.checkedAt);
const staticVerifyFresh=staticVerifyInfo?.isFile()&&staticVerifyInfo.uid===0&&(staticVerifyInfo.mode&0o777)===0o600
  &&staticVerifyReport?.schemaVersion===1&&staticVerifyReport?.ok===true
  &&Number.isFinite(staticVerifyAge)&&staticVerifyAge>=-5*60_000&&staticVerifyAge<=24*60*60_000
  &&staticVerifyReport?.forbiddenCommerceMutationPrivileges===false
  &&staticVerifyReport?.credentialSha256?.database===databaseCredentialDigest
  &&staticVerifyReport?.credentialSha256?.auditPepper===pepperCredentialDigest;
check('recent_probe_static_credential_verification',staticVerifyFresh,
  'root-owned 0600 report <=24h matching both encrypted credential digests');
const missingUnits = [];
for (const unit of requiredUnits) {
  try { await readFile(`/etc/systemd/system/${unit}`, 'utf8'); } catch { missingUnits.push(unit); }
}
let firewall;
try { firewall = await readFile('/etc/kai-cloudpay/cloudpay-mobile-edge.nft', 'utf8'); } catch {}
check('installed_service_contract', missingUnits.length === 0, missingUnits.join(', ') || `${requiredUnits.length} units`);
check('exact_source_firewall_installed', firewall?.includes('ip saddr 172.31.33.227/32 counter accept')
  && firewall?.includes('tcp dport 4154 counter drop') && !firewall?.includes('172.31.0.0/16'), '172.31.33.227/32 only');
let listeners = '';
try { listeners = execFileSync('/usr/bin/ss', ['-ltnH'], { encoding: 'utf8' }); } catch {}
const publicSensitive = listeners.split(/\r?\n/u).filter((line) => /(?:\*:|0\.0\.0\.0:|\[::\]:)(?:4100|5432|9090)\b/u.test(line));
const invalidEdge = listeners.split(/\r?\n/u).filter((line) => /:4154\b/u.test(line) && !line.includes(`${PRIVATE_IP}:4154`));
check('loopback_services_not_public', publicSensitive.length === 0, publicSensitive.join('; ') || '4100/5432/9090 not public');
check('edge_listener_private_or_stopped', invalidEdge.length === 0, invalidEdge.join('; ') || `${PRIVATE_IP}:4154 or stopped`);
const failures = checks.filter((item) => !item.pass);
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), hostRole: 'mobile_sidecar',
  privateIpv4: PRIVATE_IP, edge: `${PRIVATE_IP}:4154`, loopback: '127.0.0.1:4100', allowedSource: '172.31.33.227/32',
  readyForMigrationAndSidecarStart: failures.length === 0, checks, failures };
const reportPath = resolve(reportValue);
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${failures.length === 0 ? 'PASS' : 'FAIL'} sidecar_host_preflight\nReport: ${reportPath}\n`);
if (failures.length > 0) process.exit(1);
