import { describe, expect, it } from 'vitest';
import { buildLocalE2EDemoCatalog, localE2EDemoCatalogDigest, validWholeUnitDemoQuantity } from '../scripts/local-e2e-demo-catalog.js';

describe('local E2E demo catalog', () => {
  it('creates exactly 100 explicitly sandboxed demo resources and fails closed outside local E2E', () => {
    const now = new Date('2026-08-15T04:20:00.000Z');
    const catalog = buildLocalE2EDemoCatalog('local_e2e', now);
    expect(catalog).toHaveLength(100);
    expect(new Set(catalog.map((item) => item.id)).size).toBe(100);
    expect(catalog.every((item) => item.demo.mode === 'local_e2e'
      && item.demo.label === '演示资源' && item.demo.payment === 'sandbox_only'
      && item.demo.purchasable === false)).toBe(true);
    expect(localE2EDemoCatalogDigest(catalog)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() => buildLocalE2EDemoCatalog('production' as never, now)).toThrow('DEMO_CATALOG_LOCAL_E2E_ONLY');
  });

  it('uses the server conversion and per-unit rounding for the 02672 NVIDIA Spark 200-unit market promotion', () => {
    const catalog = buildLocalE2EDemoCatalog('local_e2e', new Date('2026-08-15T04:20:00.000Z'));
    const spark = catalog[0]!;
    expect(spark).toMatchObject({
      title: '02672 白鸽在线特供款', productCode: 'NVIDIA Spark', capacityTotal: '200.000000', capacityAvailable: '200.000000',
      productKind: 'hardware_device', fulfillmentMode: 'physical_delivery',
      shippingEstimate: '预计3个月发货',
      capacityUnit: '台', minimumQuantity: '1.000000', unitCredits: '26027.944112',
      promotion: {
        label: '限时8折', discountPercent: 20,
        originalReferenceCny: '32600.00', discountedReferenceCny: '26080.00',
        originalUnitCredits: '32534.930140', discountedUnitCredits: '26027.944112', taxIncluded: true,
        priceEvidence: { sourceType: 'local_e2e_fixture', sourceLabel: '白鸽在线演示报价', productionAudit: false },
      },
      selloutEstimate: { grossCredits: '5205588.822400', remainingCapacity: '200.000000' },
    });
    expect(['1', '200'].every(validWholeUnitDemoQuantity)).toBe(true);
    expect(['0', '1.5', '201', '500', '-1'].some(validWholeUnitDemoQuantity)).toBe(false);
    expect(catalog.slice(1).every((item) => {
      const micros = BigInt(item.unitCredits.replace('.', ''));
      const expectedCnyMicros = micros * 1_002_000n / 1_000_000n;
      return item.referenceCny === `${expectedCnyMicros / 1_000_000n}.${(expectedCnyMicros % 1_000_000n).toString().padStart(6, '0')}`;
    })).toBe(true);
  });
});
