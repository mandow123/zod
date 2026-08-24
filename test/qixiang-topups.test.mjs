import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceQixiangPending, assertQixiangCheckoutUrl, decodeQixiangCreateResponse, decodeQixiangPendingTopup,
  decodeQixiangReadinessProjection, decodeQixiangRecheckResponse, decodeQixiangTopup,
  decodeQixiangTopupCapability, decodeQixiangTopupDetail,
  decodeQixiangTopupList, parseQixiangPendingTopup, qixiangCreditAmount, qixiangPendingForSubject,
  qixiangTopupGate, shouldClearQixiangPending,
} from '../src/qixiang-topups.ts';

const TOPUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER_TOPUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const SUBJECT = 'a'.repeat(64);
const OTHER_SUBJECT = 'b'.repeat(64);

function enabledCapability(overrides = {}) {
  return {
    mode: 'on', available: true, canaryOnly: false, rails: ['qixiang_alipay'], minAmountCents: 100, maxAmountCents: 4_999_999,
    conversion: { numerator: 1000, denominator: 1002, rounding: 'floor', precision: 2 }, lotValidityDays: 364,
    checkout: { kind: 'external_browser', allowedOrigin: 'https://api.payqixiang.cn', allowedPathPrefix: '/pay/submit/' },
    blockers: [], ...overrides,
  };
}

function disabledCapability(mode = 'off') {
  return { mode, available: false, canaryOnly: false, rails: [], minAmountCents: null, maxAmountCents: null, conversion: null,
    lotValidityDays: 364, checkout: null, blockers: [] };
}

function readiness(capability = enabledCapability(), profile = 'full_commerce', releaseReady = true) {
  return {
    ok: true,
    profile: profile === 'full_commerce'
      ? { id: 'full_commerce', routePolicy: 'full-commerce-v1' }
      : { id: 'inquiry_only', routePolicy: 'allowlist-v1' },
    release: { ready: releaseReady, blockers: [] },
    capabilities: { qixiangTopups: capability, sms: true },
    deployment: { ready: releaseReady },
  };
}

function topup(status = 'pending', amountCents = 10_000, overrides = {}) {
  const succeededAt = status === 'succeeded' ? '2026-08-21T06:00:00.000Z' : null;
  const entitlementExpiry = status === 'succeeded' ? '2027-08-20T06:00:00.000Z' : null;
  const allowedActions = status === 'pending' ? ['open_checkout', 'recheck', 'contact_support']
    : status === 'succeeded' ? ['contact_support'] : status === 'failed' ? ['contact_support'] : ['recheck'];
  return {
    id: TOPUP_ID, topupNumber: 'QX-20260821-000001', provider: 'qixiang', rail: 'qixiang_alipay', status, version: 1,
    payment: { currency: 'CNY', amountCents, amount: `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}` },
    credit: { unit: 'KAI_CARD_HOUR', amount: qixiangCreditAmount(amountCents), precision: 2 },
    conversion: { numerator: 1000, denominator: 1002, rounding: 'floor' },
    entitlement: { validityDays: 364, expiresAt: entitlementExpiry },
    checkoutExpiresAt: '2026-08-21T06:10:00.000Z',
    createdAt: '2026-08-21T05:59:00.000Z', succeededAt, lastCheckedAt: null, allowedActions, ...overrides,
  };
}

function checkout() {
  return { kind: 'external_browser', url: 'https://api.payqixiang.cn/pay/submit/aZ_09-/',
    expiresAt: '2026-08-21T06:10:00.000Z' };
}

function pending(overrides = {}) {
  return {
    schemaVersion: 1, subjectFingerprint: SUBJECT, phase: 'create_persisted', amountCents: 10_000,
    rail: 'qixiang_alipay', idempotencyKey: 'qixiang:00000000-0000-4000-8000-000000000001', requestDigest: 'c'.repeat(64),
    topupId: null, createdAt: '2026-08-21T06:00:00.000Z', updatedAt: '2026-08-21T06:00:00.000Z', ...overrides,
  };
}

test('七相 capability 只有完整 full_commerce/auth/release on 契约通过门禁', () => {
  assert.equal(decodeQixiangTopupCapability(disabledCapability()).available, false);
  assert.ok(qixiangTopupGate({ authenticated: true, readiness: readiness() }));
  assert.equal(qixiangTopupGate({ authenticated: false, readiness: readiness() }), null);
  assert.equal(qixiangTopupGate({ authenticated: true, readiness: readiness(enabledCapability(), 'inquiry_only') }), null);
  assert.equal(qixiangTopupGate({ authenticated: true, readiness: readiness(enabledCapability(), 'full_commerce', false) }), null);
  assert.equal(qixiangTopupGate({ authenticated: true, readiness: readiness(disabledCapability('shadow')) }), null);

  for (const capability of [
    enabledCapability({ rails: ['qixiang_wechat'] }), enabledCapability({ blockers: ['NOT_READY'] }),
    enabledCapability({ conversion: { numerator: 1, denominator: 1, rounding: 'floor', precision: 2 } }),
    enabledCapability({ checkout: { kind: 'external_browser', allowedOrigin: 'https://example.com', allowedPathPrefix: '/pay/submit/' } }),
    { ...enabledCapability(), merchantId: 'forbidden' },
    { ...disabledCapability(), available: true },
  ]) assert.equal(qixiangTopupGate({ authenticated: true, readiness: readiness(capability) }), null);
});

