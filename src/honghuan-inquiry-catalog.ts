import type { InquiryBillingMode, InquiryCatalogCandidate, InquiryModel } from './resource-inquiries';

export const HONGHUAN_CATALOG_SOURCE = 'shanghai_honghuan' as const;
export const HONGHUAN_SUPPLIER_ID = 'supplier-shanghai-honghuan' as const;
export const HONGHUAN_SUPPLIER_NAME = '上海鸿欢网络科技有限公司' as const;
export const HONGHUAN_SUPPLIER_DISPLAY_NAME = '上海鸿欢' as const;
export const HONGHUAN_MONTHLY_TIER_ID = 'server-honghuan-b300-monthly-32plus' as const;
export const HONGHUAN_EXPECTED_ITEM_COUNT = 11;

type CanonicalCatalogEntry = Readonly<{
  catalogKind: SupplierCatalogKind; model: InquiryModel; formFactor: 'SXM4' | 'SXM' | 'NVL' | null;
  advertisedMemoryGb: number | null; countPerInstance: number | null; hourlyAmount: string | null;
  dailyAmount: string | null; monthlyAmount: string | null; legalReviewRequired: boolean;
}>;

export const HONGHUAN_CANONICAL_CATALOG: Readonly<Record<string, CanonicalCatalogEntry>> = {
  'gpu-honghuan-a100-sxm4-80gb-1': { catalogKind: 'hourly_gpu', model: 'A100', formFactor: 'SXM4', advertisedMemoryGb: 80, countPerInstance: 1, hourlyAmount: '28.44', dailyAmount: '682.63', monthlyAmount: null, legalReviewRequired: false },
  'gpu-honghuan-a100-sxm4-80gb-2': { catalogKind: 'hourly_gpu', model: 'A100', formFactor: 'SXM4', advertisedMemoryGb: 80, countPerInstance: 2, hourlyAmount: '53.89', dailyAmount: '1293.41', monthlyAmount: null, legalReviewRequired: false },
  'gpu-honghuan-h100-sxm-80gb-1': { catalogKind: 'hourly_gpu', model: 'H100', formFactor: 'SXM', advertisedMemoryGb: 80, countPerInstance: 1, hourlyAmount: '89.82', dailyAmount: '2155.69', monthlyAmount: null, legalReviewRequired: false },
  'gpu-honghuan-h100-sxm-80gb-2': { catalogKind: 'hourly_gpu', model: 'H100', formFactor: 'SXM', advertisedMemoryGb: 80, countPerInstance: 2, hourlyAmount: '163.17', dailyAmount: '3916.17', monthlyAmount: null, legalReviewRequired: false },
  'gpu-honghuan-h200-nvl-1': { catalogKind: 'hourly_gpu', model: 'H200', formFactor: 'NVL', advertisedMemoryGb: 140, countPerInstance: 1, hourlyAmount: '88.32', dailyAmount: '2119.76', monthlyAmount: null, legalReviewRequired: false },
  'gpu-honghuan-h200-nvl-2': { catalogKind: 'hourly_gpu', model: 'H200', formFactor: 'NVL', advertisedMemoryGb: 140, countPerInstance: 2, hourlyAmount: '137.72', dailyAmount: '3305.39', monthlyAmount: null, legalReviewRequired: false },
  'gpu-honghuan-b200-179gb-1': { catalogKind: 'hourly_gpu', model: 'B200', formFactor: null, advertisedMemoryGb: 179, countPerInstance: 1, hourlyAmount: '143.71', dailyAmount: '3449.10', monthlyAmount: null, legalReviewRequired: false },
  'gpu-honghuan-b200-179gb-2': { catalogKind: 'hourly_gpu', model: 'B200', formFactor: null, advertisedMemoryGb: 179, countPerInstance: 2, hourlyAmount: '278.44', dailyAmount: '6682.63', monthlyAmount: null, legalReviewRequired: false },
  'gpu-honghuan-b200-179gb-4': { catalogKind: 'hourly_gpu', model: 'B200', formFactor: null, advertisedMemoryGb: 179, countPerInstance: 4, hourlyAmount: '547.90', dailyAmount: '13149.70', monthlyAmount: null, legalReviewRequired: false },
  'gpu-honghuan-b300-269gb-1': { catalogKind: 'hourly_gpu', model: 'B300', formFactor: null, advertisedMemoryGb: 269, countPerInstance: 1, hourlyAmount: '305.39', dailyAmount: '7329.34', monthlyAmount: null, legalReviewRequired: false },
  [HONGHUAN_MONTHLY_TIER_ID]: { catalogKind: 'contract_monthly', model: 'B300', formFactor: null, advertisedMemoryGb: null, countPerInstance: null, hourlyAmount: null, dailyAmount: null, monthlyAmount: '411676.65', legalReviewRequired: true },
};

