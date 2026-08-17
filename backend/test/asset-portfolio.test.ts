import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AccountService } from '../src/account/service.js';
import { registerAssetPortfolioRoutes } from '../src/assets/routes.js';
import { AssetPortfolioService } from '../src/assets/service.js';
import type { CreditOrderStore } from '../src/credit-orders/store.js';
import type { PostgresDeviceCommerceStore } from '../src/device-commerce/store.js';
import type { MarketStore } from '../src/market/store.js';
import type { SubjectAccess } from '../src/subjects/types.js';

describe('unified asset portfolio', () => {
  it('summarizes buyer and provider assets server-side and returns executable actions', async () => {
    const limits: number[] = [];
    const market = { listProviderAssets: async () => [{ id: 'asset-1', resourceId: 'resource-1', name: 'H100 节点',
      productCode: 'H100', region: '华东-上海', specifications: {}, managementMode: 'platform_hosted',
      status: 'operating', statusLabel: '运营中', statusDetail: '节点在线', materialStatus: 'verified',
      deliveryReadiness: { status: 'ready', label: '可交付', nodeLastSeenAt: new Date('2026-08-17T00:00:00Z') },
      nodeEnrollment: { deploymentId: 'deployment-1', generation: 1, status: 'ready' }, nodeAction: null,
      lifecycle: 'active', lifecycleFacts: { renewedAt: new Date('2026-08-16T00:00:00Z'), repurchasedAt: null, closedAt: null },
      views: ['hosted','renewed','operating'], attention: null,
      nextAction: { key: 'manage_listing', label: '管理在售资源', route: 'provider_listing_manager',
        entityId: 'listing-1', target: 'listing' }, updatedAt: new Date('2026-08-17T00:00:00Z') }],
      countProviderAssets: async () => 1 } as unknown as MarketStore;
    const devices = { listOrders: async (_subject: string, side: string) => side === 'supplier' ? [] : [{ id: 'device-order-1', orderNumber: 'KDO1', buyerSubjectId: 'subject-1',
      supplierSubjectId: 'supplier-2', createdByUserId: 'user-1', productId: 'spark', status: 'shipping', quantity: 1,
      unitCreditMicros: 10_000_000n, grossCreditMicros: 10_000_000n, serviceFeeCreditMicros: null,
      supplierNetCreditMicros: null, reservationTransactionId: 'tx-1', resolutionTransactionId: null,
      reservationExpiresAt: new Date(), confirmedAt: new Date(), shippedAt: new Date(), receivedAt: null,
      resolvedAt: null, logisticsProvider: '顺丰', createdAt: new Date(), updatedAt: new Date() }],
      listAssets: async () => [], portfolioCounts: async () => ({ buyerOrders: 1, supplierOrders: 0,
        ownedDevices: 0, buyerActions: 1, supplierActions: 0 }) } as unknown as PostgresDeviceCommerceStore;
    const orders = { listForSubject: async (_subject: string, limit: number) => { limits.push(limit); return [{ id: 'order-1',
      orderNumber: 'KCO1', buyerSubjectId: 'subject-1', supplierSubjectId: 'supplier-1', createdByUserId: 'user-1',
      listingId: 'listing-2', status: 'acceptance_pending', quantity: '2.000000', capacityUnit: 'GPU_HOUR',
      unitCreditMicros: 5_000_000n, totalCreditMicros: 10_000_000n, listingSnapshot: { title: 'H100 两卡时' },
      reservationExpiresAt: new Date(), confirmedAt: new Date(), confirmedByUserId: null, deliveryStartedAt: new Date(),
      deliveryReadyAt: new Date(), acceptedAt: null, acceptedByUserId: null, closedAt: null,
      createdAt: new Date(), updatedAt: new Date() }]; },
      countForSubject: async () => ({ total: 1, actionRequired: 1 }) } as unknown as CreditOrderStore;
    const subjects = { current: async () => ({ subjectId: 'subject-1', kind: 'personal', displayName: '测试用户',
      subjectStatus: 'active', role: 'owner', userId: 'user-1', permissions: ['orders.read','orders.buy','provider.read','provider.listing.manage'] }) } as unknown as SubjectAccess;
    const service = new AssetPortfolioService(market, devices, orders, subjects);
    const summary = await service.summary({ userId: 'user-1', sessionId: 'session-1', role: 'member' });
    expect(limits).toEqual([30]);
    expect(summary.summary).toMatchObject({ total: 3, purchasedCompute: 1, purchasedDevices: 1,
      providedCompute: 1, hosted: 1, renewed: 1, operating: 1 });
    expect(summary.groups.purchasedCompute[0]?.actions[0]).toMatchObject({ key: 'inspect_delivery', method: 'GET',
      href: '/mobile/v1/orders/order-1/delivery' });
    expect(summary.groups.purchasedDeviceOrders[0]?.actions[0]).toMatchObject({ key: 'confirm_device_receipt', method: 'POST' });
    expect(summary.groups.providedCompute?.[0]?.actions[0]).toMatchObject({ key: 'manage_listing' });

    const app = Fastify();
    const accounts = { authenticate: async () => ({ principal: { userId: 'user-1', sessionId: 'session-1', role: 'member' }, identity: {} }) } as unknown as AccountService;
    await registerAssetPortfolioRoutes(app, accounts, service);
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/assets/summary', headers: { authorization: 'Bearer test' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, summary: { purchasedCompute: 1 }, groups: { providedCompute: [{ id: 'asset-1' }] } });
    await app.close();
  });
});
