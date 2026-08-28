import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const source = async (path) => readFile(new URL(path, root), 'utf8');

test('the approved local top-video treatment is shared by the two runtime surfaces', async () => {
  const [hero, home, provider, profile] = await Promise.all([
    source('src/components/TopVideoHero.tsx'), source('src/screens/HomeScreen.tsx'),
    source('src/screens/ProviderWorkspaceScreen.tsx'), source('src/screens/ProfileScreen.tsx'),
  ]);
  for (const file of [home, provider]) assert.match(file, /<TopVideoHero\b/u);
  assert.match(home, /label: '提供算力'/u);
  assert.match(home, /index === 0 \? onNavigate\('workspace'\)/u);
  assert.ok(provider.indexOf('<TopVideoHero') < provider.indexOf('!snapshot.authenticated'), 'provider media must precede authentication state');
  assert.match(provider, /<Card style=\{styles\.workspaceCard\}>[\s\S]*?workspace\.nextAction\.label/u);
  assert.match(hero, /useVideoPlayer/u);
  assert.match(hero, /server-room-preview\.mp4/u);
  assert.match(hero, /server-room-poster\.jpg/u);
  assert.match(hero, /assets\/icon\.png/u);
  assert.match(hero, /instance\.loop = true/u);
  assert.match(hero, /instance\.muted = true/u);
  assert.match(hero, /nativeControls=\{false\}/u);
  assert.match(hero, /contentFit="cover"/u);
  assert.match(hero, /AccessibilityInfo\.isReduceMotionEnabled/u);
  assert.match(hero, /useState<boolean \| null>\(null\)/u);
  assert.match(hero, /reduceMotion === false/u);
  assert.match(hero, /const absoluteFillObject = Object\.freeze/u);
  assert.match(hero, /poster: \{ \.\.\.absoluteFillObject \}/u);
  assert.match(hero, /AppState\.addEventListener/u);
  assert.match(hero, /else player\.pause\(\);/u);
  assert.doesNotMatch(hero, /return \(\) => \{ player\.pause\(\); \};/u);
  assert.doesNotMatch(hero, /https?:\/\//u);
  assert.doesNotMatch(hero, /mascot/iu);
  for (const token of ['#1976D2', '#F5F9FC', '#FFFFFF', '#132B3D', '#5A7188', '#C7D7E1', '#F1934A']) {
    assert.ok(hero.includes(token), `missing approved token ${token}`);
  }
  assert.match(hero, />KAI CloudPay</u);
  assert.doesNotMatch(profile, /登录 Zod/u);
  assert.match(profile, /KAI CloudPay/u);
});