export type SupplierCatalogKind = 'hourly_gpu' | 'contract_monthly';
export type SupplierQuantity = Readonly<{
  unit: 'instance' | 'server'; min: number; max: number; allowedValues: readonly number[] | null;
}>;
export type SupplierReferencePrice = Readonly<{
  currency: 'KAI_CARD_HOUR'; precision: 2; status: 'reference_only';
  hourlyAmount: string | null; dailyAmount: string | null; monthlyAmount: string | null; validUntil: string;
}>;

export type SupplierInquiryCatalogItem = Readonly<{
  resourceId: string;
  version: number;
  catalogKind: SupplierCatalogKind;
  title: string;
  legalReviewRequired: boolean;
  supplier: Readonly<{
    id: typeof HONGHUAN_SUPPLIER_ID;
    legalName: typeof HONGHUAN_SUPPLIER_NAME;
    displayName: typeof HONGHUAN_SUPPLIER_DISPLAY_NAME;
    logo: Readonly<{
      httpsUrl: string; version: 'v1'; authorizationStatus: 'unverified'; provenance: 'user_provided';
    }>;
    disclosureStatus: 'platform_imported_unverified';
  }>;
  specifications: Readonly<{
    gpu: Readonly<{
      model: InquiryModel; formFactor: 'SXM4' | 'SXM' | 'NVL' | null;
      advertisedMemoryGb: number | null; environmentObservedMemoryGb: number | null; countPerInstance: number | null;
    }>;
    cpu: Readonly<{ description: string | null }>;
    memory: Readonly<{ description: string | null }>;
    storage: Readonly<{ description: string | null }>;
    software: Readonly<{
      cudaVersion: string | null; pythonVersion: string | null;
      pytorchStatus: 'not_installed' | 'installed' | 'unknown';
    }>;
    notes: readonly string[];
  }>;
  quantity: SupplierQuantity;
  region: Readonly<{ scope: 'national'; exact: null; confirmationRequired: true }>;
  billing: Readonly<{
    modes: readonly InquiryBillingMode[];
    unit: 'GPU_HOUR' | 'SERVER_MONTH';
    referencePrice: SupplierReferencePrice;
  }>;
  availability: Readonly<{ status: 'inquiry_required'; quantity: null; inventoryCommitment: false }>;
  delivery: Readonly<{
    mode: 'manual';
    leadTime: Readonly<{
      value: number | null; unit: 'month' | null; status: 'supplier_declared' | 'inquiry_confirmation_required';
    }>;
  }>;
  purchase: Readonly<{ purchasable: false; orderCreation: false; inquiryAvailable: true; cta: 'submit_inquiry' }>;
  source: Readonly<{
    observedAt: '2026-08-19'; kind: 'USER_PROVIDED_SUPPLIER_QUOTE';
    label: '资料来源：用户提供的供应商报价'; verificationStatus: 'unverified';
  }>;
  terms: 'inquiry-required';
}>;

export type SupplierInquiryCatalogPage = Readonly<{
  items: readonly SupplierInquiryCatalogItem[];
  nextCursor: string | null;
}>;

export function supplierInquiryCatalogCounts(items: readonly SupplierInquiryCatalogItem[]) {
  return {
    total: items.length,
    hourly: items.filter((item) => item.catalogKind === 'hourly_gpu').length,
    monthly: items.filter((item) => item.catalogKind === 'contract_monthly').length,
  } as const;
}