test('生产 bootstrap 只在后端明示 canaryOnly 且金额固定 ¥5.01 时穿过 release 门禁', () => {
  const canary = enabledCapability({ canaryOnly: true, minAmountCents: 501, maxAmountCents: 501 });
  const gate = qixiangTopupGate({ authenticated: true, readiness: readiness(canary, 'full_commerce', false) });
  assert.equal(gate?.canaryOnly, true);
  assert.equal(gate?.maxAmountCents, 501);
  assert.throws(() => decodeQixiangTopupCapability(enabledCapability({ canaryOnly: true,
    minAmountCents: 100, maxAmountCents: 501 })), /QIXIANG_CONTRACT_INVALID/u);
  assert.equal(qixiangTopupGate({ authenticated: true,
    readiness: readiness(enabledCapability({ maxAmountCents: 501 }), 'full_commerce', false) }), null);
});

test('readiness 仅严格读取支付投影：profile exact，siblings 可共存，裸字符串拒绝', () => {
  const projection = decodeQixiangReadinessProjection(readiness());
  assert.equal(projection.profile.id, 'full_commerce');
  assert.equal(projection.releaseReady, true);
  const stringProfile = readiness(); stringProfile.profile = 'full_commerce';
  assert.throws(() => decodeQixiangReadinessProjection(stringProfile), /QIXIANG_CONTRACT_INVALID/u);
  const extraProfile = readiness(); extraProfile.profile.extra = true;
  assert.throws(() => decodeQixiangReadinessProjection(extraProfile), /QIXIANG_CONTRACT_INVALID/u);
  const wrongPolicy = readiness(); wrongPolicy.profile.routePolicy = 'allowlist-v1';
  assert.throws(() => decodeQixiangReadinessProjection(wrongPolicy), /QIXIANG_CONTRACT_INVALID/u);
});

test('金额换算严格按 1000/1002 向下取整到两位', () => {
  assert.equal(qixiangCreditAmount(100), '0.99');
  assert.equal(qixiangCreditAmount(101), '1.00');
  assert.equal(qixiangCreditAmount(10_000), '99.80');
  assert.equal(qixiangCreditAmount(100_000), '998.00');
  assert.equal(qixiangCreditAmount(enabledCapability().maxAmountCents), '49900.18');
});

test('Custom Tab checkout URL 仅接受七相 exact origin/path 且无附加 URL 成分', () => {
  const valid = checkout().url;
  assert.equal(assertQixiangCheckoutUrl(valid), valid);
  for (const invalid of [
    'http://api.payqixiang.cn/pay/submit/a/', 'https://www.api.payqixiang.cn/pay/submit/a/',
    'https://api.payqixiang.cn:443/pay/submit/a/', 'https://user@api.payqixiang.cn/pay/submit/a/',
    'https://api.payqixiang.cn/pay/submit/a', 'https://api.payqixiang.cn/pay/submit/a/?return=1',
    'https://api.payqixiang.cn/pay/submit/a/#done', 'https://api.payqixiang.cn/pay/submit/a%2Fb/',
  ]) assert.throws(() => assertQixiangCheckoutUrl(invalid), /QIXIANG_CONTRACT_INVALID/u);
});

test('Topup/Create/List/Detail/Recheck 全层 exact decode 且 detail 绑定请求 ID', () => {
  const decoded = decodeQixiangTopup(topup());
  assert.equal(decoded.credit.amount, '99.80');
  assert.equal(decodeQixiangCreateResponse({ topup: topup(), checkout: checkout() }).topup.id, TOPUP_ID);
  assert.equal(decodeQixiangCreateResponse({ topup: topup('verifying'), checkout: null }).topup.status, 'verifying');
  assert.equal(decodeQixiangTopupDetail({ topup: topup(), checkout: checkout() }, TOPUP_ID).checkout.url, checkout().url);
  assert.throws(() => decodeQixiangTopupDetail({ topup: topup(), checkout: checkout() }, OTHER_TOPUP_ID),
    /QIXIANG_TOPUP_ID_MISMATCH/u);
  assert.equal(decodeQixiangTopupList({ items: [topup()], nextCursor: null,
    creation: { allowed: false, reason: 'unresolved_topup',canaryOnly:false,requiredAmountCents:null } }).items.length, 1);
  assert.equal(decodeQixiangRecheckResponse({ topup: topup('verifying') }).topup.status, 'verifying');

  const injections = [
    () => ({ ...topup(), providerTrade: 'forbidden' }),
    () => ({ ...topup(), payment: { ...topup().payment, merchantKey: 'forbidden' } }),
    () => ({ ...topup(), credit: { ...topup().credit, cashAmount: '100.00' } }),
    () => ({ ...topup(), conversion: { ...topup().conversion, signature: 'forbidden' } }),
    () => ({ ...topup(), entitlement: { ...topup().entitlement, transferable: true } }),
  ];
  for (const inject of injections) assert.throws(() => decodeQixiangTopup(inject()), /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangCreateResponse({ topup: topup(), checkout: { ...checkout(), rawTrade: 'x' } }),
    /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangCreateResponse({ topup: topup(), checkout: null }),
    /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangCreateResponse({ topup: topup('failed'), checkout: checkout() }),
    /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangTopupList({ items: [topup()], nextCursor: null,
    creation: { allowed: true, reason: null,canaryOnly:false,requiredAmountCents:null,inventory: 1 } }), /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangRecheckResponse({ topup: topup(), checkout: checkout() }),
    /QIXIANG_CONTRACT_INVALID/u);
});

