import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) { return readFile(new URL(path, import.meta.url), 'utf8'); }

test('我的按产品经理信息架构分组，买家主路径保持优先', async () => {
  const profile = await source('../src/screens/ProfileScreen.tsx');
  for (const group of ['资产与履约', '供给经营', '合作增长', '服务与安全']) {
    assert.match(profile, new RegExp(`title="${group}"`, 'u'));
  }
  for (const item of ['我的资产', '订单', 'KAI 卡时', '达人合作', '客服与帮助', '主体与认证', '账号设置', '隐私与数据']) {
    assert.match(profile, new RegExp(`label="${item}"`, 'u'));
  }
  assert.match(profile, /我购买的、我提供的/u);
  assert.doesNotMatch(profile, /当前视角|使用算力|提供算力/u);
  assert.doesNotMatch(profile, /合同与发票/u);
});

test('纯买家不会被合成的兑付档案误判成供应商', async () => {
  const profile = await source('../src/screens/ProfileScreen.tsx');
  assert.match(profile, /const supplier = snapshot\.providerWorkspace\?\.supplier \?\? null/u);
  assert.match(profile, /const showSupplyBusiness = supplier !== null \|\| stagingTools\.draftEntry !== null/u);
  assert.match(profile, /\{showSupplyBusiness \? <MenuGroup title="供给经营"/u);
  assert.doesNotMatch(profile, /showSupplyBusiness = Boolean\(supplier \|\| snapshot\.payoutProfile\)/u);
});

test('供应资格与兑付采用真实服务端状态并区分经营入口', async () => {
  const [profile, app, api] = await Promise.all([
    source('../src/screens/ProfileScreen.tsx'), source('../App.tsx'), source('../src/api.ts'),
  ]);
  for (const state of ['资料待完善', '资料审核中', '资格已通过', '审核退回，需补充资料', '供应资格已暂停']) {
    assert.match(profile, new RegExp(state, 'u'));
  }
  assert.match(profile, /label="上架资格"[\s\S]{0,260}创建和管理资源请使用底部“上架”/u);
  assert.match(profile, /onPress=\{supplier\.status === 'approved' \? undefined : onOpenQualification\}/u);
  assert.match(profile, /enabled=\{supplier\.status !== 'approved'\}/u);
  assert.match(app, /onOpenQualification=\{\(\) => \{ setPublishIntentToOpen\('supplier'\); navigate\('publish'\); \}\}/u);
  assert.match(app, /openIntent=\{publishIntentToOpen\}/u);
  assert.match(profile, /trailingIcon=\{supplier\.status === 'approved' \? 'checkmark-circle' : undefined\}/u);
  assert.match(profile, /const payoutActive = snapshot\.payoutProfile\?\.status === 'active'/u);
  assert.match(profile, /onPress=\{payoutActive \? onOpenPayout : undefined\}/u);
  assert.match(profile, /enabled=\{payoutActive\}/u);
  assert.match(app, /onOpenPayout=\{\(\) => setPayoutVisible\(true\)\}/u);
  assert.match(app, /<CreditPayoutSheet visible=\{payoutVisible\}/u);
  assert.match(api, /status: 'pending_activation' \| 'active' \| 'suspended'/u);
});

test('主体与认证只呈现真实主体、角色和状态', async () => {
  const profile = await source('../src/screens/ProfileScreen.tsx');
  assert.match(profile, /snapshot\.subjects\.find/u);
  assert.match(profile, /subjectStatusLabel\[subject\.status\]/u);
  assert.match(profile, /subjectRoleLabel\[subject\.role\]/u);
  assert.match(profile, /onSelect\(subject\.id\)/u);
  assert.doesNotMatch(profile, /实名认证通过|企业认证通过|已认证/u);
});
