import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AccountService } from '../src/account/service.js';
import type { MarketService } from '../src/market/service.js';
import type { ListingAuditService } from '../src/listings/service.js';
import type { CreditLedgerService } from '../src/credits/service.js';
import type { CreditTopupService } from '../src/topups/service.js';
import type { CreditOrderService } from '../src/credit-orders/service.js';
import type { CreditPayoutService } from '../src/payouts/service.js';
import type { DeviceCommerceService } from '../src/device-commerce/service.js';

const routeTestAccounts = {
  authenticate: async () => ({ principal: { userId: 'route-user', sessionId: 'route-session', role: 'member' }, identity: {} }),
  requestOtp: async () => ({ challengeId: '10000000-0000-4000-8000-000000000001', expiresInSeconds: 300, resendAfterSeconds: 60 }),
} as unknown as AccountService;

const routeTestMarket = {
  resources: async () => ({ resources: [], nextCursor: null }),
} as unknown as MarketService;

const routeTestListings = {
  publicListings: async (_limit?: number, principal?: { userId: string }) => [{
    id: 'listing-1', unitCredits: '31.14', audits: { resource: true, price: true },
    ownedByCurrentSubject: principal?.userId === 'route-user',
  }],
  supplierOffers: async () => [],
  setListingStatus: async (_principal: unknown, listingId: string, status: string) => ({
    replayed: false, listing: { id: listingId, status },
  }),
} as unknown as ListingAuditService;

const routeTestCredits = {
  balance: async () => ({
    subjectId: '10000000-0000-4000-8000-000000000001', unit: 'KAI_CREDIT', precision: 2,
    available: '12.50', reserved: '2.00', supplierReceivable: '1.00', total: '15.50',
  }),
} as unknown as CreditLedgerService;

const topupCalls: Array<Record<string, unknown>> = [];
const routeTestTopups = {
  create: async (_principal: unknown, input: Record<string, unknown>) => {
    topupCalls.push(input);
    return { replayed: false, topup: { id: '30000000-0000-4000-8000-000000000001', status: 'pending', amountCny: '100.00', creditAmount: '99.80' } };
  },
  list: async () => [],
  get: async () => ({ id: '30000000-0000-4000-8000-000000000001', status: 'pending', checkoutPayload: 'signed-app-order' }),
  alipayNotification: async () => 'succeeded',
  wechatNotification: async (_headers: unknown, rawBody: string) => { topupCalls.push({ rawBody }); return 'succeeded'; },
} as unknown as CreditTopupService;

