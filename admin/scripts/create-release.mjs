#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_DIRECTORY,
  MANIFEST_FILE,
  METADATA_FILE,
  canonicalHttpsOrigin,
  createDeterministicTarGzip,
  createManifest,
  sha256,
  verifyRelease,
} from './release-lib.mjs';

const adminDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(adminDirectory, '..');
const outputDirectory = path.join(repositoryDirectory, 'artifacts', 'admin');

const SOURCE_FILES = [
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
];

function runNpm(arguments_) {
  if (process.env.npm_execpath) {
    execFileSync(process.execPath, [process.env.npm_execpath, ...arguments_], {
      cwd: adminDirectory,
      env: process.env,
      stdio: 'inherit',
    });
    return;
  }
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmExecutable, arguments_, {
    cwd: adminDirectory,
    env: process.env,
    stdio: 'inherit',
  });
}

async function copyProductionSources(stagingDirectory) {
  for (const file of SOURCE_FILES) {
    const destination = path.join(stagingDirectory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(adminDirectory, file), destination);
  }
  await cp(path.join(adminDirectory, 'src'), path.join(stagingDirectory, 'src'), {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(path.join(adminDirectory, 'src'), source);
      return !relative.split(path.sep).some((part) => ['test', 'tests', '__tests__'].includes(part));
    },
  });
  await cp(path.join(adminDirectory, 'dist'), path.join(stagingDirectory, 'dist'), { recursive: true });

  // The release package is production-only. Keep locked build/verification
  // commands and omit dev/demo/test entry points whose fixtures are excluded.
  const packagePath = path.join(stagingDirectory, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJson.scripts = {
    build: packageJson.scripts.build,
    typecheck: packageJson.scripts.typecheck,
    'release:verify': packageJson.scripts['release:verify'],
  };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function createRelease() {
  const origin = canonicalHttpsOrigin(process.env.VITE_ADMIN_API_ORIGIN, 'VITE_ADMIN_API_ORIGIN');

  runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  runNpm(['run', 'typecheck']);
  runNpm(['test']);
  runNpm(['run', 'build']);
  await writeFile(path.join(adminDirectory, 'dist', '.admin-api-origin'), origin);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'kai-admin-release-'));
  const stagingDirectory = path.join(temporaryDirectory, BUNDLE_DIRECTORY);
  try {
    await mkdir(stagingDirectory, { recursive: true });
    await copyProductionSources(stagingDirectory);
    const metadata = {
      schemaVersion: 1,
      artifact: 'kai-admin-web',
      viteAdminApiOrigin: origin,
      reproducibility: 'sorted ustar, uid/gid/mtime zero, gzip mtime zero',
    };
    await writeFile(path.join(stagingDirectory, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(path.join(stagingDirectory, MANIFEST_FILE), await createManifest(stagingDirectory));
    const verification = await verifyRelease(stagingDirectory, { expectedOrigin: origin, requireExpectedOrigin: true });

    const archive = await createDeterministicTarGzip(stagingDirectory);
    await mkdir(outputDirectory, { recursive: true });
    const archivePath = path.join(outputDirectory, `${BUNDLE_DIRECTORY}.tar.gz`);
    await writeFile(archivePath, archive);
    await writeFile(`${archivePath}.sha256`, `${sha256(archive)}  ${path.basename(archivePath)}\n`);
    console.log(`Created ${archivePath}`);
    console.log(`SHA-256 ${sha256(archive)} (${verification.fileCount} verified payload files)`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

createRelease().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
