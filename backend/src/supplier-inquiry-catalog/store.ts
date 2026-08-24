import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { SupplierCatalogFilters,SupplierCatalogItem,SupplierCatalogReadiness,SupplierCatalogSpecifications } from './types.js';

type Row=QueryResultRow&{
  id:string;canonical_id:string;version:number;catalog_kind:SupplierCatalogItem['catalogKind'];title:string;
  legal_review_required:boolean;spec_snapshot:SupplierCatalogSpecifications;quantity_unit:SupplierCatalogItem['quantityUnit'];
  quantity_min:number;quantity_max:number;quantity_allowed_values:number[]|null;billing_mode:SupplierCatalogItem['billingMode'];
  billing_unit:SupplierCatalogItem['billingUnit'];reference_hourly_minor:string|null;reference_daily_minor:string|null;
  reference_monthly_minor:string|null;valid_until:Date;source_observed_at:string|Date;
  delivery_lead_time_value:number|null;delivery_lead_time_unit:'month'|null;
  delivery_lead_time_status:SupplierCatalogItem['deliveryLeadTimeStatus'];created_at:Date;supplier_id:string;
  legal_name:string;display_name:string;disclosure_status:'platform_imported_unverified';logo_https_url:string;logo_version:string;
};

const columns=`i.id,i.canonical_id,i.version,i.catalog_kind,i.title,i.legal_review_required,i.spec_snapshot,
  i.quantity_unit,i.quantity_min,i.quantity_max,i.quantity_allowed_values,i.billing_mode,i.billing_unit,
  i.reference_hourly_minor::text,i.reference_daily_minor::text,i.reference_monthly_minor::text,i.valid_until,
  i.source_observed_at,i.delivery_lead_time_value,i.delivery_lead_time_unit,i.delivery_lead_time_status,i.created_at,
  s.supplier_id,s.legal_name,s.display_name,s.disclosure_status,s.logo_https_url,s.logo_version`;

function dateOnly(value:string|Date){return typeof value==='string'?value:new Date(value).toISOString().slice(0,10);}
function item(row:Row):SupplierCatalogItem{return{id:row.id,resourceId:row.canonical_id,version:Number(row.version),
  catalogKind:row.catalog_kind,title:row.title,legalReviewRequired:row.legal_review_required,
  supplierId:row.supplier_id as SupplierCatalogItem['supplierId'],supplierLegalName:row.legal_name as SupplierCatalogItem['supplierLegalName'],
  supplierDisplayName:row.display_name as SupplierCatalogItem['supplierDisplayName'],supplierDisclosureStatus:row.disclosure_status,
  logoHttpsUrl:row.logo_https_url,logoVersion:row.logo_version,specifications:row.spec_snapshot,
  quantityUnit:row.quantity_unit,quantityMin:Number(row.quantity_min),quantityMax:Number(row.quantity_max),
  quantityAllowedValues:row.quantity_allowed_values?.map(Number)??null,billingMode:row.billing_mode,billingUnit:row.billing_unit,
  referenceHourlyMinor:row.reference_hourly_minor===null?null:BigInt(row.reference_hourly_minor),
  referenceDailyMinor:row.reference_daily_minor===null?null:BigInt(row.reference_daily_minor),
  referenceMonthlyMinor:row.reference_monthly_minor===null?null:BigInt(row.reference_monthly_minor),
  validUntil:new Date(row.valid_until),sourceObservedAt:dateOnly(row.source_observed_at),
  deliveryLeadTimeValue:row.delivery_lead_time_value===null?null:Number(row.delivery_lead_time_value),
  deliveryLeadTimeUnit:row.delivery_lead_time_unit,deliveryLeadTimeStatus:row.delivery_lead_time_status,
  createdAt:new Date(row.created_at)};}

export class PostgresSupplierInquiryCatalogStore {
  constructor(private readonly database:Database){}

