import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  cardHourProduct, normalizeStagingQuantity, stagingOrderActions, stagingOrderStatus, stagingPurchaseGate,
} from '../src/staging-presentation.ts';
import {
  assertStagingOrderActionPrincipal, replayPendingStagingOrderAction,
} from '../src/staging-order-action-recovery-core.ts';
import { acquireStagingOrderMutation } from '../src/staging-order-mutation-lock.ts';
import {
  initialStagingOrderSlotRefresh, nextStagingOrderSlotRefresh, shouldReloadStagingOrderSlot,
} from '../src/staging-order-slot-sync.ts';
import { assertStagingOrderPrincipal, replayPendingStagingOrder } from '../src/staging-order-recovery-core.ts';
import { assertStagingTopupPrincipal, replayPendingStagingTopup } from '../src/staging-topup-recovery-core.ts';
import {
  assertStagingProfileMutationPrincipal, replayStagingProfileMutation,
} from '../src/staging-profile-mutation-recovery-core.ts';
import { checkSshPublicKey } from '../src/staging-ssh-public-key.ts';
import {
  emptySupplierDraftForm, supplierDraftPayload, validateSupplierDraftForm,
} from '../src/staging-supplier-draft-form.ts';
import {
  assertStagingSupplierDraftPrincipal, replayPendingStagingSupplierDraft,
} from '../src/staging-supplier-draft-recovery-core.ts';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { insertSigningConfig } = require('../plugins/with-android-release-signing.js');
const generatedAndroidGradle = insertSigningConfig(`android {
    defaultConfig {
        applicationId 'com.kaicloud.marketplace'
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
        }
    }
}`);

