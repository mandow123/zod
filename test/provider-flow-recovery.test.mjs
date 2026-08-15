import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test('offer conflict lets the provider reload or leave without overwriting server state', async () => {
  const source = await readFile(new URL('../src/OfferWizardSheet.tsx', import.meta.url), 'utf8');
  const exit = section(source, 'const exitWithoutSaving = useCallback', '\n\n  const reloadLatest');
  const reload = section(source, 'const reloadLatest = useCallback', '\n\n  const promptConflictResolution');
  const close = section(source, 'const closeSafely = useCallback', '\n\n  const chooseResource');

  assert.match(exit, /desiredRef\.current = null/u);
  assert.match(exit, /onClose\(\)/u);
  assert.doesNotMatch(exit, /saveOffer(?:Draft|Revision)|flush\(/u);
  assert.match(reload, /getOfferRevision\(current\.offerId\)/u);
  assert.match(reload, /getOfferDraft\(current\.id\)/u);
  assert.match(reload, /hydrate\(latest\)/u);
  assert.match(close, /saveState === 'conflict'[\s\S]*promptConflictResolution\(\)/u);
  assert.match(source, /退出不覆盖/u);
  assert.match(source, /重新读取/u);
  assert.match(source, /onRequestClose=\{handleRequestClose\}/u);
});

test('production login never reuses legal documents from an earlier sheet opening', async () => {
  const source = await readFile(new URL('../src/AuthSheet.tsx', import.meta.url), 'utf8');
  const effect = section(source, 'useEffect(() => {', '\n\n  const openDocument');
  assert.ok(effect.indexOf('setDocuments(null)') < effect.indexOf('loadLegalDocuments()'));
  assert.match(effect, /let active = true/u);
  assert.match(effect, /if \(active\) setDocuments\(nextDocuments\)/u);
  assert.match(effect, /return \(\) => \{ active = false; \}/u);
  assert.match(source, /!documents \|\| !consented/u);
});

test('listing initial-load failure exposes a retry that reruns the loading effect', async () => {
  const source = await readFile(new URL('../src/ListingPublishSheet.tsx', import.meta.url), 'utf8');
  assert.match(source, /const \[loadRevision, setLoadRevision\] = useState\(0\)/u);
  assert.match(source, /\}, \[loadRevision, offerId, visible\]\)/u);
  assert.match(source, /initialLoadFailed = !loading && Boolean\(error\) && \(!offer \|\| !resource \|\| !approvedPrice\)/u);
  assert.match(source, /setLoadRevision\(\(value\) => value \+ 1\)/u);
  assert.match(source, /accessibilityLabel="重新读取挂牌信息"/u);
});

test('provider node recovery copy is distinct from resource evidence copy', async () => {
  const source = await readFile(new URL('../src/screens/ProviderWorkspaceScreen.tsx', import.meta.url), 'utf8');
  const nodeCopy = source.indexOf("if (key === 'connect_resource_node')");
  const resourceCopy = source.indexOf("if (key.includes('resource'))");
  assert.ok(nodeCopy >= 0 && nodeCopy < resourceCopy);
  assert.match(source, /接入执行节点/u);
  assert.match(source, /执行节点已离线/u);
});

test('offer wizard keeps the active field above the Android keyboard', async () => {
  const source = await readFile(new URL('../src/OfferWizardSheet.tsx', import.meta.url), 'utf8');
  assert.match(source, /behavior=\{Platform\.OS === 'ios' \? 'padding' : 'height'\}/u);
});
