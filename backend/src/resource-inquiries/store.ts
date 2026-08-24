import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { ListingCursor } from '../market/cursor.js';
import type { SupplierImportPreflight } from './importer.js';
import type {
  CatalogCandidate, InquiryBillingMode, InquiryClarification, InquiryEnvironment, InquiryNetwork,
  InquiryRecord, InquiryStatus, InquiryUseCase,
} from './types.js';

type CandidateRow = QueryResultRow & {
  id: string; model: CatalogCandidate['model']; card_type: string; wide_region: string; modes: string[];
  status: 'inquiry_required'; source_observed_at: Date; verified_at: Date | null; supplier_subject_id: string | null;
  created_at: Date;
};

type InquiryRow = QueryResultRow & {
  id: string; inquiry_number: string; subject_id: string; requested_by_user_id: string; status: InquiryStatus;
  starts_at: Date; ends_at: Date; time_zone: string; confirm_by: Date; gpu_count: number|null; billing_mode: InquiryBillingMode;
  allow_substitutes: boolean; max_credit_micros: string; use_case: InquiryUseCase; description: string;
  environment: InquiryEnvironment; network: InquiryNetwork; storage_gib: number; data_region: string;
  terms_version: string; privacy_version: string; inquiry_version: string; accepted_at: Date;
  supplier_subject_id: string | null; cancelled_at: Date | null; capacity_confirmed_at: Date | null;
  expired_at: Date | null; status_message: string | null; version: number; created_at: Date; updated_at: Date;
  candidate_id: string | null; model: CatalogCandidate['model'] | null; card_type: string | null; wide_region: string | null;
  modes: string[] | null;candidate_status: 'inquiry_required' | null; source_observed_at: Date | null; verified_at: Date | null;
  candidate_supplier_subject_id: string | null; candidate_created_at: Date;
  supplier_catalog_item_id:string|null;supplier_catalog_version:number|null;requested_quantity:number|null;
  supplier_snapshot:Record<string,unknown>|null;
  resource_snapshot:Record<string,unknown>|null;reference_price_snapshot:Record<string,unknown>|null;
  source_snapshot:Record<string,unknown>|null;
  client_request_id: string; payload_digest: string; cancel_idempotency_key: string | null; cancel_payload_digest: string | null;
};

type ClarificationRow = QueryResultRow & { id: string; message: string;
  message_kind: InquiryClarification['kind']; created_at: Date; payload_digest?: string };
type FormalResourceRow=QueryResultRow&{id:string;canonical_id:string;version:number;catalog_kind:'hourly_gpu'|'contract_monthly';
  title:string;legal_review_required:boolean;spec_snapshot:NonNullable<InquiryRecord['supplierResource']>['specifications'];
  quantity_unit:'instance'|'server';quantity_min:number;quantity_max:number;quantity_allowed_values:number[]|null;
  billing_mode:InquiryBillingMode;gpu_count:number|null;reference_hourly_minor:string|null;reference_daily_minor:string|null;
  reference_monthly_minor:string|null;valid_until:Date;source_observed_at:string|Date;supplier_id:'supplier-shanghai-honghuan';
  legal_name:'上海鸿欢网络科技有限公司';display_name:'上海鸿欢';
  disclosure_status:'platform_imported_unverified';logo_https_url:string;logo_version:string;
  logo_source_sha256:string;logo_authorization_status:string;logo_provenance:string;publication_directive_ref:string;
  supplier_authorization_evidence_ref:string|null;quote_evidence_sha256:string;quote_evidence_storage_ref:string;
  quote_evidence_status:string;source_kind:string;source_verification_status:string;source_valid_until:Date;
  evidence_complete:boolean;item_digest:string;price_digest:string};

const HONGHUAN_ITEM_DIGESTS:Readonly<Record<string,string>>={
  'gpu-honghuan-a100-sxm4-80gb-1':'43d3b15da7ea6125be30cdb01ee98c28',
  'gpu-honghuan-a100-sxm4-80gb-2':'db66e5e383aff127cef0a4749d1102d1',
  'gpu-honghuan-h100-sxm-80gb-1':'3a1b65f04ee25919fc7ad2839c618768',
  'gpu-honghuan-h100-sxm-80gb-2':'4cefb2195bb5e8009d2f2f45a3505c6f',
  'gpu-honghuan-h200-nvl-1':'7cd4f3b38a6b1f8af7966912eb2b1c9f',
  'gpu-honghuan-h200-nvl-2':'4cb5c9b97e2af5ee238ef5d7f715da9b',
  'gpu-honghuan-b200-179gb-1':'6ecbc2391eab2c5342ceee1a19fcc819',
  'gpu-honghuan-b200-179gb-2':'8946bc5598b45e1948ce817c83104298',
  'gpu-honghuan-b200-179gb-4':'6510dc990c70567b5b2ba240cfdf033f',
  'gpu-honghuan-b300-269gb-1':'962c4b86a12b65792a2af9949e907942',
  'server-honghuan-b300-monthly-32plus':'135ff67bc633d5f77c9c757e7f6442eb',
};
const HONGHUAN_PRICE_DIGESTS:Readonly<Record<string,string>>={
  'gpu-honghuan-a100-sxm4-80gb-1':'9bc92bdf59077a93c09e436141c54bb5',
  'gpu-honghuan-a100-sxm4-80gb-2':'e6a091d09329a441666afc1ef6f52ab9',
  'gpu-honghuan-h100-sxm-80gb-1':'5b08709d3a272e127c4071dbd06925a5',
  'gpu-honghuan-h100-sxm-80gb-2':'4ffbcc97a92e3aa83c7292d32e326cdf',
  'gpu-honghuan-h200-nvl-1':'00a1ae9d0aeff303e6d54cb803cadb8b',
  'gpu-honghuan-h200-nvl-2':'ce462d062283904ba7f2866dddf52c42',
  'gpu-honghuan-b200-179gb-1':'f36d5f9f1af3cede045078cb02bb652f',
  'gpu-honghuan-b200-179gb-2':'bd84696f3648c3f876b7f8d51e16bff4',
  'gpu-honghuan-b200-179gb-4':'0f1d81e7a3da80576a3d3bc25bcdc1a0',
  'gpu-honghuan-b300-269gb-1':'e4451510a818f3a5076bbd6423e7adb4',
  'server-honghuan-b300-monthly-32plus':'7978a5cd52a9beecbd879202c1c22fe9',
};
const HONGHUAN_ITEM_DIGEST_SQL=`md5(jsonb_build_object('id',i.id,'canonicalId',i.canonical_id,'version',i.version,
  'supplierId',i.supplier_id,'catalogKind',i.catalog_kind,'title',i.title,'model',i.model,'formFactor',i.form_factor,
  'memoryGb',i.memory_gb,'gpuCount',i.gpu_count,'specSnapshot',i.spec_snapshot,'quantityUnit',i.quantity_unit,
  'quantityMin',i.quantity_min,'quantityMax',i.quantity_max,'quantityAllowedValues',i.quantity_allowed_values,
  'billingMode',i.billing_mode,'billingUnit',i.billing_unit,'referenceHourlyMinor',i.reference_hourly_minor,
  'referenceDailyMinor',i.reference_daily_minor,'referenceMonthlyMinor',i.reference_monthly_minor,
  'referenceCurrency',i.reference_currency,'referencePrecision',i.reference_precision,'referenceStatus',i.reference_status,
  'availabilityStatus',i.availability_status,'deliveryMode',i.delivery_mode,'deliveryLeadTimeValue',i.delivery_lead_time_value,
  'deliveryLeadTimeUnit',i.delivery_lead_time_unit,'deliveryLeadTimeStatus',i.delivery_lead_time_status,
  'purchaseMode',i.purchase_mode,'purchasable',i.purchasable,'inventoryCommitment',i.inventory_commitment,
  'orderCreation',i.order_creation,'inquiryAvailable',i.inquiry_available,'simulation',i.simulation,
  'legalReviewRequired',i.legal_review_required,'active',i.active)::text)`;
