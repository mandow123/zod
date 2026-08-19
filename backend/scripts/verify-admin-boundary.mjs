import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

function parseRoot(argv) {
  if (argv.length === 0) return resolve(import.meta.dirname, '..', '..');
  if (argv.length !== 2 || argv[0] !== '--root' || !argv[1]) {
    throw new Error('Usage: node backend/scripts/verify-admin-boundary.mjs [--root <repository-root>]');
  }
  return resolve(argv[1]);
}

const root = parseRoot(process.argv.slice(2));
const displayRoot = isAbsolute(root) ? root : resolve(root);
const backendRoot = resolve(root, 'backend');
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

function read(relativePath, required = true) {
  const path = resolve(root, relativePath);
  if (!existsSync(path)) {
    if (required) check(`required_file_${relativePath.replaceAll(/[\\/.]/gu, '_')}`, false, 'missing');
    return null;
  }
  return readFileSync(path, 'utf8');
}

function filesBelow(directory, predicate) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return [];
  const result = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && predicate(path)) result.push(path);
    }
  };
  visit(absolute);
  return result.sort();
}

function source(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

const config = read('backend/src/config.ts');
check('admin_auth_default_disabled', Boolean(config)
  && /ADMIN_AUTH_ENABLED:\s*z\.enum\(\[\s*['"]true['"]\s*,\s*['"]false['"]\s*\]\)\.default\(['"]false['"]\)/u.test(config),
'ADMIN_AUTH_ENABLED has an explicit false default');

const adminSourceFiles = filesBelow('backend/src/admin', (path) => /\.(?:ts|js)$/u.test(path));
const adminBuildFiles = filesBelow('backend/dist/admin', (path) => /\.js$/u.test(path));
const buildPresent = existsSync(resolve(backendRoot, 'dist'));
check('admin_source_boundary_present', adminSourceFiles.length > 0, `${adminSourceFiles.length} admin source file(s)`);
check('admin_build_boundary_current', !buildPresent || (
  adminBuildFiles.some((path) => /[\\/]routes\.js$/u.test(path))
  && adminBuildFiles.some((path) => /[\\/]security\.js$/u.test(path))
), buildPresent
  ? `${adminBuildFiles.length} admin build file(s); routes.js and security.js required`
  : 'backend/dist absent; source-only verification');

const routeFiles = [...adminSourceFiles, ...adminBuildFiles].filter((path) => /(?:^|[\\/])routes?\.(?:ts|js)$/u.test(path));
check('admin_route_boundary_present', routeFiles.length > 0, `${routeFiles.length} source/build route file(s)`);

const bearerPatterns = [
  /headers\s*\[\s*['"]authorization['"]\s*\]/iu,
  /headers\.authorization/iu,
  /\bBearer\s+/iu,
  /authorization\s*:\s*['"`]/iu,
];
const bearerFiles = routeFiles.filter((path) => bearerPatterns.some((pattern) => pattern.test(source(relative(root, path)))));
check('admin_routes_reject_bearer_authentication', bearerFiles.length === 0,
  bearerFiles.length ? bearerFiles.map((path) => relative(root, path)).join(', ') : 'no Authorization/Bearer parsing in admin routes');

const routeText = routeFiles.map((path) => source(relative(root, path))).join('\n');
check('admin_routes_use_fixed_session_cookie', routeText.includes('ADMIN_SESSION_COOKIE')
  && routeText.includes('parseCookieHeader') && routeText.includes('requireOpaqueCookie'),
'admin route authentication is cookie based');

const securityFiles = [
  'backend/src/admin/security.ts',
  ...(existsSync(resolve(backendRoot, 'dist/admin/security.js')) ? ['backend/dist/admin/security.js'] : []),
];
const securityText = securityFiles.map((name) => read(name)).filter(Boolean).join('\n');
const hostCookieNames = [...securityText.matchAll(/__Host-[A-Za-z0-9_-]+/gu)].map((match) => match[0]);
const uniqueCookieNames = [...new Set(hostCookieNames)].sort();
const expectedCookieNames = ['__Host-kai_admin_login', '__Host-kai_admin_session'].sort();
check('admin_cookie_names_fixed', JSON.stringify(uniqueCookieNames) === JSON.stringify(expectedCookieNames),
  uniqueCookieNames.length ? uniqueCookieNames.join(', ') : 'no admin cookie names found');
check('admin_cookie_host_prefix_contract', /Path=\//u.test(securityText)
  && /Secure/u.test(securityText) && /HttpOnly/u.test(securityText)
  && /SameSite=Lax/u.test(securityText) && !/;\s*Domain=/iu.test(securityText),
'Secure, HttpOnly, SameSite=Lax, Path=/, no Domain');

const forbiddenFeatures = ['refunds?', 'disputes?', 'invoices?', 'vast'];
const forbiddenRoutePatterns = forbiddenFeatures.flatMap((feature) => [
  new RegExp(`['"]\\/admin\\/v1\\/[^'"]*${feature}`, 'iu'),
  new RegExp(`\\badmin\\.(?:get|post|put|patch|delete|route)\\s*\\([^)]*['"]\\/[^'"]*${feature}`, 'iu'),
]);
const forbiddenRouteFiles = routeFiles.filter((path) => {
  const text = source(relative(root, path));
  return forbiddenRoutePatterns.some((pattern) => pattern.test(text));
});
check('legacy_and_vast_admin_routes_forbidden', forbiddenRouteFiles.length === 0,
  forbiddenRouteFiles.length
    ? forbiddenRouteFiles.map((path) => relative(root, path)).join(', ')
    : 'no refunds/disputes/invoices/Vast admin route declarations');

const appFiles = ['backend/src/app.ts', 'backend/src/server.ts',
  ...['backend/dist/app.js', 'backend/dist/server.js'].filter((path) => existsSync(resolve(root, path)))];
const loggingText = appFiles.map((name) => read(name)).filter(Boolean).join('\n');
const callbackRouteText = routeFiles.map((path) => source(relative(root, path))).join('\n');
const globalRequestLoggingDisabled = /disableRequestLogging\s*:\s*true/u.test(loggingText);
const requestUrlFullyRedacted = /['"]req\.url['"]/u.test(loggingText);
const safeRequestSerializer = /serializers\s*:\s*\{[\s\S]{0,1200}?req\s*:/u.test(loggingText)
  && /(?:split\s*\(\s*['"]\?['"]|URL\s*\(|pathname|sanitize)/iu.test(loggingText);
const callbackLoggingSilent = /(?:get|route)\s*\(\s*['"]\/auth\/callback['"][\s\S]{0,1000}?logLevel\s*:\s*['"]silent['"]/u
  .test(callbackRouteText);
check('oidc_callback_query_not_logged', globalRequestLoggingDisabled || requestUrlFullyRedacted
  || safeRequestSerializer || callbackLoggingSilent,
globalRequestLoggingDisabled ? 'Fastify request logging disabled'
  : requestUrlFullyRedacted ? 'req.url redacted'
    : safeRequestSerializer ? 'safe request serializer present'
      : callbackLoggingSilent ? 'callback route request logging silent'
        : 'no verifiable callback query logging protection');

const secretFileReads = /(?:readFileSync|readFile|openSync)\s*\([^\n]*(?:\.env|process\.env|SECRET|PEPPER|ENCRYPTION_KEY)/iu;
const networkCalls = /\b(?:fetch|https?\.request|https?\.get|Invoke-WebRequest|curl|wget)\s*\(/iu;
const self = readFileSync(new URL(import.meta.url), 'utf8');
check('verifier_does_not_read_environment_secrets', !/process\.env/u.test(self) && !secretFileReads.test(self),
  'no environment or secret-file reads');
check('verifier_has_no_network_access', !networkCalls.test(self), 'no network call primitives');

const failed = checks.filter((item) => !item.pass);
process.stdout.write(`Admin boundary root: ${displayRoot}\n`);
for (const item of checks) {
  process.stdout.write(`${item.pass ? 'PASS' : 'FAIL'} ${item.name}: ${item.detail}\n`);
}
if (failed.length > 0) {
  process.stderr.write(`Admin boundary verification failed with ${failed.length} problem(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Admin boundary verification passed (${checks.length} checks).\n`);
}
