import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('home always keeps the KAI credit account entry visible', async () => {
  const [home, app] = await Promise.all([
    readFile(new URL('../src/screens/HomeScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(home, /KAI 卡时账户/u);
  assert.match(home, /余额暂未更新/u);
  assert.match(app, /onOpenCredits=\{\(\) => snapshot\.authenticated \? setCreditWalletVisible\(true\) : setAuthVisible\(true\)\}/u);
});

test('market listing contract and UI expose both audit decisions and the CNY reference', async () => {
  const [api, market] = await Promise.all([
    readFile(new URL('../src/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/MarketScreen.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(api, /referenceCny: string/u);
  assert.match(api, /conversion: '1 KAI卡时 = ¥1\.002'/u);
  assert.match(market, /资源与价格双审通过/u);
  assert.match(market, /人民币参考 ¥\{cnyPrice\(item\.referenceCny\)\}/u);
  assert.match(market, /KAI 卡时/u);
});

test('buyer home stays compact and its resource rows do not promise a hidden detail route', async () => {
  const home = await readFile(new URL('../src/screens/HomeScreen.tsx', import.meta.url), 'utf8');
  assert.match(home, /const shortcuts = \[/u);
  assert.match(home, /\.slice\(0, 3\)/u);
  assert.doesNotMatch(home, /resourceRow[\s\S]{0,300}chevron-forward/u);
});