const HONGHUAN_PRICE_DIGEST_SQL=`md5(jsonb_build_object('catalogItemId',p.catalog_item_id,
  'sourceCurrency',p.source_currency,'sourceHourlyMinor',p.source_hourly_minor,'sourceDailyMinor',p.source_daily_minor,
  'sourceMonthlyMinor',p.source_monthly_minor,'listingMultiplierMillis',p.listing_multiplier_millis,
  'conversionPolicyVersion',p.conversion_policy_version,'settlementFeeApplied',p.settlement_fee_applied,
  'evidenceSha256',p.evidence_sha256,'evidenceStorageRef',p.evidence_storage_ref,
  'evidenceStatus',p.evidence_status,'rawLegalTerms',p.raw_legal_terms)::text)`;

type CreateBase=Readonly<{id:string;inquiryNumber:string;subjectId:string;userId:string;startsAt:Date;endsAt:Date;
  timeZone:string;confirmBy:Date;billingMode:InquiryBillingMode;allowSubstitutes:boolean;maxCreditMicros:bigint;
  useCase:InquiryUseCase;description:string;environment:InquiryEnvironment;network:InquiryNetwork;storageGiB:number;
  dataRegion:string;termsVersion:string;privacyVersion:string;inquiryVersion:string;idempotencyKey:string;
  payloadDigest:string;ipHash:string;requestId:string;now:Date}>;
export type ResourceInquiryCreateInput=CreateBase&(
  Readonly<{candidateId:string;gpuCount:number}>|
  Readonly<{supplierResourceId:string;supplierResourceVersion:number;quantity:number}>
);

const inquirySelect = `i.id,i.inquiry_number,i.subject_id,i.requested_by_user_id,i.status,i.starts_at,i.ends_at,
  i.time_zone,i.confirm_by,i.gpu_count,i.billing_mode,i.allow_substitutes,i.max_credit_micros::text,
  i.use_case,i.description,i.environment,i.network,i.storage_gib,i.data_region,i.terms_version,i.privacy_version,
  i.inquiry_version,i.created_at AS accepted_at,i.supplier_subject_id,i.cancelled_at,i.capacity_confirmed_at,
  i.expired_at,i.status_message,i.version,i.created_at,i.updated_at,i.client_request_id,
  i.payload_digest,i.cancel_idempotency_key,i.cancel_payload_digest,i.supplier_catalog_item_id,
  i.supplier_catalog_version,i.requested_quantity,i.supplier_snapshot,i.resource_snapshot,i.reference_price_snapshot,
  i.source_snapshot,c.id AS candidate_id,c.model,c.card_type,
  c.wide_region,c.modes,c.status AS candidate_status,c.source_observed_at,c.verified_at,
  c.supplier_subject_id AS candidate_supplier_subject_id,c.created_at AS candidate_created_at`;

function candidate(row:CandidateRow):CatalogCandidate;
function candidate(row:InquiryRow):CatalogCandidate|null;
function candidate(row:CandidateRow|InquiryRow):CatalogCandidate|null{
  if('candidate_id'in row){if(!row.candidate_id)return null;return{id:row.candidate_id,model:row.model!,
    cardType:row.card_type!,region:row.wide_region!,modes:row.modes as InquiryBillingMode[],status:row.candidate_status!,
    sourceObservedAt:new Date(row.source_observed_at!),verifiedAt:row.verified_at?new Date(row.verified_at):null,
    supplierSubjectId:row.candidate_supplier_subject_id,createdAt:new Date(row.candidate_created_at)};}
  return{id:row.id,model:row.model,cardType:row.card_type,region:row.wide_region,modes:row.modes as InquiryBillingMode[],
    status:row.status,sourceObservedAt:new Date(row.source_observed_at),verifiedAt:row.verified_at?new Date(row.verified_at):null,
    supplierSubjectId:row.supplier_subject_id,createdAt:new Date(row.created_at)};
}

function inquiry(row: InquiryRow): InquiryRecord {
  const resource=row.resource_snapshot,supplier=row.supplier_snapshot,referencePrice=row.reference_price_snapshot,
    source=row.source_snapshot;
  const supplierResource=row.supplier_catalog_item_id&&row.requested_quantity&&resource&&supplier&&referencePrice&&source?{
    ...(resource as Omit<NonNullable<InquiryRecord['supplierResource']>,'supplier'|'referencePrice'|'source'|'requestedQuantity'>),
    supplier:supplier as NonNullable<InquiryRecord['supplierResource']>['supplier'],
    referencePrice:referencePrice as NonNullable<InquiryRecord['supplierResource']>['referencePrice'],
    source:source as NonNullable<InquiryRecord['supplierResource']>['source'],requestedQuantity:Number(row.requested_quantity)}:null;
  return { id: row.id, inquiryNumber: row.inquiry_number, subjectId: row.subject_id,
    requestedByUserId: row.requested_by_user_id, supplierSubjectId: row.supplier_subject_id,
    candidate: candidate(row),supplierResource,status: row.status,
    startsAt: new Date(row.starts_at), endsAt: new Date(row.ends_at), timeZone: row.time_zone,
    confirmBy: new Date(row.confirm_by), gpuCount: row.gpu_count===null?null:Number(row.gpu_count),
    requestedQuantity:row.requested_quantity===null?null:Number(row.requested_quantity),billingMode: row.billing_mode,
    allowSubstitutes: row.allow_substitutes, maxCreditMicros: BigInt(row.max_credit_micros), useCase: row.use_case,
    description: row.description, environment: row.environment, network: row.network, storageGiB: Number(row.storage_gib),
    dataRegion: row.data_region, termsVersion: row.terms_version, privacyVersion: row.privacy_version,
    inquiryVersion: row.inquiry_version, acceptedAt: new Date(row.accepted_at),
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at) : null,
    capacityConfirmedAt: row.capacity_confirmed_at ? new Date(row.capacity_confirmed_at) : null,
    expiredAt: row.expired_at ? new Date(row.expired_at) : null, statusMessage: row.status_message,
    version: Number(row.version),
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) };
}

