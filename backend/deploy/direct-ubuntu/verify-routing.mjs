import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { probeInquiryOrigin } from './probe-inquiry.mjs';

const PUBLIC_ORIGIN = 'https://cloudpay.kai.com';
const DIRECT_ORIGIN = 'http://18.163.148.84:8081';
const CLOUD_KAI_ORIGIN = 'https://cloud.kai.com';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function protectedRecord(origin, path) {
  const host = origin === DIRECT_ORIGIN ? 'cloudpay.kai.com' : new URL(origin).host;
  const response = await fetch(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(10_000),
    headers: { accept: path === '/' ? 'text/html' : 'application/json', host } });
  const body = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(body.toString('utf8')); } catch {}
  return { path, status: response.status, contentType: (response.headers.get('content-type') ?? '').split(';')[0],
    bytes: body.length, sha256: sha256(body), json };
}

async function protectedPair() {
  const [publicRoot, directRoot, publicApi, directApi, publicMobile, directMobile,
    publicMobileMarket, directMobileMarket, cloudKaiRoot] = await Promise.all([
    protectedRecord(PUBLIC_ORIGIN, '/'), protectedRecord(DIRECT_ORIGIN, '/'),
    protectedRecord(PUBLIC_ORIGIN, '/api/health'), protectedRecord(DIRECT_ORIGIN, '/api/health'),
    protectedRecord(PUBLIC_ORIGIN, '/mobile/v1/health'), protectedRecord(DIRECT_ORIGIN, '/mobile/v1/health'),
    protectedRecord(PUBLIC_ORIGIN, '/mobile/v1/market/resources'),
    protectedRecord(DIRECT_ORIGIN, '/mobile/v1/market/resources'),
    protectedRecord(CLOUD_KAI_ORIGIN, '/'),
  ]);
  return { root: { public: publicRoot, direct: directRoot }, apiHealth: { public: publicApi, direct: directApi },
    mobileHealth: { public: publicMobile, direct: directMobile },
    mobileMarket: { public: publicMobileMarket, direct: directMobileMarket }, cloudKaiRoot };
}

function sameRecord(left, right) {
  return left?.status === right?.status && left?.contentType === right?.contentType
    && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
}

function validLegacyIdentity(record) {
  return record?.json?.service === 'kai-transaction' && record?.json?.phase === 1
    && record?.json?.payment_mode === 'provider' && record?.json?.auth_provider === 'kai_identity'
    && record?.json?.auth_ready === true && record?.json?.sms_ready === false
    // The legacy CloudPay rail is intentionally provider-ready while new
    // payment creation remains gated. Preserve that exact safety posture
    // instead of expecting the pre-integration `payment_ready=false` state.
    && record?.json?.payment_ready === true && record?.json?.payment_create_enabled === false
    && record?.json?.payment_create_ready === false
    && record?.json?.payment_reconciliation_enabled === true
    && record?.json?.payment_reconciliation_ready === true
    && record?.json?.payment_worker_ready === true;
}

function validLegacyMobileHealth(record) {
  return record?.status === 200 && record?.contentType === 'application/json'
    && record?.json?.ok === true && record?.json?.service === 'kai-cloudpay-backend'
    && record?.json?.apiVersion === 'mobile/v1' && Number.isFinite(Date.parse(record?.json?.time));
}

