import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isVpcPrivateIpv4 } from './preflight-host.mjs';

const providerPaths = [
  '/mobile/v1/provider/bootstrap', '/mobile/v1/provider/resources', '/mobile/v1/provider/offer-drafts',
  '/mobile/v1/provider/offers', '/mobile/v1/provider/listings',
];
const paths = [
  '/mobile/v1/health', '/mobile/v1/readiness', '/privacy', '/terms', '/account/delete', ...providerPaths,
];

function contentType(response) {
  return ((response.headers.get('content-type') ?? '').split(';')[0] ?? '').trim().toLowerCase();
}

async function fetchRecord(origin, path) {
  const response = await fetch(new URL(path, origin), {
    redirect: 'manual',
    headers: {
      accept: path.startsWith('/mobile/v1/') ? 'application/json' : 'text/html',
      host: 'cloudpay.kai.com',
      'x-forwarded-proto': 'https',
    },
    signal: AbortSignal.timeout(8_000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  return { path, status: response.status, contentType: contentType(response), bytes: body.length, body };
}

function parseJson(record) {
  try { return JSON.parse(record.body.toString('utf8')); } catch { return null; }
}

export async function probeOrigin(rawOrigin) {
  const origin = new URL(rawOrigin);
  if (origin.protocol !== 'http:' || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Sidecar probes require a canonical private HTTP origin.');
  }
  const records = await Promise.all(paths.map((path) => fetchRecord(origin, path)));
  const byPath = Object.fromEntries(records.map((record) => [record.path, record]));
  const failures = [];

  const health = byPath['/mobile/v1/health'];
  const healthBody = parseJson(health);
  if (health.status !== 200 || health.contentType !== 'application/json'
    || healthBody?.ok !== true || healthBody?.service !== 'kai-cloudpay-backend' || healthBody?.apiVersion !== 'mobile/v1') {
    failures.push('/mobile/v1/health: invalid service identity');
  }

  const readiness = byPath['/mobile/v1/readiness'];
  const readinessBody = parseJson(readiness);
  if (readiness.status !== 200 || readiness.contentType !== 'application/json'
    || readinessBody?.ok !== true || readinessBody?.service !== 'kai-cloudpay-backend'
    || readinessBody?.deployment?.ready !== true || readinessBody?.release?.ready !== true
    || !Array.isArray(readinessBody?.deployment?.blockers) || readinessBody.deployment.blockers.length !== 0
    || !Array.isArray(readinessBody?.release?.blockers) || readinessBody.release.blockers.length !== 0) {
    failures.push('/mobile/v1/readiness: deployment or release is not ready');
  }

  for (const [path, marker] of [['/privacy', '隐私政策'], ['/terms', '用户协议'], ['/account/delete', '删除 CloudPay 账户']]) {
    const record = byPath[path];
    const html = record.body.toString('utf8');
    if (record.status !== 200 || record.contentType !== 'text/html' || !html.includes('KAI CloudPay') || !html.includes(marker)) {
      failures.push(`${path}: legal page missing`);
    }
  }

  for (const path of providerPaths) {
    const record = byPath[path];
    const body = parseJson(record);
    if (record.status !== 401 || record.contentType !== 'application/json'
      || body?.ok !== false || typeof body?.error?.code !== 'string') {
      failures.push(`${path}: protected provider API identity missing`);
    }
  }

  return {
    origin: origin.origin,
    ok: failures.length === 0,
    records: records.map(({ body: _body, ...record }) => record),
    signatures: Object.fromEntries(records.map((record) => {
      const body = parseJson(record);
      return [record.path, {
        status: record.status,
        contentType: record.contentType,
        service: body?.service ?? null,
        apiVersion: body?.apiVersion ?? null,
        errorCode: body?.error?.code ?? null,
      }];
    })),
    failures,
  };
}

export function compareProbeSignatures(loopback, edge) {
  const differences = [];
  for (const path of paths) {
    if (JSON.stringify(loopback.signatures[path]) !== JSON.stringify(edge.signatures[path])) differences.push(path);
  }
  return differences;
}

async function main() {
  const values = process.argv.slice(2);
  const privateIpIndex = values.indexOf('--private-ip');
  const reportIndex = values.indexOf('--report');
  const privateIp = privateIpIndex >= 0 ? values[privateIpIndex + 1] : undefined;
  const reportValue = reportIndex >= 0 ? values[reportIndex + 1] : undefined;
  const validShape = values.length === 4 && privateIpIndex >= 0 && reportIndex >= 0
    && privateIp && reportValue && isVpcPrivateIpv4(privateIp);
  if (!validShape) {
    process.stderr.write('Usage: node verify-sidecar.mjs --private-ip 172.31.x.x --report /absolute/sidecar-probe.json\n');
    process.exit(2);
  }

  const reportPath = resolve(reportValue);
  let loopback;
  let edge;
  const executionFailures = [];
  try { loopback = await probeOrigin('http://127.0.0.1:4100'); } catch (error) {
    executionFailures.push(`loopback: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { edge = await probeOrigin(`http://${privateIp}:4154`); } catch (error) {
    executionFailures.push(`private edge: ${error instanceof Error ? error.message : String(error)}`);
  }
  const differences = loopback && edge ? compareProbeSignatures(loopback, edge) : [];
  const readyForAlbTargetRegistration = executionFailures.length === 0 && loopback?.ok === true && edge?.ok === true && differences.length === 0;
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    privateIp,
    readyForAlbTargetRegistration,
    nextStep: readyForAlbTargetRegistration ? 'register_private_target_then_verify_exact_public_routes' : 'keep_alb_routes_unchanged_and_fix_sidecar',
    loopback: loopback ?? null,
    edge: edge ?? null,
    signatureDifferences: differences,
    executionFailures,
  };
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${readyForAlbTargetRegistration ? 'PASS' : 'FAIL'} sidecar_provider_cutover: loopback=${String(loopback?.ok)}, edge=${String(edge?.ok)}, differences=${differences.length}\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
  if (!readyForAlbTargetRegistration) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
