import { AppError } from '../errors.js';
import type { PostgresSupplierQuoteDirectoryStore } from './store.js';
import type { SupplierQuoteDirectoryRow, SupplierQuoteModel } from './types.js';

type RawQuote = Readonly<{
  model: string; formFactor: unknown; declaredInGpuModels: unknown;
  referenceHourlyMinor: unknown; referenceMonthlyMinor: unknown; priceStatus: unknown;
}>;

function textArray(value: unknown, allowed?: readonly string[]) {
  if (!Array.isArray(value)) throw new AppError('SUPPLIER_QUOTE_DIRECTORY_DATA_INVALID', 503, '供应商报价目录数据不完整。');
  const result = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (result.length !== value.length || (allowed && result.some((item) => !allowed.includes(item)))) {
    throw new AppError('SUPPLIER_QUOTE_DIRECTORY_DATA_INVALID', 503, '供应商报价目录数据不完整。');
  }
  return result;
}

function amount(value: unknown) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AppError('SUPPLIER_QUOTE_DIRECTORY_DATA_INVALID', 503, '供应商报价目录价格数据不完整。');
  }
  const minor = BigInt(Number(value));
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
}

function publicQuotes(value: unknown) {
  if (!Array.isArray(value)) throw new AppError('SUPPLIER_QUOTE_DIRECTORY_DATA_INVALID', 503, '供应商报价目录价格数据不完整。');
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const quote = candidate as RawQuote;
    if (!['H100', 'H200', 'B300'].includes(quote.model) || quote.declaredInGpuModels !== true
      || quote.priceStatus !== 'reference_only' || !['SXM', 'PCIe', null].includes(quote.formFactor as string | null)) return [];
    return [{
      model: quote.model as SupplierQuoteModel, formFactor: quote.formFactor as 'SXM' | 'PCIe' | null,
      referencePrice: { currency: 'KAI_CARD_HOUR' as const, precision: 2 as const, status: 'reference_only' as const,
        hourlyAmount: amount(quote.referenceHourlyMinor), monthlyAmount: amount(quote.referenceMonthlyMinor) },
    }];
  });
}

export class SupplierQuoteDirectoryService {
  constructor(private readonly store: PostgresSupplierQuoteDirectoryStore, private readonly now: () => Date = () => new Date()) {}

  readiness() { return this.store.readiness(this.now()); }

  async list(input: Readonly<{ model?: SupplierQuoteModel; query?: string; limit?: number }>) {
    const state = await this.readiness();
    if (!state.ready) throw new AppError('SUPPLIER_QUOTE_DIRECTORY_NOT_READY', 503, '100 家供应商报价目录暂不可用。', { blockers: state.blockers });
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
    const rows = await this.store.list({ ...(input.model ? { model: input.model } : {}),
      ...(input.query?.trim() ? { query: input.query.trim() } : {}), limit }, this.now());
    return { items: rows.map((row) => this.publicItem(row)), totalPublished: 100 };
  }

  private publicItem(row: SupplierQuoteDirectoryRow) {
    const models = textArray(row.declaredGpuModels, ['H100', 'H200', 'B300']) as SupplierQuoteModel[];
    const quotes = publicQuotes(row.quotes);
    if (!models.length || !quotes.length) throw new AppError('SUPPLIER_QUOTE_DIRECTORY_DATA_INVALID', 503, '供应商报价目录数据不完整。');
    return {
      supplierId: row.supplierId, sourceRow: row.sourceRow, legalName: row.legalName, displayName: row.displayName,
      entityType: row.entityType, locations: textArray(row.locations), gpu: { description: row.declaredGpuDescription, models },
      quotes, contractTerms: row.contractTerms, networkDescription: row.networkDescription,
      sourceClaims: { availability: row.sourceAvailabilityClaim, sla: row.sourceSlaClaim, notes: row.sourceNotes },
      logo: { httpsUrl: row.logoHttpsUrl, sourceUrl: row.logoSourceUrl, status: row.logoStatus },
      availability: { status: 'inquiry_required' as const, quantity: null, inventoryCommitment: false as const },
      purchase: { purchasable: false as const, orderCreation: false as const, inquiryAvailable: true as const,
        cta: 'publish_directed_requirement' as const },
      source: { kind: 'USER_PROVIDED_SUPPLIER_WORKBOOK' as const, observedAt: row.sourceObservedAt,
        validUntil: row.validUntil.toISOString(), verificationStatus: 'unverified' as const,
        label: '资料来源：用户提供的 100 家供应商报价表；价格、库存、主体与 SLA 均待核验' as const },
      terms: 'inquiry-required' as const,
    };
  }
}
