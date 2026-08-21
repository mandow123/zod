import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RESPONSE_BYTES = 64 * 1024;
const WEB_PATHS = ['/', '/healthz', '/mobile/v1/health', '/api/health'];
const API_PATHS = ['/admin/v1/auth/me', '/mobile/v1/health', '/api/health', '/'];
const REPORTABLE_ERROR_CODES = new Set(['NOT_FOUND', 'ADMIN_AUTH_REQUIRED']);
const ROLLBACK = Object.freeze({
  removeOnly: Object.freeze([
    'ingress/cloudpay-admin-web',
    'ingress/cloudpay-admin-api',
  ]),
  preserve: Object.freeze([
    'ingress/cloudpay-mobile-api',
    'deployment/cloudpay-backend',
    'database migrations',
    'admin audit data',
  ]),
});
const CANARY = Object.freeze({
  manifest: 'admin-api-canary.yaml',
  deployment: 'cloudpay-admin-api-canary',
  service: 'cloudpay-admin-api-canary',
  replicas: 1,
  adminAuthEnabled: true,
  imageMustMatchDeployment: 'cloudpay-backend',
  mainService: 'cloudpay-backend',
  ingress: 'cloudpay-admin-api',
});
const TRANSITIONS = Object.freeze({
  stageC: Object.freeze([
    'apply_canary_manifest', 'wait_canary_ready', 'verify_canary_admin_environment',
    'switch_admin_api_ingress_main_to_canary', 'verify_enabled_admin_routes',
  ]),
  stageD: Object.freeze([
    'set_main_admin_auth_enabled_true', 'restart_main_backend', 'wait_main_backend_rollout',
    'verify_every_main_pod_admin_environment', 'switch_admin_api_ingress_canary_to_main',
    'verify_enabled_admin_routes', 'delete_canary_manifest',
  ]),
  emergencyDisable: Object.freeze([
    'set_main_admin_auth_enabled_false', 'restart_main_backend', 'wait_main_backend_rollout',
    'verify_every_main_pod_admin_auth_disabled', 'remove_admin_ingresses', 'delete_canary_manifest',
  ]),
});
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export function parseAdminRoutingArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!['--web-origin', '--api-origin', '--auth-state', '--report'].includes(name)) {
      throw new Error(`Unknown argument: ${String(name)}`);
    }
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    const key = name.slice(2);
    if (parsed[key]) throw new Error(`${name} may be supplied only once`);
    parsed[key] = value;
    index += 1;
  }
  for (const name of ['web-origin', 'api-origin', 'auth-state', 'report']) {
    if (!parsed[name]) throw new Error(`--${name} is required`);
  }
  if (!['disabled', 'enabled'].includes(parsed['auth-state'])) {
    throw new Error('--auth-state must be disabled or enabled');
  }
  if (!isAbsolute(parsed.report)) throw new Error('--report must be an absolute path');
  return parsed;
}

function canonicalHttpsOrigin(rawOrigin, expectedHost) {
  const origin = new URL(rawOrigin);
  if (origin.protocol !== 'https:' || origin.hostname !== expectedHost || origin.username || origin.password
    || origin.port || origin.pathname !== '/' || origin.search || origin.hash
    || ![origin.origin, `${origin.origin}/`].includes(rawOrigin)) {
    throw new Error(`Expected canonical HTTPS origin for ${expectedHost}`);
  }
  return origin.origin;
}

function contentType(response) {
  return ((response.headers.get('content-type') ?? '').split(';')[0] ?? '').trim().toLowerCase();
}

async function boundedBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('response exceeds canary limit');
  }
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('response exceeds canary limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fetchRecord(fetchImplementation, origin, path, accept) {
  const url = new URL(path, origin);
  if (url.search || url.hash) throw new Error('canary paths must not contain query or fragment');
  const response = await fetchImplementation(url, {
    redirect: 'manual',
    headers: { accept },
    signal: AbortSignal.timeout(12_000),
  });
  return {
    path,
    status: response.status,
    contentType: contentType(response),
    headers: response.headers,
    body: await boundedBody(response),
  };
}

function parseJson(record) {
  try { return JSON.parse(record.body.toString('utf8')); } catch { return null; }
}

