export type SupplierQuoteModel = 'H100' | 'H200' | 'B300';
export type SupplierQuoteBillingMode = 'hourly' | 'monthly';
export type SupplierQuoteDirectoryItem = Readonly<{
  supplierId: string;
  sourceRow: number;
  legalName: string;
  displayName: string;
  entityType: string | null;
  locations: readonly string[];
  gpu: Readonly<{ description: string; models: readonly SupplierQuoteModel[] }>;
  quotes: readonly Readonly<{
    model: SupplierQuoteModel;
    formFactor: 'SXM' | 'PCIe' | null;
    referencePrice: Readonly<{
      currency: 'KAI_CARD_HOUR'; precision: 2; status: 'reference_only';
      hourlyAmount: string | null; monthlyAmount: string | null;
    }>;
  }>[];
  contractTerms: string | null;
  networkDescription: string | null;
  sourceClaims: Readonly<{ availability: string | null; sla: string | null; notes: string | null }>;
  logo: Readonly<{
    httpsUrl: string | null; sourceUrl: string | null;
    status: 'official_domain_candidate' | 'not_verified';
  }>;
  availability: Readonly<{ status: 'inquiry_required'; quantity: null; inventoryCommitment: false }>;
  purchase: Readonly<{
    purchasable: false; orderCreation: false; inquiryAvailable: true; cta: 'publish_directed_requirement';
  }>;
  source: Readonly<{
    kind: 'USER_PROVIDED_SUPPLIER_WORKBOOK'; observedAt: string; validUntil: string;
    verificationStatus: 'unverified';
    label: '资料来源：用户提供的 100 家供应商报价表；价格、库存、主体与 SLA 均待核验';
  }>;
  terms: 'inquiry-required';
}>;

export type SupplierQuoteDirectory = Readonly<{
  items: readonly SupplierQuoteDirectoryItem[];
  totalPublished: 100;
  dataSource: 'live_api' | 'bundled_reference_snapshot';
}>;

const pricePattern = /^(?:0|[1-9]\d*)\.\d{2}$/u;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 240) {
  if (typeof value !== 'string') throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  const result = value.normalize('NFKC').trim();
  if (!result || result.length > maximum) throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  return result;
}

function nullableText(value: unknown, maximum = 240) { return value === null ? null : text(value, maximum); }
function price(value: unknown) {
  if (value === null) return null;
  const result = text(value, 40);
  if (!pricePattern.test(result)) throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  return result;
}

function model(value: unknown): SupplierQuoteModel {
  if (!['H100', 'H200', 'B300'].includes(String(value))) throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  return value as SupplierQuoteModel;
}

function stringList(value: unknown, maximum = 20) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  return value.map((item) => text(item, 120));
}

