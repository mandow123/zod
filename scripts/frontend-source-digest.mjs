import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const fixedFiles = [
  'App.tsx', 'index.ts', 'app.json', 'app.config.js', 'metro.config.js', 'package.json', 'package-lock.json',
];
const sourceDirectories = ['src', 'plugins', 'android/app/src'];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function frontendSourceDigest(projectRoot) {
  const root = resolve(projectRoot);
  const files = [];
  for (const name of fixedFiles) {
    const path = join(root, name);
    if ((await stat(path).catch(() => null))?.isFile()) files.push(path);
  }
  for (const name of sourceDirectories) {
    const path = join(root, name);
    if ((await stat(path).catch(() => null))?.isDirectory()) files.push(...await filesUnder(path));
  }
  const unique = [...new Set(files)].sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  const digest = createHash('sha256');
  for (const path of unique) {
    digest.update(relative(root, path).replaceAll('\\', '/'));
    digest.update('\0');
    digest.update(await readFile(path));
    digest.update('\0');
  }
  return { digest: digest.digest('hex'), fileCount: unique.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await frontendSourceDigest(process.argv[2] ?? resolve(import.meta.dirname, '..'));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
