import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const BUNDLE_DIRECTORY = 'kai-admin-web';
export const MANIFEST_FILE = 'RELEASE-MANIFEST.sha256';
export const METADATA_FILE = 'RELEASE-METADATA.json';

const REQUIRED_FILES = [
  'Dockerfile',
  'README.md',
  'default.conf.template',
  'dist/.admin-api-origin',
  'dist/index.html',
  'package-lock.json',
  'package.json',
  'scripts/release-lib.mjs',
  'scripts/verify-release.mjs',
  METADATA_FILE,
];

const STATIC_RELEASE_FILES = new Set([
  'Dockerfile',
  'README.md',
  'default.conf.template',
  'index.html',
  'package-lock.json',
  'package.json',
  'scripts/release-lib.d.mts',
  'scripts/release-lib.mjs',
  'scripts/verify-release.mjs',
  'tsconfig.app.json',
  'tsconfig.json',
  'vite.config.mjs',
  METADATA_FILE,
]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\b(?:client_secret|private_key|database_password)\s*[:=]\s*["'][^"'\n]{8,}["']/iu,
];

export function canonicalHttpsOrigin(value, name = 'origin') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must not contain whitespace or control characters`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || value !== parsed.origin
  ) {
    throw new Error(`${name} must be one canonical HTTPS origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

export function assertReleasePath(relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.includes('\\')
    || relativePath.startsWith('/')
    || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe release path: ${relativePath}`);
  }

  const parts = relativePath.toLowerCase().split('/');
  if (
    parts.includes('node_modules')
    || parts.includes('test')
    || parts.includes('tests')
    || parts.includes('__tests__')
    || parts.some((part) => part === '.env' || part.startsWith('.env.'))
    || parts.some((part) => part.includes('demo-api') || part.includes('fixture') || part.includes('mock'))
  ) {
    throw new Error(`forbidden production release path: ${relativePath}`);
  }

  if (
    !STATIC_RELEASE_FILES.has(relativePath)
    && !relativePath.startsWith('src/')
    && !relativePath.startsWith('dist/')
  ) {
    throw new Error(`unexpected production release path: ${relativePath}`);
  }
  if (relativePath.endsWith('.map')) {
    throw new Error(`source maps are forbidden in the production release: ${relativePath}`);
  }
  return relativePath;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function formatManifest(records) {
  const sorted = [...records].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const seen = new Set();
  return `${sorted.map(({ digest, path: recordPath }) => {
    assertReleasePath(recordPath);
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`invalid SHA-256 for ${recordPath}`);
    if (seen.has(recordPath)) throw new Error(`duplicate manifest path: ${recordPath}`);
    seen.add(recordPath);
    return `${digest}  ${recordPath}`;
  }).join('\n')}\n`;
}

export async function listFiles(rootDirectory) {
  const result = [];
  async function visit(relativeDirectory) {
    const absoluteDirectory = path.join(rootDirectory, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory.split(path.sep).join('/'), entry.name);
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile()) result.push(relativePath);
      else throw new Error(`release contains a non-regular entry: ${relativePath}`);
    }
  }
  await visit('');
  return result;
}

function assertNoSecret(filePath, bytes) {
  if (bytes.includes(0)) return;
  const text = bytes.toString('utf8');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error(`possible secret material in ${filePath}`);
  }
}

export async function createManifest(rootDirectory) {
  const files = (await listFiles(rootDirectory)).filter((file) => file !== MANIFEST_FILE);
  const records = [];
  for (const file of files) {
    assertReleasePath(file);
    const bytes = await readFile(path.join(rootDirectory, file));
    assertNoSecret(file, bytes);
    records.push({ path: file, digest: sha256(bytes) });
  }
  return formatManifest(records);
}

function parseManifest(value) {
  if (!value.endsWith('\n')) throw new Error(`${MANIFEST_FILE} must end with a newline`);
  const records = value.slice(0, -1).split('\n').map((line) => {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match) throw new Error(`malformed manifest line: ${line}`);
    return { digest: match[1], path: assertReleasePath(match[2]) };
  });
  const normalized = formatManifest(records);
  if (normalized !== value) throw new Error(`${MANIFEST_FILE} must be sorted and contain unique paths`);
  return records;
}

function assertDeploymentContract(dockerfile, nginxTemplate) {
  const dockerRequirements = [
    'ARG VITE_ADMIN_API_ORIGIN',
    'ENV VITE_ADMIN_API_ORIGIN=${VITE_ADMIN_API_ORIGIN}',
    'ADMIN_API_ORIGIN',
    '.admin-api-origin',
    'test \\"$value\\" = \\"$(cat /usr/share/nginx/html/.admin-api-origin)\\"',
    "envsubst '$ADMIN_API_ORIGIN'",
    'USER nginx',
  ];
  for (const required of dockerRequirements) {
    if (!dockerfile.includes(required)) throw new Error(`Dockerfile is missing release contract: ${required}`);
  }
  if (!nginxTemplate.includes("connect-src 'self' ${ADMIN_API_ORIGIN}")) {
    throw new Error('nginx template does not bind CSP connect-src to ADMIN_API_ORIGIN');
  }
}

export async function verifyRelease(rootDirectory, options = {}) {
  const absoluteRoot = path.resolve(rootDirectory);
  const manifestText = await readFile(path.join(absoluteRoot, MANIFEST_FILE), 'utf8');
  const records = parseManifest(manifestText);
  const manifestPaths = records.map((record) => record.path);
  const actualPaths = (await listFiles(absoluteRoot)).filter((file) => file !== MANIFEST_FILE);
  if (JSON.stringify(manifestPaths) !== JSON.stringify(actualPaths)) {
    throw new Error('release file set does not match the manifest');
  }
  for (const required of REQUIRED_FILES) {
    if (!manifestPaths.includes(required)) throw new Error(`release is missing ${required}`);
  }

  for (const record of records) {
    const bytes = await readFile(path.join(absoluteRoot, record.path));
    assertNoSecret(record.path, bytes);
    if (sha256(bytes) !== record.digest) throw new Error(`SHA-256 mismatch: ${record.path}`);
  }

  const metadata = JSON.parse(await readFile(path.join(absoluteRoot, METADATA_FILE), 'utf8'));
  if (metadata.schemaVersion !== 1 || metadata.artifact !== 'kai-admin-web') {
    throw new Error('unsupported release metadata');
  }
  const buildOrigin = canonicalHttpsOrigin(metadata.viteAdminApiOrigin, 'release VITE_ADMIN_API_ORIGIN');
  const marker = (await readFile(path.join(absoluteRoot, 'dist/.admin-api-origin'), 'utf8')).trimEnd();
  if (marker !== buildOrigin) throw new Error('dist build-origin marker does not match release metadata');

  const expectedOrigin = options.expectedOrigin;
  if (expectedOrigin !== undefined && canonicalHttpsOrigin(expectedOrigin, 'ADMIN_API_ORIGIN') !== buildOrigin) {
    throw new Error('ADMIN_API_ORIGIN does not exactly match the release VITE_ADMIN_API_ORIGIN');
  }
  if (options.requireExpectedOrigin && expectedOrigin === undefined) {
    throw new Error('ADMIN_API_ORIGIN is required to verify the runtime/build origin contract');
  }

  const packageJson = JSON.parse(await readFile(path.join(absoluteRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(path.join(absoluteRoot, 'package-lock.json'), 'utf8'));
  const lockRoot = packageLock.packages?.[''];
  if (
    !lockRoot
    || JSON.stringify(packageJson.dependencies ?? {}) !== JSON.stringify(lockRoot.dependencies ?? {})
    || JSON.stringify(packageJson.devDependencies ?? {}) !== JSON.stringify(lockRoot.devDependencies ?? {})
  ) {
    throw new Error('package.json dependencies do not exactly match the lockfile root');
  }

  const dockerfile = await readFile(path.join(absoluteRoot, 'Dockerfile'), 'utf8');
  const nginxTemplate = await readFile(path.join(absoluteRoot, 'default.conf.template'), 'utf8');
  assertDeploymentContract(dockerfile, nginxTemplate);

  const builtFiles = manifestPaths.filter((file) => file.startsWith('dist/') && file !== 'dist/.admin-api-origin');
  let compiledOriginFound = false;
  for (const file of builtFiles) {
    const bytes = await readFile(path.join(absoluteRoot, file));
    if (!bytes.includes(0) && bytes.toString('utf8').includes(buildOrigin)) compiledOriginFound = true;
  }
  if (!compiledOriginFound) throw new Error('compiled admin Web assets do not contain VITE_ADMIN_API_ORIGIN');

  return { buildOrigin, fileCount: records.length };
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`tar header field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) throw new Error(`tar numeric field overflow: ${value}`);
  writeString(buffer, offset, length, `${encoded}\0`);
}