function decodeItem(value: unknown): SupplierQuoteDirectoryItem {
  const item = record(value); const gpu = record(item.gpu); const logo = record(item.logo);
  const availability = record(item.availability); const purchase = record(item.purchase); const source = record(item.source);
  const claims = record(item.sourceClaims);
  if (!Number.isInteger(item.sourceRow) || Number(item.sourceRow) < 1 || Number(item.sourceRow) > 100
    || availability.status !== 'inquiry_required' || availability.quantity !== null || availability.inventoryCommitment !== false
    || purchase.purchasable !== false || purchase.orderCreation !== false || purchase.inquiryAvailable !== true
    || purchase.cta !== 'publish_directed_requirement' || source.kind !== 'USER_PROVIDED_SUPPLIER_WORKBOOK'
    || source.verificationStatus !== 'unverified' || source.label !== '资料来源：用户提供的 100 家供应商报价表；价格、库存、主体与 SLA 均待核验'
    || item.terms !== 'inquiry-required' || !Array.isArray(item.quotes) || item.quotes.length < 1
    || !Array.isArray(gpu.models) || gpu.models.length < 1) throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  const observedAt = text(source.observedAt, 20); const validUntil = text(source.validUntil, 40);
  if (Number.isNaN(Date.parse(observedAt)) || Number.isNaN(Date.parse(validUntil))) throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  const logoStatus = text(logo.status, 40);
  if (!['official_domain_candidate', 'not_verified'].includes(logoStatus)
    || (logo.httpsUrl !== null && !/^https:\/\//u.test(String(logo.httpsUrl)))
    || (logo.sourceUrl !== null && !/^https:\/\//u.test(String(logo.sourceUrl)))) throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  const quotes = item.quotes.map((candidate) => {
    const quote = record(candidate); const reference = record(quote.referencePrice);
    if (!['SXM', 'PCIe', null].includes(quote.formFactor as string | null)
      || reference.currency !== 'KAI_CARD_HOUR' || reference.precision !== 2 || reference.status !== 'reference_only') {
      throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
    }
    return { model: model(quote.model), formFactor: quote.formFactor as 'SXM' | 'PCIe' | null,
      referencePrice: { currency: 'KAI_CARD_HOUR' as const, precision: 2 as const, status: 'reference_only' as const,
        hourlyAmount: price(reference.hourlyAmount), monthlyAmount: price(reference.monthlyAmount) } };
  });
  const models = gpu.models.map(model);
  if (quotes.some((quote) => !models.includes(quote.model))) throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  return {
    supplierId: text(item.supplierId, 80), sourceRow: Number(item.sourceRow), legalName: text(item.legalName, 160),
    displayName: text(item.displayName, 160), entityType: nullableText(item.entityType, 80), locations: stringList(item.locations),
    gpu: { description: text(gpu.description, 240), models }, quotes,
    contractTerms: nullableText(item.contractTerms), networkDescription: nullableText(item.networkDescription),
    sourceClaims: { availability: nullableText(claims.availability), sla: nullableText(claims.sla), notes: nullableText(claims.notes) },
    logo: { httpsUrl: nullableText(logo.httpsUrl, 500), sourceUrl: nullableText(logo.sourceUrl, 500),
      status: logoStatus as 'official_domain_candidate' | 'not_verified' },
    availability: { status: 'inquiry_required', quantity: null, inventoryCommitment: false },
    purchase: { purchasable: false, orderCreation: false, inquiryAvailable: true, cta: 'publish_directed_requirement' },
    source: { kind: 'USER_PROVIDED_SUPPLIER_WORKBOOK', observedAt, validUntil, verificationStatus: 'unverified',
      label: '资料来源：用户提供的 100 家供应商报价表；价格、库存、主体与 SLA 均待核验' },
    terms: 'inquiry-required',
  };
}

export function decodeSupplierQuoteDirectory(value: unknown, dataSource: SupplierQuoteDirectory['dataSource']): SupplierQuoteDirectory {
  const response = record(value);
  if (response.ok !== true || response.totalPublished !== 100 || !Array.isArray(response.items)) {
    throw new Error('SUPPLIER_QUOTE_DIRECTORY_INVALID');
  }
  const items = response.items.map(decodeItem);
  if (items.length !== 100 || new Set(items.map((item) => item.supplierId)).size !== 100
    || items.some((item, index) => item.sourceRow !== index + 1)) throw new Error('SUPPLIER_QUOTE_DIRECTORY_INCOMPLETE');
  return { items, totalPublished: 100, dataSource };
}

function readableSnapshot() {
  const snapshot = require('./data/supplier-quote-directory.snapshot.json') as unknown;
  const cache = record(record(snapshot).cache);
  const validUntil = text(cache.validUntil, 40);
  if (cache.kind !== 'bundled_reference_snapshot' || Date.now() >= Date.parse(validUntil)) {
    throw new Error('SUPPLIER_QUOTE_DIRECTORY_SNAPSHOT_EXPIRED');
  }
  return decodeSupplierQuoteDirectory(snapshot, 'bundled_reference_snapshot');
}

export async function loadSupplierQuoteDirectory() {
  const { ApiError, apiRequest } = await import('./api-client');
  try {
    return decodeSupplierQuoteDirectory(await apiRequest<unknown>('/mobile/v1/supplier-quote-directory?limit=100', { retry: true }), 'live_api');
  } catch (error) {
    if (error instanceof ApiError && ![0, 404, 502, 503, 504].includes(error.status)) throw error;
    return readableSnapshot();
  }
}

export function supplierQuoteForBilling(item: SupplierQuoteDirectoryItem, billingMode: SupplierQuoteBillingMode = 'hourly') {
  const quote = item.quotes.find((candidate) => billingMode === 'monthly'
    ? candidate.referencePrice.monthlyAmount !== null : candidate.referencePrice.hourlyAmount !== null) ?? item.quotes[0];
  return quote ?? null;
}

export function supplierQuoteReference(item: SupplierQuoteDirectoryItem, billingMode: SupplierQuoteBillingMode = 'hourly') {
  const quote = supplierQuoteForBilling(item, billingMode);
  if (!quote) return '待确认';
  const amount = billingMode === 'monthly'
    ? quote.referencePrice.monthlyAmount : quote.referencePrice.hourlyAmount;
  return amount === null ? '待确认' : `${amount} KAI 卡时`;
}