const pricePattern = /^(?:0|[1-9]\d{0,17})\.\d{2}$/u;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort(); const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  }
}

function asText(value: unknown, maximum = 160) {
  if (typeof value !== 'string') throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > maximum) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  return normalized;
}

function asNullableText(value: unknown, maximum = 160) { return value === null ? null : asText(value, maximum); }
function asPositiveInteger(value: unknown, maximum: number) {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  return Number(value);
}
function asNullablePositiveNumber(value: unknown, maximum = 1_000_000) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  return value;
}
function asNullablePrice(value: unknown) {
  if (value === null) return null;
  const amount = asText(value, 40);
  if (!pricePattern.test(amount)) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  return amount;
}
function asDateTime(value: unknown) {
  const date = asText(value, 40);
  if (Number.isNaN(Date.parse(date))) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  return date;
}
function asModel(value: unknown): InquiryModel {
  const model = asText(value, 16);
  if (!['A100', 'H100', 'H200', 'B200', 'B300'].includes(model)) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  return model as InquiryModel;
}
function asModes(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1 || !['hourly', 'monthly'].includes(String(value[0]))) {
    throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  }
  return [value[0] as InquiryBillingMode];
}
function asNotes(value: unknown) {
  if (!Array.isArray(value) || value.length > 30) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  return value.map((item) => asText(item, 240));
}
function asAllowedValues(value: unknown) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  const result = value.map((item) => asPositiveInteger(item, 128));
  if (new Set(result).size !== result.length || result.some((item, index) => index > 0 && item <= result[index - 1]!)) {
    throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  }
  return result;
}

