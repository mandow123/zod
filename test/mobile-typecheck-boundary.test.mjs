import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('mobile typecheck does not depend on backend or unrelated workspaces', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const tsconfig = JSON.parse(await readFile(new URL('tsconfig.mobile.json', root), 'utf8'));

  assert.equal(packageJson.scripts.typecheck, 'tsc --noEmit -p tsconfig.mobile.json');
  assert.deepEqual(tsconfig.include, ['App.tsx', 'index.ts', 'src/**/*.ts', 'src/**/*.tsx']);
  assert.ok(tsconfig.exclude.includes('backend'));
  assert.ok(tsconfig.exclude.includes('promo'));
  assert.ok(tsconfig.exclude.includes('admin'));
});
