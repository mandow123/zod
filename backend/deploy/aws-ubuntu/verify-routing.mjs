import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [mode, rawOrigin, baselinePath] = process.argv.slice(2);
if (!['capture', 'verify'].includes(mode ?? '') || !rawOrigin || !baselinePath) {
  process.stderr.write('Usage: node verify-routing.mjs <capture|verify> <https-origin> <baseline.json>\n');
  process.exit(2);
}

const origin = new URL(rawOrigin);
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('Origin must be a canonical HTTPS origin, for example https://cloudpay.kai.com');
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const contentType = (response) => ((response.headers.get('content-type') ?? '').split(';')[0] ?? '').trim().toLowerCase();

async function fetchRecord(path) {
  const response = await fetch(new URL(path, origin), {
    redirect: 'manual',
    headers: { accept: path.startsWith('/mobile/v1/') || path.startsWith('/api/') ? 'application/json' : 'text/html' },
    signal: AbortSignal.timeout(12_000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  return { path, status: response.status, contentType: contentType(response), bytes: body.length, sha256: sha256(body), body };
}

function publicRecord(record) {
  const { body: _body, ...rest } = record;
  return rest;
}

const protectedPaths = ['/', '/api/health'];
if (mode === 'capture') {
  const records = await Promise.all(protectedPaths.map(fetchRecord));
  const baseline = {
    schemaVersion: 1,
    origin: origin.origin,
    capturedAt: new Date().toISOString(),
    protected: Object.fromEntries(records.map((record) => [record.path, publicRecord(record)])),
  };
  const outputPath = resolve(baselinePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`Captured protected production routes in ${outputPath}\n`);
  process.stdout.write(`${JSON.stringify(baseline.protected, null, 2)}\n`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
if (baseline.schemaVersion !== 1 || baseline.origin !== origin.origin) throw new Error('Baseline does not match this origin.');

const protectedProviderPaths = [
  '/mobile/v1/provider/bootstrap', '/mobile/v1/provider/resources', '/mobile/v1/provider/offer-drafts',
  '/mobile/v1/provider/offers', '/mobile/v1/provider/listings',
];
const [root, legacyApi, health, readiness, privacy, terms, deletion, ...providerProbes] = await Promise.all([
  fetchRecord('/'), fetchRecord('/api/health'), fetchRecord('/mobile/v1/health'), fetchRecord('/mobile/v1/readiness'),
  fetchRecord('/privacy'), fetchRecord('/terms'), fetchRecord('/account/delete'), ...protectedProviderPaths.map(fetchRecord),
]);

const failures = [];
for (const record of [root, legacyApi]) {
  const before = baseline.protected?.[record.path];
  if (!before) failures.push(`${record.path}: missing baseline`);
  else if (record.status !== before.status || record.contentType !== before.contentType || record.sha256 !== before.sha256) {
    failures.push(`${record.path}: existing route changed`);
  }
}

let healthBody;
try { healthBody = JSON.parse(health.body.toString('utf8')); } catch { healthBody = null; }
if (health.status !== 200 || health.contentType !== 'application/json' || healthBody?.service !== 'kai-cloudpay-backend') {
  failures.push('/mobile/v1/health: not served by kai-cloudpay-backend');
}

let readinessBody;
try { readinessBody = JSON.parse(readiness.body.toString('utf8')); } catch { readinessBody = null; }
if (readiness.status !== 200 || readiness.contentType !== 'application/json'
  || readinessBody?.deployment?.ready !== true || readinessBody?.release?.ready !== true
  || !Array.isArray(readinessBody?.release?.blockers) || readinessBody.release.blockers.length !== 0) {
  failures.push(`/mobile/v1/readiness: production release is not ready (${JSON.stringify(readinessBody?.release ?? null)})`);
}

for (const [record, marker] of [[privacy, '隐私政策'], [terms, '用户协议'], [deletion, '删除 CloudPay 账户']]) {
  const html = record.body.toString('utf8');
  if (record.status !== 200 || record.contentType !== 'text/html' || !html.includes('KAI CloudPay') || !html.includes(marker)) {
    failures.push(`${record.path}: CloudPay legal page is missing`);
  }
}

for (const record of providerProbes) {
  let body;
  try { body = JSON.parse(record.body.toString('utf8')); } catch { body = null; }
  if (record.status !== 401 || record.contentType !== 'application/json'
    || body?.ok !== false || typeof body?.error?.code !== 'string') {
    failures.push(`${record.path}: protected provider route is not served by CloudPay JSON API`);
  }
}

const report = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  decision: failures.length === 0 ? 'keep_mobile_routes' : 'remove_mobile_routes',
  rollback: failures.length === 0 ? null : {
    removeOnly: ['/mobile/v1', '/mobile/v1/*', '/privacy', '/terms', '/account/delete'],
    preserve: ['/', '/api/*', 'database migrations'],
    reason: 'The mobile cutover did not pass every old-site, readiness, legal-page and provider-route check.',
  },
  protected: [publicRecord(root), publicRecord(legacyApi)],
  mobile: [publicRecord(health), publicRecord(readiness), publicRecord(privacy), publicRecord(terms), publicRecord(deletion),
    ...providerProbes.map(publicRecord)],
  failures,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) process.exit(1);