function decodeItem(value: unknown): SupplierInquiryCatalogItem {
  const item = asRecord(value); const supplier = asRecord(item.supplier); const logo = asRecord(supplier.logo);
  const specs = asRecord(item.specifications); const gpu = asRecord(specs.gpu); const cpu = asRecord(specs.cpu);
  const memory = asRecord(specs.memory); const storage = asRecord(specs.storage); const software = asRecord(specs.software);
  const quantity = asRecord(item.quantity); const region = asRecord(item.region); const billing = asRecord(item.billing);
  const referencePrice = asRecord(billing.referencePrice); const availability = asRecord(item.availability);
  const delivery = asRecord(item.delivery); const leadTime = asRecord(delivery.leadTime);
  const purchase = asRecord(item.purchase); const source = asRecord(item.source);
  exactKeys(item, ['resourceId', 'version', 'catalogKind', 'title', 'legalReviewRequired', 'supplier', 'specifications',
    'quantity', 'region', 'billing', 'availability', 'delivery', 'purchase', 'source', 'terms']);
  exactKeys(supplier, ['id', 'legalName', 'displayName', 'logo', 'disclosureStatus']);
  exactKeys(logo, ['httpsUrl', 'version', 'authorizationStatus', 'provenance']);
  exactKeys(specs, ['gpu', 'cpu', 'memory', 'storage', 'software', 'notes']);
  exactKeys(gpu, ['model', 'formFactor', 'advertisedMemoryGb', 'environmentObservedMemoryGb', 'countPerInstance']);
  exactKeys(cpu, ['description']); exactKeys(memory, ['description']); exactKeys(storage, ['description']);
  exactKeys(software, ['cudaVersion', 'pythonVersion', 'pytorchStatus']);
  exactKeys(quantity, ['unit', 'min', 'max', 'allowedValues']);
  exactKeys(region, ['scope', 'exact', 'confirmationRequired']);
  exactKeys(billing, ['modes', 'unit', 'referencePrice']);
  exactKeys(referencePrice, ['currency', 'precision', 'status', 'hourlyAmount', 'dailyAmount', 'monthlyAmount', 'validUntil']);
  exactKeys(availability, ['status', 'quantity', 'inventoryCommitment']);
  exactKeys(delivery, ['mode', 'leadTime']); exactKeys(leadTime, ['status', 'value', 'unit']);
  exactKeys(purchase, ['purchasable', 'orderCreation', 'inquiryAvailable', 'cta']);
  exactKeys(source, ['observedAt', 'kind', 'label', 'verificationStatus']);
  const catalogKind = asText(item.catalogKind, 40); const modes = asModes(billing.modes);
  const allowedValues = asAllowedValues(quantity.allowedValues); const countPerInstance = gpu.countPerInstance === null
    ? null : asPositiveInteger(gpu.countPerInstance, 128);
  const resourceId = asText(item.resourceId, 100); const canonical = HONGHUAN_CANONICAL_CATALOG[resourceId];
  const model = asModel(gpu.model); const advertisedMemoryGb = asNullablePositiveNumber(gpu.advertisedMemoryGb);
  const hourlyAmount = asNullablePrice(referencePrice.hourlyAmount);
  const dailyAmount = asNullablePrice(referencePrice.dailyAmount);
  const monthlyAmount = asNullablePrice(referencePrice.monthlyAmount);
  if (!['hourly_gpu', 'contract_monthly'].includes(catalogKind)
    || !canonical || canonical.catalogKind !== catalogKind || canonical.model !== model
    || canonical.formFactor !== gpu.formFactor || canonical.advertisedMemoryGb !== advertisedMemoryGb
    || canonical.countPerInstance !== countPerInstance || canonical.hourlyAmount !== hourlyAmount
    || canonical.dailyAmount !== dailyAmount || canonical.monthlyAmount !== monthlyAmount
    || canonical.legalReviewRequired !== item.legalReviewRequired
    || supplier.id !== HONGHUAN_SUPPLIER_ID || supplier.legalName !== HONGHUAN_SUPPLIER_NAME
    || supplier.displayName !== HONGHUAN_SUPPLIER_DISPLAY_NAME || supplier.disclosureStatus !== 'platform_imported_unverified'
    || logo.version !== 'v1' || logo.authorizationStatus !== 'unverified' || logo.provenance !== 'user_provided'
    || !/^https:\/\//u.test(String(logo.httpsUrl))
    || !['SXM4', 'SXM', 'NVL', null].includes(gpu.formFactor as null | string)
    || !['not_installed', 'installed', 'unknown'].includes(String(software.pytorchStatus))
    || !['instance', 'server'].includes(String(quantity.unit))
    || !['GPU_HOUR', 'SERVER_MONTH'].includes(String(billing.unit))
    || referencePrice.currency !== 'KAI_CARD_HOUR' || referencePrice.precision !== 2 || referencePrice.status !== 'reference_only'
    || region.scope !== 'national' || region.exact !== null || region.confirmationRequired !== true
    || availability.status !== 'inquiry_required' || availability.quantity !== null || availability.inventoryCommitment !== false
    || delivery.mode !== 'manual'
    || !['supplier_declared', 'inquiry_confirmation_required'].includes(String(leadTime.status))
    || !['month', null].includes(leadTime.unit as null | string)
    || !((leadTime.value === null && leadTime.unit === null && leadTime.status === 'inquiry_confirmation_required')
      || (Number.isInteger(leadTime.value) && Number(leadTime.value) > 0 && Number(leadTime.value) <= 120
        && leadTime.unit === 'month' && leadTime.status === 'supplier_declared'))
    || purchase.purchasable !== false || purchase.orderCreation !== false
    || purchase.inquiryAvailable !== true || purchase.cta !== 'submit_inquiry'
    || source.observedAt !== '2026-08-19' || source.kind !== 'USER_PROVIDED_SUPPLIER_QUOTE'
    || source.label !== '资料来源：用户提供的供应商报价'
    || source.verificationStatus !== 'unverified' || item.terms !== 'inquiry-required'
    || typeof item.legalReviewRequired !== 'boolean') throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  const minimum = asPositiveInteger(quantity.min, 100_000); const maximum = asPositiveInteger(quantity.max, 100_000);
  if (minimum > maximum
    || (catalogKind === 'hourly_gpu' && (modes[0] !== 'hourly' || billing.unit !== 'GPU_HOUR'
      || resourceId === HONGHUAN_MONTHLY_TIER_ID || quantity.unit !== 'instance' || minimum !== 1 || maximum !== 100_000
      || allowedValues !== null || countPerInstance === null || item.legalReviewRequired !== false
      || leadTime.value !== null || leadTime.unit !== null || leadTime.status !== 'inquiry_confirmation_required'))
    || (catalogKind === 'contract_monthly' && (modes[0] !== 'monthly' || billing.unit !== 'SERVER_MONTH'
      || resourceId !== HONGHUAN_MONTHLY_TIER_ID || quantity.unit !== 'server' || minimum !== 32 || maximum !== 128
      || allowedValues?.join(',') !== '32,64,128' || item.legalReviewRequired !== true
      || leadTime.value !== 4 || leadTime.unit !== 'month' || leadTime.status !== 'supplier_declared'))) {
    throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  }
  return {
    resourceId, version: asPositiveInteger(item.version, Number.MAX_SAFE_INTEGER),
    catalogKind: catalogKind as SupplierCatalogKind, title: asText(item.title, 100),
    legalReviewRequired: item.legalReviewRequired as boolean,
    supplier: {
      id: HONGHUAN_SUPPLIER_ID, legalName: HONGHUAN_SUPPLIER_NAME, displayName: HONGHUAN_SUPPLIER_DISPLAY_NAME,
      logo: { httpsUrl: asText(logo.httpsUrl, 500), version: 'v1', authorizationStatus: 'unverified', provenance: 'user_provided' },
      disclosureStatus: 'platform_imported_unverified',
    },
    specifications: {
      gpu: {
        model, formFactor: gpu.formFactor as 'SXM4' | 'SXM' | 'NVL' | null,
        advertisedMemoryGb,
        environmentObservedMemoryGb: asNullablePositiveNumber(gpu.environmentObservedMemoryGb), countPerInstance,
      },
      cpu: { description: asNullableText(cpu.description, 160) },
      memory: { description: asNullableText(memory.description, 160) },
      storage: { description: asNullableText(storage.description, 160) },
      software: {
        cudaVersion: asNullableText(software.cudaVersion, 40), pythonVersion: asNullableText(software.pythonVersion, 40),
        pytorchStatus: software.pytorchStatus as 'not_installed' | 'installed' | 'unknown',
      }, notes: asNotes(specs.notes),
    },
    quantity: { unit: quantity.unit as 'instance' | 'server', min: minimum, max: maximum, allowedValues },
    region: { scope: 'national', exact: null, confirmationRequired: true },
    billing: {
      modes, unit: billing.unit as 'GPU_HOUR' | 'SERVER_MONTH',
      referencePrice: {
        currency: 'KAI_CARD_HOUR', precision: 2, status: 'reference_only',
        hourlyAmount, dailyAmount, monthlyAmount, validUntil: asDateTime(referencePrice.validUntil),
      },
    },
    availability: { status: 'inquiry_required', quantity: null, inventoryCommitment: false },
    delivery: { mode: 'manual', leadTime: {
      value: leadTime.value === null ? null : Number(leadTime.value), unit: leadTime.unit as 'month' | null,
      status: leadTime.status as 'supplier_declared' | 'inquiry_confirmation_required',
    } },
    purchase: { purchasable: false, orderCreation: false, inquiryAvailable: true, cta: 'submit_inquiry' },
    source: { observedAt: '2026-08-19', kind: 'USER_PROVIDED_SUPPLIER_QUOTE',
      label: '资料来源：用户提供的供应商报价', verificationStatus: 'unverified' },
    terms: 'inquiry-required',
  };
}

