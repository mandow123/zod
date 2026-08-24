import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('供应方消息订单保持在可见消息页，资源入口直达资产页', async () => {
  const [app, intents] = await Promise.all([
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/core/app-navigation-intents.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /messageNavigationIntent\(message\)/u);
  assert.match(intents, /route === 'provider_order'[\s\S]*?tab: 'messages', side: 'provider'/u);
  assert.match(app, /onOpenProviderAssets=\{\(resourceId\) => \{ setResourceToOpenId\(resourceId \?\? null\); navigate\('resources'\); \}\}/u);
  assert.match(app, /onOpenPublish=\{\(\) => navigate\('publish'\)\}/u);
  assert.doesNotMatch(app, /onOpenPublish=\{\(\) => \{ setWorkMode\('provider'\)/u);
});

test('算力订单使用自动锁定和开通心智', async () => {
  const [card, screen] = await Promise.all([
    readFile(new URL('../src/OrderCard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/OrdersScreen.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(card, /reserved: \{ label: '已锁定'/u);
  assert.match(card, /confirmed: \{ label: '已确认'/u);
  assert.match(card, /ready: \{ label: '可连接'/u);
  assert.doesNotMatch(card, /待接单|已接单/u);
  assert.match(screen, /资源锁定、自动开通、验收和结算/u);
});
