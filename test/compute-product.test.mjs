import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  dedicatedGpuServiceTitle, gpuHourMeaning, gpuNodeSummary, isDedicatedGpuHour, memoryGiBPerGpu, nodeGpuCount,
} from '../src/compute-product.ts';

test('turns an eight-card node name into a one-card service title', () => {
  assert.equal(dedicatedGpuServiceTitle('8× NVIDIA H100 SXM5'), 'NVIDIA H100 SXM5 单卡独享');
  assert.equal(dedicatedGpuServiceTitle('H100 整卡独享'), 'H100 整卡独享');
});

test('only the current dedicated GPU-hour contract is purchasable', () => {
  assert.equal(isDedicatedGpuHour({ kind: 'gpu', capacityUnit: 'GPU时', serviceMode: 'dedicated' }), true);
  assert.equal(isDedicatedGpuHour({ kind: 'gpu', capacityUnit: 'GPU时', serviceMode: 'shared' }), false);
  assert.equal(isDedicatedGpuHour({ kind: 'storage', capacityUnit: 'TB时', serviceMode: 'dedicated' }), false);
});

test('explains duration and reads audited node GPU count', () => {
  assert.equal(gpuHourMeaning('3'), '3 GPU时 = 1 张 GPU × 3 小时');
  assert.equal(nodeGpuCount({ gpuCount: 8 }), 8);
  assert.equal(nodeGpuCount({ acceleratorCount: '8' }), 8);
  assert.equal(nodeGpuCount({}), null);
  assert.equal(memoryGiBPerGpu({ memoryGiBPerGpu: 98 }), 98);
  assert.equal(gpuNodeSummary({ gpuCount: 8, memoryGiBPerGpu: 98 }), '8 张 GPU · 单卡 98 GB');
});

test('provider, market, and order UI use the same single-card contract', async () => {
  const [app, resource, wizard, market, order, detail] = await Promise.all([
    readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/PublishFlowSheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/OfferWizardSheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/screens/MarketScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/MarketOrderSheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/OrderDetailSheet.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(resource, /节点 GPU 数/u);
  assert.match(resource, /单卡显存（GB）/u);
  assert.match(resource, /1 张 GPU × 1 小时/u);
  assert.match(resource, /8 张卡各开放 100 小时，填写 800 GPU时/u);
  assert.match(wizard, /可售总量/u);
  assert.match(wizard, /formScrollRef\.current\?\.scrollTo\(\{ y: 0, animated: false \}\)/u);
  assert.match(wizard, /不需要重复创建方案/u);
  assert.doesNotMatch(resource, /H100-SXM-80G/u);
  assert.doesNotMatch(wizard, /共享算力|切片实例|整机节点|预约时段/u);
  assert.match(wizard, /每个订单固定分配 1 张 GPU/u);
  assert.match(market, /每单 1 张 GPU/u);
  assert.match(order, /实例健康并取得连接信息后才开始计费/u);
  assert.match(order, /订单结果正在确认/u);
  assert.match(order, /不会重复下单/u);
  assert.match(detail, /!isComputeOrder && currentOrder\.side === 'buyer'/u);
  assert.match(detail, /isComputeOrder \? '资源已锁定' : '提供方接单'/u);
  assert.match(app, /setSelectedOrder\(order\);\s*void refresh\(\)\.catch/u);
  assert.doesNotMatch(app, /await refresh\(\);\s*setSelectedOrder\(order\)/u);
});