export function decodeSupplierInquiryCatalog(value: unknown, requireComplete = false): SupplierInquiryCatalogPage {
  const response = asRecord(value);
  exactKeys(response, ['ok', 'items', 'nextCursor']);
  if (response.ok !== true || !Array.isArray(response.items)
    || (response.nextCursor !== null && typeof response.nextCursor !== 'string')) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  const items = response.items.map(decodeItem);
  if (new Set(items.map((item) => item.resourceId)).size !== items.length) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  if (requireComplete) {
    const monthly = items.find((item) => item.resourceId === HONGHUAN_MONTHLY_TIER_ID);
    if (items.length !== HONGHUAN_EXPECTED_ITEM_COUNT || response.nextCursor !== null || !monthly
      || monthly.quantity.allowedValues?.join(',') !== '32,64,128'
      || monthly.billing.referencePrice.monthlyAmount !== '411676.65' || !monthly.legalReviewRequired) {
      throw new Error('SUPPLIER_INQUIRY_CATALOG_INCOMPLETE');
    }
  }
  return { items, nextCursor: response.nextCursor as string | null };
}

export function decodeSupplierInquiryResource(value: unknown, expectedResourceId?: string) {
  const response = asRecord(value);
  exactKeys(response, ['ok', 'item']);
  if (response.ok !== true) throw new Error('SUPPLIER_INQUIRY_CATALOG_INVALID');
  const item = decodeItem(response.item);
  if (expectedResourceId !== undefined && item.resourceId !== expectedResourceId) {
    throw new Error('SUPPLIER_INQUIRY_CATALOG_RESOURCE_MISMATCH');
  }
  return item;
}

