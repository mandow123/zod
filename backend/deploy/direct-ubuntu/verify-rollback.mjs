import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PUBLIC_ORIGIN = 'https://cloudpay.kai.com';
const DIRECT_ORIGIN = 'http://18.163.148.84:8081';
const CLOUD_KAI_ORIGIN = 'https://cloud.kai.com';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function record(origin, path) {
  const host = origin === DIRECT_ORIGIN ? 'cloudpay.kai.com' : new URL(origin).host;
  const response = await fetch(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(10_000),
    headers: { accept: path === '/' ? 'text/html' : 'application/json', host } });
  const body = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(body.toString('utf8')); } catch {}
  return { status: response.status, contentType: (response.headers.get('content-type') ?? '').split(';')[0],
    bytes: body.length, sha256: sha256(body), json };
}
const same = (left, right) => left?.status === right?.status && left?.contentType === right?.contentType
  && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
const validLegacyMobileHealth = (value) => value?.status === 200 && value?.contentType === 'application/json'
  && value?.json?.ok === true && value?.json?.service === 'kai-cloudpay-backend'
  && value?.json?.apiVersion === 'mobile/v1' && Number.isFinite(Date.parse(value?.json?.time));
const [origin, baselineValue, reportValue] = process.argv.slice(2);
if (origin !== PUBLIC_ORIGIN || !baselineValue || !reportValue) {
  process.stderr.write('Usage: verify-rollback.mjs https://cloudpay.kai.com /absolute/baseline.json /absolute/report.json\n');
  process.exit(2);
}
const baseline = JSON.parse(await readFile(resolve(baselineValue), 'utf8'));
const [publicRoot, directRoot, publicApi, directApi, publicMobile, directMobile,
  publicMobileMarket, directMobileMarket, cloudKaiRoot] = await Promise.all([
  record(PUBLIC_ORIGIN, '/'), record(DIRECT_ORIGIN, '/'), record(PUBLIC_ORIGIN, '/api/health'),
  record(DIRECT_ORIGIN, '/api/health'), record(PUBLIC_ORIGIN, '/mobile/v1/health'),
  record(DIRECT_ORIGIN, '/mobile/v1/health'), record(PUBLIC_ORIGIN, '/mobile/v1/market/resources'),
  record(DIRECT_ORIGIN, '/mobile/v1/market/resources'), record(CLOUD_KAI_ORIGIN, '/'),
]);
const failures = [];
if (!same(publicRoot, baseline.protected?.root?.public) || !same(directRoot, baseline.protected?.root?.direct)
  || !same(publicRoot, directRoot)) failures.push('legacy root was not restored');
if (!same(publicApi, baseline.protected?.apiHealth?.public) || !same(directApi, baseline.protected?.apiHealth?.direct)
  || !same(publicApi, directApi)) failures.push('legacy /api/health was not restored');
if (!validLegacyMobileHealth(publicMobile) || !validLegacyMobileHealth(directMobile)
  || !same(publicMobileMarket, baseline.protected?.mobileMarket?.public)
  || !same(directMobileMarket, baseline.protected?.mobileMarket?.direct)
  || !same(publicMobileMarket, directMobileMarket) || publicMobileMarket.status !== 404) {
  failures.push('legacy mobile auth-only routes were not restored');
}
if (!same(cloudKaiRoot, baseline.protected?.cloudKaiRoot)) failures.push('cloud.kai.com changed');
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), rollbackVerified: failures.length === 0,
  acceptanceMode: 'always_rollback',
  scope: { restoredHost: '18.163.148.84', restoredArtifact: 'saved_nginx_config', reloadRequired: true },
  preserved: ['18 legacy service', '43 inquiry backend', '43 database', '43 migrations', '43 local backups'],
  unchanged: ['DNS', 'cloud.kai.com'], cleanupEvidence: {
    probeTestFamily: 'requires_remote_revocation_confirmation', appSession: 'requires_device_and_auth_cleanup',
    noCredentialCleanupClaimWithoutEvidence: true,
  }, failures };
const outputPath = resolve(reportValue);
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${failures.length === 0 ? 'PASS' : 'FAIL'} nginx_rollback\nReport: ${outputPath}\n`);
if (failures.length > 0) process.exit(1);