const routeTestOrders = {
  create: async (_principal: unknown, input: Record<string, unknown>) => ({
    replayed: false, order: {
      id: '40000000-0000-4000-8000-000000000001', status: 'reserved', side: 'buyer',
      listingId: input.listingId, quantity: input.quantity, unitCredits: '31.14', totalCredits: '62.28',
    },
  }),
  list: async () => [],
  get: async () => ({ id: '40000000-0000-4000-8000-000000000001', status: 'reserved', side: 'buyer' }),
  confirm: async () => ({ replayed: false, order: { id: '40000000-0000-4000-8000-000000000001', status: 'confirmed', side: 'provider' } }),
  cancel: async () => ({ replayed: false, order: { id: '40000000-0000-4000-8000-000000000001', status: 'cancelled', side: 'buyer' } }),
  startDelivery: async () => ({ replayed: false, order: { id: '40000000-0000-4000-8000-000000000001', status: 'provisioning', side: 'provider' } }),
  startRework: async () => ({ replayed: false, order: { id: '40000000-0000-4000-8000-000000000001', status: 'provisioning', side: 'provider' } }),
  deliveryReady: async (_principal: unknown, _orderId: string, details: Record<string, unknown>) => ({
    replayed: false, order: { id: '40000000-0000-4000-8000-000000000001', status: 'acceptance_pending', side: 'provider' }, detailsReceived: details,
  }),
  delivery: async () => ({
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'acceptance_pending', side: 'buyer' },
    delivery: { details: { endpoint: '10.0.0.8', username: 'root' }, digest: 'delivery-digest' },
  }),
  accept: async () => ({ replayed: false, order: { id: '40000000-0000-4000-8000-000000000001', status: 'accepted', side: 'buyer' } }),
  reportDeliveryIssue: async () => ({ replayed: false, order: { id: '40000000-0000-4000-8000-000000000001', status: 'disputed', side: 'buyer' } }),
  deliveryIssue: async () => ({
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'disputed', side: 'provider' },
    issue: { status: 'open', requestedResolution: 'rework', description: '连接后立即断开。' },
  }),
  approveMutualRefund: async () => ({ replayed: false, order: { id: '40000000-0000-4000-8000-000000000001', status: 'refunded', side: 'provider' } }),
  mutualRefund: async () => ({
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'refunded', side: 'buyer' },
    refund: { status: 'succeeded', creditAmount: '62.28', approvedAt: '2026-08-12T13:00:00.000Z' },
  }),
  escalateDispute: async () => ({
    replayed: false,
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'disputed', side: 'buyer' },
  }),
  disputeAdjudication: async () => ({
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'refunded', side: 'buyer' },
    adjudication: {
      status: 'resolved', outcome: 'full_refund', reason: '交付与挂牌不一致，支持全额退款。',
      creditAmount: '62.28', decidedAt: '2026-08-12T13:00:00.000Z',
    },
  }),
  pendingDisputeAdjudications: async () => [{
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'disputed' },
    description: '交付规格不一致。', delivery: { attemptNumber: 1, details: { endpoint: '10.0.0.8' } },
  }],
  decideDispute: async (_principal: unknown, _orderId: string, input: Record<string, unknown>) => ({
    replayed: false, decisionId: 'decision-1', outcome: input.outcome,
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'refunded' },
  }),
  settleSupplier: async () => ({
    replayed: false,
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'closed', side: 'provider' },
  }),
  supplierSettlement: async () => ({
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'closed', side: 'provider' },
    settlement: {
      status: 'succeeded', creditAmount: '62.28', triggeredBy: 'provider',
      acceptedAt: '2026-08-05T13:00:00.000Z', availableAt: '2026-08-12T13:00:00.000Z',
      settledAt: '2026-08-12T13:00:00.000Z',
    },
  }),
  requestPostAcceptanceRefund: async () => ({
    replayed: false,
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'accepted', side: 'buyer' },
  }),
  approvePostAcceptanceRefund: async () => ({
    replayed: false,
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'refunded', side: 'provider' },
  }),
  contestPostAcceptanceRefund: async () => ({
    replayed: false,
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'accepted', side: 'provider' },
  }),
  escalatePostAcceptanceRefund: async () => ({
    replayed: false,
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'accepted', side: 'buyer' },
  }),
  pendingPostAcceptanceRefundAdjudications: async () => [{
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'accepted' },
    description: '验收后发现实际规格不符。', providerResponse: '资源规格与审核材料一致。',
    creditAmount: '62.28',
    delivery: { attemptNumber: 1, details: { endpoint: '10.0.0.8' } },
  }],
  decidePostAcceptanceRefund: async (_principal: unknown, _orderId: string, input: Record<string, unknown>) => {
    const outcome = input.outcome === 'approve_refund' ? 'full_refund' : 'reject_refund';
    return { replayed: false, decisionId: 'aftercare-decision-1', outcome,
      order: { id: '40000000-0000-4000-8000-000000000001', status: outcome === 'full_refund' ? 'refunded' : 'accepted' } };
  },
  postAcceptanceRefund: async () => ({
    order: { id: '40000000-0000-4000-8000-000000000001', status: 'refunded', side: 'buyer' },
    aftercareRefund: {
      status: 'succeeded', description: '验收后发现实际规格不符。', creditAmount: '62.28',
      requestedAt: '2026-08-06T00:00:00.000Z', resolvedAt: '2026-08-07T00:00:00.000Z',
    },
  }),
} as unknown as CreditOrderService;

const routeTestPayouts = {
  create: async (_principal: unknown, input: Record<string, unknown>) => ({ replayed: false,
    payout: { id: '50000000-0000-4000-8000-000000000001', status: 'submitted', ...input } }),
  profile: async () => ({ status: 'active' }), list: async () => [],
  get: async () => ({ id: '50000000-0000-4000-8000-000000000001', status: 'submitted' }),
  cancel: async () => ({ replayed: false, payout: { status: 'cancelled' } }),
} as unknown as CreditPayoutService;

