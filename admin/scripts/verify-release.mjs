#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRelease } from './release-lib.mjs';

export async function main(argv = process.argv.slice(2), environment = process.env) {
  if (argv.length > 1 || argv.includes('--help')) {
    console.error('Usage: ADMIN_API_ORIGIN=https://admin-api.example.invalid node scripts/verify-release.mjs [release-directory]');
    return argv.includes('--help') ? 0 : 64;
  }
  const rootDirectory = path.resolve(argv[0] ?? '.');
  const result = await verifyRelease(rootDirectory, {
    expectedOrigin: environment.ADMIN_API_ORIGIN,
    requireExpectedOrigin: true,
  });
  console.log(`Verified ${result.fileCount} files; VITE_ADMIN_API_ORIGIN equals ADMIN_API_ORIGIN (${result.buildOrigin}).`);
  return 0;
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