function tarPathFields(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  for (let split = name.lastIndexOf('/'); split > 0; split = name.lastIndexOf('/', split - 1)) {
    const prefix = name.slice(0, split);
    const base = name.slice(split + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) return { name: base, prefix };
  }
  throw new Error(`release path is too long for ustar: ${name}`);
}

function tarHeader(name, size, type, mode) {
  const header = Buffer.alloc(512);
  const fields = tarPathFields(name);
  writeString(header, 0, 100, fields.name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, type);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, fields.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

export async function createDeterministicTarGzip(rootDirectory) {
  const files = await listFiles(rootDirectory);
  const directories = new Set([BUNDLE_DIRECTORY]);
  for (const file of files) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`${BUNDLE_DIRECTORY}/${parts.slice(0, index).join('/')}`);
    }
  }
  const chunks = [];
  for (const directory of [...directories].sort((left, right) => left.localeCompare(right, 'en'))) {
    chunks.push(tarHeader(`${directory}/`, 0, '5', 0o755));
  }
  for (const file of files) {
    const bytes = await readFile(path.join(rootDirectory, file));
    const executable = file.startsWith('scripts/') && file.endsWith('.mjs');
    chunks.push(tarHeader(`${BUNDLE_DIRECTORY}/${file}`, bytes.length, '0', executable ? 0o755 : 0o644));
    chunks.push(bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}