  async readiness(now:Date):Promise<SupplierCatalogReadiness>{
    const result=await this.database.query<{sources:string;items:string;prices:string;invalid:string;expired:string}>(`SELECT
      (SELECT count(*) FROM supplier_inquiry_catalog_sources WHERE supplier_id='supplier-shanghai-honghuan'
        AND evidence_complete=true AND logo_https_url LIKE 'https://%'
        AND logo_source_sha256 ~ '^sha256:[a-f0-9]{64}$' AND publication_directive_ref IS NOT NULL
        AND logo_authorization_status='unverified' AND logo_provenance='user_provided'
        AND source_kind='USER_PROVIDED_SUPPLIER_QUOTE' AND source_verification_status='unverified'
        AND quote_evidence_status='user_provided_unverified')::text sources,
      (SELECT count(*) FROM supplier_inquiry_catalog_items WHERE supplier_id='supplier-shanghai-honghuan' AND active)::text items,
      (SELECT count(*) FROM supplier_inquiry_catalog_source_prices p JOIN supplier_inquiry_catalog_items i
        ON i.id=p.catalog_item_id WHERE i.supplier_id='supplier-shanghai-honghuan'
        AND p.evidence_status='user_provided_unverified')::text prices,
      (SELECT count(*) FROM supplier_inquiry_catalog_items WHERE supplier_id='supplier-shanghai-honghuan'
        AND (purchasable OR inventory_commitment OR order_creation OR NOT inquiry_available OR simulation))::text invalid,
      ((SELECT count(*) FROM supplier_inquiry_catalog_sources WHERE supplier_id='supplier-shanghai-honghuan'
          AND valid_until<=$1)+(SELECT count(*) FROM supplier_inquiry_catalog_items
          WHERE supplier_id='supplier-shanghai-honghuan' AND active AND valid_until<=$1))::text expired`,[now]);
    const row=result.rows[0],blockers:string[]=[];
    if(row?.sources!=='1')blockers.push('HONGHUAN_SUPPLIER_SOURCE_OR_LOGO_EVIDENCE');
    if(row?.items!=='11')blockers.push('HONGHUAN_SUPPLIER_CATALOG_SEED_11_ITEMS');
    if(row?.prices!=='11')blockers.push('HONGHUAN_SUPPLIER_PRICE_EVIDENCE_11_ITEMS');
    if(row?.invalid!=='0')blockers.push('HONGHUAN_SUPPLIER_CATALOG_PUBLIC_INVARIANTS');
    if(row?.expired!=='0')blockers.push('HONGHUAN_REFERENCE_PRICE_EXPIRED');
    return{ready:blockers.length===0,blockers};
  }

  async list(filters:SupplierCatalogFilters,now:Date){
    const values:unknown[]=[],where=[`i.active=true`,`i.supplier_id='supplier-shanghai-honghuan'`,`s.evidence_complete=true`,
      `s.quote_evidence_status='user_provided_unverified'`];
    const parameter=(value:unknown)=>{values.push(value);return`$${values.length}`;};
    const current=parameter(now);where.push(`i.valid_until>${current}::timestamptz`,`s.valid_until>${current}::timestamptz`);
    if(filters.kind)where.push(`i.catalog_kind=${parameter(filters.kind)}`);
    if(filters.model)where.push(`i.model=${parameter(filters.model)}`);
    if(filters.query){const query=parameter(`%${filters.query.replace(/[\\%_]/gu,'\\$&')}%`);
      where.push(`(i.title ILIKE ${query} ESCAPE '\\' OR i.model ILIKE ${query} ESCAPE '\\'
        OR i.canonical_id ILIKE ${query} ESCAPE '\\')`);}
    if(filters.cursor){const created=parameter(filters.cursor.createdAt),id=parameter(filters.cursor.id);
      where.push(`(i.created_at,i.id)<(${created}::timestamptz,${id}::uuid)`);}
    const limit=parameter(filters.limit);
    const result=await this.database.query<Row>(`SELECT ${columns} FROM supplier_inquiry_catalog_items i
      JOIN supplier_inquiry_catalog_sources s ON s.supplier_id=i.supplier_id WHERE ${where.join(' AND ')}
      ORDER BY i.created_at DESC,i.id DESC LIMIT ${limit}`,values);
    return result.rows.map(item);
  }

  async get(resourceId:string,now:Date){const result=await this.database.query<Row>(`SELECT ${columns}
    FROM supplier_inquiry_catalog_items i JOIN supplier_inquiry_catalog_sources s ON s.supplier_id=i.supplier_id
    WHERE i.canonical_id=$1 AND i.active=true AND s.evidence_complete=true
      AND s.quote_evidence_status='user_provided_unverified' AND i.valid_until>$2 AND s.valid_until>$2`,[resourceId,now]);
    return result.rows[0]?item(result.rows[0]):null;}
}
