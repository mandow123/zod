import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createOrReplayQixiangTopup, createQixiangBrowserReturnCoordinator,
  listQixiangTopupsWhenEnabled, recoverQixiangTopup,
  loadQixiangTopupWhenEnabled, observeQixiangBrowserReturn, recheckQixiangTopupByUser,
} from '../src/qixiang-topup-flow.ts';
import { createQixiangPendingPersistence } from '../src/qixiang-topup-persistence-core.ts';
import { qixiangCreditAmount } from '../src/qixiang-topups.ts';

const TOPUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER_TOPUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const SUBJECT = 'a'.repeat(64);
const OTHER_SUBJECT = 'b'.repeat(64);

function readiness(enabled = true) {
  return {
    authenticated: enabled,
    readiness: {
      profile: { id: enabled ? 'full_commerce' : 'inquiry_only',
        routePolicy: enabled ? 'full-commerce-v1' : 'allowlist-v1' },
      release: { ready: enabled, blockers: [] },
      capabilities: { qixiangTopups: enabled ? {
        mode: 'on', available: true, canaryOnly: false, rails: ['qixiang_alipay'], minAmountCents: 100, maxAmountCents: 4_999_999,
        conversion: { numerator: 1000, denominator: 1002, rounding: 'floor', precision: 2 }, lotValidityDays: 364,
        checkout: { kind: 'external_browser', allowedOrigin: 'https://api.payqixiang.cn',
          allowedPathPrefix: '/pay/submit/' }, blockers: [],
      } : { mode: 'off', available: false, canaryOnly: false, rails: [], minAmountCents: null, maxAmountCents: null,
        conversion: null, lotValidityDays: 364, checkout: null, blockers: [] } },
    },
  };
}

function topup(status = 'pending', version = 1) {
  const succeededAt = status === 'succeeded' ? '2026-08-21T06:00:00.000Z' : null;
  return {
    id: TOPUP_ID, topupNumber: 'QX-20260821-000001', provider: 'qixiang', rail: 'qixiang_alipay', status, version,
    payment: { currency: 'CNY', amountCents: 10_000, amount: '100.00' },
    credit: { unit: 'KAI_CARD_HOUR', amount: qixiangCreditAmount(10_000), precision: 2 },
    conversion: { numerator: 1000, denominator: 1002, rounding: 'floor' },
    entitlement: { validityDays: 364, expiresAt: status === 'succeeded' ? '2027-08-20T06:00:00.000Z' : null },
    checkoutExpiresAt: '2026-08-21T06:10:00.000Z', createdAt: '2026-08-21T05:59:00.000Z',
    succeededAt, lastCheckedAt: null,
    allowedActions: status === 'pending' ? ['open_checkout', 'recheck', 'contact_support']
      : status === 'succeeded' || status === 'failed' ? ['contact_support'] : ['recheck'],
  };
}

function checkout() {
  return { kind: 'external_browser', url: 'https://api.payqixiang.cn/pay/submit/opaque_1/',
    expiresAt: '2026-08-21T06:10:00.000Z' };
}

function harness(initialRaw = null) {
  let raw = initialRaw; let tick = 0; let uuid = 0;
  const writes = []; let removes = 0;
  const pending = createQixiangPendingPersistence({
    get: async () => raw,
    set: async (value) => { writes.push(value); raw = value; },
    remove: async () => { removes += 1; raw = null; },
    digest: async (value) => createHash('sha256').update(value).digest('hex'),
    randomUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    now: () => new Date(Date.parse('2026-08-21T06:00:00.000Z') + tick++ * 1_000).toISOString(),
  });
  return { pending, writes, get raw() { return raw; }, get removes() { return removes; } };
}

function api(overrides = {}) {
  return {
    create: async () => ({ topup: topup(), checkout: checkout() }),
    list: async () => ({ items: [topup()] }),
    detail: async () => ({ topup: topup(), checkout: checkout() }),
    recheck: async () => ({ topup: topup('verifying', 2) }),
    ...overrides,
  };
}

