export type SupplierQuoteModel = 'H100' | 'H200' | 'B300';

export type SupplierQuoteDirectoryRow = Readonly<{
  sourceRow: number;
  supplierId: string;
  legalName: string;
  displayName: string;
  entityType: string | null;
  locations: unknown;
  declaredGpuDescription: string;
  declaredGpuModels: unknown;
  quotes: unknown;
  contractTerms: string | null;
  networkDescription: string | null;
  sourceAvailabilityClaim: string | null;
  sourceSlaClaim: string | null;
  sourceNotes: string | null;
  logoHttpsUrl: string | null;
  logoSourceUrl: string | null;
  logoStatus: 'official_domain_candidate' | 'not_verified';
  sourceObservedAt: string;
  validUntil: Date;
}>;

export type SupplierQuoteDirectoryFilters = Readonly<{
  model?: SupplierQuoteModel;
  query?: string;
  limit: number;
}>;