test('Topup 状态、金额、到账日期和动作不一致时 fail closed', () => {
  assert.throws(() => decodeQixiangTopup(topup('pending', 10_000,
    { credit: { unit: 'KAI_CARD_HOUR', amount: '99.81', precision: 2 } })), /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangTopup(topup('pending', 10_000, { succeededAt: '2026-08-21T06:00:00.000Z' })),
    /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangTopup(topup('succeeded', 10_000,
    { entitlement: { validityDays: 364, expiresAt: '2027-08-21T06:00:00.000Z' } })),
    /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangTopup(topup('failed', 10_000,
    { allowedActions: ['open_checkout'], checkoutExpiresAt: '2026-08-21T06:10:00.000Z' })),
    /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangTopup(topup('pending', 10_000, { id: TOPUP_ID.toUpperCase() })),
    /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangTopup(topup('pending', 10_000,
    { id: '00000000-0000-1000-8000-000000000001' })), /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangTopup(topup('pending', 10_000, { createdAt: '2026-08-21T06:00:00Z' })),
    /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangTopup(topup('pending', 10_000,
    { checkoutExpiresAt: '2026-08-21T14:10:00.000+08:00' })), /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangTopup(topup('pending', 10_000, { lastCheckedAt: '2026-02-30T06:00:00.000Z' })),
    /QIXIANG_CONTRACT_INVALID/u);
  assert.throws(() => decodeQixiangTopupList({ items: [topup()], nextCursor: null,
    creation: { allowed: true, reason: 'unresolved_topup',canaryOnly:false,requiredAmountCents:null } }), /QIXIANG_CONTRACT_INVALID/u);
});

test('待处理状态 exact、跨主体隔离、只向前推进且只在服务端成功或失败后清理', () => {
  const initial = decodeQixiangPendingTopup(pending());
  assert.equal(qixiangPendingForSubject(initial, SUBJECT).amountCents, 10_000);
  assert.throws(() => qixiangPendingForSubject(initial, OTHER_SUBJECT), /QIXIANG_PENDING_SUBJECT_MISMATCH/u);
  const opened = advanceQixiangPending(initial, 'checkout_opened', '2026-08-21T06:01:00.000Z', TOPUP_ID);
  const returned = advanceQixiangPending(opened, 'return_observed', '2026-08-21T06:02:00.000Z');
  const rechecking = advanceQixiangPending(returned, 'recheck_pending', '2026-08-21T06:03:00.000Z');
  assert.equal(rechecking.topupId, TOPUP_ID);
  assert.throws(() => advanceQixiangPending(rechecking, 'checkout_opened', '2026-08-21T06:04:00.000Z'),
    /QIXIANG_PENDING_INTEGRITY/u);
  assert.equal(shouldClearQixiangPending(decodeQixiangTopup(topup('succeeded'))), true);
  assert.equal(shouldClearQixiangPending(decodeQixiangTopup(topup('failed'))), true);
  assert.equal(shouldClearQixiangPending(decodeQixiangTopup(topup('expired'))), false);
  assert.equal(shouldClearQixiangPending(decodeQixiangTopup(topup('manual_review'))), false);
});

test('待处理状态损坏、额外字段、主体不匹配和无 topup 的后续 phase 都阻断且不被覆盖', () => {
  assert.throws(() => parseQixiangPendingTopup('{'), /QIXIANG_PENDING_INTEGRITY/u);
  assert.throws(() => decodeQixiangPendingTopup({ ...pending(), checkoutUrl: checkout().url }),
    /QIXIANG_PENDING_INTEGRITY/u);
  assert.throws(() => decodeQixiangPendingTopup(pending({ subjectFingerprint: OTHER_SUBJECT.slice(1) })),
    /QIXIANG_PENDING_INTEGRITY/u);
  assert.throws(() => decodeQixiangPendingTopup(pending({ phase: 'checkout_opened' })),
    /QIXIANG_PENDING_INTEGRITY/u);
  assert.throws(() => decodeQixiangPendingTopup(pending({ topupId: TOPUP_ID })),
    /QIXIANG_PENDING_INTEGRITY/u);
  assert.throws(() => decodeQixiangPendingTopup(pending({ updatedAt: '2026-08-21T05:59:59.000Z' })),
    /QIXIANG_PENDING_INTEGRITY/u);
});