function backendErrorCode(record) {
  const body = parseJson(record);
  const error = body && typeof body === 'object' && !Array.isArray(body) ? body.error : null;
  if (body?.ok !== false || !error || typeof error !== 'object' || Array.isArray(error)
    || typeof error.code !== 'string' || !REPORTABLE_ERROR_CODES.has(error.code)
    || typeof error.message !== 'string' || typeof error.requestId !== 'string'
    || error.requestId.length < 1 || error.requestId.length > 200) return null;
  return error.code;
}

function securityHeaderChecks(record) {
  const csp = record.headers.get('content-security-policy') ?? '';
  const hsts = record.headers.get('strict-transport-security') ?? '';
  const permissions = record.headers.get('permissions-policy') ?? '';
  const cacheControl = record.headers.get('cache-control') ?? '';
  return Object.freeze({
    contentSecurityPolicy: csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'")
      && csp.includes("object-src 'none'"),
    strictTransportSecurity: /^max-age=(?:[3-9]\d{7}|[1-9]\d{8,});\s*includeSubDomains$/iu.test(hsts),
    contentTypeOptions: record.headers.get('x-content-type-options')?.toLowerCase() === 'nosniff',
    referrerPolicy: record.headers.get('referrer-policy')?.toLowerCase() === 'no-referrer',
    permissionsPolicy: ['camera=()', 'geolocation=()', 'microphone=()', 'payment=()', 'usb=()']
      .every((directive) => permissions.includes(directive)),
    frameOptions: record.headers.get('x-frame-options')?.toUpperCase() === 'DENY',
    noStore: cacheControl.toLowerCase().includes('no-store'),
  });
}

function publicRecord(record) {
  if (!record) return null;
  return {
    path: record.path,
    status: record.status,
    contentType: record.contentType,
  };
}

function isAdminSpa(record) {
  if (!record || record.status !== 200 || record.contentType !== 'text/html') return false;
  const html = record.body.toString('utf8');
  return html.includes('<title>KAI 管理控制台</title>') && html.includes('<div id="root"></div>');
}

function routingContractIsExact(contract) {
  return contract?.schemaVersion === 1
    && contract.web?.host === 'admin.kai.com' && contract.web?.path === '/'
    && contract.web?.pathType === 'Prefix' && contract.web?.service === 'cloudpay-admin-web'
    && contract.web?.tlsSecret === 'cloudpay-admin-kai-com-tls'
    && contract.api?.host === 'admin-api.kai.com' && contract.api?.path === '/admin/v1'
    && contract.api?.pathType === 'Prefix' && contract.api?.service === 'cloudpay-backend'
    && contract.api?.tlsSecret === 'cloudpay-admin-api-kai-com-tls'
    && JSON.stringify(contract.canary) === JSON.stringify(CANARY)
    && JSON.stringify(contract.transitions) === JSON.stringify(TRANSITIONS)
    && JSON.stringify(contract.rollback?.removeOnly) === JSON.stringify(ROLLBACK.removeOnly)
    && JSON.stringify(contract.rollback?.preserve) === JSON.stringify(ROLLBACK.preserve);
}

