import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('provider listing sellout estimate is server-authored and clearly excludes service fees', async () => {
  const [contract, manage, publish] = await Promise.all([
    readFile(new URL('../src/publishing.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/ListingManageSheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/PublishScreen.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(contract, /kind: 'gross_before_fee'/u);
  assert.match(contract, /basis: 'remaining_capacity'/u);
  for (const source of [manage, publish]) {
    assert.match(source, /满售预计成交额/u);
    assert.match(source, /listing\.selloutEstimate\.grossCredits/u);
    assert.match(source, /listing\.selloutEstimate\.disclosure/u);
    assert.doesNotMatch(source, /capacityAvailable\s*[*)]\s*unitCredits|unitCredits\s*[*)]\s*capacityAvailable/u);
  }
});
