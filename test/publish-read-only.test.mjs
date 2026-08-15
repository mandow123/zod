import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('publish page derives mutation permission from the active provider subject', async () => {
  const source = await readFile(new URL('../src/screens/PublishScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /const canManage = snapshot\.providerWorkspace\?\.canManage === true/u);
  assert.match(source, /const progressWritable = canManage && snapshot\.online/u);
  assert.match(source, /mode=\{canManage \? mode : null\}/u);
  assert.match(source, /readOnly=\{!canManage \|\| !progressWritable\}/u);
});

test('viewer keeps real progress but every publish mutation entrance is hidden', async () => {
  const source = await readFile(new URL('../src/screens/PublishScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /canManage \? <View style=\{styles\.draftActions\}/u);
  assert.match(source, /canManage \? <Pressable onPress=\{\(\) => withFreshProgress\(\(\) => onOpenOfferWizard\(\{ revisionOfferId: offer\.id \}\)\)\}/u);
  assert.match(source, /canManage && offer\.status === 'approved'/u);
  assert.match(source, /canManage \? <Pressable\s+disabled=\{reauditingOfferId === offer\.id\}/u);
  assert.match(source, /canManage \? <Pressable onPress=\{\(\) => withFreshProgress\(\(\) => setManagedListingId\(listing\.id\)\)\}/u);
  assert.match(source, /canManage \? <Pressable onPress=\{\(\) => withFreshProgress\(\(\) => onOpenOfferWizard\(\)\)\}/u);
  assert.match(source, /!readOnly \? <>/u);
});

test('deep links cannot reopen editor or listing sheets after permission becomes read-only', async () => {
  const source = await readFile(new URL('../src/screens/PublishScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(canManage\) setMode\(openIntent\)/u);
  assert.match(source, /if \(canManage\) setManagedListingId\(revealListingId\)/u);
  assert.match(source, /if \(!canManage\) \{\s*setMode\(null\);\s*setManagedListingId\(null\);/u);
  assert.match(source, /当前主体为查看权限。你可以查看进度和审核信息，编辑与提交由管理员完成。/u);
});
