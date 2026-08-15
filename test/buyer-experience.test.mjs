import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('home always keeps the KAI credit account entry visible', async () => {
  const [home, app] = await Promise.all([
    readFile(new URL('../src/screens/HomeScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(home, /KAI 卡时账户/u);
  assert.match(home, /先充值卡时再购买算力/u);
  assert.match(home, /余额暂未更新/u);
  assert.doesNotMatch(home, /snapshot\.creditBalance\s*\?\s*\(\s*<Pressable/u);
  assert.match(app, /onOpenCredits=\{\(\) => snapshot\.authenticated \? setCreditWalletVisible\(true\) : setAuthVisible\(true\)\}/u);
});

test('market listing contract and UI expose both audit decisions and the CNY reference', async () => {
  const [api, market] = await Promise.all([
    readFile(new URL('../src/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/MarketScreen.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(api, /referenceCny: string/u);
  assert.match(api, /conversion: '1 KAI卡时 = ¥1\.002'/u);
  assert.match(market, /资源已审核/u);
  assert.match(market, /价格已审核/u);
  assert.match(market, /每 GPU 小时卡时价/u);
  assert.match(market, /人民币审核参考 ¥\{cnyPrice\(item\.referenceCny\)\}/u);
  assert.match(market, /item\.conversion/u);
});

test('non-interactive delivery rows do not promise navigation with chevrons', async () => {
  const home = await readFile(new URL('../src/screens/HomeScreen.tsx', import.meta.url), 'utf8');
  assert.match(home, /购买后怎么交付/u);
  assert.doesNotMatch(home, /timelineRow[\s\S]*?name="chevron-forward"/u);
});