export async function loadSupplierInquiryCatalog() {
  const { apiRequest } = await import('./api-client');
  const response = await apiRequest<unknown>('/mobile/v1/supplier-inquiry-catalog?limit=50', { retry: true });
  return decodeSupplierInquiryCatalog(response, true);
}

export async function loadSupplierInquiryResource(resourceId: string) {
  const { apiRequest } = await import('./api-client');
  const response = await apiRequest<unknown>(`/mobile/v1/supplier-inquiry-catalog/${encodeURIComponent(resourceId)}`, { retry: true });
  return decodeSupplierInquiryResource(response, resourceId);
}

export function supplierCatalogCardCount(item: SupplierInquiryCatalogItem) {
  const options = item.quantity.allowedValues;
  const perInstance = item.specifications.gpu.countPerInstance;
  if (options && perInstance !== null) return `${options.map((value) => value * perInstance).join(' / ')} 张 GPU`;
  if (options) return '总 GPU 数待确认';
  return item.specifications.gpu.countPerInstance === null ? '待确认' : `${item.specifications.gpu.countPerInstance} 张 / 实例`;
}

export function supplierCatalogReferenceCredit(item: SupplierInquiryCatalogItem) {
  const amount = item.catalogKind === 'contract_monthly'
    ? item.billing.referencePrice.monthlyAmount : item.billing.referencePrice.hourlyAmount;
  return amount === null ? '待确认' : `${amount} KAI 卡时`;
}

export function supplierCatalogInquiryCandidate(item: SupplierInquiryCatalogItem): InquiryCatalogCandidate {
  const gpuCounts = item.quantity.allowedValues ?? (item.specifications.gpu.countPerInstance === null
    ? [] : [item.specifications.gpu.countPerInstance]);
  const referenceCreditAmount = item.catalogKind === 'contract_monthly'
    ? item.billing.referencePrice.monthlyAmount : item.billing.referencePrice.hourlyAmount;
  return {
    candidateId: item.resourceId, source: HONGHUAN_CATALOG_SOURCE,
    model: item.specifications.gpu.model, cardType: item.specifications.gpu.formFactor ?? '卡型待确认', region: '全国·询价确认',
    modes: [...item.billing.modes], status: 'inquiry_required', sourceObservedAt: item.source.observedAt, lastVerifiedAt: null,
    verification: { status: 'awaiting_supplier_confirmation', message: '库存与交付需询价确认' },
    supplier: { displayName: item.supplier.legalName, claimed: false }, terms: 'inquiry-required',
    catalog: {
      canonicalId: item.resourceId, version: item.version,
      serviceMode: item.catalogKind === 'hourly_gpu' ? 'hourly_compute' : 'long_term_machine',
      quantity: item.quantity, gpuCounts, referenceCreditAmount, legalReviewRequired: item.legalReviewRequired,
    },
  };
}