test('create 一定先持久化；丢响应/强杀后不自动 create，用户重试复用同 key', async () => {
  const storage = harness(); const keys = []; let createCalls = 0;
  const firstApi = api({ create: async (_amount, key) => {
    createCalls += 1; keys.push(key);
    assert.equal(JSON.parse(storage.raw).phase, 'create_persisted');
    throw new Error('NETWORK_RESPONSE_LOST');
  } });
  await assert.rejects(() => createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000,
    { pending: storage.pending, api: firstApi }), /NETWORK_RESPONSE_LOST/u);
  const persisted = JSON.parse(storage.raw);
  assert.equal(persisted.topupId, null);
  assert.equal(createCalls, 1);

  let recoveryNetwork = 0;
  const recovered = await recoverQixiangTopup(readiness(), SUBJECT,
    { pending: storage.pending, api: api({ detail: async () => { recoveryNetwork += 1; throw new Error('unexpected'); } }) });
  assert.equal(recovered.kind, 'create_unresolved');
  assert.equal(recoveryNetwork, 0);

  const replayed = await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000, {
    pending: storage.pending,
    api: api({ create: async (_amount, key) => { keys.push(key); return { topup: topup(), checkout: checkout() }; } }),
  });
  assert.equal(keys[0], keys[1]);
  assert.equal(replayed.pending.phase, 'checkout_opened');
  assert.equal(JSON.parse(storage.raw).topupId, TOPUP_ID);
});

test('有 topupId 的强杀恢复只 GET detail；服务端 late success 清 pending，expired 保留', async () => {
  const storage = harness();
  await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000, { pending: storage.pending, api: api() });
  let createCalls = 0; let detailCalls = 0;
  const recovered = await recoverQixiangTopup(readiness(), SUBJECT, { pending: storage.pending,
    api: api({ create: async () => { createCalls += 1; throw new Error('unexpected'); }, detail: async () => {
      detailCalls += 1; return { topup: topup('succeeded', 2), checkout: null };
    } }) });
  assert.equal(recovered.kind, 'loaded');
  assert.equal(recovered.pending, null);
  assert.equal(createCalls, 0); assert.equal(detailCalls, 1); assert.equal(storage.raw, null);

  const expiredStorage = harness();
  await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000, { pending: expiredStorage.pending, api: api() });
  const expired = await recoverQixiangTopup(readiness(), SUBJECT, { pending: expiredStorage.pending,
    api: api({ detail: async () => ({ topup: topup('expired', 2), checkout: null }) }) });
  assert.equal(expired.topup.status, 'expired');
  assert.notEqual(expiredStorage.raw, null);
});

test('成功取得 topupId 后重复点击只 GET detail，不重复 POST create', async () => {
  const storage = harness();
  await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000, { pending: storage.pending, api: api() });
  let creates = 0; let details = 0;
  const result = await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000, { pending: storage.pending, api: api({
    create: async () => { creates += 1; throw new Error('unexpected'); },
    detail: async () => { details += 1; return { topup: topup(), checkout: checkout() }; },
  }) });
  assert.equal(result.topup.id, TOPUP_ID);
  assert.equal(creates, 0); assert.equal(details, 1);
});

test('create 有即时 checkout 才进入 checkout_opened；verifying 歧义进入 return_observed', async () => {
  const direct = harness();
  const created = await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000, {
    pending: direct.pending, api: api(),
  });
  assert.equal(created.pending.phase, 'checkout_opened');
  assert.notEqual(created.checkout, null);

  const ambiguous = harness(); let creates = 0;
  const verifying = await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000, {
    pending: ambiguous.pending,
    api: api({ create: async () => {
      creates += 1;
      return { topup: topup('verifying'), checkout: null };
    } }),
  });
  assert.equal(creates, 1);
  assert.equal(verifying.topup.status, 'verifying');
  assert.equal(verifying.checkout, null);
  assert.equal(verifying.pending.phase, 'return_observed');
  assert.equal(JSON.parse(ambiguous.raw).topupId, TOPUP_ID);
});

test('verifying 歧义强杀恢复只 GET；迟到 pending checkout 可由UI显式打开', async () => {
  const storage = harness();
  await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000, {
    pending: storage.pending,
    api: api({ create: async () => ({ topup: topup('verifying'), checkout: null }) }),
  });
  let creates = 0; let details = 0;
  const recovered = await recoverQixiangTopup(readiness(), SUBJECT, {
    pending: storage.pending,
    api: api({
      create: async () => { creates += 1; throw new Error('unexpected'); },
      detail: async () => { details += 1; return { topup: topup('pending', 2), checkout: checkout() }; },
    }),
  });
  assert.equal(recovered.kind, 'loaded');
  assert.equal(recovered.pending.phase, 'return_observed');
  assert.equal(recovered.topup.status, 'pending');
  assert.deepEqual(recovered.checkout, checkout());
  assert.equal(creates, 0); assert.equal(details, 1);
});

