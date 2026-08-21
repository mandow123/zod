import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('the hosted demo bundle uses synthetic data and excludes the production API client', async () => {
  const chunks = join(import.meta.dirname, '..', 'dist', 'client', '_next', 'static', 'chunks');
  const names = await readdir(chunks);
  const bundleName = names.find((name) => /^AdminDemoApp-.*\.js$/u.test(name));
  assert.ok(bundleName, 'ADMIN_DEMO_BUNDLE_MISSING');
  const bundle = await readFile(join(chunks, bundleName), 'utf8');

  assert.match(bundle, /本地演示管理员/u);
  assert.match(bundle, /ADMIN_DEMO_REQUEST_FAILED/u);
  assert.doesNotMatch(bundle, /ADMIN_NETWORK_ERROR/u);
});
