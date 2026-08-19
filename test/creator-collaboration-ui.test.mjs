import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) { return readFile(new URL(path, import.meta.url), 'utf8'); }

test('达人合作只消费独立服务端返佣账本', async () => {
  const [api, screen, profile] = await Promise.all([
    source('../src/creator-commissions.ts'),
    source('../src/screens/CreatorCollaborationScreen.tsx'),
    source('../src/screens/ProfileScreen.tsx'),
  ]);
  for (const route of [
    '/mobile/v1/creator/commissions', '/mobile/v1/creator/referral-links',
    '/mobile/v1/referrals/attribute', '/mobile/v1/creator/commissions/transfer',
    '/mobile/v1/creator/reward-events',
  ]) assert.match(api, new RegExp(route.replaceAll('/', '\\/'), 'u'));
  assert.match(screen, /summary\.balances\.availableCardHours/u);
  assert.match(screen, /summary\.commissions\.map/u);
  assert.match(profile, /title="合作增长"/u);
  assert.match(profile, /label="达人合作"/u);
  assert.doesNotMatch(screen, /她们都在算力市场赚卡时|虚拟|模拟收益/u);
});

test('红包只由真实未消费事件触发且市场按钮不重复转账', async () => {
  const [app, reward, api] = await Promise.all([
    source('../App.tsx'), source('../src/CreatorRewardSheet.tsx'), source('../src/creator-commissions.ts'),
  ]);
  assert.match(app, /loadCreatorRewardEvents\(1\)/u);
  assert.match(app, /setCreatorReward\(event\)/u);
  assert.match(reward, /恭喜获得卡时红包/u);
  assert.match(reward, /已存入你的 KAI 卡时账户/u);
  assert.match(reward, /转入卡时市场/u);
  assert.match(app, /consumeCreatorRewardEvent\(event\.eventId\)/u);
  assert.doesNotMatch(reward, /transferCreatorCommission|Math\.random|fixture|demo/u);
  assert.match(api, /status: 'unconsumed' \| 'consumed'/u);
  assert.match(api, /parseCreatorReferralToken/u);
  assert.match(api, /parseOwnedReferralToken/u);
});

test('用户可见卡时与 Spark 活动价不暴露折前或法币参考价', async () => {
  const sources = await Promise.all([
    source('../src/screens/CreatorCollaborationScreen.tsx'), source('../src/CreatorRewardSheet.tsx'),
    source('../src/CreditWalletSheet.tsx'), source('../src/SparkProductDetailSheet.tsx'),
    source('../src/screens/MarketScreen.tsx'), source('../src/DeviceOrderSheet.tsx'),
  ]);
  for (const text of sources) assert.doesNotMatch(text, /人民币|¥|￥|参考价/u);
  for (const text of sources.slice(3)) assert.doesNotMatch(text, /listUnitCredit|原价/u);
});
