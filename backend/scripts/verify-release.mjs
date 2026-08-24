import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationNamePattern = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;
const appleMetadataPattern = /(?:^|\/)(?:\._[^/]*|__MACOSX|\.AppleDouble)(?:\/|$)|\.\.namedfork\/rsrc/u;
const installDependencies = process.argv.includes('--install');
const manifestPath = join(releaseRoot, 'RELEASE-MANIFEST.json');
const failures = [];
const passes = [];

function pass(name, detail) {
  passes.push({ name, detail });
  process.stdout.write(`PASS ${name}: ${detail}\n`);
}

function fail(name, detail) {
  failures.push({ name, detail });
  process.stderr.write(`FAIL ${name}: ${detail}\n`);
}

function run(binary, args, options = {}) {
  return spawnSync(binary, args, { cwd: releaseRoot, encoding: 'utf8', ...options });
}

function versionAtLeast(actual, minimum) {
  const left = actual.split('.').map(Number);
  const right = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

if (!existsSync(manifestPath)) {
  fail('release_manifest', `${basename(manifestPath)} is missing`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const minimumNode = String(manifest.node ?? '').match(/(\d+\.\d+\.\d+)/u)?.[1];
if (minimumNode && versionAtLeast(process.versions.node, minimumNode)) pass('node_version', process.versions.node);
else fail('node_version', `${process.versions.node}; requires ${manifest.node ?? 'a declared minimum'}`);

const badFiles = [];
for (const [name, expected] of Object.entries(manifest.files ?? {})) {
  const path = join(releaseRoot, name);
  if (!existsSync(path)) {
    badFiles.push(`${name} (missing)`);
    continue;
  }
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== expected) badFiles.push(`${name} (digest mismatch)`);
}
if (badFiles.length === 0) pass('release_files', `${Object.keys(manifest.files ?? {}).length} digests matched`);
else fail('release_files', badFiles.slice(0, 8).join(', '));

const forbiddenEntries = readdirSync(releaseRoot).filter((name) =>
  (name.startsWith('.env') && name !== '.env.example') || /(?:secret|credential|private.*key)/iu.test(name));
if (forbiddenEntries.length === 0) pass('no_release_secrets', 'no environment or credential files');
else fail('no_release_secrets', forbiddenEntries.join(', '));

function entriesUnder(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [name, ...entriesUnder(join(directory, entry.name), name)] : [name];
  });
}
const releaseEntries = entriesUnder(releaseRoot);
const appleMetadata = releaseEntries.filter((name) => appleMetadataPattern.test(name));
if (appleMetadata.length === 0) pass('no_appledouble_or_resource_forks', 'release tree is metadata-clean');
else fail('no_appledouble_or_resource_forks', appleMetadata.slice(0, 8).join(', '));

const migrationEntries = readdirSync(join(releaseRoot, 'migrations'));
const forbiddenMigrations = migrationEntries.filter((name) => name.startsWith('._')
  || (name.endsWith('.sql') && !migrationNamePattern.test(name))).sort();
if (forbiddenMigrations.length > 0) fail('canonical_migration_names', forbiddenMigrations.join(', '));
else pass('canonical_migration_names', 'only four-digit canonical SQL names');
const migrations = migrationEntries.filter((name) => migrationNamePattern.test(name)).sort();
if (migrations.length === manifest.migrationCount && migrations.at(-1) === manifest.latestMigration) {
  pass('migration_set', `${migrations.length} migrations through ${migrations.at(-1)}`);
} else {
  fail('migration_set', `${migrations.length} migrations through ${migrations.at(-1) ?? 'none'}`);
}

if (installDependencies && failures.length === 0) {
  const install = run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  if (install.status === 0) pass('production_dependencies', 'clean production install completed');
  else fail('production_dependencies', (install.stderr || install.stdout).trim().split(/\r?\n/u).at(-1) ?? 'npm ci failed');
} else if (!installDependencies) {
  pass('production_dependencies', 'not installed; pass --install for the target-host gate');
}

if (installDependencies && failures.length === 0) {
  const compiledImport = run(process.execPath, ['--input-type=module', '-e', 'import("./dist/app.js")']);
  if (compiledImport.status === 0) pass('compiled_entrypoint', 'dist/app.js loaded from release dependencies');
  else fail('compiled_entrypoint', (compiledImport.stderr || compiledImport.stdout).trim().split(/\r?\n/u).at(-1) ?? 'import failed');

  const gateEnvironment = {
    PATH: process.env.PATH ?? '', NODE_ENV: 'production', PORT: '4100',
    PUBLIC_ORIGIN: 'https://cloudpay.kai.com',
  };
  for (const [name, host, expected] of [
    ['systemd_fail_closed', '127.0.0.1', 'production environment is incomplete'],
    ['container_fail_closed', '0.0.0.0', 'container environment is incomplete'],
  ]) {
    const script = name.startsWith('systemd') ? 'scripts/verify-production-env.mjs' : 'scripts/verify-container-env.mjs';
    const gate = run(process.execPath, [script], { env: { ...gateEnvironment, HOST: host } });
    const output = `${gate.stdout ?? ''}${gate.stderr ?? ''}`;
    if (gate.status === 1 && output.includes(expected)) pass(name, 'incomplete configuration rejected');
    else fail(name, `unexpected exit ${String(gate.status)}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Release verification failed with ${failures.length} problem(s).\n`);
  process.exit(1);
}
process.stdout.write(`Release verification passed (${passes.length} checks).\n`);