const routeTestDevices = {
  products: async () => [{ id: '02672000-0000-4000-8000-000000000200', title: 'NVIDIA DGX Spark',
    purchasable: true, inventory: { total: 200, available: 200 } }],
  product: async () => ({ id: '02672000-0000-4000-8000-000000000200', title: 'NVIDIA DGX Spark' }),
  create: async (_principal: unknown, input: Record<string, unknown>) => ({ replayed: false,
    order: { id: '60000000-0000-4000-8000-000000000001', status: 'reserved', ...input } }),
  ship: async (_principal: unknown, orderId: string, _key: string, _context: unknown, input: Record<string, unknown>) => ({
    replayed: false, order: { id: orderId, status: 'shipping', ...input },
  }),
  orders: async () => [], assets: async () => [],
} as unknown as DeviceCommerceService;

describe('system routes', () => {
  it('serves liveness without exposing configuration', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, marketService: routeTestMarket, logger: false,
    });
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, apiVersion: 'mobile/v1' });
    await app.close();
  });

  it('keeps readiness closed when the database and release credentials are absent', async () => {
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), database: null, logger: false });
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/readiness' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, release: { ready: false } });
    expect(response.json().release.blockers).toContain('DATABASE_CONNECTION');
    expect(response.json().release.blockers).toContain('PUSH');
    expect(response.json().release.blockers).not.toContain('PUSH_CREDENTIALS_JSON');
    expect(response.json()).toMatchObject({
      deployment: { ready: false },
      commerce: { model: 'kai-credit-only', ready: false, implemented: true },
      capabilities: { creditCommerce: false },
    });
    await app.close();
  });

  it('returns a stable error envelope for unknown routes', async () => {
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), database: null, logger: false });
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/missing' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(response.json().error.requestId).toBeTypeOf('string');
    await app.close();
  });

  it('returns a stable 429 envelope when a route rate limit is reached', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, logger: false,
    });
    const request = () => app.inject({
      method: 'POST', url: '/mobile/v1/auth/otp/request',
      payload: { phone: '13800138000', purpose: 'login' },
    });
    for (let index = 0; index < 5; index += 1) expect((await request()).statusCode).toBe(202);
    const limited = await request();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      ok: false, error: { code: 'RATE_LIMITED', message: '操作太频繁，请稍后再试。' },
    });
    expect(limited.json().error.requestId).toBeTypeOf('string');
    await app.close();
  });

  it('exposes only the new double-audited credit listing catalog', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, listingAuditService: routeTestListings, logger: false,
    });
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/market/listings' });
    expect(response.statusCode).toBe(200);
    expect(response.json().listings[0]).toMatchObject({
      unitCredits: '31.14', audits: { resource: true, price: true },
      ownedByCurrentSubject: false,
    });
    expect(response.json().listings[0]).not.toHaveProperty('supplierId');
    expect(response.json().listings[0]).not.toHaveProperty('supplierSubjectId');
    expect(response.json().listings[0]).not.toHaveProperty('unitPriceCents');
    expect(response.json().listings[0]).not.toHaveProperty('unitPriceCny');
    await app.close();
  });

  it('marks the current subject listing without exposing provider identity', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, listingAuditService: routeTestListings, logger: false,
    });
    const response = await app.inject({
      method: 'GET', url: '/mobile/v1/market/listings', headers: { authorization: 'Bearer route-test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().listings[0]).toMatchObject({ ownedByCurrentSubject: true });
    expect(response.json().listings[0]).not.toHaveProperty('supplierId');
    expect(response.json().listings[0]).not.toHaveProperty('supplierSubjectId');
    await app.close();
  });

  it('changes only the authenticated provider listing status', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, listingAuditService: routeTestListings, logger: false,
    });
    const listingId = '20000000-0000-4000-8000-000000000001';
    const response = await app.inject({
      method: 'PUT', url: `/mobile/v1/provider/listings/${listingId}/status`,
      headers: { authorization: 'Bearer route-test' }, payload: { status: 'paused' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, replayed: false, listing: { id: listingId, status: 'paused' } });
    await app.close();
  });

  it('returns the selected subject KAI credit balance without RMB fields', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditLedgerService: routeTestCredits, logger: false,
    });
    const response = await app.inject({
      method: 'GET', url: '/mobile/v1/credits/balance', headers: { authorization: 'Bearer route-test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      balance: {
        unit: 'KAI_CREDIT', precision: 2, available: '12.50', reserved: '2.00',
        supplierReceivable: '1.00', total: '15.50',
      },
    });
    expect(response.json().balance).not.toHaveProperty('amountCny');
    expect(response.json().balance).not.toHaveProperty('balanceCents');
    await app.close();
  });

  it('creates only an authenticated App topup and preserves the raw WeChat signature body', async () => {
    topupCalls.length = 0;
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditTopupService: routeTestTopups, logger: false,
    });
    const created = await app.inject({
      method: 'POST', url: '/mobile/v1/credits/topups',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'topup-route-request-0001' },
      payload: { amountCents: 10_000, provider: 'alipay', channel: 'app' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ topup: { status: 'pending', amountCny: '100.00', creditAmount: '99.80' } });
    const storeTopup = await app.inject({
      method: 'POST', url: '/mobile/v1/credits/topups',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'topup-route-store-0001', 'x-kai-distribution-channel': 'google-play' },
      payload: { amountCents: 10_000, provider: 'alipay', channel: 'app' },
    });
    expect(storeTopup.statusCode).toBe(403);
    expect(storeTopup.json()).toMatchObject({ error: { code: 'DISTRIBUTION_CHANNEL_RESTRICTED' } });
    const resumable = await app.inject({
      method: 'GET', url: '/mobile/v1/credits/topups/30000000-0000-4000-8000-000000000001',
      headers: { authorization: 'Bearer route-test' },
    });
    expect(resumable.statusCode).toBe(200);
    expect(resumable.json()).toMatchObject({ topup: { status: 'pending', checkoutPayload: 'signed-app-order' } });
    const rejectedH5 = await app.inject({
      method: 'POST', url: '/mobile/v1/credits/topups',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'topup-route-request-0002' },
      payload: { amountCents: 10_000, provider: 'alipay', channel: 'h5' },
    });
    expect(rejectedH5.statusCode).toBe(400);
    const raw = '{"id":"wechat-event","resource":{"ciphertext":"opaque"}}';
    const callback = await app.inject({ method: 'POST', url: '/mobile/v1/credits/topups/wechat/notify', headers: { 'content-type': 'application/json' }, payload: raw });
    expect(callback.statusCode).toBe(200);
    expect(topupCalls).toContainEqual({ rawBody: raw });
    await app.close();
  });

  it('creates a KAI credit reservation order and rejects old RMB checkout fields', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditOrderService: routeTestOrders, logger: false,
    });
    const created = await app.inject({
      method: 'POST', url: '/mobile/v1/orders',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'credit-order-route-0001' },
      payload: { listingId: '20000000-0000-4000-8000-000000000001', quantity: '2' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ order: { status: 'reserved', totalCredits: '62.28' } });
    const rmb = await app.inject({
      method: 'POST', url: '/mobile/v1/orders',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'credit-order-route-0002' },
      payload: {
        listingId: '20000000-0000-4000-8000-000000000001', quantity: '2',
        totalCents: 6240, currency: 'CNY', paymentProvider: 'alipay',
      },
    });
    expect(rmb.statusCode).toBe(400);
    const storeOrder = await app.inject({
      method: 'POST', url: '/mobile/v1/orders',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'credit-order-route-store-0001', 'x-kai-distribution-channel': 'google-play' },
      payload: { listingId: '20000000-0000-4000-8000-000000000001', quantity: '2' },
    });
    expect(storeOrder.statusCode).toBe(403);
    expect(storeOrder.json()).toMatchObject({ error: { code: 'DISTRIBUTION_CHANNEL_RESTRICTED' } });
    await app.close();
  });

  it('exposes separate provider confirmation and buyer cancellation actions', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditOrderService: routeTestOrders, logger: false,
    });
    const orderId = '40000000-0000-4000-8000-000000000001';
    const confirmed = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/confirm`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'provider-confirm-route-001' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ order: { status: 'confirmed', side: 'provider' } });
    const cancelled = await app.inject({
      method: 'POST', url: `/mobile/v1/orders/${orderId}/cancel`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'buyer-cancel-route-0001' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ order: { status: 'cancelled', side: 'buyer' } });
    await app.close();
  });

  it('keeps delivery actions separate and releases KAI credits only through buyer acceptance', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditOrderService: routeTestOrders, logger: false,
    });
    const orderId = '40000000-0000-4000-8000-000000000001';
    const headers = { authorization: 'Bearer route-test', 'idempotency-key': 'delivery-route-request-001' };
    const started = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/delivery/start`, headers,
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ order: { status: 'provisioning', side: 'provider' } });
    const ready = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/delivery/ready`, headers,
      payload: { details: {
        endpoint: '10.0.0.8', username: 'root', instructions: '登录后运行验收任务。',
      } },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ order: { status: 'acceptance_pending' } });
    const delivery = await app.inject({
      method: 'GET', url: `/mobile/v1/orders/${orderId}/delivery`, headers: { authorization: 'Bearer route-test' },
    });
    expect(delivery.statusCode).toBe(200);
    expect(delivery.json()).toMatchObject({ delivery: { details: { endpoint: '10.0.0.8', username: 'root' } } });
    const accepted = await app.inject({
      method: 'POST', url: `/mobile/v1/orders/${orderId}/accept`, headers, payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ order: { status: 'accepted', side: 'buyer' } });
    await app.close();
  });

  it('exposes a separate delivery issue action without treating it as acceptance', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditOrderService: routeTestOrders, logger: false,
    });
    const orderId = '40000000-0000-4000-8000-000000000001';
    const reported = await app.inject({
      method: 'POST', url: `/mobile/v1/orders/${orderId}/delivery/issue`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'buyer-report-route-0001' },
      payload: { requestedResolution: 'rework', description: '连接后立即断开。' },
    });
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toMatchObject({ order: { status: 'disputed', side: 'buyer' } });
    const detail = await app.inject({
      method: 'GET', url: `/mobile/v1/orders/${orderId}/delivery/issue`,
      headers: { authorization: 'Bearer route-test' },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      issue: { status: 'open', requestedResolution: 'rework', description: '连接后立即断开。' },
    });
    const rework = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/delivery/rework/start`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'provider-rework-route-001' },
    });
    expect(rework.statusCode).toBe(200);
    expect(rework.json()).toMatchObject({ order: { status: 'provisioning', side: 'provider' } });
    await app.close();
  });

  it('approves an exact full refund without accepting an amount from either party', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditOrderService: routeTestOrders, logger: false,
    });
    const orderId = '40000000-0000-4000-8000-000000000001';
    const approved = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/refund/approve`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'provider-refund-route-001' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ order: { status: 'refunded', side: 'provider' } });
    const rejectedAmount = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/refund/approve`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'provider-refund-route-002' },
      payload: { creditAmount: '1.00' },
    });
    expect(rejectedAmount.statusCode).toBe(400);
    const detail = await app.inject({
      method: 'GET', url: `/mobile/v1/orders/${orderId}/refund`, headers: { authorization: 'Bearer route-test' },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ refund: { status: 'succeeded', creditAmount: '62.28' } });
    await app.close();
  });

  it('escalates a refund dispute and exposes an amount-free operator decision route', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditOrderService: routeTestOrders, logger: false,
    });
    const orderId = '40000000-0000-4000-8000-000000000001';
    const escalated = await app.inject({
      method: 'POST', url: `/mobile/v1/orders/${orderId}/dispute/escalate`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'buyer-escalate-route-001' }, payload: {},
    });
    expect(escalated.statusCode).toBe(200);
    expect(escalated.json()).toMatchObject({ order: { status: 'disputed', side: 'buyer' } });
    const queue = await app.inject({
      method: 'GET', url: '/mobile/v1/operator/order-disputes', headers: { authorization: 'Bearer route-test' },
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toMatchObject({ disputes: [{ description: '交付规格不一致。' }] });
    const decision = await app.inject({
      method: 'POST', url: `/mobile/v1/operator/order-disputes/${orderId}/decision`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'operator-decision-route01' },
      payload: { outcome: 'full_refund', reason: '交付内容与审核挂牌不一致，支持全额退款。' },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toMatchObject({ outcome: 'full_refund', order: { status: 'refunded' } });
    const suppliedAmount = await app.inject({
      method: 'POST', url: `/mobile/v1/operator/order-disputes/${orderId}/decision`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'operator-decision-route02' },
      payload: { outcome: 'full_refund', reason: '交付内容与审核挂牌不一致，支持全额退款。', creditAmount: '1.00' },
    });
    expect(suppliedAmount.statusCode).toBe(400);
    const receipt = await app.inject({
      method: 'GET', url: `/mobile/v1/orders/${orderId}/dispute/adjudication`,
      headers: { authorization: 'Bearer route-test' },
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({
      adjudication: { status: 'resolved', outcome: 'full_refund', creditAmount: '62.28' },
    });
    await app.close();
  });

  it('settles only an exact order amount and returns a participant receipt', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditOrderService: routeTestOrders, logger: false,
    });
    const orderId = '40000000-0000-4000-8000-000000000001';
    const settled = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/settle`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'provider-settle-route-001' },
      payload: {},
    });
    expect(settled.statusCode).toBe(200);
    expect(settled.json()).toMatchObject({ order: { status: 'closed', side: 'provider' } });
    const suppliedAmount = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/settle`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'provider-settle-route-002' },
      payload: { creditAmount: '1.00' },
    });
    expect(suppliedAmount.statusCode).toBe(400);
    const receipt = await app.inject({
      method: 'GET', url: `/mobile/v1/orders/${orderId}/settlement`,
      headers: { authorization: 'Bearer route-test' },
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({
      settlement: { status: 'succeeded', creditAmount: '62.28', triggeredBy: 'provider' },
    });
    await app.close();
  });

  it('opens a requested aftercare amount and keeps provider approval amount-free', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditOrderService: routeTestOrders, logger: false,
    });
    const orderId = '40000000-0000-4000-8000-000000000001';
    const requested = await app.inject({
      method: 'POST', url: `/mobile/v1/orders/${orderId}/aftercare/refund`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'buyer-aftercare-route-001' },
      payload: { description: '验收后发现实际规格与订单不一致。', creditAmount: '31.00' },
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({ order: { status: 'accepted', side: 'buyer' } });
    const requestWithoutAmount = await app.inject({
      method: 'POST', url: `/mobile/v1/orders/${orderId}/aftercare/refund`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'buyer-aftercare-route-002' },
      payload: { description: '验收后发现实际规格与订单不一致。' },
    });
    expect(requestWithoutAmount.statusCode).toBe(400);
    const approved = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/aftercare/refund/approve`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'provider-aftercare-route-001' },
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ order: { status: 'refunded', side: 'provider' } });
    const approvalWithAmount = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/aftercare/refund/approve`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'provider-aftercare-route-002' },
      payload: { creditAmount: '1.00' },
    });
    expect(approvalWithAmount.statusCode).toBe(400);
    const receipt = await app.inject({
      method: 'GET', url: `/mobile/v1/orders/${orderId}/aftercare/refund`,
      headers: { authorization: 'Bearer route-test' },
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({
      aftercareRefund: { status: 'succeeded', creditAmount: '62.28' },
    });
    await app.close();
  });

  it('exposes provider contest, buyer escalation, and amount-locked platform aftercare adjudication', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditOrderService: routeTestOrders, logger: false,
    });
    const orderId = '40000000-0000-4000-8000-000000000001';
    const contested = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/aftercare/refund/contest`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'provider-aftercare-contest-route1' },
      payload: { response: '资源规格与审核材料一致，请平台核对运行记录。' },
    });
    expect(contested.statusCode).toBe(200);
    expect(contested.json()).toMatchObject({ order: { status: 'accepted', side: 'provider' } });
    const contestWithAmount = await app.inject({
      method: 'POST', url: `/mobile/v1/provider/orders/${orderId}/aftercare/refund/contest`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'provider-aftercare-contest-route2' },
      payload: { response: '资源规格与审核材料一致，请平台核对运行记录。', creditAmount: '1.00' },
    });
    expect(contestWithAmount.statusCode).toBe(400);
    const escalated = await app.inject({
      method: 'POST', url: `/mobile/v1/orders/${orderId}/aftercare/refund/escalate`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'buyer-aftercare-escalate-route1' }, payload: {},
    });
    expect(escalated.statusCode).toBe(200);
    const queue = await app.inject({
      method: 'GET', url: '/mobile/v1/operator/aftercare-refunds', headers: { authorization: 'Bearer route-test' },
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toMatchObject({ refunds: [{ providerResponse: '资源规格与审核材料一致。' }] });
    const decision = await app.inject({
      method: 'POST', url: `/mobile/v1/operator/aftercare-refunds/${orderId}/decision`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'operator-aftercare-decision-route1' },
      payload: { outcome: 'approve_refund', reason: '实际运行记录显示资源规格与审核挂牌不一致。' },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toMatchObject({ outcome: 'full_refund', order: { status: 'refunded' } });
    const decisionWithAmount = await app.inject({
      method: 'POST', url: `/mobile/v1/operator/aftercare-refunds/${orderId}/decision`,
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'operator-aftercare-decision-route2' },
      payload: { outcome: 'approve_refund', reason: '实际运行记录显示资源规格与审核挂牌不一致。', creditAmount: '1.00' },
    });
    expect(decisionWithAmount.statusCode).toBe(400);
    await app.close();
  });

  it('exposes two-decimal supplier payout creation without accepting company payment proof from the supplier', async () => {
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, creditPayoutService: routeTestPayouts, logger: false });
    const response = await app.inject({ method: 'POST', url: '/mobile/v1/credits/payouts',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'supplier-payout-route-0001' },
      payload: { creditAmount: '100.00' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ payout: { status: 'submitted', creditAmount: '100.00' } });
    const forged = await app.inject({ method: 'POST', url: '/mobile/v1/credits/payouts',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'supplier-payout-route-0002' },
      payload: { creditAmount: '100.00', companyPaymentReference: 'forged' } });
    expect(forged.statusCode).toBe(400);
    await app.close();
  });

  it('exposes one authoritative Spark product and a card-time reservation order route', async () => {
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, deviceCommerceService: routeTestDevices, logger: false });
    const catalog = await app.inject({ method: 'GET', url: '/mobile/v1/device-products' });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({ products: [{ id: '02672000-0000-4000-8000-000000000200',
      title: 'NVIDIA DGX Spark', inventory: { total: 200 } }] });
    const order = await app.inject({ method: 'POST', url: '/mobile/v1/device-orders',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'spark-device-order-route-001' },
      payload: { productId: '02672000-0000-4000-8000-000000000200', quantity: 1,
        shippingAddressReference: 'address-vault-token-001' } });
    expect(order.statusCode).toBe(201);
    expect(order.json()).toMatchObject({ order: { status: 'reserved', quantity: 1 } });
    const digestOnly = await app.inject({ method: 'POST',
      url: '/mobile/v1/provider/device-orders/60000000-0000-4000-8000-000000000001/ship',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'spark-device-ship-route-001' },
      payload: { logisticsProvider: '顺丰', trackingDigest: 'client-controlled-digest' } });
    expect(digestOnly.statusCode).toBe(400);
    const shipped = await app.inject({ method: 'POST',
      url: '/mobile/v1/provider/device-orders/60000000-0000-4000-8000-000000000001/ship',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'spark-device-ship-route-002' },
      payload: { logisticsProvider: '顺丰', trackingNumber: 'SF1234567890' } });
    expect(shipped.statusCode).toBe(200);
    expect(shipped.json()).toMatchObject({ order: { status: 'shipping', trackingNumber: 'SF1234567890' } });
    const manualSettlement = await app.inject({ method: 'POST',
      url: '/mobile/v1/provider/device-orders/60000000-0000-4000-8000-000000000001/settle',
      headers: { authorization: 'Bearer route-test', 'idempotency-key': 'spark-device-settle-route-01' } });
    expect(manualSettlement.statusCode).toBe(404);
    await app.close();
  });

  it.each([
    ['POST', '/mobile/v1/supplier/listings'],
    ['GET', '/mobile/v1/supplier/profile'],
    ['POST', '/mobile/v1/supplier/resources'],
    ['POST', '/mobile/v1/provider/offers'],
    ['PUT', '/mobile/v1/provider/offers/00000000-0000-4000-8000-000000000001'],
    ['POST', '/mobile/v1/provider/offers/00000000-0000-4000-8000-000000000001/submit'],
    ['POST', '/mobile/v1/orders/00000000-0000-4000-8000-000000000001/payments'],
    ['GET', '/mobile/v1/orders/00000000-0000-4000-8000-000000000001/payment'],
  ] as const)('does not expose removed resource checkout route %s %s', async (method, url) => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), database: null,
      accountService: routeTestAccounts, marketService: routeTestMarket, listingAuditService: routeTestListings, logger: false,
    });
    const response = await app.inject({ method, url });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });
});
