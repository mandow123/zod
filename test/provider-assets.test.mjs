import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  filterProviderAssets, providerAssetActionAllowed, providerAssetLifecycleLabel, providerAssetManagementLabel,
  providerAssetMaterialLabel,
} from '../src/provider-asset-model.ts';

function asset(overrides = {}) {
  return {
    id: 'asset-1',
    resourceId: 'resource-1',
    name: 'H100 计算节点',
    productCode: 'gpu-h100',
    region: '华东-上海',
    specifications: { gpuModel: 'H100', gpuCount: 8 },
    managementMode: 'self_managed',
    status: 'pending_connection',
    statusLabel: '待接入',
    statusDetail: '请完成节点接入。',
    materialStatus: 'verified',
    deliveryReadiness: { status: 'unbound', label: '节点待接入', nodeLastSeenAt: null },
    lifecycle: 'registered',
    lifecycleFacts: { renewedAt: null, repurchasedAt: null, closedAt: null },
    views: [],
    attention: null,
    nextAction: null,
    updatedAt: '2026-08-14T08:00:00.000Z',
    ...overrides,
  };
}

test('asset filters only expose evidence-backed operating states', () => {
  const assets = [
    asset(),
    asset({ id: 'asset-2', status: 'standby' }),
    asset({ id: 'asset-3', status: 'operating', views: ['operating'] }),
    asset({ id: 'asset-4', status: 'operating_issue', views: ['attention'], attention: { title: '节点离线', detail: '请检查节点。', severity: 'critical' } }),
  ];
  assert.equal(filterProviderAssets(assets, 'all').length, 4);
  assert.deepEqual(filterProviderAssets(assets, 'attention').map((item) => item.id), ['asset-4']);
  assert.deepEqual(filterProviderAssets(assets, 'pending_connection').map((item) => item.id), ['asset-1']);
  assert.deepEqual(filterProviderAssets(assets, 'standby').map((item) => item.id), ['asset-2']);
  assert.deepEqual(filterProviderAssets(assets, 'operating').map((item) => item.id), ['asset-3']);
});

test('asset views filter only on backend lifecycle and custody facts', () => {
  const hosted = asset({ id: 'hosted', managementMode: 'platform_hosted', views: ['hosted'] });
  const deploying = asset({ id: 'deploying', views: ['deploying'] });
  const renewed = asset({ id: 'renewed', views: ['renewed'], lifecycleFacts: { renewedAt: '2026-08-15T01:00:00.000Z', repurchasedAt: null, closedAt: null } });
  const repurchased = asset({ id: 'repurchased', lifecycle: 'retired', views: ['repurchased', 'closed'], lifecycleFacts: { renewedAt: null, repurchasedAt: '2026-08-15T02:00:00.000Z', closedAt: '2026-08-15T02:00:00.000Z' } });
  const closed = asset({ id: 'closed', lifecycle: 'retired', views: ['closed'], lifecycleFacts: { renewedAt: null, repurchasedAt: null, closedAt: '2026-08-15T03:00:00.000Z' } });
  const assets = [hosted, deploying, renewed, repurchased, closed];
  for (const [view, expected] of [
    ['hosted', ['hosted']], ['deploying', ['deploying']], ['renewed', ['renewed']],
    ['repurchased', ['repurchased']], ['closed', ['repurchased', 'closed']],
  ]) assert.deepEqual(filterProviderAssets(assets, view).map((item) => item.id), expected);
  assert.deepEqual(filterProviderAssets(assets, 'pending_connection').map((item) => item.id), ['hosted', 'deploying', 'renewed']);
});

test('asset labels do not invent hosted ownership or lifecycle actions', () => {
  assert.equal(providerAssetManagementLabel('self_managed'), '自有设备');
  assert.equal(providerAssetManagementLabel('platform_hosted'), '托管设备');
  assert.equal(providerAssetMaterialLabel('verified'), '资料已核验');
  assert.equal(providerAssetLifecycleLabel('active'), '使用中');
  assert.equal(providerAssetLifecycleLabel('retired'), '设备关闭');
});

test('read-only members can inspect evidence but cannot see management actions', () => {
  const view = { key: 'view_resource', label: '查看资料', route: 'provider_resources', entityId: 'resource-1', target: 'resource' };
  const resubmit = { ...view, key: 'resubmit_resource', label: '重新提交' };
  const createOffer = { ...view, key: 'create_offer', label: '创建方案', route: 'provider_offer_create' };
  const fulfillment = { key: 'view_fulfillment', label: '查看运行订单', route: 'provider_order', entityId: 'order-1', target: 'fulfillment' };
  const review = { key: 'track_offer_review', label: '查看双审进度', route: 'provider_offer_review', entityId: 'offer-1', target: 'offer_review' };
  const draft = { ...review, key: 'view_offer_draft', label: '查看上架草稿' };
  assert.equal(providerAssetActionAllowed(view, false), true);
  assert.equal(providerAssetActionAllowed(fulfillment, false), true);
  assert.equal(providerAssetActionAllowed(review, false), true);
  assert.equal(providerAssetActionAllowed(draft, false), true);
  assert.equal(providerAssetActionAllowed(resubmit, false), false);
  assert.equal(providerAssetActionAllowed(createOffer, false), false);
  assert.equal(providerAssetActionAllowed(createOffer, true), true);
});

test('asset action contract includes every backend offer and draft transition', async () => {
  const model = await readFile(new URL('../src/provider-asset-model.ts', import.meta.url), 'utf8');
  for (const key of [
    'resume_offer_draft', 'resolve_offer_review', 'reaudit_expired_offer',
    'publish_approved_offer', 'track_offer_review', 'view_offer_draft',
  ]) assert.match(model, new RegExp(`'${key}'`, 'u'));
  for (const route of ['provider_offer_editor', 'provider_offer_review', 'provider_listing_editor']) {
    assert.match(model, new RegExp(`'${route}'`, 'u'));
  }
  for (const target of ['wizard_draft', 'offer_revision', 'offer_review', 'offer_listing']) {
    assert.match(model, new RegExp(`'${target}'`, 'u'));
  }
});

test('asset UI consumes the dedicated API contract and exposes lifecycle views', async () => {
  const [screen, contract, navigation] = await Promise.all([
    readFile(new URL('../src/screens/ProviderResourcesScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/provider-assets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(contract, /\/mobile\/v1\/provider\/assets/u);
  assert.match(screen, /loadProviderAssets\(\)/u);
  assert.match(screen, /loadProviderAsset\(asset\.id\)/u);
  assert.match(screen, /assetRequestGeneration/u);
  assert.match(screen, /providerAssetActionAllowed/u);
  assert.match(screen, /!snapshot\.authenticated \|\| canManage/u);
  assert.match(navigation, /key: 'resources', label: '资产'/u);
  for (const lifecycleCopy of ['托管设备', '部署中', '设备关闭', '已续产', '已回购']) {
    assert.match(screen, new RegExp(lifecycleCopy, 'u'));
  }
  assert.match(contract, /ProviderAssetSummary/u);
});