function clarification(row: ClarificationRow): InquiryClarification {
  return { id: row.id, message: row.message, kind: row.message_kind, createdAt: new Date(row.created_at) };
}

function formalCatalogReady(rows:readonly FormalResourceRow[],now:Date){
  if(rows.length!==11)return false;
  const seen=new Set<string>();
  for(const row of rows){
    if(seen.has(row.canonical_id)||HONGHUAN_ITEM_DIGESTS[row.canonical_id]!==row.item_digest
      ||HONGHUAN_PRICE_DIGESTS[row.canonical_id]!==row.price_digest)return false;
    seen.add(row.canonical_id);
    if(row.supplier_id!=='supplier-shanghai-honghuan'||row.legal_name!=='上海鸿欢网络科技有限公司'
      ||row.display_name!=='上海鸿欢'||row.disclosure_status!=='platform_imported_unverified'
      ||row.logo_https_url!=='https://cloud.kai.com/assets/suppliers/shanghai-honghuan.jpg'||row.logo_version!=='v1'
      ||row.logo_source_sha256!=='sha256:db1ed9e4cddc31f4b6e641bbc9179443e5a5d251a31abe28109c3fa55f32a70f'
      ||row.logo_authorization_status!=='unverified'||row.logo_provenance!=='user_provided'
      ||row.publication_directive_ref!=='platform-directive:2026-08-20:honghuan-formal-catalog-b1'
      ||row.supplier_authorization_evidence_ref!==null
      ||row.quote_evidence_sha256!=='sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9'
      ||row.quote_evidence_storage_ref!=='evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1'
      ||row.quote_evidence_status!=='user_provided_unverified'||row.source_kind!=='USER_PROVIDED_SUPPLIER_QUOTE'
      ||row.source_verification_status!=='unverified'||!row.evidence_complete
      ||new Date(row.valid_until)<=now||new Date(row.source_valid_until)<=now)return false;
  }
  return seen.size===Object.keys(HONGHUAN_ITEM_DIGESTS).length;
}

export type SupplierImportCommitInput = Readonly<{
  id: string;
  preflight: SupplierImportPreflight;
  leads: readonly Readonly<{
    id: string; sourceRow: number; supplierReferenceDigest: string; privatePayloadCiphertext: string;
    candidates: readonly Readonly<{ id: string; fingerprint: string; model: CatalogCandidate['model']; cardType: string;
      wideRegion: string; modes: readonly InquiryBillingMode[]; sourceObservedAt: string }>[];
    h200Unconfirmed: null | Readonly<{ id: string; hourlyQuotePresent: boolean; monthlyQuotePresent: boolean }>;
  }>[];
  warnings: readonly Readonly<{ id: string; leadId: string; sourceRow: number; sourceColumn: string }>[];
}>;

export class PostgresSupplierImportStore {
  constructor(private readonly database: Database) {}