const [mode, origin, baselineValue, reportValue] = process.argv.slice(2);
if (!['capture', 'verify'].includes(mode) || origin !== PUBLIC_ORIGIN || !baselineValue
  || (mode === 'capture' && reportValue) || (mode === 'verify' && !reportValue)) {
  process.stderr.write('Usage: verify-routing.mjs capture https://cloudpay.kai.com /absolute/baseline.json\n'
    + '   or: verify-routing.mjs verify https://cloudpay.kai.com /absolute/baseline.json /absolute/report.json\n');
  process.exit(2);
}
const baselinePath = resolve(baselineValue);
if (mode === 'capture') {
  const protectedRoutes = await protectedPair();
  const failures = [];
  if (!sameRecord(protectedRoutes.root.public, protectedRoutes.root.direct)) failures.push('public/direct root differ');
  if (!sameRecord(protectedRoutes.apiHealth.public, protectedRoutes.apiHealth.direct)) failures.push('public/direct /api/health differ');
  // The auth-only backend emits a current timestamp, so its two health bodies
  // cannot be byte-identical. Validate the stable identity fields instead.
  if (!validLegacyMobileHealth(protectedRoutes.mobileHealth.public)
    || !validLegacyMobileHealth(protectedRoutes.mobileHealth.direct)) failures.push('legacy mobile auth health baseline differs');
  if (!sameRecord(protectedRoutes.mobileMarket.public, protectedRoutes.mobileMarket.direct)
    || protectedRoutes.mobileMarket.public.status !== 404
    || protectedRoutes.mobileMarket.public.contentType !== 'application/json') {
    failures.push('legacy mobile auth-only market gate differs');
  }
  if (!validLegacyIdentity(protectedRoutes.apiHealth.public)) failures.push('legacy /api/health identity changed');
  if (failures.length > 0) throw new Error(`BASELINE_REJECTED:${failures.join('; ')}`);
  const baseline = { schemaVersion: 1, capturedAt: new Date().toISOString(), publicOrigin: PUBLIC_ORIGIN,
    directOrigin: DIRECT_ORIGIN, protected: protectedRoutes,
    observedReference: { capturedAt: '2026-08-21T10:30:00+08:00', rootBytes: 23026,
      rootSha256: '2d0347e75baaf93bebe0a0a79a4640d6102ec399a10a1d0c2a0941d7ae3e07b2', releaseGate: false } };
  await mkdir(dirname(baselinePath), { recursive: true, mode: 0o700 });
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`PASS protected_route_baseline\nBaseline: ${baselinePath}\n`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const protectedRoutes = await protectedPair();
const failures = [];
const baselineAge = Date.now() - Date.parse(baseline.capturedAt);
if (baseline.schemaVersion !== 1 || !Number.isFinite(baselineAge)
  || baselineAge < -5 * 60_000 || baselineAge > 24 * 60 * 60_000) failures.push('baseline missing, future-dated, or older than 24h');
for (const key of ['root', 'apiHealth']) {
  if (!sameRecord(protectedRoutes[key].public, baseline.protected?.[key]?.public)) failures.push(`public ${key} changed`);
  if (!sameRecord(protectedRoutes[key].direct, baseline.protected?.[key]?.direct)) failures.push(`direct ${key} changed`);
  if (!sameRecord(protectedRoutes[key].public, protectedRoutes[key].direct)) failures.push(`public/direct ${key} differ`);
}
if (!sameRecord(protectedRoutes.cloudKaiRoot, baseline.protected?.cloudKaiRoot)) failures.push('cloud.kai.com changed');
if (!validLegacyIdentity(protectedRoutes.apiHealth.public)) failures.push('legacy /api/health identity changed');
let inquiryProbe;
try { inquiryProbe = await probeInquiryOrigin(PUBLIC_ORIGIN); } catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}
if (inquiryProbe?.ok !== true) failures.push(...(inquiryProbe?.failures ?? ['public inquiry probe failed']));
for (const record of inquiryProbe?.records ?? []) {
  if (record.path.startsWith('/mobile/v1') && !/(?:^|,)\s*(?:private|no-store|no-cache)\b/iu.test(record.cacheControl ?? '')) {
    failures.push(`${record.path}: API caching is not disabled`);
  }
}
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), publicOrigin: PUBLIC_ORIGIN,
  acceptanceMode: 'always_rollback',
  decision: failures.length === 0 ? 'technical_acceptance_passed' : 'technical_acceptance_failed',
  protected: protectedRoutes, inquiryProbe: inquiryProbe ?? null, failures,
  rollback: { required: true, onlyHost: '18.163.148.84', action: 'restore_saved_nginx_config_and_reload',
    preserve: ['legacy origin service', '/', '/api/*', '43 database', '43 migrations', '43 local backups'],
    forbidden: ['change DNS', 'change cloud.kai.com', 'rollback database migrations'] } };
const outputPath = resolve(reportValue);
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${failures.length === 0 ? 'PASS' : 'FAIL'} public_route_cutover\nReport: ${outputPath}\n`);
if (failures.length > 0) process.exit(1);