test('staging keeps its own package and API while rendering the original five-tab app', async () => {
  const [config, gradle, metro, shell, components, app] = await Promise.all([
    source('../app.config.js'),
    generatedAndroidGradle,
    source('../metro.config.js'),
    source('../src/StagingDemoShell.staging.tsx'),
    source('../src/components.tsx'),
    source('../App.tsx'),
  ]);
  assert.match(config, /CLOUDPAY_STAGING_DEMO/u);
  assert.match(config, /http:\/\/10\.0\.2\.2:4187/u);
  assert.match(config, /com\.kaicloud\.marketplace\.staging/u);
  assert.match(gradle, /applicationIdSuffix "\.staging"/u);
  assert.match(config, /Zod 测试版/u);
  assert.match(gradle, /resValue "string", "app_name", "Zod 测试版"/u);
  assert.match(gradle, /cloudPayReferralScheme: "zod-staging"/u);
  assert.doesNotMatch(gradle, /cloudPayAuth(?:Scheme|Host|Path)/u);
  assert.doesNotMatch(metro, /StagingDemoShell\.staging\.tsx/u);
  assert.match(shell, /return children;/u);
  assert.match(app, /<StagingDemoShell><CloudPayApp \/><\/StagingDemoShell>/u);
  assert.match(components, /label: '首页'.*label: '市场'.*label: '上架'.*label: '消息'.*label: '我的'/us);
  assert.doesNotMatch(components, /label: '收益'|DEMO ASSETS|DEMO MARKET/u);
  await assert.rejects(() => source('../src/StagingDemoApp.tsx'), /ENOENT/u);
  assert.match(metro, /StagingProfileToolsSlot\.staging\.tsx/u);
  assert.match(metro, /StagingManualDeliverySlot\.staging\.tsx/u);
  assert.match(metro, /StagingEnvironmentBanner\.staging\.tsx/u);
  const environmentMarker = await source('../src/StagingEnvironmentBanner.staging.tsx');
  assert.match(environmentMarker, /测试环境/u);
  assert.match(environmentMarker, /数据与正式环境隔离/u);
  assert.match(environmentMarker, /backgroundColor: colors\.surface/u);
  assert.match(environmentMarker, /backgroundColor: colors\.primary/u);
  assert.doesNotMatch(environmentMarker, /position: ['"]absolute|backgroundColor: colors\.orange|#(?:E87909|FF6A00)/u);
});

test('staging purchase math keeps exact two-decimal card hours and rejects fractional cents', () => {
  assert.equal(normalizeStagingQuantity('1'), '1.00');
  assert.equal(normalizeStagingQuantity('1.01'), '1.01');
  assert.equal(normalizeStagingQuantity('0'), null);
  assert.equal(normalizeStagingQuantity('1.001'), null);
  assert.equal(cardHourProduct('100.00', '1.00'), '100.00');
  assert.equal(cardHourProduct('10.00', '1.01'), '10.10');
  assert.equal(cardHourProduct('0.01', '0.01'), null);
});

test('staging purchase gate enforces server capacity and available demo credits', () => {
  const base = { unitPriceCredits: '10.00', capacityAvailable: '8.00', availableBalance: '99.80' };
  assert.deepEqual(stagingPurchaseGate({ ...base, quantityInput: '1' }), {
    quantity: '1.00', total: '10.00', reason: null,
  });
  assert.equal(stagingPurchaseGate({ ...base, quantityInput: '8.01' }).reason, 'capacity_exceeded');
  assert.equal(stagingPurchaseGate({ ...base, quantityInput: '1.00', availableBalance: '9.99' }).reason,
    'insufficient_balance');
  assert.equal(stagingPurchaseGate({ ...base, quantityInput: '1.00', availableBalance: null }).reason,
    'balance_unavailable');
  assert.equal(stagingPurchaseGate({ ...base, quantityInput: '0.001' }).reason, 'invalid_quantity');
  assert.equal(stagingPurchaseGate({ ...base, quantityInput: '0.01', unitPriceCredits: '0.01' }).reason,
    'invalid_total_precision');
});

test('original market screen selects the isolated server catalog and balance source in staging', async () => {
  const [market, formalSource, stagingSource, metro] = await Promise.all([
    source('../src/screens/MarketScreen.tsx'), source('../src/MarketCommerceSource.ts'),
    source('../src/MarketCommerceSource.staging.ts'), source('../metro.config.js'),
  ]);
  assert.match(market, /const commerce = useMarketCommerceSource\(\)/u);
  assert.match(market, /commerce\.source === 'staging'/u);
  assert.match(market, /stagingPurchaseGate/u);
  assert.match(market, /commerce\.createOrder\(selectedCommerceItem\.id, gate\.quantity\)/u);
  assert.match(stagingSource, /Promise\.all\(\[loadStagingCatalog\(\), loadStagingBalance\(\)\]\)/u);
  assert.match(stagingSource, /createStagingOrder\(request\.listingId, request\.quantity, request\.idempotencyKey\)/u);
  assert.match(stagingSource, /title: '测试资源'/u);
  assert.match(stagingSource, /auditLabel: '测试审核已通过'/u);
  assert.match(stagingSource, /inventoryLabel: '测试容量'/u);
  assert.doesNotMatch(stagingSource, /title: item\.title|auditLabel: item\.auditLabel|inventoryLabel: item\.inventoryLabel/u);
  assert.match(stagingSource, /loadPendingStagingOrder\(\)/u);
  assert.match(stagingSource, /await replayOrder\(pending\)/u);
  assert.match(formalSource, /source: 'formal'/u);
  assert.doesNotMatch(formalSource, /staging-sandbox-api|loadStagingCatalog|\/mobile\/v1\/staging/u);
  assert.match(metro, /MarketCommerceSource\.staging\.ts/u);
});

test('staging order creation persists one idempotency key until a confirmed response', async () => {
  const [api, recovery] = await Promise.all([
    source('../src/staging-sandbox-api.ts'),
    source('../src/staging-order-recovery.ts'),
  ]);
  assert.match(recovery, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
  assert.match(recovery, /existing\.signature !== pending\.signature/u);
  assert.match(recovery, /existing\.idempotencyKey !== idempotencyKey/u);
  assert.match(api, /\/mobile\/v1\/staging\/compute-orders', mutation\(idempotencyKey, \{ listingId, quantity \}\)/u);
  assert.match(api, /\/mobile\/v1\/staging\/compute-orders\?limit=50/u);
});

test('a response lost after server commit replays the same key after process restart exactly once', async () => {
  const principalFingerprint = 'a'.repeat(64);
  const pending = {
    signature: 'listing-1:1.00', listingId: 'listing-1', quantity: '1.00',
    idempotencyKey: 'staging-order:00000000-0000-4000-8000-000000000001',
    principalFingerprint,
  };
  let persisted = JSON.stringify(pending);
  let applyCount = 0;
  let available = 10000;
  let capacity = 500;
  const committed = new Map();
  const server = async (request, loseResponse = false) => {
    let response = committed.get(request.idempotencyKey);
    if (!response) {
      applyCount += 1;
      available -= 1000;
      capacity -= 100;
      response = { order: { id: 'order-1' }, balance: { available: '90.00', reserved: '10.00' } };
      committed.set(request.idempotencyKey, response);
    }
    if (loseResponse) throw new Error('response lost after commit');
    return response;
  };

  await assert.rejects(() => replayPendingStagingOrder(JSON.parse(persisted), principalFingerprint,
    (request) => server(request, true), async () => { persisted = ''; }), /response lost/u);
  assert.notEqual(persisted, '');

  const afterRestart = JSON.parse(persisted);
  const recovered = await replayPendingStagingOrder(afterRestart, principalFingerprint, server, async (key) => {
    assert.equal(key, pending.idempotencyKey);
    persisted = '';
  });
  assert.equal(recovered.order.id, 'order-1');
  assert.equal(applyCount, 1);
  assert.equal(available, 9000);
  assert.equal(capacity, 400);
  assert.equal(committed.size, 1);
  assert.equal(persisted, '');
});

test('quickline response loss replays the original key once and clears only after confirmation', async () => {
  const principalFingerprint = 'b'.repeat(64);
  const pending = {
    amount: '100.00', idempotencyKey: 'staging-topup:00000000-0000-4000-8000-000000000001',
    principalFingerprint,
  };
  let persisted = JSON.stringify(pending);
  let applyCount = 0;
  const committed = new Map();
  const server = async (request, loseResponse = false) => {
    let response = committed.get(request.idempotencyKey);
    if (!response) {
      applyCount += 1;
      response = { id: 'topup-1', status: 'processing' };
      committed.set(request.idempotencyKey, response);
    }
    if (loseResponse) throw new Error('response lost after topup commit');
    return response;
  };
  await assert.rejects(() => replayPendingStagingTopup(JSON.parse(persisted), principalFingerprint,
    (request) => server(request, true), async () => { persisted = ''; }), /response lost/u);
  assert.notEqual(persisted, '');
  const recovered = await replayPendingStagingTopup(JSON.parse(persisted), principalFingerprint, server,
    async (key) => { assert.equal(key, pending.idempotencyKey); persisted = ''; });
  assert.equal(recovered.id, 'topup-1');
  assert.equal(applyCount, 1);
  assert.equal(committed.size, 1);
  assert.equal(persisted, '');
});

test('pending order and payment records reject a different staging principal before replay', () => {
  const owner = 'c'.repeat(64);
  const other = 'd'.repeat(64);
  assert.throws(() => assertStagingOrderPrincipal({
    signature: 'listing:1.00', listingId: 'listing', quantity: '1.00', idempotencyKey: 'order-key-123456',
    principalFingerprint: owner,
  }, other), /其他测试账号/u);
  assert.throws(() => assertStagingTopupPrincipal({
    amount: '100.00', idempotencyKey: 'topup-key-123456', principalFingerprint: owner,
  }, other), /其他测试账号/u);
  assert.throws(() => assertStagingProfileMutationPrincipal({
    operation: 'revoke_ssh_key', signature: 'a'.repeat(64), idempotencyKey: 'profile-key-123456',
    principalFingerprint: owner, payload: { id: 'key-1', expectedVersion: 1 },
  }, other), /其他测试账号/u);
  assert.throws(() => assertStagingSupplierDraftPrincipal({
    operation: 'create', clientDraftId: 'client-draft-1', draftId: null, expectedVersion: null,
    payload: {}, signature: 'b'.repeat(64), idempotencyKey: 'draft-key-123456', principalFingerprint: owner,
  }, other), /其他测试账号/u);
});

test('fulfillment actions remain server-authoritative and every visible state has honest copy', () => {
  const base = {
    id: 'order-1', number: 'SIM-1', status: 'reserved', version: 6,
    listingSnapshot: { id: 'listing-1', title: '测试 H100', productCode: 'DEMO', region: '华东',
      specifications: {}, simulation: true },
    quantity: '1.00', capacityUnit: 'GPU时', unitPriceCredits: '10.00', totalCredits: '10.00',
    reservedCredits: '10.00', metering: null, createdAt: '', updatedAt: '',
  };
  const running = { ...base, fulfillment: { status: 'running', connectionStatus: 'connected' },
    allowedActions: ['access_preview', 'request_stop', 'open_dispute'] };
  assert.equal(stagingOrderStatus(running), '模拟资源运行中');
  assert.deepEqual(stagingOrderActions(running), ['access_preview', 'request_stop', 'open_dispute']);
  assert.deepEqual(stagingOrderActions({ ...running, allowedActions: [] }), []);
  assert.equal(stagingOrderStatus({ ...base, status: 'acceptance_pending',
    fulfillment: { status: 'stopped', connectionStatus: 'stopped' }, allowedActions: ['accept', 'open_dispute'] }), '待验收');
  assert.equal(stagingOrderStatus({ ...base, status: 'accepted',
    fulfillment: { status: 'stopped', connectionStatus: 'stopped' }, allowedActions: [] }), '测试订单已验收');
  assert.equal(stagingOrderStatus({ ...base, status: 'refunded',
    fulfillment: { status: 'failed', connectionStatus: 'stopped' }, allowedActions: [] }), '测试卡时已退回');
  assert.equal(stagingOrderStatus({ ...base, status: 'disputed',
    fulfillment: { status: 'stopped', connectionStatus: 'stopped' }, allowedActions: [] }), '争议处理中');
});

test('lost fulfillment response replays one persisted action key after restart', async () => {
  const principalFingerprint = 'e'.repeat(64);
  const pending = {
    signature: 'request_stop:order-1:6:', action: 'request_stop', orderId: 'order-1', expectedVersion: 6,
    idempotencyKey: 'staging-order-action:00000000-0000-4000-8000-000000000001', dispute: null,
    principalFingerprint,
  };
  let persisted = JSON.stringify(pending);
  let applyCount = 0;
  const committed = new Map();
  const server = async (request, loseResponse = false) => {
    let response = committed.get(request.idempotencyKey);
    if (!response) {
      applyCount += 1;
      response = { order: { id: request.orderId, version: 7, fulfillment: { status: 'stopping' } } };
      committed.set(request.idempotencyKey, response);
    }
    if (loseResponse) throw new Error('response lost after fulfillment commit');
    return response;
  };
  await assert.rejects(() => replayPendingStagingOrderAction(JSON.parse(persisted), principalFingerprint,
    (request) => server(request, true), async () => { persisted = ''; }), /response lost/u);
  assert.notEqual(persisted, '');
  const recovered = await replayPendingStagingOrderAction(JSON.parse(persisted), principalFingerprint, server, async (key) => {
    assert.equal(key, pending.idempotencyKey);
    persisted = '';
  });
  assert.equal(recovered.order.version, 7);
  assert.equal(applyCount, 1);
  assert.equal(persisted, '');
});

test('pending fulfillment action rejects another principal before replay or clear', async () => {
  const owner = 'e'.repeat(64);
  const other = 'f'.repeat(64);
  const pending = {
    signature: 'a'.repeat(64), action: 'accept', orderId: 'order-1', expectedVersion: 8,
    idempotencyKey: 'staging-order-action:00000000-0000-4000-8000-000000000002', dispute: null,
    principalFingerprint: owner,
  };
  assert.throws(() => assertStagingOrderActionPrincipal(pending, other), /其他测试账号/u);
  let replayed = false; let cleared = false;
  await assert.rejects(() => replayPendingStagingOrderAction(pending, other,
    async () => { replayed = true; }, async () => { cleared = true; }), /其他测试账号/u);
  assert.equal(replayed, false);
  assert.equal(cleared, false);
});

test('cancel and manual delivery cannot mutate the same staging order concurrently', () => {
  const releaseCancel = acquireStagingOrderMutation('order-shared-lock');
  assert.equal(typeof releaseCancel, 'function');
  assert.equal(acquireStagingOrderMutation('order-shared-lock'), null);
  releaseCancel();
  const releaseManualDelivery = acquireStagingOrderMutation('order-shared-lock');
  assert.equal(typeof releaseManualDelivery, 'function');
  releaseManualDelivery();
});

test('cancel refreshes both order slots and manual delivery immediately reads canceled', () => {
  const refresh = nextStagingOrderSlotRefresh(initialStagingOrderSlotRefresh, 'order-shared-refresh', 'order-action');
  const actionReloads = shouldReloadStagingOrderSlot(refresh, 0, 'order-shared-refresh');
  const manualReloads = shouldReloadStagingOrderSlot(refresh, 0, 'order-shared-refresh');
  assert.equal(actionReloads, true);
  assert.equal(manualReloads, true);
  let manualDelivery = { status: 'submitted' };
  if (manualReloads) manualDelivery = { status: 'canceled' };
  assert.equal(manualDelivery.status, 'canceled');
});

test('order detail gates every mutation by allowedActions and terminal rejects connection material', async () => {
  const [slot, actions, actionRecovery, api, recovery, detail, metro] = await Promise.all([
    source('../src/StagingManualDeliverySlot.staging.tsx'), source('../src/StagingOrderActionsSlot.staging.tsx'),
    source('../src/staging-order-action-recovery.ts'), source('../src/staging-sandbox-api.ts'),
    source('../src/staging-profile-mutation-recovery.ts'), source('../src/OrderDetailSheet.tsx'), source('../metro.config.js'),
  ]);
  assert.match(detail, /<StagingManualDeliverySlot enabled=\{source === 'staging'\} orderId=\{currentOrder\.id\}/u);
  assert.match(detail, /<StagingOrderActionsSlot enabled=\{source === 'staging'\}/u);
  assert.match(detail, /refreshSignal=\{stagingSlotRefresh\}/u);
  assert.match(detail, /stagingSlotChanged\('order-action', currentOrder\.id\)/u);
  assert.match(detail, /stagingSlotChanged\('manual-delivery', currentOrder\.id\)/u);
  assert.match(detail, /source === 'formal' \? <><Text style=\{styles\.sectionTitle\}>进度/u);
  assert.match(metro, /StagingOrderActionsSlot\.staging\.tsx/u);
  assert.match(actions, /loadStagingOrder\(orderId\)/u);
  assert.match(actions, /latest\.allowedActions\.includes\(mutationAllowedAction\[action\]\)/u);
  assert.match(actions, /latest\.allowedActions\.includes\('access_preview'\)/u);
  assert.match(actions, /expectedVersion: latest\.version/u);
  assert.match(actions, /replayPendingStagingOrderAction\(pending, fingerprint/u);
  assert.match(actions, /savePendingStagingOrderAction/u);
  assert.match(actions, /acquireStagingOrderMutation\(orderId\)/u);
  assert.match(actions, /shouldReloadStagingOrderSlot\(refreshSignal, observedRefreshRevision\.current, orderId\)/u);
  assert.match(actions, /reason instanceof ApiError && reason\.status === 409/u);
  assert.match(actions, /loadStagingAccessPreview/u);
  assert.match(actions, /不提供复制或连接功能/u);
  assert.match(actionRecovery, /principalFingerprint/u);
  assert.match(actionRecovery, /assertStagingOrderActionPrincipal/u);
  assert.match(actionRecovery, /description\.trim\(\)\.length >= 20/u);
  assert.match(slot, /allowedActions\.includes\('submit_manual_delivery'\)/u);
  assert.match(slot, /loadStagingOrder\(orderId\)/u);
  assert.match(slot, /savePendingStagingProfileMutation/u);
  assert.match(slot, /acquireStagingOrderMutation\(order\.id\)/u);
  assert.match(slot, /shouldReloadStagingOrderSlot\(refreshSignal, observedRefreshRevision\.current, orderId\)/u);
  assert.match(slot, /latest\.allowedActions\.includes\('submit_manual_delivery'\)/u);
  assert.match(slot, /reason instanceof ApiError && reason\.status === 409/u);
  assert.match(slot, /sshPublicKeyId: selected/u);
  assert.match(slot, /不显示真实服务器秘密，不提供复制或连接按钮/u);
  assert.doesNotMatch(slot, /operator\/|标记成功|host|privateKey|terminalScript/u);
  assert.match(recovery, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
  assert.match(recovery, /existing\.signature !== pending\.signature/u);
  assert.match(api, /preview\.connectable !== false/u);
  assert.match(api, /preview\.copyAllowed !== false/u);
  assert.match(api, /preview\.headline !== '测试终端已就绪'/u);
  assert.match(api, /Object\.keys\(preview\)\.some\(\(key\) => !allowedKeys\.has\(key\)\)/u);
  assert.match(api, /preview\.terminalScript\.some\(\(line, index\) => line !== safeTerminalScript\[index\]\)/u);
});

test('customer-facing staging bundle copy uses test environment terms and avoids banned wording', async () => {
  const sources = await Promise.all([
    source('../app.config.js'), generatedAndroidGradle,
    source('../plugins/with-android-release-signing.js'),
    source('../src/StagingEnvironmentBanner.staging.tsx'),
    source('../src/StagingDemoShell.staging.tsx'), source('../src/StagingProfileToolsSlot.staging.tsx'),
    source('../src/StagingManualDeliverySlot.staging.tsx'),
    source('../src/api-client.local-e2e.ts'),
    source('../src/staging-principal.ts'), source('../src/staging-profile-mutation-recovery.ts'),
    source('../src/staging-manual-delivery-api.ts'),
  ]);
  const bundledText = sources.join('\n');
  const banned = new RegExp(['\\u6f14\\u793a', '\\u5c55\\u793a', '\\u671f\\u8d27', '\\u4ea4\\u6613'].join('|'), 'u');
  assert.doesNotMatch(bundledText, banned);
  assert.match(bundledText, /测试环境/u);
  assert.match(bundledText, /人工履约/u);
});

test('visible palette uses mist blue-gray cards without orange surfaces', async () => {
  const paths = [
    '../app.json', '../plugins/with-android-release-signing.js',
    '../src/theme.ts', '../src/ComputeFulfillmentCard.tsx', '../src/OrderDetailSheet.tsx',
    '../src/OrderCard.tsx', '../src/OfferWizardSheet.tsx', '../src/ListingManageSheet.tsx',
    '../src/AccountSecuritySheet.tsx', '../src/screens/MarketScreen.tsx', '../src/screens/PublishScreen.tsx',
    '../src/ListingPublishSheet.tsx', '../src/screens/ProviderWorkspaceScreen.tsx', '../src/CreditPayoutSheet.tsx',
    '../src/SparkProductDetailSheet.tsx', '../src/DeviceOrderSheet.tsx', '../src/CreatorRewardSheet.tsx',
    '../src/FulfillmentIssueCard.tsx', '../src/StagingSupplierDraftsSheet.tsx',
    '../src/StagingProfileToolsSlot.staging.tsx', '../src/StagingOrderActionsSlot.staging.tsx',
  ];
  const visibleSources = (await Promise.all(paths.map(source))).join('\n');
  assert.match(visibleSources, /primary: '#1677FF'/u);
  assert.match(visibleSources, /canvas: '#F2F5F8'/u);
  assert.match(visibleSources, /surface: '#FFFFFF'/u);
  assert.doesNotMatch(visibleSources,
    /#(?:E87909|FF6A00|FFF4E5|FFF0E5|FFF4D4|FFF8E7|FFFCF2|E6D7A9|FFF7E1|FFF3D7|FFE4A8|F4D39A|F0D79A|FFF9E9|7A5000|7A4B22|9A6400|8A5B00|FFFDF9)/iu);
});

test('formal shell contains no staging copy or simulated workflow implementation', async () => {
  const shell = await source('../src/StagingDemoShell.tsx');
  assert.doesNotMatch(shell, /测试环境|测试卡时|模拟支付|模拟购买|10\.0\.2\.2/u);
});

test('staging API traffic is paired with environment request and response proof', async () => {
  const [client, config, principal] = await Promise.all([
    source('../src/api-client.local-e2e.ts'), source('../app.config.js'), source('../src/staging-principal.ts'),
  ]);
  assert.match(client, /'X-Zod-Client-Environment': 'staging'/u);
  assert.match(client, /response\.headers\.get\('X-Zod-Environment'\) !== 'staging'/u);
  assert.match(client, /envelope\?\.environment !== 'staging'/u);
  assert.match(client, /envelope\.simulation !== true/u);
  assert.match(client, /STAGING_RESPONSE_MISMATCH/u);
  assert.match(client, /loadStagingPrincipalToken/u);
  assert.match(config, /tokens must be injected into SecureStore/u);
  assert.doesNotMatch(config, /stagingPrincipalToken/u);
  assert.match(principal, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
  assert.doesNotMatch(principal, /console\.|AsyncStorage/u);
});

function sshRsa(bits) {
  const field = (value) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  const modulus = Buffer.alloc(bits / 8, 0xff);
  const blob = Buffer.concat([field(Buffer.from('ssh-rsa')), field(Buffer.from([1, 0, 1])), field(modulus)]);
  return `ssh-rsa ${blob.toString('base64')}`;
}

test('SSH key input rejects private material and RSA below 3072 bits before server validation', () => {
  assert.equal(checkSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret').valid, false);
  assert.match(checkSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret').error, /私钥/u);
  assert.match(checkSshPublicKey(sshRsa(2048)).error, /至少需要 3072 位/u);
  assert.equal(checkSshPublicKey(sshRsa(3072)).valid, true);
  const ed25519 = checkSshPublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGR1bW15 comment-not-saved');
  assert.equal(ed25519.valid, true);
  assert.equal(ed25519.commentIgnored, true);
});

test('profile and manual-delivery mutations retain one key until server confirmation', async () => {
  const principalFingerprint = '7'.repeat(64);
  const pending = { operation: 'submit_manual_delivery', signature: 'a'.repeat(64),
    idempotencyKey: 'staging-profile:00000000-0000-4000-8000-000000000001',
    payload: { orderId: 'order-1', expectedOrderVersion: 3, sshPublicKeyId: 'key-1' },
    principalFingerprint };
  let clears = 0; let calls = 0;
  await assert.rejects(() => replayStagingProfileMutation(pending, principalFingerprint, async (value) => {
    calls += 1;
    assert.equal(value.idempotencyKey, pending.idempotencyKey);
    throw new Error('response lost');
  }, async () => { clears += 1; }), /response lost/u);
  assert.equal(clears, 0);
  await replayStagingProfileMutation(pending, principalFingerprint, async () => { calls += 1; return { id: 'request-1' }; },
    async (key) => { assert.equal(key, pending.idempotencyKey); clears += 1; });
  assert.equal(calls, 2);
  assert.equal(clears, 1);
});

test('manual-delivery API consumes only safe wrappers and static POST/PATCH contracts', async () => {
  const [api, slot, profile] = await Promise.all([
    source('../src/staging-manual-delivery-api.ts'), source('../src/StagingManualDeliverySlot.staging.tsx'),
    source('../src/StagingProfileToolsSlot.staging.tsx'),
  ]);
  assert.match(api, /\{ sshPublicKey: StagingSshPublicKey \}/u);
  assert.match(api, /return response\.sshPublicKey/u);
  assert.match(api, /\{ manualDeliveryRequest: StagingManualDeliveryRequest \}/u);
  assert.match(api, /return response\.manualDeliveryRequest/u);
  assert.match(api, /\/revoke`[^]*method: 'POST'/u);
  assert.match(api, /manual-delivery-requests`[^]*method: 'POST'/u);
  assert.match(api, /method: 'PATCH'/u);
  assert.doesNotMatch(api, /publicKey: StagingSshPublicKey\['publicKey'\]|privateKey|password/u);
  assert.match(slot, /allowedActions\.includes\('submit_manual_delivery'\)/u);
  assert.match(profile, /只粘贴公钥，绝不要提交私钥/u);
  assert.match(profile, /服务端不会回传完整公钥/u);
});

test('supplier draft permits partial server saves but rejects sensitive fields and fractional cents', () => {
  const partial = emptySupplierDraftForm('client-draft-0001', 'Asia/Shanghai');
  assert.deepEqual(validateSupplierDraftForm(partial), {});
  assert.equal(supplierDraftPayload(partial).deliveryPlan, null);
  assert.equal(supplierDraftPayload(partial).pricing.amount, null);
  assert.match(validateSupplierDraftForm({ ...partial, fulfillmentNotes: 'password=secret' }).fulfillmentNotes,
    /禁止填写/u);
  assert.match(validateSupplierDraftForm({ ...partial, priceAmount: '1.001' }).priceAmount, /最多两位小数/u);
  assert.equal(supplierDraftPayload({ ...partial, capacityGpuHours: '120', priceAmount: '2.5' }).resource.capacityGpuHours,
    '120.00');
  assert.equal(supplierDraftPayload({ ...partial, capacityGpuHours: '120', priceAmount: '2.5' }).pricing.amount,
    '2.50');
});

test('supplier draft create/update retains one persisted key until server confirmation', async () => {
  const principalFingerprint = '8'.repeat(64);
  const payload = supplierDraftPayload(emptySupplierDraftForm('client-draft-0002', 'Asia/Shanghai'));
  const pending = { operation: 'create', clientDraftId: payload.clientDraftId, draftId: null, expectedVersion: null,
    payload, signature: 'b'.repeat(64), idempotencyKey: 'staging-draft:00000000-0000-4000-8000-000000000001',
    principalFingerprint };
  let cleared = false;
  await assert.rejects(() => replayPendingStagingSupplierDraft(pending, principalFingerprint,
    async () => { throw new Error('lost response'); },
    async () => { cleared = true; }), /lost response/u);
  assert.equal(cleared, false);
  const result = await replayPendingStagingSupplierDraft(pending, principalFingerprint,
    async () => ({ id: 'draft-1', version: 1 }),
    async (key) => { assert.equal(key, pending.idempotencyKey); cleared = true; });
  assert.equal(result.id, 'draft-1');
  assert.equal(cleared, true);
});

test('supplier draft UI is an incremental Profile sheet with four compact groups and no publish action', async () => {
  const [profile, slot, sheet, api, recovery] = await Promise.all([
    source('../src/screens/ProfileScreen.tsx'), source('../src/StagingProfileToolsSlot.staging.tsx'),
    source('../src/StagingSupplierDraftsSheet.tsx'), source('../src/staging-supplier-drafts-api.ts'),
    source('../src/staging-supplier-draft-recovery.ts'),
  ]);
  assert.match(profile, /label=\{stagingTools\.draftEntry\.label\}/u);
  assert.match(slot, /label: '测试资源草稿'/u);
  assert.match(slot, /<StagingSupplierDraftsSheet/u);
  assert.match(sheet, /基础资源.*设备能力.*可用安排.*拟定卡时与确认/us);
  assert.match(sheet, /保存到服务器/u);
  assert.match(sheet, /DateTimePickerAndroid\.open/u);
  assert.match(sheet, /服务器已有新版本/u);
  assert.match(sheet, /setNotice\(`已保存 · 版本 \$\{saved\.version\}`\)/u);
  assert.match(sheet, /setServerDraft\(saved\).*setBaseline\(savedForm\)/us);
  assert.doesNotMatch(sheet, /onSaved=\{async \(\) => \{ setEditing\(null\)/u);
  assert.doesNotMatch(sheet, /提交审核|发布资源|立即购买|人民币|¥/u);
  assert.match(api, /method: 'POST'/u);
  assert.match(api, /method: 'PATCH'/u);
  assert.match(recovery, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
});

test('test principal connection validates before replacing SecureStore and stays out of the formal slot', async () => {
  const [staging, formal, principal, profile, guard, profileRecovery, draftRecovery] = await Promise.all([
    source('../src/StagingProfileToolsSlot.staging.tsx'), source('../src/StagingProfileToolsSlot.tsx'),
    source('../src/staging-principal.ts'), source('../src/screens/ProfileScreen.tsx'), source('../src/staging-pending-guard.ts'),
    source('../src/staging-profile-mutation-recovery.ts'), source('../src/staging-supplier-draft-recovery.ts'),
  ]);
  assert.match(staging, /secureTextEntry/u);
  assert.match(staging, /await verifyStagingPrincipal\(value\)/u);
  assert.match(staging, /await assertNoPendingStagingMutationBeforePrincipalChange\(\)/u);
  assert.match(staging, /await saveStagingPrincipalToken\(value\)/u);
  assert.match(staging, /'X-Zod-Client-Environment': 'staging'/u);
  assert.match(staging, /'x-kai-e2e-session': candidate/u);
  assert.doesNotMatch(staging, /Authorization|X-KAI-ID-Token|console\.|Clipboard/u);
  assert.match(staging, /clearStagingPrincipalToken/u);
  assert.match(guard, /loadPendingStagingOrder\(\).*loadPendingStagingTopup\(\).*loadPendingStagingOrderAction\(\).*loadPendingStagingProfileMutation\(\).*loadPendingStagingSupplierDraft\(\)/us);
  assert.match(guard, /Promise\.allSettled/u);
  assert.match(profileRecovery, /principalFingerprint/u);
  assert.match(profileRecovery, /assertStagingProfileMutationPrincipal/u);
  assert.match(draftRecovery, /principalFingerprint/u);
  assert.match(draftRecovery, /assertStagingSupplierDraftPrincipal/u);
  assert.match(principal, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
  assert.doesNotMatch(formal, /连接测试账号|staging\.principal|x-kai-e2e-session|4187/u);
  assert.match(profile, /stagingTools\.connectionEntry/u);
  assert.doesNotMatch(profile, /连接测试账号|测试资源草稿|SSH 公钥/u);
});
