import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('local Qixiang preview is isolated behind the staging-only Metro resolver', async () => {
  const [config, metro, app, formal, preview] = await Promise.all([
    source('../app.config.js'), source('../metro.config.js'), source('../App.tsx'),
    source('../src/LocalQixiangPreviewShell.tsx'),
    source('../src/LocalQixiangPreviewShell.local-preview.tsx'),
  ]);
  assert.match(config, /CLOUDPAY_LOCAL_QIXIANG_PREVIEW/u);
  assert.match(config, /allowed only with CLOUDPAY_STAGING_DEMO=1/u);
  assert.match(metro, /localQixiangPreview && !isolatedDemo/u);
  assert.match(metro, /LocalQixiangPreviewShell\.local-preview\.tsx/u);
  assert.match(app, /<LocalQixiangPreviewShell><StagingDemoShell><CloudPayApp \/><\/StagingDemoShell><\/LocalQixiangPreviewShell>/u);
  assert.match(formal, /return children;/u);
  assert.doesNotMatch(formal, /七相|预览|支付/u);
  assert.match(preview, /本地预览/u);
  assert.match(preview, /不连接真实支付/u);
  assert.match(preview, /不会发送网络支付请求/u);
  assert.doesNotMatch(preview, /qixiang-topup-api|apiRequest|WebBrowser|api\.payqixiang\.cn/u);
});
