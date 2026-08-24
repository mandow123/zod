import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('App owns one navigation intent executor and centralized lifecycle subscriptions', async () => {
  const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.equal(app.match(/const executeNavigationIntent =/gu)?.length, 1);
  assert.match(app, /providerNextIntent\(/u);
  assert.match(app, /messageNavigationIntent\(message\)/u);
  assert.match(app, /resolveProviderOfferMessageIntent\(/u);
  assert.match(app, /useAppLifecycle\(/u);
  assert.doesNotMatch(app, /Linking\.addEventListener|AppState\.addEventListener|Notifications\.addNotificationResponseReceivedListener/u);
  assert.equal(app.match(/Haptics\.selectionAsync\(\)/gu)?.length, 1);
  assert.match(app, /const openProviderWorkspaceNextAction =[\s\S]*?Haptics\.selectionAsync\(\)[\s\S]*?openProviderNextAction/u);
  assert.match(app, /<ProviderWorkspaceScreen[\s\S]*?onNext=\{openProviderWorkspaceNextAction\}/u);
  assert.match(app, /<ProviderResourcesScreen[\s\S]*?onNext=\{openProviderNextAction\}/u);
});

test('open-order synchronizes side and formal source before routing and loading', async () => {
  const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(app, /case 'open-order':[\s\S]*?setOrderSide\(intent\.side\);[\s\S]*?setSelectedOrderSource\('formal'\);[\s\S]*?setActiveTab\(intent\.tab\);[\s\S]*?loadCloudPayOrder\(intent\.orderId\)/u);
});

test('protected Inquiry, wallet, Qixiang, staging and auth anchors remain wired', async () => {
  const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  for (const anchor of [
    'InquiryComposerSheet', 'MyInquiriesSheet', 'onOpenInquiry={setSelectedInquiryCandidate}',
    'onOpenMyInquiries={() => setMyInquiriesVisible(true)}', "setSelectedOrderSource] = useState<'formal' | 'staging'>('formal')",
    "setSelectedOrderSource('staging')", 'StagingEnvironmentBanner', 'StagingDemoShell',
    'qixiangCapability={snapshot.qixiangTopupCapability}', 'userId={snapshot.user?.id ?? null}',
    'subjectId={snapshot.currentSubjectId}', 'onOpenSupport={() =>', 'reconcileCommittedKaiOidcSession',
    'acceptVerifiedKaiConsents', 'cancelVerifiedKaiAuth', 'resumeVerifiedKaiAuth', 'startKaiOidcRevocationRetry',
  ]) assert.ok(app.includes(anchor), `missing protected App anchor: ${anchor}`);
});
