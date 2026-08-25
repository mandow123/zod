import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('default-disabled Seedance collapses mobile video routes to home', async () => {
  const flags = await source('src/feature-flags.ts');
  assert.match(flags, /seedanceVideoEnabled:\s*false/u);
  assert.match(flags, /route === 'video' && !mobileFeatureFlags\.seedanceVideoEnabled \? 'home' : route/u);
});

test('App normalizes every public navigation boundary before rendering', async () => {
  const app = await source('App.tsx');
  assert.match(app, /setActiveTab\(normalizeMobileRoute\(tab\)\)/u);
  assert.match(app, /case 'navigate':[\s\S]*?setActiveTab\(normalizeMobileRoute\(intent\.tab\)\)/u);
  assert.match(app, /switch \(normalizeMobileRoute\(activeTab\)\)/u);
  assert.doesNotMatch(app, /VideoGenerationScreen/u);
  assert.doesNotMatch(app, /createVideoTask|getVideoTask/u);
});

test('future video route type remains internal but does not create a default entry', async () => {
  const navigation = await source('src/navigation.ts');
  const home = await source('src/screens/HomeScreen.tsx');
  assert.match(navigation, /\| 'video'/u);
  assert.match(navigation, /video:\s*'home'/u);
  assert.doesNotMatch(home, /video|Seedance|Motion Lab/iu);
});
