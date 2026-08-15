import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const backendRoot = resolve(import.meta.dirname, '..');
const projectRoot = resolve(backendRoot, '..');
const packageJson = JSON.parse(await readFile(join(backendRoot, 'package.json'), 'utf8'));
const releaseName = `KAI-CloudPay-backend-${packageJson.version}-production`;
const outputDirectory = join(projectRoot, 'artifacts', 'release');
const archivePath = join(outputDirectory, `${releaseName}.tar.gz`);
const digestPath = `${archivePath}.sha256`;
const stagingRoot = await mkdtemp(join(tmpdir(), 'cloudpay-backend-release-'));
const stagingDirectory = join(stagingRoot, releaseName);

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

  const migrations = (await readdir(join(backendRoot, 'migrations')))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  if (migrations.length !== 45 || migrations.at(-1) !== '0045_kai_oidc_mobile_broker.sql') {
    throw new Error(`Expected migrations 0001..0045; found ${migrations.length}, latest ${migrations.at(-1) ?? 'none'}.`);
  }

  const included = [
    '.dockerignore', '.env.example', 'Dockerfile', 'README.md', 'package.json', 'package-lock.json',
    'tsconfig.json', 'tsconfig.build.json', 'src', 'dist', 'migrations', 'deploy', 'docs/production-runbook.md',
    'scripts/build-deployment-bundle.mjs', 'scripts/verify-production-env.mjs',
    'scripts/verify-container-env.mjs', 'scripts/start-production-container.mjs',
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
      targetHostPreflightIncluded: 'passed',
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
  run('tar', ['-czf', archivePath, '-C', stagingRoot, releaseName]);

  const archiveEntries = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (archiveEntries.status !== 0) throw new Error(archiveEntries.stderr || 'Unable to inspect deployment archive.');
  const forbidden = archiveEntries.stdout.split(/\r?\n/u).filter((entry) =>
    /(?:^|\/)(?:node_modules|test|coverage)(?:\/|$)/u.test(entry)
      || (/(?:^|\/)\.env(?:\.|$)/u.test(entry) && !entry.endsWith('/.env.example')),
  );
  if (forbidden.length > 0) throw new Error(`Forbidden release entries: ${forbidden.join(', ')}`);

  const archivePaths = archiveEntries.stdout.split(/\r?\n/u).filter(Boolean);
  const archivedMigrations = archivePaths.filter((entry) => /\/migrations\/\d{4}_.+\.sql$/u.test(entry));
  if (archivedMigrations.length !== migrations.length
    || !archivePaths.some((entry) => entry.endsWith(`/migrations/${migrations.at(-1)}`))) {
    throw new Error(`Deployment archive migration set is incomplete: ${archivedMigrations.length}/${migrations.length}.`);
  }
  for (const required of [
    'RELEASE-MANIFEST.json', 'deploy/aws-ubuntu/verify-routing.mjs', 'deploy/aws-ubuntu/preflight-host.mjs',
    'deploy/aws-ubuntu/verify-sidecar.mjs',
    'scripts/verify-production-env.mjs', 'scripts/verify-container-env.mjs',
    'scripts/start-production-container.mjs', 'scripts/verify-release.mjs',
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
  if ((await stat(archivePath)).size < 100_000) throw new Error('Deployment archive is unexpectedly small.');
  const digest = sha256(archiveBytes);
  await writeFile(digestPath, `${digest}  ${basename(archivePath)}\n`);
  process.stdout.write(`CloudPay backend deployment bundle: ${archivePath}\nSHA-256: ${digest}\n`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
