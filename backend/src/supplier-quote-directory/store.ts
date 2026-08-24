import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { SupplierQuoteDirectoryFilters, SupplierQuoteDirectoryRow } from './types.js';

type Row = QueryResultRow & {
  source_row: number; supplier_id: string; legal_name: string; display_name: string; entity_type: string | null;
  locations: unknown; declared_gpu_description: string; declared_gpu_models: unknown; quotes: unknown;
  contract_terms: string | null; network_description: string | null; source_availability_claim: string | null;
  source_sla_claim: string | null; source_notes: string | null; logo_https_url: string | null;
  logo_source_url: string | null; logo_status: SupplierQuoteDirectoryRow['logoStatus'];
  source_observed_at: string | Date; valid_until: Date;
};

function dateOnly(value: string | Date) {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function mapRow(row: Row): SupplierQuoteDirectoryRow {
  return {
    sourceRow: Number(row.source_row), supplierId: row.supplier_id, legalName: row.legal_name,
    displayName: row.display_name, entityType: row.entity_type, locations: row.locations,
    declaredGpuDescription: row.declared_gpu_description, declaredGpuModels: row.declared_gpu_models,
    quotes: row.quotes, contractTerms: row.contract_terms, networkDescription: row.network_description,
    sourceAvailabilityClaim: row.source_availability_claim, sourceSlaClaim: row.source_sla_claim,
    sourceNotes: row.source_notes, logoHttpsUrl: row.logo_https_url, logoSourceUrl: row.logo_source_url,
    logoStatus: row.logo_status, sourceObservedAt: dateOnly(row.source_observed_at), validUntil: new Date(row.valid_until),
  };
}

const columns = `i.source_row,i.supplier_id,i.legal_name,i.display_name,i.entity_type,i.locations,
  i.declared_gpu_description,i.declared_gpu_models,i.quotes,i.contract_terms,i.network_description,
  i.source_availability_claim,i.source_sla_claim,i.source_notes,i.logo_https_url,i.logo_source_url,i.logo_status,
  s.source_observed_at,s.valid_until`;

export class PostgresSupplierQuoteDirectoryStore {
  constructor(private readonly database: Database) {}

  async readiness(now: Date) {
    const result = await this.database.query<{ sources: string; items: string; invalid: string; expired: string }>(`SELECT
      (SELECT count(*) FROM supplier_quote_directory_sources WHERE source_id='gpu-supplier-workbook-2026-08-17'
        AND source_kind='USER_PROVIDED_SUPPLIER_WORKBOOK' AND verification_status='unverified'
        AND supplier_count=100 AND source_sha256 ~ '^sha256:[a-f0-9]{64}$')::text sources,
      (SELECT count(*) FROM supplier_quote_directory_items WHERE source_id='gpu-supplier-workbook-2026-08-17' AND active)::text items,
      (SELECT count(*) FROM supplier_quote_directory_items WHERE source_id='gpu-supplier-workbook-2026-08-17'
        AND (availability_status<>'inquiry_required' OR inventory_commitment OR purchasable OR order_creation
          OR NOT inquiry_available OR jsonb_array_length(quotes)=0))::text invalid,
      (SELECT count(*) FROM supplier_quote_directory_sources WHERE source_id='gpu-supplier-workbook-2026-08-17'
        AND valid_until<=$1)::text expired`, [now]);
    const row = result.rows[0]; const blockers: string[] = [];
    if (row?.sources !== '1') blockers.push('SUPPLIER_QUOTE_DIRECTORY_SOURCE');
    if (row?.items !== '100') blockers.push('SUPPLIER_QUOTE_DIRECTORY_SEED_100_ITEMS');
    if (row?.invalid !== '0') blockers.push('SUPPLIER_QUOTE_DIRECTORY_PUBLIC_INVARIANTS');
    if (row?.expired !== '0') blockers.push('SUPPLIER_QUOTE_DIRECTORY_EXPIRED');
    return { ready: blockers.length === 0, blockers };
  }

  async list(filters: SupplierQuoteDirectoryFilters, now: Date) {
    const values: unknown[] = [now]; const where = [
      `i.active=true`, `i.source_id='gpu-supplier-workbook-2026-08-17'`,
      `i.availability_status='inquiry_required'`, `i.inventory_commitment=false`, `i.purchasable=false`,
      `i.order_creation=false`, `i.inquiry_available=true`, `s.valid_until>$1`,
    ];
    const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (filters.model) where.push(`i.declared_gpu_models ? ${parameter(filters.model)}`);
    if (filters.query) {
      const query = parameter(`%${filters.query.replace(/[\\%_]/gu, '\\$&')}%`);
      where.push(`(i.legal_name ILIKE ${query} ESCAPE '\\' OR i.declared_gpu_description ILIKE ${query} ESCAPE '\\'
        OR i.entity_type ILIKE ${query} ESCAPE '\\' OR i.locations::text ILIKE ${query} ESCAPE '\\')`);
    }
    const limit = parameter(filters.limit);
    const result = await this.database.query<Row>(`SELECT ${columns} FROM supplier_quote_directory_items i
      JOIN supplier_quote_directory_sources s ON s.source_id=i.source_id WHERE ${where.join(' AND ')}
      ORDER BY i.source_row ASC LIMIT ${limit}`, values);
    return result.rows.map(mapRow);
  }
}
