import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/ComputeFulfillmentCard.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
const validator = fs.readFileSync(new URL('../src/ssh-connection.ts', import.meta.url), 'utf8');
const orderDetail = fs.readFileSync(new URL('../src/OrderDetailSheet.tsx', import.meta.url), 'utf8');

test('connection information is requested only from an explicit user action and kept out of persistence and logs', () => {
  const enterStart = source.indexOf('const enter = async () =>');
  const accessCall = source.indexOf('createCloudPayAccessSession(order.id', enterStart);
  const nextHandler = source.indexOf('\n  const stop =', enterStart);
  assert.ok(enterStart >= 0 && accessCall > enterStart && accessCall < nextHandler);
  assert.doesNotMatch(source, /SecureStore|saveDeliveryDraft|AsyncStorage|console\.|logger\./u);
  assert.match(source, /connectionRef\.current = null/u);
  assert.match(source, /setConnection\(null\); setRevealPrivateKey\(false\)/u);
});

test('mobile never receives or exchanges a sidecar URI or ticket', () => {
  assert.doesNotMatch(validator, /fetch\(|Authorization|Bearer|session\.uri|session\.ticket/u);
  assert.doesNotMatch(source, /fetch\(|Authorization|Bearer|session\.uri|session\.ticket/u);
  const start = api.indexOf('export function createCloudPayAccessSession');
  const end = api.indexOf('\nexport ', start + 1);
  const body = api.slice(start, end);
  assert.match(body, /\/mobile\/v1\/orders\/\$\{encodeURIComponent\(orderId\)\}\/fulfillment\/access-session/u);
  assert.match(body, /retry: false/u);
});

test('an ambiguous access response reuses the server-replayable request key while the App stays active', () => {
  const enterStart = source.indexOf('const enter = async () =>');
  const enterEnd = source.indexOf('\n  const stop =', enterStart);
  const enter = source.slice(enterStart, enterEnd);
  const catchStart = enter.indexOf('catch (reason)');
  assert.ok(catchStart >= 0);
  assert.match(enter.slice(catchStart), /if \(!isAmbiguousMutationFailure\(reason\)\) requestIds\.current\.delete\('access'\)/u);
  assert.match(source, /requestIds\.current\.delete\('access'\)/u);
});

test('the App accepts final SSH details only from its authenticated backend response', () => {
  assert.match(source, /result\.fulfillment\.connection,\s*result\.fulfillment\.leaseExpiresAt/u);
  assert.match(validator, /record\.protocol !== expectedConnection\.protocol/u);
  assert.match(validator, /record\.host !== expectedConnection\.host/u);
  assert.match(validator, /record\.port !== expectedConnection\.port/u);
  assert.match(validator, /record\.hostKeyFingerprint !== expectedConnection\.hostKeyFingerprint/u);
  assert.match(validator, /record\.knownHostsEntry !== expectedConnection\.knownHostsEntry/u);
  assert.doesNotMatch(source, /Linking|openURL|openBrowser|session\.uri|session\.ticket/u);
  assert.match(source, /获取连接信息/u);
});

test('SSH commands pin the audited host key instead of trusting the first connection', () => {
  assert.match(source, /服务器指纹/u);
  assert.match(source, /安装服务器身份凭证/u);
  assert.match(validator, /UserKnownHostsFile=\$\{knownHostsPath\(connection\)\}/u);
  assert.match(validator, /StrictHostKeyChecking=yes/u);
  assert.doesNotMatch(validator, /StrictHostKeyChecking=no|accept-new/u);
  assert.match(source, /第 2 步 · 私钥保存路径/u);
  assert.match(source, /privateKeyPath\(connection\)/u);
});

test('connection secrets are protected from screenshots and cleared when the App backgrounds', () => {
  assert.match(source, /ScreenCapture\.preventScreenCaptureAsync\(pendingScreenCaptureKey\)/u);
  assert.ok(source.indexOf('await ScreenCapture.preventScreenCaptureAsync') < source.indexOf('setConnection(validated)'));
  assert.match(source, /ScreenCapture\.allowScreenCaptureAsync\(key\)/u);
  assert.match(source, /AppState\.addEventListener\('change'/u);
  assert.match(source, /setConnection\(null\); setRevealPrivateKey\(false\)/u);
  assert.match(source, /导入后请清空系统剪贴板/u);
});

test('a credential response is discarded if the App backgrounds, changes order, or unmounts mid-request', () => {
  assert.match(source, /mounted: mountedRef\.current/u);
  assert.match(source, /appState: AppState\.currentState/u);
  assert.match(source, /currentOrderId: orderIdRef\.current/u);
  assert.match(source, /currentGeneration: accessGenerationRef\.current/u);
  const prevent = source.indexOf('await ScreenCapture.preventScreenCaptureAsync');
  assert.ok(source.indexOf('if (!isCurrent()) return;', source.indexOf('createCloudPayAccessSession')) < prevent);
  const postPreventGuard = source.indexOf('if (!isCurrent()) {', prevent);
  assert.ok(postPreventGuard > prevent);
  assert.ok(source.indexOf('ScreenCapture.allowScreenCaptureAsync(pendingScreenCaptureKey)', postPreventGuard) > postPreventGuard);
  assert.ok(source.indexOf('setConnection(validated)', postPreventGuard) > postPreventGuard);
  assert.match(source, /mountedRef\.current = false;\s*accessGenerationRef\.current \+= 1/u);
});

test('lease expiry and authoritative usage are visible without client-side billing math', () => {
  assert.match(source, /租约到期/u);
  assert.match(source, /state\.usage\.consumedCredits/u);
  assert.match(source, /state\.usage\.remainingCredits/u);
  assert.doesNotMatch(source, /consumedCredits\s*[+\-*\/]|remainingCredits\s*[+\-*\/]/u);
});

test('live fulfillment states periodically resync from the server for both buyer and provider views', () => {
  assert.match(source, /status === 'failed'/u);
  assert.match(source, /setInterval\(\(\) => void refresh\(true\), delay\)/u);
});

test('a stopped fulfillment keeps syncing while its server-owned acceptance window is pending', () => {
  assert.match(source, /acceptancePending = status === 'stopped' && state\?\.fulfillment\?\.acceptanceMode === 'pending'/u);
  assert.match(source, /acceptancePresentation\(fulfillment, now\)/u);
  assert.match(source, /截止 \{formatTime\(acceptance\.deadline\)\}/u);
  assert.doesNotMatch(source, /acceptanceDueAt\s*[+\-*\/]/u);
});

test('system acceptance and metered provider credits remain distinct in order-level UI', () => {
  assert.match(orderDetail, /acceptanceMode === 'system' \? '系统按计量完成'/u);
  assert.match(orderDetail, /computeSnapshot\.usage\.consumedCredits/u);
  assert.match(orderDetail, /computeIssue\.settlement\.providerCredits/u);
  assert.doesNotMatch(orderDetail, /acceptanceMode === 'system'[^\n]+买方验收/u);
});

test('metering and access issues pause settlement without claiming an automatic refund', () => {
  assert.match(source, /reportCloudPayFulfillmentIssue\(order\.id, issueKind, description, key\)/u);
  assert.match(source, /提交问题，暂缓结算/u);
  assert.match(source, /提交后不会自动退款/u);
});
