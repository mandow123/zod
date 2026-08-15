import { createHash } from 'node:crypto';
import { creditMicrosFromCnyMicros, formatCnyMicros, formatCreditMicros } from '../src/listings/types.js';

const SCALE = 1_000_000n;
const SPARK_ORIGINAL_CNY_MICROS = 32_600_000_000n;
const SPARK_DISCOUNTED_CNY_MICROS = 26_080_000_000n;

export type LocalE2EDemoListing = Readonly<{
  id: string;
  resourceId: string;
  title: string;
  productCode: string;
  productKind: 'hardware_device' | 'compute_capacity';
  fulfillmentMode: 'physical_delivery' | 'compute_sidecar_v1';
  shippingEstimate: '预计3个月发货' | null;
  kind: 'gpu';
  region: string;
  serviceMode: 'dedicated';
  capacityTotal: string;
  capacityReserved: string;
  capacitySold: string;
  capacityAvailable: string;
  capacityUnit: '台' | 'GPU时';
  minimumQuantity: string;
  unitCredits: string;
  referenceCny: string;
  status: 'active';
  startsAt: string;
  expiresAt: string;
  demo: Readonly<{
    mode: 'local_e2e'; label: '演示资源'; payment: 'sandbox_only';
    purchasable: boolean; simulatedAudit: true;
  }>;
  promotion: null | Readonly<{
    kind: 'percentage'; label: '限时8折'; discountPercent: 20;
    originalReferenceCny: '32600.00'; discountedReferenceCny: '26080.00';
    originalUnitCredits: string; discountedUnitCredits: string;
    taxIncluded: true; startsAt: string; endsAt: string;
    priceEvidence: Readonly<{
      sourceType: 'local_e2e_fixture'; sourceLabel: '白鸽在线演示报价'; productionAudit: false;
    }>;
  }>;
  selloutEstimate: Readonly<{
    kind: 'gross_before_fee'; grossCredits: string; basis: 'remaining_capacity';
    remainingCapacity: string; asOf: string;
    disclosure: '按当前剩余容量全部售完测算，未扣服务费';
  }>;
}>;

function uuid(namespace: number, index: number) {
  return `de${namespace.toString(16).padStart(2, '0')}0000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function creditsForQuantity(unitCreditMicros: bigint, quantity: bigint) {
  return formatCreditMicros((unitCreditMicros * quantity + SCALE - 1n) / SCALE);
}

export function buildLocalE2EDemoCatalog(
  mode: 'local_e2e',
  now = new Date(),
  sparkListingId = uuid(0, 1),
): readonly LocalE2EDemoListing[] {
  if (mode !== 'local_e2e') throw new Error('DEMO_CATALOG_LOCAL_E2E_ONLY');
  const startsAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const sparkUnit = creditMicrosFromCnyMicros(SPARK_DISCOUNTED_CNY_MICROS);
  const sparkOriginalUnit = creditMicrosFromCnyMicros(SPARK_ORIGINAL_CNY_MICROS);
  const products = ['H100 SXM5 98G', 'H200 SXM 141G', 'A100 80G', 'L40S 48G', 'RTX 4090 24G'];
  return Array.from({ length: 100 }, (_, index): LocalE2EDemoListing => {
    const spark = index === 0;
    const unitCreditMicros = spark ? sparkUnit : 20_000_000n + BigInt(index) * 125_000n;
    const capacity = spark ? 200n : 80n + BigInt(index % 20);
    const capacityText = `${capacity}.000000`;
    const product = spark ? 'NVIDIA Spark' : products[index % products.length]!;
    return {
      id: spark ? sparkListingId : uuid(0, index + 1),
      resourceId: uuid(1, index + 1),
      title: spark ? '02672 白鸽在线特供款' : `演示算力 ${String(index + 1).padStart(3, '0')} · ${product}`,
      productCode: product,
      productKind: spark ? 'hardware_device' : 'compute_capacity',
      fulfillmentMode: spark ? 'physical_delivery' : 'compute_sidecar_v1',
      shippingEstimate: spark ? '预计3个月发货' : null,
      kind: 'gpu', region: '华东-上海', serviceMode: 'dedicated',
      capacityTotal: capacityText, capacityReserved: '0.000000', capacitySold: '0.000000',
      capacityAvailable: capacityText, capacityUnit: spark ? '台' : 'GPU时', minimumQuantity: '1.000000',
      unitCredits: formatCreditMicros(unitCreditMicros),
      referenceCny: spark ? '26080.000000' : formatCnyMicros((unitCreditMicros * 1_002_000n) / SCALE), status: 'active', startsAt, expiresAt,
      demo: { mode: 'local_e2e', label: '演示资源', payment: 'sandbox_only', purchasable: false, simulatedAudit: true },
      promotion: spark ? {
        kind: 'percentage', label: '限时8折', discountPercent: 20,
        originalReferenceCny: '32600.00', discountedReferenceCny: '26080.00',
        originalUnitCredits: formatCreditMicros(sparkOriginalUnit), discountedUnitCredits: formatCreditMicros(sparkUnit),
        taxIncluded: true, startsAt, endsAt: expiresAt,
        priceEvidence: {
          sourceType: 'local_e2e_fixture', sourceLabel: '白鸽在线演示报价', productionAudit: false,
        },
      } : null,
      selloutEstimate: {
        kind: 'gross_before_fee', grossCredits: creditsForQuantity(unitCreditMicros, capacity * SCALE),
        basis: 'remaining_capacity', remainingCapacity: capacityText, asOf: startsAt,
        disclosure: '按当前剩余容量全部售完测算，未扣服务费',
      },
    };
  });
}

export function localE2EDemoCatalogDigest(listings: readonly LocalE2EDemoListing[]) {
  return `sha256:${createHash('sha256').update(JSON.stringify(listings)).digest('hex')}`;
}

export function validWholeUnitDemoQuantity(value: string) {
  return /^(?:[1-9]\d{0,2})$/u.test(value) && Number(value) <= 200;
}
