import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const backendRoot = resolve(import.meta.dirname, '..');
const projectRoot = resolve(backendRoot, '..');
const packageJson = JSON.parse(await readFile(join(backendRoot, 'package.json'), 'utf8'));
const releaseName = `KAI-CloudPay-backend-${packageJson.version}-production`;
const outputDirectory = join(projectRoot, 'artifacts', 'release');
const archivePath = join(outputDirectory, `${releaseName}.tar.gz`);
const digestPath = `${archivePath}.sha256`;
const stagingRoot = await mkdtemp(join(tmpdir(), 'cloudpay-backend-release-'));
const stagingDirectory = join(stagingRoot, releaseName);
const migrationNamePattern = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;
const appleMetadataPattern = /(?:^|\/)(?:\._[^/]*|__MACOSX|\.AppleDouble)(?:\/|$)|\.\.namedfork\/rsrc/u;

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: backendRoot, stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await filesUnder(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

try {
  run(process.execPath, ['../scripts/verify-mobile-backend-contract.mjs']);
  // Release verification is intentionally serial. The Postgres/PGlite integration
  // suites are comprehensive and can exceed their per-test budget when 49 files
  // compete for CPU during a mobile build, even though the same tests are healthy.
  run('npm', ['test', '--', '--pool=forks', '--no-file-parallelism', '--maxWorkers=1']);
  run('npm', ['run', 'build']);
  run('npm', ['run', 'deployment:verify']);

  const migrationEntries = await readdir(join(backendRoot, 'migrations'));
  const forbiddenMigrationEntries = migrationEntries.filter((name) => name.startsWith('._')
    || (name.endsWith('.sql') && !migrationNamePattern.test(name))).sort();
  if (forbiddenMigrationEntries.length > 0) {
    throw new Error(`Forbidden migration directory entries: ${forbiddenMigrationEntries.join(', ')}`);
  }
  const migrations = migrationEntries.filter((name) => migrationNamePattern.test(name)).sort();
  const branchMigrations = ['0060_admin_identity_rbac_sessions.sql', '0060_kai_direct_auth_consents.sql'];
  if (migrations.length !== 66
    || new Set(migrations).size !== migrations.length
    || branchMigrations.some((name) => !migrations.includes(name))
    || migrations.at(-1) !== '0065_credit_order_transition_closure.sql') {
    throw new Error(`Expected 66 migrations including both 0060 branch migrations through 0065_credit_order_transition_closure.sql; found ${migrations.length}, latest ${migrations.at(-1) ?? 'none'}.`);
  }

  const included = [
    '.dockerignore', '.env.example', 'Dockerfile', 'README.md', 'package.json', 'package-lock.json',
    'tsconfig.json', 'tsconfig.build.json', 'src', 'dist', 'migrations', 'deploy', 'docs/production-runbook.md',
    'docs/creator-commissions.md',
    'docs/dual-rewards-core.md',
    'docs/honghuan-supplier-inquiry-catalog.md',
    'scripts/build-deployment-bundle.mjs', 'scripts/verify-production-env.mjs',
    'scripts/verify-container-env.mjs', 'scripts/start-production-container.mjs',
    'scripts/record-inquiry-readiness.mjs',
    'scripts/record-inquiry-app-session.mjs',
    'scripts/run-inquiry-readiness-systemd.mjs',
    'scripts/run-private-honghuan-acceptance-systemd.mjs',
    'scripts/rotate-kai-probe-credential.mjs',
    'scripts/kai-probe-credential-core.mjs',
    'scripts/authorize-and-enroll-kai-probe.mjs',
    'scripts/authorize-and-enroll-kai-probe.d.mts',
    'scripts/persist-kai-probe-refresh.mjs',
    'scripts/prepare-kai-probe-revocation.mjs',
    'scripts/revoke-kai-probe-family.mjs',
    'scripts/finalize-kai-probe-revocation.mjs',
    'scripts/verify-release.mjs', 'scripts/verify-deployment-contract.mjs',
  ];
  await mkdir(stagingDirectory, { recursive: true });
  for (const item of included) {
    const source = join(backendRoot, item);
    const destination = join(stagingDirectory, item);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }

  const stagedFiles = await filesUnder(stagingDirectory);
  const manifest = {
    format: 1,
    name: releaseName,
    package: packageJson.name,
    version: packageJson.version,
    node: packageJson.engines?.node,
    migrationCount: migrations.length,
    latestMigration: migrations.at(-1),
    checks: {
      mobileFrontendBackendContract: 'passed',
      fullTestSuite: 'passed',
      productionBuild: 'passed',
      isolatedProductionInstall: 'passed',
      isolatedCompiledEntrypoint: 'passed',
      incompleteContainerEnvironmentRejected: 'passed',
      deploymentConfigurationContract: 'passed',
      sidecarAndOriginPreflightIncluded: 'passed',
      privateSidecarVerificationIncluded: 'passed',
      secretsIncluded: false,
    },
    files: Object.fromEntries(await Promise.all(stagedFiles.map(async (path) => [
      relative(stagingDirectory, path), sha256(await readFile(path)),
    ]))),
  };
  await writeFile(join(stagingDirectory, 'RELEASE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Run the same single command operators will run after extracting the archive.
  const isolatedVerification = spawnSync('npm', ['run', 'release:verify'], {
    cwd: stagingDirectory, encoding: 'utf8',
  });
  if (isolatedVerification.status !== 0) {
    throw new Error(`Target-host release verification failed:\n${isolatedVerification.stderr || isolatedVerification.stdout}`);
  }
  await rm(join(stagingDirectory, 'node_modules'), { recursive: true, force: true });

  await mkdir(outputDirectory, { recursive: true });
  await rm(archivePath, { force: true });
  run('tar', ['--no-xattrs', '-czf', archivePath, '-C', stagingRoot, releaseName], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });

  const archiveEntries = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (archiveEntries.status !== 0) throw new Error(archiveEntries.stderr || 'Unable to inspect deployment archive.');
  const archivePaths = archiveEntries.stdout.split(/\r?\n/u).filter(Boolean);
  const appleMetadata = archivePaths.filter((entry) => appleMetadataPattern.test(entry));
  if (appleMetadata.length > 0) throw new Error(`AppleDouble or resource-fork archive entries: ${appleMetadata.join(', ')}`);
  const forbidden = archivePaths.filter((entry) =>
    /(?:^|\/)(?:node_modules|test|coverage)(?:\/|$)/u.test(entry)
      || (/(?:^|\/)\.env(?:\.|$)/u.test(entry) && !entry.endsWith('/.env.example')),
  );
  if (forbidden.length > 0) throw new Error(`Forbidden release entries: ${forbidden.join(', ')}`);

  const archivedMigrationEntries = archivePaths.filter((entry) => /\/migrations\/[^/]+\.sql$/u.test(entry));
  const forbiddenArchivedMigrations = archivedMigrationEntries.filter((entry) => {
    const name = entry.slice(entry.lastIndexOf('/') + 1);
    return !migrationNamePattern.test(name);
  });
  if (forbiddenArchivedMigrations.length > 0) {
    throw new Error(`Non-canonical archived migrations: ${forbiddenArchivedMigrations.join(', ')}`);
  }
  const archivedMigrations = archivedMigrationEntries.filter((entry) => migrationNamePattern.test(entry.slice(entry.lastIndexOf('/') + 1)));
  if (archivedMigrations.length !== migrations.length
    || !archivePaths.some((entry) => entry.endsWith(`/migrations/${migrations.at(-1)}`))) {
    throw new Error(`Deployment archive migration set is incomplete: ${archivedMigrations.length}/${migrations.length}.`);
  }
  for (const required of [
    'RELEASE-MANIFEST.json', 'deploy/direct-ubuntu/verify-routing.mjs',
    'deploy/direct-ubuntu/preflight-sidecar.mjs', 'deploy/direct-ubuntu/preflight-origin.mjs',
    'deploy/direct-ubuntu/verify-sidecar.mjs', 'deploy/direct-ubuntu/verify-nginx-config.mjs',
    'deploy/direct-ubuntu/verify-rollback.mjs', 'deploy/direct-ubuntu/verify-paired-probe-systemd.mjs',
    'deploy/direct-ubuntu/acceptance-watchdog-policy.mjs',
    'deploy/direct-ubuntu/cloudpay-mobile-nginx-routes.conf',
    'scripts/verify-production-env.mjs', 'scripts/verify-container-env.mjs',
    'scripts/start-production-container.mjs', 'scripts/verify-release.mjs',
    'scripts/record-inquiry-readiness.mjs',
    'scripts/record-inquiry-app-session.mjs',
    'scripts/run-inquiry-readiness-systemd.mjs',
    'scripts/run-private-honghuan-acceptance-systemd.mjs',
    'scripts/rotate-kai-probe-credential.mjs',
    'scripts/kai-probe-credential-core.mjs',
    'scripts/authorize-and-enroll-kai-probe.mjs',
    'deploy/direct-ubuntu/enroll-probe-refresh-credential.mjs',
    'deploy/direct-ubuntu/full-commerce-gate-core.mjs',
    'deploy/direct-ubuntu/qixiang-evidence-trust-policy.mjs',
    'deploy/direct-ubuntu/qixiang-production-evidence-core.mjs',
    'deploy/direct-ubuntu/assert-full-commerce-runtime.mjs',
    'deploy/direct-ubuntu/verify-qixiang-production-evidence.mjs',
    'deploy/direct-ubuntu/preflight-full-commerce.mjs',
    'deploy/direct-ubuntu/cloudpay-mobile-backend-commerce-credentials.conf',
    'deploy/direct-ubuntu/cloudpay-mobile-qixiang-gate-refresh.service',
    'deploy/direct-ubuntu/cloudpay-mobile-qixiang-gate-refresh.timer',
    'deploy/direct-ubuntu/enroll-qixiang-commerce-credentials.mjs',
    'deploy/direct-ubuntu/enroll-qixiang-technical-canary-credentials.mjs',
    'deploy/direct-ubuntu/issue-qixiang-technical-canary-gate.mjs',
    'deploy/direct-ubuntu/cloudpay-mobile-qixiang-technical-canary-gate-refresh.service',
    'deploy/direct-ubuntu/cloudpay-mobile-qixiang-technical-canary-gate-refresh.timer',
    'scripts/persist-kai-probe-refresh.mjs',
    'scripts/prepare-kai-probe-revocation.mjs',
    'scripts/revoke-kai-probe-family.mjs',
    'scripts/finalize-kai-probe-revocation.mjs',
    'scripts/verify-deployment-contract.mjs',
  ]) {
    if (!archivePaths.some((entry) => entry.endsWith(`/${required}`))) throw new Error(`Deployment archive is missing ${required}.`);
  }

  const sourceFiles = stagedFiles.filter((path) => {
    const name = relative(stagingDirectory, path);
    return /^(?:src|dist|deploy)\//u.test(name) && /\.(?:js|mjs|ts|json)$/u.test(name);
  });
  const forbiddenSourceMarkers = ['/__e2e/', '10.0.2.2:4100', 'CLOUDPAY_LOCAL_E2E_BASE_URL'];
  for (const path of sourceFiles) {
    const source = await readFile(path, 'utf8');
    const found = forbiddenSourceMarkers.filter((marker) => source.includes(marker));
    if (found.length > 0) throw new Error(`Production backend source contains local E2E markers in ${relative(stagingDirectory, path)}: ${found.join(', ')}`);
  }

  const archiveBytes = await readFile(archivePath);
  const rawArchive = gunzipSync(archiveBytes);
  const metadataMarkers = [
    ['LIBARCHIVE', 'xattr'], ['SCHILY', 'xattr'], ['com', 'apple', 'provenance'], ['com', 'apple', 'ResourceFork'],
  ].map((parts) => parts.join('.'));
  for (const marker of metadataMarkers) {
    if (rawArchive.includes(Buffer.from(marker))) throw new Error(`Deployment archive contains extended metadata: ${marker}.`);
  }
  if ((await stat(archivePath)).size < 100_000) throw new Error('Deployment archive is unexpectedly small.');
  const digest = sha256(archiveBytes);
  await writeFile(digestPath, `${digest}  ${basename(archivePath)}\n`);
  process.stdout.write(`CloudPay backend deployment bundle: ${archivePath}\nSHA-256: ${digest}\n`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