  async commit(input: SupplierImportCommitInput) {
    return this.database.transaction(async (client) => {
      const inserted = await client.query<{ id: string; committed_at: Date }>(`INSERT INTO supplier_import_batches(
        id,source_digest,schema_version,status,source_size_bytes,lead_count,candidate_count,warning_count)
        VALUES($1,$2,$3,'committed',$4,$5,$6,$7) ON CONFLICT(source_digest) DO NOTHING RETURNING id,committed_at`,
      [input.id, input.preflight.sourceDigest, input.preflight.schemaVersion, input.preflight.sourceSizeBytes,
        input.preflight.counts.leads, input.preflight.counts.candidates, input.preflight.counts.sourceWarnings]);
      if (!inserted.rows[0]) {
        const existing = await client.query<{ id: string; committed_at: Date }>(
          `SELECT id,committed_at FROM supplier_import_batches WHERE source_digest=$1`, [input.preflight.sourceDigest]);
        return { replayed: true, id: existing.rows[0]!.id, committedAt: new Date(existing.rows[0]!.committed_at) };
      }
      await client.query(`UPDATE supplier_import_batches SET status='superseded',superseded_at=now()
        WHERE id<>$1 AND status='committed'`, [input.id]);
      await client.query(`UPDATE candidate_resources SET active=false WHERE active`);
      for (const lead of input.leads) {
        await client.query(`INSERT INTO supplier_leads(id,batch_id,source_row,supplier_reference_digest,private_payload_ciphertext)
          VALUES($1,$2,$3,$4,$5)`, [lead.id, input.id, lead.sourceRow, lead.supplierReferenceDigest, lead.privatePayloadCiphertext]);
        for (const item of lead.candidates) await client.query(`INSERT INTO candidate_resources(
          id,batch_id,lead_id,candidate_fingerprint,model,card_type,wide_region,modes,source_observed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [item.id, input.id, lead.id, item.fingerprint, item.model,
          item.cardType, item.wideRegion, item.modes, item.sourceObservedAt]);
        if (lead.h200Unconfirmed) await client.query(`INSERT INTO h200_unconfirmed_leads(
          id,batch_id,lead_id,source_row,hourly_quote_present,monthly_quote_present) VALUES($1,$2,$3,$4,$5,$6)`,
        [lead.h200Unconfirmed.id, input.id, lead.id, lead.sourceRow, lead.h200Unconfirmed.hourlyQuotePresent,
          lead.h200Unconfirmed.monthlyQuotePresent]);
      }
      for (const warning of input.warnings) await client.query(`INSERT INTO supplier_import_source_warnings(
        id,batch_id,lead_id,warning_code,source_row,source_column) VALUES($1,$2,$3,'H200_QUOTE_WITHOUT_MODEL',$4,$5)`,
      [warning.id, input.id, warning.leadId, warning.sourceRow, warning.sourceColumn]);
      return { replayed: false, id: inserted.rows[0].id, committedAt: new Date(inserted.rows[0].committed_at) };
    });
  }
}

export type CandidateFilters = Readonly<{
  model?: CatalogCandidate['model']; region?: string; query?: string; cursor: ListingCursor | null; limit: number;
}>;

export class PostgresResourceInquiryStore {
  constructor(private readonly database: Database) {}

  async listCandidates(filters: CandidateFilters):Promise<CatalogCandidate[]> {
    const values: unknown[] = []; const where = ['active=true'];
    const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (filters.model) where.push(`model=${parameter(filters.model)}`);
    if (filters.region) where.push(`wide_region=${parameter(filters.region)}`);
    if (filters.query) {
      const query = parameter(`%${filters.query.replace(/[\\%_]/gu, '\\$&')}%`);
      where.push(`(model ILIKE ${query} ESCAPE '\\' OR card_type ILIKE ${query} ESCAPE '\\' OR wide_region ILIKE ${query} ESCAPE '\\')`);
    }
    if (filters.cursor) {
      const createdAt = parameter(filters.cursor.createdAt); const id = parameter(filters.cursor.id);
      where.push(`(created_at,id)<(${createdAt}::timestamptz,${id}::uuid)`);
    }
    const limit = parameter(filters.limit);
    const rows = await this.database.query<CandidateRow>(`SELECT id,model,card_type,wide_region,modes,status,
      source_observed_at,verified_at,supplier_subject_id,created_at FROM candidate_resources WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC,id DESC LIMIT ${limit}`, values);
    return rows.rows.map((row)=>candidate(row));
  }

  async getCandidate(id: string) {
    const result = await this.database.query<CandidateRow>(`SELECT id,model,card_type,wide_region,modes,status,
      source_observed_at,verified_at,supplier_subject_id,created_at FROM candidate_resources WHERE id=$1 AND active=true`, [id]);
    return result.rows[0] ? candidate(result.rows[0]) : null;
  }

  async create(input:ResourceInquiryCreateInput):Promise<Readonly<{status:'created'|'replayed';inquiry:InquiryRecord}>
    |Readonly<{status:'conflict'|'candidate_not_found'|'supplier_resource_not_found'|'catalog_not_ready'|'mode_unavailable'|'quantity_invalid'}>
    |Readonly<{status:'catalog_version_conflict';currentVersion:number}>>{
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[
        `resource-inquiry-create:${input.subjectId}:${input.idempotencyKey}`]);
      const claim=await this.claimIdempotency(client,input.userId,`resource_inquiry.create:${input.subjectId}`,
        input.idempotencyKey,input.payloadDigest,input.now);
      if(claim==='conflict')return{status:'conflict' as const};
      const existing = await this.findByRequest(client, input.subjectId, input.idempotencyKey);
      if (existing){if(existing.payload_digest!==input.payloadDigest){await this.releaseIdempotency(client,input.userId,
          `resource_inquiry.create:${input.subjectId}`,input.idempotencyKey);return{status:'conflict' as const};}
        await this.completeIdempotency(client,input.userId,`resource_inquiry.create:${input.subjectId}`,
          input.idempotencyKey,{inquiryId:existing.id});return{status:'replayed' as const,inquiry:inquiry(existing)};}
      let auditResource:Record<string,unknown>;
      if('candidateId'in input){
        const candidateResult=await client.query<CandidateRow>(`SELECT id,model,card_type,wide_region,modes,status,
          source_observed_at,verified_at,supplier_subject_id,created_at FROM candidate_resources
          WHERE id=$1 AND active=true FOR SHARE`,[input.candidateId]);
        const selected=candidateResult.rows[0];
        if(!selected){await this.releaseIdempotency(client,input.userId,`resource_inquiry.create:${input.subjectId}`,
          input.idempotencyKey);return{status:'candidate_not_found' as const};}
        if(!selected.modes.includes(input.billingMode)){await this.releaseIdempotency(client,input.userId,
          `resource_inquiry.create:${input.subjectId}`,input.idempotencyKey);return{status:'mode_unavailable' as const};}
        await client.query(`INSERT INTO resource_inquiries(id,inquiry_number,subject_id,requested_by_user_id,candidate_id,
          status,starts_at,ends_at,time_zone,confirm_by,gpu_count,billing_mode,allow_substitutes,max_credit_micros,
          use_case,description,environment,network,storage_gib,data_region,terms_version,privacy_version,inquiry_version,
          client_request_id,payload_digest,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,'submitted',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25)`,
        [input.id,input.inquiryNumber,input.subjectId,input.userId,input.candidateId,input.startsAt,input.endsAt,input.timeZone,
          input.confirmBy,input.gpuCount,input.billingMode,input.allowSubstitutes,input.maxCreditMicros.toString(),input.useCase,
          input.description,input.environment,input.network,input.storageGiB,input.dataRegion,input.termsVersion,input.privacyVersion,
          input.inquiryVersion,input.idempotencyKey,input.payloadDigest,input.now]);
        auditResource={candidateId:input.candidateId};
      }else{
        await client.query(`LOCK TABLE supplier_inquiry_catalog_sources,supplier_inquiry_catalog_items,
          supplier_inquiry_catalog_source_prices IN SHARE MODE`);
        const counts=await client.query<{sources:string;items:string;prices:string}>(`SELECT
          (SELECT count(*) FROM supplier_inquiry_catalog_sources WHERE supplier_id='supplier-shanghai-honghuan')::text sources,
          (SELECT count(*) FROM supplier_inquiry_catalog_items WHERE supplier_id='supplier-shanghai-honghuan')::text items,
          (SELECT count(*) FROM supplier_inquiry_catalog_source_prices p JOIN supplier_inquiry_catalog_items i
            ON i.id=p.catalog_item_id WHERE i.supplier_id='supplier-shanghai-honghuan')::text prices`);
        const catalogResult=await client.query<FormalResourceRow>(`SELECT i.id,i.canonical_id,i.version,i.catalog_kind,
          i.title,i.legal_review_required,i.spec_snapshot,i.quantity_unit,i.quantity_min,i.quantity_max,
          i.quantity_allowed_values,i.billing_mode,i.gpu_count,i.reference_hourly_minor::text,
          i.reference_daily_minor::text,i.reference_monthly_minor::text,i.valid_until,i.source_observed_at,
          s.supplier_id,s.legal_name,s.display_name,s.disclosure_status,s.logo_https_url,s.logo_version,
          s.logo_source_sha256,s.logo_authorization_status,s.logo_provenance,s.publication_directive_ref,
          s.supplier_authorization_evidence_ref,s.quote_evidence_sha256,s.quote_evidence_storage_ref,
          s.quote_evidence_status,s.source_kind,s.source_verification_status,s.valid_until source_valid_until,
          s.evidence_complete,${HONGHUAN_ITEM_DIGEST_SQL} item_digest,${HONGHUAN_PRICE_DIGEST_SQL} price_digest
          FROM supplier_inquiry_catalog_items i JOIN supplier_inquiry_catalog_sources s ON s.supplier_id=i.supplier_id
          JOIN supplier_inquiry_catalog_source_prices p ON p.catalog_item_id=i.id
          WHERE i.supplier_id='supplier-shanghai-honghuan' FOR SHARE OF i,s,p`);
        if(counts.rows[0]?.sources!=='1'||counts.rows[0]?.items!=='11'||counts.rows[0]?.prices!=='11'
          ||!formalCatalogReady(catalogResult.rows,input.now)){
          await this.releaseIdempotency(client,input.userId,`resource_inquiry.create:${input.subjectId}`,
            input.idempotencyKey);return{status:'catalog_not_ready' as const};
        }
        const selected=catalogResult.rows.find((row)=>row.canonical_id===input.supplierResourceId);
        if(!selected){await this.releaseIdempotency(client,input.userId,`resource_inquiry.create:${input.subjectId}`,
          input.idempotencyKey);return{status:'supplier_resource_not_found' as const};}
        if(selected.version!==input.supplierResourceVersion){await this.releaseIdempotency(client,input.userId,
          `resource_inquiry.create:${input.subjectId}`,input.idempotencyKey);return{status:'catalog_version_conflict' as const,
          currentVersion:Number(selected.version)};}
        if(selected.billing_mode!==input.billingMode){await this.releaseIdempotency(client,input.userId,
          `resource_inquiry.create:${input.subjectId}`,input.idempotencyKey);return{status:'mode_unavailable' as const};}
        const allowed=selected.quantity_allowed_values;
        if(input.quantity<Number(selected.quantity_min)||input.quantity>Number(selected.quantity_max)
          ||(allowed!==null&&!allowed.map(Number).includes(input.quantity))){await this.releaseIdempotency(client,input.userId,
          `resource_inquiry.create:${input.subjectId}`,input.idempotencyKey);return{status:'quantity_invalid' as const};}
        const minor=(value:string|null)=>value===null?null:`${BigInt(value)/100n}.${(BigInt(value)%100n).toString().padStart(2,'0')}`;
        const supplierSnapshot={id:selected.supplier_id,legalName:selected.legal_name,displayName:selected.display_name,
          logo:{httpsUrl:selected.logo_https_url,version:selected.logo_version,authorizationStatus:'unverified',provenance:'user_provided'},
          disclosureStatus:selected.disclosure_status};
        const resourceSnapshot={resourceId:selected.canonical_id,version:Number(selected.version),catalogKind:selected.catalog_kind,
          title:selected.title,legalReviewRequired:selected.legal_review_required,specifications:selected.spec_snapshot,
          quantity:{unit:selected.quantity_unit,min:Number(selected.quantity_min),max:Number(selected.quantity_max),
            allowedValues:allowed?.map(Number)??null}};
        const referenceSnapshot={currency:'KAI_CARD_HOUR',precision:2,status:'reference_only',
          hourlyAmount:minor(selected.reference_hourly_minor),dailyAmount:minor(selected.reference_daily_minor),
          monthlyAmount:minor(selected.reference_monthly_minor),validUntil:new Date(selected.valid_until).toISOString()};
        const observed=typeof selected.source_observed_at==='string'?selected.source_observed_at
          :new Date(selected.source_observed_at).toISOString().slice(0,10);
        const sourceSnapshot={observedAt:observed,kind:'USER_PROVIDED_SUPPLIER_QUOTE',
          label:'资料来源：用户提供的供应商报价',verificationStatus:'unverified'};
        const derivedGpuCount=selected.gpu_count===null?null:Number(selected.gpu_count)*input.quantity;
        await client.query(`INSERT INTO resource_inquiries(id,inquiry_number,subject_id,requested_by_user_id,
          supplier_catalog_item_id,supplier_catalog_version,requested_quantity,supplier_snapshot,resource_snapshot,
          reference_price_snapshot,source_snapshot,status,starts_at,ends_at,time_zone,confirm_by,gpu_count,billing_mode,
          allow_substitutes,max_credit_micros,use_case,description,environment,network,storage_gib,data_region,terms_version,
          privacy_version,inquiry_version,client_request_id,payload_digest,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,'submitted',$12,$13,$14,$15,$16,
          $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$31)`,[input.id,input.inquiryNumber,input.subjectId,
          input.userId,selected.id,selected.version,input.quantity,JSON.stringify(supplierSnapshot),JSON.stringify(resourceSnapshot),
          JSON.stringify(referenceSnapshot),JSON.stringify(sourceSnapshot),input.startsAt,input.endsAt,input.timeZone,input.confirmBy,
          derivedGpuCount,input.billingMode,input.allowSubstitutes,input.maxCreditMicros.toString(),input.useCase,input.description,
          input.environment,input.network,input.storageGiB,input.dataRegion,input.termsVersion,input.privacyVersion,input.inquiryVersion,
          input.idempotencyKey,input.payloadDigest,input.now]);
        auditResource={supplierResourceId:input.supplierResourceId,supplierResourceVersion:input.supplierResourceVersion,
          quantity:input.quantity,legalReviewRequired:selected.legal_review_required};
      }
      for (const [kind, version] of [['terms',input.termsVersion],['privacy',input.privacyVersion],['inquiry',input.inquiryVersion]] as const) {
        await client.query(`INSERT INTO resource_inquiry_terms_acceptances(id,inquiry_id,subject_id,user_id,document_kind,
          version,ip_hash,accepted_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
        [input.id,input.subjectId,input.userId,kind,version,input.ipHash,input.now]);
      }
      await this.audit(client, input.userId, 'RESOURCE_INQUIRY_SUBMITTED', input.id, input.requestId, input.ipHash,
        input.payloadDigest, { subjectId: input.subjectId,...auditResource,status:'submitted' });
      await this.outbox(client, 'resource_inquiry.submitted', input.id, { inquiryId: input.id,
        subjectId: input.subjectId,...auditResource,status:'submitted' });
      await this.completeIdempotency(client,input.userId,`resource_inquiry.create:${input.subjectId}`,
        input.idempotencyKey,{inquiryId:input.id});
      const created = await this.getForSubject(client, input.subjectId, input.id);
      return { status: 'created' as const, inquiry: inquiry(created!) };
    });
  }

  async list(subjectId: string, input: Readonly<{ status?: InquiryStatus; cursor: ListingCursor | null; limit: number }>) {
    const values: unknown[] = [subjectId]; const where = ['i.subject_id=$1'];
    const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (input.status) where.push(`i.status=${parameter(input.status)}`);
    if (input.cursor) {
      const createdAt = parameter(input.cursor.createdAt); const id = parameter(input.cursor.id);
      where.push(`(i.created_at,i.id)<(${createdAt}::timestamptz,${id}::uuid)`);
    }
    const limit = parameter(input.limit);
    const rows = await this.database.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      LEFT JOIN candidate_resources c ON c.id=i.candidate_id WHERE ${where.join(' AND ')}
      ORDER BY i.created_at DESC,i.id DESC LIMIT ${limit}`, values);
    return rows.rows.map(inquiry);
  }

  async get(subjectId: string, id: string) {
    const result = await this.database.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      LEFT JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.subject_id=$1 AND i.id=$2`, [subjectId,id]);
    return result.rows[0] ? inquiry(result.rows[0]) : null;
  }