test('recheck 使用自己的 pending key，先存再 POST；丢响应后同 version 复用同 key', async () => {
  const storage = harness();
  const created = await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000,
    { pending: storage.pending, api: api() });
  const keys = [];
  await assert.rejects(() => recheckQixiangTopupByUser(readiness(), SUBJECT, created.topup, {
    pending: storage.pending, api: api({ recheck: async (_id, _version, key) => {
      keys.push(key); assert.equal(JSON.parse(storage.raw).phase, 'recheck_pending'); throw new Error('NETWORK_RESPONSE_LOST');
    } }),
  }), /NETWORK_RESPONSE_LOST/u);
  const persisted = JSON.parse(storage.raw);
  assert.match(persisted.idempotencyKey, /^qixiang-recheck:/u);
  assert.notEqual(persisted.idempotencyKey, created.pending.idempotencyKey);
  await recheckQixiangTopupByUser(readiness(), SUBJECT, created.topup, { pending: storage.pending,
    api: api({ recheck: async (_id, _version, key) => { keys.push(key); return { topup: topup('verifying', 2) }; } }) });
  assert.equal(keys[0], keys[1]);
  assert.notEqual(storage.raw, null);
});

test('历史 topup 无本机 create pending 也能先落 recheck pending 再请求', async () => {
  const storage = harness(); const keys = [];
  const result = await recheckQixiangTopupByUser(readiness(), SUBJECT, topup(), {
    pending: storage.pending,
    api: api({ recheck: async (_id, _version, key) => {
      keys.push(key);
      const persisted = JSON.parse(storage.raw);
      assert.equal(persisted.phase, 'recheck_pending');
      assert.equal(persisted.topupId, TOPUP_ID);
      assert.equal(persisted.amountCents, 10_000);
      return { topup: topup('verifying', 2) };
    } }),
  });
  assert.equal(result.topup.status, 'verifying');
  assert.match(keys[0], /^qixiang-recheck:/u);
});

test('另一未解决 topup 阻断历史 recheck 且不覆盖、不发请求', async () => {
  const storage = harness(); let recheckCalls = 0;
  await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000, { pending: storage.pending, api: api() });
  const original = storage.raw;
  const otherTopup = { ...topup(), id: OTHER_TOPUP_ID };
  await assert.rejects(() => recheckQixiangTopupByUser(readiness(), SUBJECT, otherTopup, {
    pending: storage.pending,
    api: api({ recheck: async () => { recheckCalls += 1; throw new Error('unexpected'); } }),
  }), /QIXIANG_PENDING_UNRESOLVED/u);
  assert.equal(recheckCalls, 0);
  assert.equal(storage.raw, original);
});

test('浏览器返回、Linking 或 AppState 恢复只推进 return 并 GET detail', async () => {
  const storage = harness(); let creates = 0; let details = 0; let rechecks = 0;
  await createOrReplayQixiangTopup(readiness(), SUBJECT, 10_000, {
    pending: storage.pending, api: api({ create: async () => { creates += 1; return { topup: topup(), checkout: checkout() }; } }),
  });
  const observed = await observeQixiangBrowserReturn(readiness(), SUBJECT, {
    pending: storage.pending,
    api: api({
      create: async () => { creates += 1; throw new Error('unexpected'); },
      detail: async () => { details += 1; return { topup: topup(), checkout: checkout() }; },
      recheck: async () => { rechecks += 1; throw new Error('unexpected'); },
    }),
  });
  assert.equal(observed.kind, 'loaded');
  assert.equal(JSON.parse(storage.raw).phase, 'return_observed');
  assert.equal(creates, 1); assert.equal(details, 1); assert.equal(rechecks, 0);
});

test('browser promise resolve 与 AppState/Linking 紧邻回流共用一次只读核对', async () => {
  const coordinator = createQixiangBrowserReturnCoordinator();
  const attempt = coordinator.begin();
  let detailGets = 0; let recheckPosts = 0; let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const readDetailOnly = async () => { detailGets += 1; await barrier; };
  const browserResolve = coordinator.observe(attempt, readDetailOnly);
  const appState = coordinator.observe(attempt, readDetailOnly);
  const linking = coordinator.observe(attempt, readDetailOnly);
  release();
  assert.deepEqual(await Promise.all([browserResolve, appState, linking]), [true, true, true]);
  assert.equal(detailGets, 1);
  assert.equal(recheckPosts, 0);
  assert.equal(await coordinator.observe(attempt, async () => { recheckPosts += 1; }), false);
  assert.equal(recheckPosts, 0);
});