export async function verifyAdminRouting(options) {
  const webOrigin = canonicalHttpsOrigin(options.webOrigin, 'admin.kai.com');
  const apiOrigin = canonicalHttpsOrigin(options.apiOrigin, 'admin-api.kai.com');
  if (!['disabled', 'enabled'].includes(options.authState)) throw new Error('invalid administrator authentication state');
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const contract = options.routingContract ?? JSON.parse(
    await readFile(resolve(moduleDirectory, 'admin-routing-contract.json'), 'utf8'),
  );
  const records = { web: {}, api: {} };
  const requestFailures = [];

  await Promise.all([
    ...WEB_PATHS.map(async (path) => {
      try {
        records.web[path] = await fetchRecord(fetchImplementation, webOrigin, path, 'text/html');
      } catch { requestFailures.push(`web${path}:request_failed`); }
    }),
    ...API_PATHS.map(async (path) => {
      try {
        records.api[path] = await fetchRecord(fetchImplementation, apiOrigin, path, 'application/json');
      } catch { requestFailures.push(`api${path}:request_failed`); }
    }),
  ]);

  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  check('routing_contract_exact', routingContractIsExact(contract), 'fixed hosts, path prefixes and rollback boundary');
  check('all_probes_completed', requestFailures.length === 0, `${WEB_PATHS.length + API_PATHS.length - requestFailures.length}/${WEB_PATHS.length + API_PATHS.length} probes`);

  const webRoot = records.web['/'];
  const webHealth = records.web['/healthz'];
  check('admin_web_identity', isAdminSpa(webRoot), 'HTTPS administrator SPA shell');
  check('admin_web_health', webHealth?.status === 200 && webHealth.contentType === 'text/plain'
    && webHealth.body.equals(Buffer.from('ok\n')), 'GET /healthz returns the fixed health response');
  for (const [name, record] of [['root', webRoot], ['health', webHealth]]) {
    const headers = record ? securityHeaderChecks(record) : {};
    check(`admin_web_${name}_security_headers`, Object.values(headers).length === 7
      && Object.values(headers).every(Boolean), 'CSP, HSTS, nosniff, referrer, permissions, frame and no-store');
  }

  const authMe = records.api['/admin/v1/auth/me'];
  const expectedAuthStatus = options.authState === 'disabled' ? 404 : 401;
  const expectedAuthCode = options.authState === 'disabled' ? 'NOT_FOUND' : 'ADMIN_AUTH_REQUIRED';
  const authErrorCode = authMe ? backendErrorCode(authMe) : null;
  check('admin_api_unauthenticated_contract', authMe?.status === expectedAuthStatus
    && authMe.contentType === 'application/json' && authErrorCode === expectedAuthCode
    && !authMe.headers.has('set-cookie'), `${options.authState}: ${expectedAuthStatus} ${expectedAuthCode} backend envelope`);

  for (const path of ['/mobile/v1/health', '/api/health']) {
    check(`admin_web_scope_${path.replaceAll('/', '_')}`, isAdminSpa(records.web[path]),
      'administrator host remains the administrator SPA, not mobile or legacy service');
  }
  for (const path of ['/mobile/v1/health', '/api/health', '/']) {
    const record = records.api[path];
    check(`admin_api_scope_${path.replaceAll('/', '_') || '_root'}`, record?.status === 404
      && backendErrorCode(record) !== 'ADMIN_AUTH_REQUIRED' && !record?.headers.has('set-cookie'),
    'administrator API ingress does not expose mobile or legacy paths');
  }

  const failures = [
    ...requestFailures.sort(),
    ...checks.filter((item) => !item.pass).map((item) => item.name),
  ];
  const ok = failures.length === 0;
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    authState: options.authState,
    ok,
    decision: ok ? 'keep_admin_routes' : 'remove_admin_routes',
    rollback: ok ? null : {
      removeOnly: [...ROLLBACK.removeOnly],
      preserve: [...ROLLBACK.preserve],
      reason: 'Administrator web, API authentication or host isolation canary failed.',
    },
    checks,
    probes: {
      web: WEB_PATHS.map((path) => publicRecord(records.web[path])),
      api: API_PATHS.map((path) => ({ ...publicRecord(records.api[path]),
        errorCode: records.api[path] ? backendErrorCode(records.api[path]) : null })),
    },
    failures,
  };
}

export async function writeImmutableAdminRoutingReport(path, report) {
  if (!isAbsolute(path)) throw new Error('administrator routing report path must be absolute');
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return outputPath;
}

async function main() {
  let args;
  try { args = parseAdminRoutingArguments(process.argv.slice(2)); } catch {
    process.stderr.write('Usage: node verify-admin-routing.mjs --web-origin https://admin.kai.com --api-origin https://admin-api.kai.com --auth-state <disabled|enabled> --report /absolute/admin-routing-report.json\n');
    process.exit(2);
  }
  const report = await verifyAdminRouting({
    webOrigin: args['web-origin'],
    apiOrigin: args['api-origin'],
    authState: args['auth-state'],
  });
  const outputPath = await writeImmutableAdminRoutingReport(args.report, report);
  process.stdout.write(`${report.ok ? 'PASS' : 'FAIL'} admin_route_canary: decision=${report.decision}\n`);
  process.stdout.write(`Report: ${outputPath}\n`);
  if (!report.ok) process.exit(1);
}

if (process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
