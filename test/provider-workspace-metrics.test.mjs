import assert from 'node:assert/strict';
import test from 'node:test';
import {
  providerOrderSection, providerWorkspaceMetrics, providerWorkspaceRoadmap,
} from '../src/provider-workspace-metrics.ts';

function workspace(overrides = {}) {
  return {
    supplier: { status: 'approved' },
    resources: { draft: 0, awaitingMaterials: 0, underReview: 0, verified: 1, rejected: 0, suspended: 0, retired: 0 },
    offers: { draft: 0, underReview: 0, changesRequested: 0, approved: 0, rejected: 0, suspended: 0, expired: 0 },
    listings: { selling: 0, scheduled: 0, scheduledPaused: 0, paused: 0, soldOut: 0 },
    resourceActions: [],
    ...overrides,
  };
}

test('materials not yet submitted count as action, not review', () => {
  const metrics = providerWorkspaceMetrics({
    resources: { draft: 0, awaitingMaterials: 2, underReview: 1, verified: 3, rejected: 1, suspended: 0, retired: 0 },
    offers: { draft: 0, underReview: 4, changesRequested: 1, approved: 0, rejected: 1, suspended: 0, expired: 1 },
  });
  assert.deepEqual(metrics, { resourceTotal: 7, awaitingReview: 5, needsAction: 6 });
});

test('provider order section distinguishes real work from recent history', () => {
  assert.deepEqual(providerOrderSection([{ actions: ['confirm'] }, { actions: [] }]), {
    title: '订单处理', count: '1 笔待处理', actionable: 1,
  });
  assert.deepEqual(providerOrderSection([{ actions: [] }]), {
    title: '近期订单', count: '1 笔', actionable: 0,
  });
  assert.deepEqual(providerOrderSection([{ actions: [], status: 'disputed' }]), {
    title: '订单处理', count: '1 笔待处理', actionable: 1,
  });
  assert.deepEqual(providerOrderSection([{ actions: [], status: 'accepted', requiresAttention: true }]), {
    title: '订单处理', count: '1 笔待处理', actionable: 1,
  });
});

test('资料通过后必须先完成节点接入，不能跳过到方案双审', () => {
  assert.deepEqual(providerWorkspaceRoadmap(workspace()), {
    supplierDone: true, resourceDone: true, nodeDone: false, offerDone: false, listingDone: false, firstIncomplete: 2,
  });
  assert.deepEqual(providerWorkspaceRoadmap(workspace({
    resourceActions: [{ key: 'create_offer' }],
  })), {
    supplierDone: true, resourceDone: true, nodeDone: true, offerDone: false, listingDone: false, firstIncomplete: 3,
  });
});

test('已有上架方案或挂牌时节点阶段保持完成', () => {
  assert.equal(providerWorkspaceRoadmap(workspace({
    offers: { draft: 1, underReview: 0, changesRequested: 0, approved: 0, rejected: 0, suspended: 0, expired: 0 },
  })).nodeDone, true);
  assert.equal(providerWorkspaceRoadmap(workspace({
    listings: { selling: 1, scheduled: 0, scheduledPaused: 0, paused: 0, soldOut: 0 },
  })).nodeDone, true);
});