test('cross-subject/corrupt/changed pending 均保留原值并阻断覆盖或清理', async () => {
  const storage = harness();
  await storage.pending.prepareCreate(SUBJECT, 10_000);
  const original = storage.raw;
  await assert.rejects(() => storage.pending.load(OTHER_SUBJECT), /QIXIANG_PENDING_SUBJECT_MISMATCH/u);
  await assert.rejects(() => storage.pending.prepareCreate(OTHER_SUBJECT, 10_000), /QIXIANG_PENDING_SUBJECT_MISMATCH/u);
  assert.equal(storage.raw, original);

  const corrupt = harness('{');
  await assert.rejects(() => corrupt.pending.prepareCreate(SUBJECT, 10_000), /QIXIANG_PENDING_INTEGRITY/u);
  assert.equal(corrupt.raw, '{');
  assert.equal(corrupt.removes, 0);

  const prepared = await storage.pending.load(SUBJECT);
  const opened = await storage.pending.advance(prepared, 'checkout_opened', TOPUP_ID);
  await storage.pending.prepareRecheck(SUBJECT, TOPUP_ID, 10_000, 1);
  await assert.rejects(() => storage.pending.clearTerminal(opened), /QIXIANG_PENDING_CHANGED/u);
});

test('gate false 时 storage 与 create/list/detail/recheck 全部 0 调用', async () => {
  const calls = { get: 0, set: 0, create: 0, list: 0, detail: 0, recheck: 0 };
  const pending = {
    load: async () => { calls.get += 1; return null; },
    prepareCreate: async () => { calls.set += 1; throw new Error('unexpected'); },
    advance: async () => { calls.set += 1; throw new Error('unexpected'); },
    prepareRecheck: async () => { calls.set += 1; throw new Error('unexpected'); },
    clearTerminal: async () => { calls.set += 1; },
  };
  const network = api({
    create: async () => { calls.create += 1; throw new Error('unexpected'); },
    list: async () => { calls.list += 1; throw new Error('unexpected'); },
    detail: async () => { calls.detail += 1; throw new Error('unexpected'); },
    recheck: async () => { calls.recheck += 1; throw new Error('unexpected'); },
  });
  const deps = { pending, api: network }; const off = readiness(false);
  await assert.rejects(() => createOrReplayQixiangTopup(off, SUBJECT, 10_000, deps), /QIXIANG_CAPABILITY_UNAVAILABLE/u);
  await assert.rejects(() => recoverQixiangTopup(off, SUBJECT, deps), /QIXIANG_CAPABILITY_UNAVAILABLE/u);
  await assert.rejects(() => listQixiangTopupsWhenEnabled(off, null, deps), /QIXIANG_CAPABILITY_UNAVAILABLE/u);
  await assert.rejects(() => loadQixiangTopupWhenEnabled(off, TOPUP_ID, deps),
    /QIXIANG_CAPABILITY_UNAVAILABLE/u);
  await assert.rejects(() => observeQixiangBrowserReturn(off, SUBJECT, deps),
    /QIXIANG_CAPABILITY_UNAVAILABLE/u);
  await assert.rejects(() => recheckQixiangTopupByUser(off, SUBJECT, topup(), deps),
    /QIXIANG_CAPABILITY_UNAVAILABLE/u);
  assert.deepEqual(calls, { get: 0, set: 0, create: 0, list: 0, detail: 0, recheck: 0 });
});

test('bootstrap canary 非 ¥5.01 在持久化和网络前阻断', async () => {
  const gate = readiness();
  gate.readiness.release.ready = false;
  Object.assign(gate.readiness.capabilities.qixiangTopups,
    { canaryOnly: true, minAmountCents: 501, maxAmountCents: 501 });
  const storage = harness(); let creates = 0;
  await assert.rejects(() => createOrReplayQixiangTopup(gate, SUBJECT, 500, {
    pending: storage.pending,
    api: api({ create: async () => { creates += 1; throw new Error('unexpected'); } }),
  }), /QIXIANG_CANARY_AMOUNT_REQUIRED/u);
  assert.equal(storage.raw, null); assert.equal(creates, 0);
});

test('正式 transport 仅含 paired exact API，SecureStore 使用 device-only 且无浏览器/UI 接线', async () => {
  const [transport, persistence, flow] = await Promise.all([
    readFile(new URL('../src/qixiang-topup-api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/qixiang-topup-persistence.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/qixiang-topup-flow.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(transport, /\/mobile\/v1\/credits\/topups\/qixiang/u);
  assert.match(transport, /body: \{ amountCents, rail: QIXIANG_RAIL \}/u);
  assert.match(transport, /body: \{ expectedVersion \}/u);
  assert.match(transport, /auth: 'required'/u);
  assert.doesNotMatch(transport, /wechat|wxpay|WebView|sign_type|merchantPid|providerReference/u);
  assert.match(persistence, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/u);
  assert.doesNotMatch(persistence, /checkoutUrl|providerReference|merchantPid/u);
  assert.doesNotMatch(flow, /WebBrowser|WebView|AppState/u);
});
