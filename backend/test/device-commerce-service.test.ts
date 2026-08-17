import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decryptPii } from '../src/account/crypto.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import { DeviceCommerceService } from '../src/device-commerce/service.js';
import type { PostgresDeviceCommerceStore } from '../src/device-commerce/store.js';
import type { DeviceOrder, DeviceProduct } from '../src/device-commerce/types.js';
import type { SubjectAccess } from '../src/subjects/types.js';

const buyerId = '10000000-0000-4000-8000-000000000001';
const providerId = '10000000-0000-4000-8000-000000000002';
const piiKey = Buffer.alloc(32, 4).toString('base64');

const product: DeviceProduct = {
  id: '02672000-0000-4000-8000-000000000200', sku: 'NVIDIA-DGX-SPARK-200-BAIGE',
  campaignKey: 'nvidia-dgx-spark-200-baige-20off', templateKey: 'nvidia-dgx-spark-preorder-v1',
  title: 'NVIDIA DGX Spark', supplierDisplayName: '白鸽在线', supplierSubjectId: providerId,
  activationStatus: 'active', inventoryTotal: 200, inventoryReserved: 0, inventorySold: 0,
  listPriceCnyMicros: 40_750_000_000n, salePriceCnyMicros: 32_600_000_000n,
  listUnitCreditMicros: 40_668_660_000n, unitCreditMicros: 32_534_930_000n,
  discountBasisPoints: 8000, expectedShipDays: 90, specifications: { model: 'DGX Spark' },
};

const baseOrder: DeviceOrder = {
  id: '60000000-0000-4000-8000-000000000001', orderNumber: 'KDO202608170001',
  buyerSubjectId: buyerId, supplierSubjectId: providerId, createdByUserId: buyerId,
  productId: product.id, campaignKey: product.campaignKey, campaignVersion: product.templateKey,
  status: 'confirmed', quantity: 1, unitCreditMicros: product.unitCreditMicros,
  grossCreditMicros: product.unitCreditMicros, serviceFeeCreditMicros: null, supplierNetCreditMicros: null,
  reservationTransactionId: '70000000-0000-4000-8000-000000000001', resolutionTransactionId: null,
  reservationExpiresAt: new Date('2026-08-17T01:00:00.000Z'), confirmedAt: new Date('2026-08-17T00:10:00.000Z'),
  shippedAt: null, receivedAt: null, resolvedAt: null, logisticsProvider: null, trackingCiphertext: null,
  createdAt: new Date('2026-08-17T00:00:00.000Z'), updatedAt: new Date('2026-08-17T00:10:00.000Z'),
};

function serviceFor(store: Partial<PostgresDeviceCommerceStore>) {
  const subjects = { current: async (userId: string) => ({
    subjectId: userId === 'provider-user' ? providerId : buyerId, userId, kind: 'personal' as const,
    displayName: '测试', subjectStatus: 'active' as const, role: 'owner' as const, permissions: [],
  }) } as unknown as SubjectAccess;
  return new DeviceCommerceService(store as PostgresDeviceCommerceStore, subjects, loadConfig({
    NODE_ENV: 'test', AUDIT_PEPPER: 'p'.repeat(32), PII_ENCRYPTION_KEY: piiKey,
  }), () => new Date('2026-08-17T00:20:00.000Z'));
}

describe('device commerce mobile contract', () => {
  it('publishes the server-authoritative Spark campaign using card-hours only', async () => {
    const service = serviceFor({ listProducts: async () => [product] });
    const [serialized] = await service.products();
    expect(serialized).toMatchObject({
      campaignKey: 'nvidia-dgx-spark-200-baige-20off', templateKey: 'nvidia-dgx-spark-preorder-v1',
      pricing: { listUnitCredit: '40668.66', unitCredit: '32534.93', discountBasisPoints: 8000, discountPercent: 20 },
      inventory: { total: 200, available: 200 },
    });
    expect(JSON.stringify(serialized)).not.toMatch(/(?:cny|rmb|人民币|¥)/iu);
  });

  it('encrypts tracking at the service boundary and reveals it only to the buyer detail contract', async () => {
    let actionInput: Parameters<PostgresDeviceCommerceStore['action']>[0] | null = null;
    let shipped = baseOrder;
    const store = {
      action: async (input: Parameters<PostgresDeviceCommerceStore['action']>[0]) => {
        actionInput = input;
        shipped = { ...baseOrder, status: 'shipping', shippedAt: input.now,
          logisticsProvider: input.logisticsProvider ?? null, trackingCiphertext: input.trackingCiphertext ?? null };
        return { status: 'updated' as const, order: shipped };
      },
      getOrder: async () => shipped,
    };
    const service = serviceFor(store);
    const provider: AccountPrincipal = { userId: 'provider-user', sessionId: 'provider-session', role: 'supplier' };
    const shippedResult = await service.ship(provider, baseOrder.id, 'device-ship-service-0001',
      { requestId: 'request-1', ip: '127.0.0.1' }, { logisticsProvider: ' 顺丰 ', trackingNumber: ' sf 1234567890 ' });
    const captured = actionInput as unknown as Parameters<PostgresDeviceCommerceStore['action']>[0];
    expect(captured.trackingCiphertext).not.toContain('SF1234567890');
    expect(decryptPii(captured.trackingCiphertext!, piiKey)).toBe('SF1234567890');
    expect(captured.trackingDigest).not.toContain('SF1234567890');
    expect(shippedResult.order).toMatchObject({ side: 'provider', actions: [], trackingDisplay: 'SF****7890' });

    const buyer: AccountPrincipal = { userId: 'buyer-user', sessionId: 'buyer-session', role: 'member' };
    expect(await service.get(buyer, baseOrder.id)).toMatchObject({
      side: 'buyer', actions: ['receive'], logisticsProvider: '顺丰', trackingDisplay: 'SF1234567890',
      campaignVersion: 'nvidia-dgx-spark-preorder-v1',
    });
  });
});