  async listOperator(input: Readonly<{ status?: InquiryStatus; assignment?: 'assigned' | 'unassigned';
    cursor: ListingCursor | null; limit: number }>) {
    return this.listByScope('', input, 'operator');
  }

  async getOperator(id: string) {
    const result = await this.database.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      LEFT JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.id=$1`, [id]);
    return result.rows[0] ? inquiry(result.rows[0]) : null;
  }

  async listSupplier(supplierSubjectId: string, input: Readonly<{ status?: InquiryStatus;
    cursor: ListingCursor | null; limit: number }>) {
    return this.listByScope(supplierSubjectId, input, 'supplier');
  }

  async getSupplier(supplierSubjectId: string, id: string) {
    const result = await this.database.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      LEFT JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.supplier_subject_id=$1 AND i.id=$2`,
    [supplierSubjectId,id]);
    return result.rows[0] ? inquiry(result.rows[0]) : null;
  }

  async assign(input: Readonly<{ inquiryId: string; supplierSubjectId: string; expectedVersion: number;
    actorId: string; idempotencyKey: string; payloadDigest: string; requestId: string; ipHash: string; now: Date }>) {
    return this.database.transaction(async(client)=>{
      const scope=`resource_inquiry.assign:${input.inquiryId}`,claim=await this.claimIdempotency(client,input.actorId,scope,
        input.idempotencyKey,input.payloadDigest,input.now);if(claim==='conflict')return{status:'conflict' as const};
      const replay=await this.actionReplay(client,input.actorId,input.inquiryId,'assign',input.idempotencyKey,input.payloadDigest);
      if(replay){if(replay.status==='replayed')await this.completeIdempotency(client,input.actorId,scope,input.idempotencyKey,
        {inquiryId:input.inquiryId});else await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return replay;}
      const current=await this.getAny(client,input.inquiryId,true);if(!current){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'not_found' as const};}
      if(current.version!==input.expectedVersion){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'version_conflict' as const,inquiry:inquiry(current)};}
      if(current.status!=='submitted'){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'invalid_state' as const,inquiry:inquiry(current)};}
      if(current.supplier_catalog_item_id){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);
        return{status:'formal_assignment_unavailable' as const};}
      const supplier=await client.query(`SELECT 1 FROM supplier_profiles p JOIN trading_subjects s ON s.id=p.subject_id
        WHERE p.subject_id=$1 AND p.status='approved' AND s.status='active' FOR SHARE`,[input.supplierSubjectId]);
      if(!supplier.rowCount){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'invalid_supplier' as const};}
      if(current.candidate_id){
        const claimed=await client.query<{supplier_subject_id:string|null}>(`SELECT supplier_subject_id FROM candidate_resources
          WHERE id=$1 FOR UPDATE`,[current.candidate_id]);
        const bound=claimed.rows[0]?.supplier_subject_id;
        if(bound&&bound!==input.supplierSubjectId){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'assignment_conflict' as const};}
        if(!bound)await client.query(`UPDATE candidate_resources SET supplier_subject_id=$2,claimed_at=$3,claimed_by=$4
          WHERE id=$1`,[current.candidate_id,input.supplierSubjectId,input.now,input.actorId]);
      }
      await client.query(`UPDATE resource_inquiries SET supplier_subject_id=$2,assigned_by=$3,assigned_at=$4,
        status='awaiting_supplier',version=version+1 WHERE id=$1`,[input.inquiryId,input.supplierSubjectId,input.actorId,input.now]);
      await this.recordAction(client,{...input,actorSubjectId:null,action:'assign',fromStatus:'submitted',
        toStatus:'awaiting_supplier',resultingVersion:current.version+1});
      await this.audit(client,input.actorId,'RESOURCE_INQUIRY_ASSIGNED',input.inquiryId,input.requestId,input.ipHash,
        input.payloadDigest,{supplierSubjectId:input.supplierSubjectId,status:'awaiting_supplier',version:current.version+1},'operator');
      await this.outbox(client,'resource_inquiry.assigned',input.inquiryId,{inquiryId:input.inquiryId,
        supplierSubjectId:input.supplierSubjectId,status:'awaiting_supplier',version:current.version+1});
      await this.completeIdempotency(client,input.actorId,scope,input.idempotencyKey,{inquiryId:input.inquiryId});
      return{status:'updated' as const,inquiry:inquiry((await this.getAny(client,input.inquiryId))!)};
    });
  }

  async transition(input: Readonly<{ inquiryId: string; actorId: string; actorKind: 'operator'|'provider';
    actorSubjectId: string | null; action: 'request_clarification'|'decline'|'confirm_capacity'|'expire'|'submit_audit';
    expectedVersion: number; idempotencyKey: string; payloadDigest: string; message?: string;
    requestId: string; ipHash: string; now: Date }>) {
    return this.database.transaction(async(client)=>{
      const scope=`resource_inquiry.${input.action}:${input.inquiryId}`,claim=await this.claimIdempotency(client,input.actorId,
        scope,input.idempotencyKey,input.payloadDigest,input.now);if(claim==='conflict')return{status:'conflict' as const};
      const replay=await this.actionReplay(client,input.actorId,input.inquiryId,input.action,input.idempotencyKey,input.payloadDigest);
      if(replay){if(replay.status==='replayed')await this.completeIdempotency(client,input.actorId,scope,input.idempotencyKey,
        {inquiryId:input.inquiryId});else await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return replay;}
      const current=await this.getAny(client,input.inquiryId,true);if(!current){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'not_found' as const};}
      if(input.actorKind==='provider'&&current.supplier_subject_id!==input.actorSubjectId){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'not_found' as const};}
      if(current.version!==input.expectedVersion){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'version_conflict' as const,inquiry:inquiry(current)};}
      const rule=this.transitionRule(input.action,current.status,input.actorKind,input.now,new Date(current.confirm_by));
      if(!rule){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'invalid_state' as const,inquiry:inquiry(current)};}
      if(input.action==='request_clarification')await client.query(`INSERT INTO resource_inquiry_clarifications(
        id,inquiry_id,subject_id,author_user_id,message,idempotency_key,payload_digest,created_at,
        author_kind,author_subject_id,message_kind) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [input.inquiryId,current.subject_id,input.actorId,input.message,input.idempotencyKey,input.payloadDigest,input.now,
        input.actorKind==='provider'?'supplier':'operator',input.actorSubjectId,
        input.actorKind==='provider'?'supplier_request':'operator_request']);
      await client.query(`UPDATE resource_inquiries SET status=$2,version=version+1,
        capacity_confirmed_at=CASE WHEN $2='capacity_confirmed' THEN $3 ELSE capacity_confirmed_at END,
        expired_at=CASE WHEN $2='inquiry_expired' THEN $3 ELSE expired_at END,
        status_message=CASE WHEN $2='supplier_declined' THEN $4 ELSE status_message END WHERE id=$1`,
      [input.inquiryId,rule.to,input.now,input.message??null]);
      await this.recordAction(client,{...input,fromStatus:current.status,toStatus:rule.to,resultingVersion:current.version+1});
      await this.audit(client,input.actorId,rule.audit,input.inquiryId,input.requestId,input.ipHash,input.payloadDigest,
        {subjectId:current.subject_id,supplierSubjectId:current.supplier_subject_id,status:rule.to,version:current.version+1},input.actorKind);
      await this.outbox(client,rule.topic,input.inquiryId,{inquiryId:input.inquiryId,subjectId:current.subject_id,
        supplierSubjectId:current.supplier_subject_id,status:rule.to,version:current.version+1});
      await this.completeIdempotency(client,input.actorId,scope,input.idempotencyKey,{inquiryId:input.inquiryId});
      return{status:'updated' as const,inquiry:inquiry((await this.getAny(client,input.inquiryId))!)};
    });
  }

  async expireDue(now:Date,limit=100){return this.database.transaction(async(client)=>{
    const due=await client.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      LEFT JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.confirm_by<=$1
      AND i.status IN ('submitted','awaiting_supplier','clarification_required')
      ORDER BY i.confirm_by,i.id FOR UPDATE OF i SKIP LOCKED LIMIT $2`,[now,limit]);
    for(const row of due.rows){await client.query(`UPDATE resource_inquiries SET status='inquiry_expired',
        expired_at=$2,version=version+1 WHERE id=$1`,[row.id,now]);
      await this.audit(client,null,'RESOURCE_INQUIRY_EXPIRED',row.id,`worker:${now.toISOString()}`,null,
        row.payload_digest,{status:'inquiry_expired',version:Number(row.version)+1},'system');
      await this.outbox(client,'resource_inquiry.expired',row.id,{inquiryId:row.id,status:'inquiry_expired',
        version:Number(row.version)+1});}
    return due.rowCount;
  });}

  async clarifications(subjectId: string, id: string) {
    const exists = await this.database.query(`SELECT 1 FROM resource_inquiries WHERE subject_id=$1 AND id=$2`, [subjectId,id]);
    if (!exists.rowCount) return null;
    const rows = await this.database.query<ClarificationRow>(`SELECT id,message,message_kind,created_at FROM resource_inquiry_clarifications
      WHERE subject_id=$1 AND inquiry_id=$2 ORDER BY created_at,id`, [subjectId,id]);
    return rows.rows.map(clarification);
  }

  async cancel(input: Readonly<{ subjectId: string; userId: string; inquiryId: string; idempotencyKey: string;
    expectedVersion: number; payloadDigest: string; ipHash: string; requestId: string; now: Date }>) {
    return this.database.transaction(async (client) => {
      const row = await this.getForSubject(client,input.subjectId,input.inquiryId,true);
      if (!row) return { status: 'not_found' as const };
      if (row.cancel_idempotency_key) return row.cancel_idempotency_key === input.idempotencyKey
        && row.cancel_payload_digest === input.payloadDigest
        ? { status: 'replayed' as const, inquiry: inquiry(row) } : { status: 'conflict' as const };
      if(row.version!==input.expectedVersion)return{status:'version_conflict' as const,inquiry:inquiry(row)};
      if (!['submitted','awaiting_supplier','clarification_required'].includes(row.status)) return { status: 'invalid_state' as const };
      await client.query(`UPDATE resource_inquiries SET status='user_cancelled',cancel_idempotency_key=$2,
        cancel_payload_digest=$3,cancelled_at=$4,version=version+1 WHERE id=$1`, [input.inquiryId,input.idempotencyKey,input.payloadDigest,input.now]);
      await this.audit(client,input.userId,'RESOURCE_INQUIRY_CANCELLED',input.inquiryId,input.requestId,input.ipHash,
        input.payloadDigest,{ subjectId:input.subjectId,status:'user_cancelled' });
      await this.outbox(client,'resource_inquiry.cancelled',input.inquiryId,
        { inquiryId:input.inquiryId,subjectId:input.subjectId,status:'user_cancelled' });
      const updated = await this.getForSubject(client,input.subjectId,input.inquiryId);
      return { status:'updated' as const,inquiry:inquiry(updated!) };
    });
  }

  async clarify(input: Readonly<{ id: string; subjectId: string; userId: string; inquiryId: string; message: string;
    expectedVersion: number; idempotencyKey: string; payloadDigest: string; ipHash: string; requestId: string; now: Date }>) {
    return this.database.transaction(async (client) => {
      const scope=`resource_inquiry.clarify:${input.inquiryId}`,claim=await this.claimIdempotency(client,input.userId,scope,
        input.idempotencyKey,input.payloadDigest,input.now);if(claim==='conflict')return{status:'conflict' as const};
      const existing = await client.query<ClarificationRow>(`SELECT id,message,message_kind,created_at,payload_digest
        FROM resource_inquiry_clarifications WHERE subject_id=$1 AND inquiry_id=$2 AND idempotency_key=$3 FOR UPDATE`,
      [input.subjectId,input.inquiryId,input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].payload_digest !== input.payloadDigest){await this.releaseIdempotency(client,input.userId,scope,
          input.idempotencyKey);return { status:'conflict' as const };}
        const current = await this.getForSubject(client,input.subjectId,input.inquiryId);
        await this.completeIdempotency(client,input.userId,scope,input.idempotencyKey,{inquiryId:input.inquiryId,
          clarificationId:existing.rows[0].id});
        return { status:'replayed' as const,inquiry:inquiry(current!),clarification:clarification(existing.rows[0]) };
      }
      const current = await this.getForSubject(client,input.subjectId,input.inquiryId,true);
      if (!current){await this.releaseIdempotency(client,input.userId,scope,input.idempotencyKey);return { status:'not_found' as const };}
      if(current.version!==input.expectedVersion){await this.releaseIdempotency(client,input.userId,scope,input.idempotencyKey);return{status:'version_conflict' as const,inquiry:inquiry(current)};}
      if (current.status !== 'clarification_required'){await this.releaseIdempotency(client,input.userId,scope,input.idempotencyKey);return { status:'invalid_state' as const };}
      const inserted = await client.query<ClarificationRow>(`INSERT INTO resource_inquiry_clarifications(
        id,inquiry_id,subject_id,author_user_id,message,idempotency_key,payload_digest,created_at,
        author_kind,author_subject_id,message_kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'buyer',$3,'buyer_response') RETURNING id,message,message_kind,created_at`,
      [input.id,input.inquiryId,input.subjectId,input.userId,input.message,input.idempotencyKey,input.payloadDigest,input.now]);
      await client.query(`UPDATE resource_inquiries SET status='awaiting_supplier',version=version+1 WHERE id=$1`, [input.inquiryId]);
      await this.audit(client,input.userId,'RESOURCE_INQUIRY_CLARIFIED',input.inquiryId,input.requestId,input.ipHash,
        input.payloadDigest,{ subjectId:input.subjectId,status:'awaiting_supplier',clarificationId:input.id });
      await this.outbox(client,'resource_inquiry.clarified',input.inquiryId,
        { inquiryId:input.inquiryId,subjectId:input.subjectId,status:'awaiting_supplier',clarificationId:input.id });
      await this.completeIdempotency(client,input.userId,scope,input.idempotencyKey,{inquiryId:input.inquiryId,
        clarificationId:input.id});
      const updated = await this.getForSubject(client,input.subjectId,input.inquiryId);
      return { status:'created' as const,inquiry:inquiry(updated!),clarification:clarification(inserted.rows[0]!) };
    });
  }

  private async listByScope(scopeId:string,input:Readonly<{status?:InquiryStatus;assignment?:'assigned'|'unassigned';
    cursor:ListingCursor|null;limit:number}>,scope:'operator'|'supplier'){
    const values:unknown[]=[];const where:string[]=[];const parameter=(value:unknown)=>{values.push(value);return`$${values.length}`;};
    if(scope==='supplier')where.push(`i.supplier_subject_id=${parameter(scopeId)}`);
    if(input.status)where.push(`i.status=${parameter(input.status)}`);
    if(input.assignment)where.push(input.assignment==='assigned'?'i.supplier_subject_id IS NOT NULL':'i.supplier_subject_id IS NULL');
    if(input.cursor){const createdAt=parameter(input.cursor.createdAt),id=parameter(input.cursor.id);
      where.push(`(i.created_at,i.id)<(${createdAt}::timestamptz,${id}::uuid)`);}
    const limit=parameter(input.limit);const result=await this.database.query<InquiryRow>(`SELECT ${inquirySelect}
      FROM resource_inquiries i LEFT JOIN candidate_resources c ON c.id=i.candidate_id
      ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY i.created_at DESC,i.id DESC LIMIT ${limit}`,values);
    return result.rows.map(inquiry);
  }

  private async actionReplay(client:PoolClient,actorId:string,inquiryId:string,action:string,key:string,digest:string){
    const found=await client.query<{payload_digest:string}>(`SELECT payload_digest FROM resource_inquiry_actions
      WHERE actor_user_id=$1 AND inquiry_id=$2 AND action=$3 AND idempotency_key=$4 FOR UPDATE`,
    [actorId,inquiryId,action,key]);if(!found.rows[0])return null;
    if(found.rows[0].payload_digest!==digest)return{status:'conflict' as const};
    const current=await this.getAny(client,inquiryId);return current?{status:'replayed' as const,inquiry:inquiry(current)}:{status:'not_found' as const};
  }

  private async claimIdempotency(client:PoolClient,actorId:string,scope:string,key:string,digest:string,now:Date){
    const result=await client.query<{payload_hash:string;state:'processing'|'completed'|'failed'}>(`INSERT INTO idempotency_records(
      id,actor_id,scope,idempotency_key,payload_hash,state,expires_at,created_at,updated_at)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,'processing',$5::timestamptz+interval '24 hours',$5,$5)
      ON CONFLICT(actor_id,scope,idempotency_key) DO UPDATE SET updated_at=idempotency_records.updated_at
      RETURNING payload_hash,state`,[actorId,scope,key,digest,now]);
    const row=result.rows[0]!;return row.payload_hash===digest?(row.state==='completed'?'replayed' as const:'claimed' as const):'conflict' as const;
  }

  private completeIdempotency(client:PoolClient,actorId:string,scope:string,key:string,response:Record<string,unknown>){
    return client.query(`UPDATE idempotency_records SET state='completed',response_status=200,response_body=$4::jsonb,
      updated_at=now() WHERE actor_id=$1 AND scope=$2 AND idempotency_key=$3`,[actorId,scope,key,JSON.stringify(response)]);
  }

  private releaseIdempotency(client:PoolClient,actorId:string,scope:string,key:string){return client.query(
    `DELETE FROM idempotency_records WHERE actor_id=$1 AND scope=$2 AND idempotency_key=$3 AND state='processing'`,
    [actorId,scope,key]);}

  private recordAction(client:PoolClient,input:Readonly<{inquiryId:string;actorId:string;actorSubjectId:string|null;
    action:string;idempotencyKey:string;payloadDigest:string;fromStatus:string;toStatus:string;resultingVersion:number}>){
    return client.query(`INSERT INTO resource_inquiry_actions(id,inquiry_id,actor_user_id,actor_subject_id,action,
      idempotency_key,payload_digest,from_status,to_status,resulting_version)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9)`,[input.inquiryId,input.actorId,input.actorSubjectId,input.action,
        input.idempotencyKey,input.payloadDigest,input.fromStatus,input.toStatus,input.resultingVersion]);
  }

  private transitionRule(action:'request_clarification'|'decline'|'confirm_capacity'|'expire'|'submit_audit',
    status:InquiryStatus,actorKind:'operator'|'provider',now:Date,confirmBy:Date){
    if(action==='request_clarification'&&['awaiting_supplier'].includes(status))return{to:'clarification_required' as const,
      audit:'RESOURCE_INQUIRY_CLARIFICATION_REQUESTED',topic:'resource_inquiry.clarification_requested'};
    if(action==='decline'&&actorKind==='provider'&&['awaiting_supplier','clarification_required'].includes(status))return{
      to:'supplier_declined' as const,audit:'RESOURCE_INQUIRY_DECLINED',topic:'resource_inquiry.declined'};
    if(action==='confirm_capacity'&&actorKind==='provider'&&status==='awaiting_supplier')return{to:'capacity_confirmed' as const,
      audit:'RESOURCE_INQUIRY_CAPACITY_CONFIRMED',topic:'resource_inquiry.capacity_confirmed'};
    if(action==='submit_audit'&&actorKind==='operator'&&status==='capacity_confirmed')return{to:'audit_pending' as const,
      audit:'RESOURCE_INQUIRY_AUDIT_SUBMITTED',topic:'resource_inquiry.audit_pending'};
    if(action==='expire'&&actorKind==='operator'&&confirmBy<=now&&['submitted','awaiting_supplier','clarification_required'].includes(status))return{
      to:'inquiry_expired' as const,audit:'RESOURCE_INQUIRY_EXPIRED',topic:'resource_inquiry.expired'};
    return null;
  }

  private async findByRequest(client: PoolClient, subjectId: string, key: string) {
    const result = await client.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      LEFT JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.subject_id=$1 AND i.client_request_id=$2 FOR UPDATE OF i`,
    [subjectId,key]);
    return result.rows[0] ?? null;
  }

  private async getForSubject(client: PoolClient, subjectId: string, id: string, lock = false) {
    const result = await client.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      LEFT JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.subject_id=$1 AND i.id=$2${lock ? ' FOR UPDATE OF i' : ''}`,
    [subjectId,id]);
    return result.rows[0] ?? null;
  }

  private async getAny(client:PoolClient,id:string,lock=false){const result=await client.query<InquiryRow>(`SELECT ${inquirySelect}
    FROM resource_inquiries i LEFT JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.id=$1${lock?' FOR UPDATE OF i':''}`,[id]);
    return result.rows[0]??null;}

  private audit(client: PoolClient,userId:string|null,action:string,id:string,requestId:string,ipHash:string|null,
    payloadDigest:string,metadata:Record<string,unknown>,actorKind:'user'|'operator'|'system'|'provider'='user') {
    return client.query(`INSERT INTO audit_events(id,actor_id,actor_kind,action,entity_type,entity_id,request_id,ip_hash,
      payload_digest,metadata) VALUES(gen_random_uuid(),$1,$2,$3,'RESOURCE_INQUIRY',$4,$5,$6,$7,$8::jsonb)`,
    [userId,actorKind,action,id,requestId,ipHash,payloadDigest,JSON.stringify(metadata)]);
  }

  private outbox(client: PoolClient,topic:string,id:string,payload:Record<string,unknown>) {
    return client.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,payload)
      VALUES(gen_random_uuid(),$1,'RESOURCE_INQUIRY',$2,$3::jsonb)`, [topic,id,JSON.stringify(payload)]);
  }
}
