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
  starts_at: Date; ends_at: Date; time_zone: string; confirm_by: Date; gpu_count: number; billing_mode: InquiryBillingMode;
  allow_substitutes: boolean; max_credit_micros: string; use_case: InquiryUseCase; description: string;
  environment: InquiryEnvironment; network: InquiryNetwork; storage_gib: number; data_region: string;
  terms_version: string; privacy_version: string; inquiry_version: string; accepted_at: Date;
  supplier_subject_id: string | null; cancelled_at: Date | null; capacity_confirmed_at: Date | null;
  expired_at: Date | null; status_message: string | null; version: number; created_at: Date; updated_at: Date;
  candidate_id: string; model: CatalogCandidate['model']; card_type: string; wide_region: string; modes: string[];
  candidate_status: 'inquiry_required'; source_observed_at: Date; verified_at: Date | null;
  candidate_supplier_subject_id: string | null; candidate_created_at: Date;
  client_request_id: string; payload_digest: string; cancel_idempotency_key: string | null; cancel_payload_digest: string | null;
};

type ClarificationRow = QueryResultRow & { id: string; message: string;
  message_kind: InquiryClarification['kind']; created_at: Date; payload_digest?: string };

const inquirySelect = `i.id,i.inquiry_number,i.subject_id,i.requested_by_user_id,i.status,i.starts_at,i.ends_at,
  i.time_zone,i.confirm_by,i.gpu_count,i.billing_mode,i.allow_substitutes,i.max_credit_micros::text,
  i.use_case,i.description,i.environment,i.network,i.storage_gib,i.data_region,i.terms_version,i.privacy_version,
  i.inquiry_version,i.created_at AS accepted_at,i.supplier_subject_id,i.cancelled_at,i.capacity_confirmed_at,
  i.expired_at,i.status_message,i.version,i.created_at,i.updated_at,i.client_request_id,
  i.payload_digest,i.cancel_idempotency_key,i.cancel_payload_digest,c.id AS candidate_id,c.model,c.card_type,
  c.wide_region,c.modes,c.status AS candidate_status,c.source_observed_at,c.verified_at,
  c.supplier_subject_id AS candidate_supplier_subject_id,c.created_at AS candidate_created_at`;

function candidate(row: CandidateRow | InquiryRow): CatalogCandidate {
  return { id: 'candidate_id' in row ? row.candidate_id : row.id, model: row.model, cardType: row.card_type,
    region: row.wide_region, modes: row.modes as InquiryBillingMode[],
    status: 'candidate_status' in row ? row.candidate_status : row.status as 'inquiry_required',
    sourceObservedAt: new Date(row.source_observed_at), verifiedAt: row.verified_at ? new Date(row.verified_at) : null,
    supplierSubjectId: 'candidate_supplier_subject_id' in row ? row.candidate_supplier_subject_id : row.supplier_subject_id,
    createdAt: new Date('candidate_created_at' in row ? row.candidate_created_at : row.created_at) };
}

function inquiry(row: InquiryRow): InquiryRecord {
  return { id: row.id, inquiryNumber: row.inquiry_number, subjectId: row.subject_id,
    requestedByUserId: row.requested_by_user_id, supplierSubjectId: row.supplier_subject_id,
    candidate: candidate(row), status: row.status,
    startsAt: new Date(row.starts_at), endsAt: new Date(row.ends_at), timeZone: row.time_zone,
    confirmBy: new Date(row.confirm_by), gpuCount: Number(row.gpu_count), billingMode: row.billing_mode,
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

  async listCandidates(filters: CandidateFilters) {
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
    return rows.rows.map(candidate);
  }

  async getCandidate(id: string) {
    const result = await this.database.query<CandidateRow>(`SELECT id,model,card_type,wide_region,modes,status,
      source_observed_at,verified_at,supplier_subject_id,created_at FROM candidate_resources WHERE id=$1 AND active=true`, [id]);
    return result.rows[0] ? candidate(result.rows[0]) : null;
  }

  async create(input: Readonly<{
    id: string; inquiryNumber: string; subjectId: string; userId: string; candidateId: string; startsAt: Date; endsAt: Date;
    timeZone: string; confirmBy: Date; gpuCount: number; billingMode: InquiryBillingMode; allowSubstitutes: boolean;
    maxCreditMicros: bigint; useCase: InquiryUseCase; description: string; environment: InquiryEnvironment;
    network: InquiryNetwork; storageGiB: number; dataRegion: string; termsVersion: string; privacyVersion: string;
    inquiryVersion: string; idempotencyKey: string; payloadDigest: string; ipHash: string; requestId: string; now: Date;
  }>): Promise<Readonly<{ status: 'created' | 'replayed'; inquiry: InquiryRecord }>
    | Readonly<{ status: 'conflict' | 'candidate_not_found' | 'mode_unavailable' }>> {
    return this.database.transaction(async (client) => {
      const claim=await this.claimIdempotency(client,input.userId,`resource_inquiry.create:${input.subjectId}`,
        input.idempotencyKey,input.payloadDigest,input.now);
      if(claim==='conflict')return{status:'conflict' as const};
      const existing = await this.findByRequest(client, input.subjectId, input.idempotencyKey);
      if (existing){if(existing.payload_digest!==input.payloadDigest){await this.releaseIdempotency(client,input.userId,
          `resource_inquiry.create:${input.subjectId}`,input.idempotencyKey);return{status:'conflict' as const};}
        await this.completeIdempotency(client,input.userId,`resource_inquiry.create:${input.subjectId}`,
          input.idempotencyKey,{inquiryId:existing.id});return{status:'replayed' as const,inquiry:inquiry(existing)};}
      const candidateResult = await client.query<CandidateRow>(`SELECT id,model,card_type,wide_region,modes,status,
        source_observed_at,verified_at,supplier_subject_id,created_at FROM candidate_resources WHERE id=$1 AND active=true FOR SHARE`, [input.candidateId]);
      const selected = candidateResult.rows[0];
      if (!selected){await this.releaseIdempotency(client,input.userId,`resource_inquiry.create:${input.subjectId}`,input.idempotencyKey);
        return { status: 'candidate_not_found' as const };}
      if (!selected.modes.includes(input.billingMode)){await this.releaseIdempotency(client,input.userId,
        `resource_inquiry.create:${input.subjectId}`,input.idempotencyKey);return { status: 'mode_unavailable' as const };}
      await client.query(`INSERT INTO resource_inquiries(id,inquiry_number,subject_id,requested_by_user_id,candidate_id,
        status,starts_at,ends_at,time_zone,confirm_by,gpu_count,billing_mode,allow_substitutes,max_credit_micros,
        use_case,description,environment,network,storage_gib,data_region,terms_version,privacy_version,inquiry_version,
        client_request_id,payload_digest,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'submitted',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25)`,
      [input.id,input.inquiryNumber,input.subjectId,input.userId,input.candidateId,input.startsAt,input.endsAt,input.timeZone,
        input.confirmBy,input.gpuCount,input.billingMode,input.allowSubstitutes,input.maxCreditMicros.toString(),input.useCase,
        input.description,input.environment,input.network,input.storageGiB,input.dataRegion,input.termsVersion,input.privacyVersion,
        input.inquiryVersion,input.idempotencyKey,input.payloadDigest,input.now]);
      for (const [kind, version] of [['terms',input.termsVersion],['privacy',input.privacyVersion],['inquiry',input.inquiryVersion]] as const) {
        await client.query(`INSERT INTO resource_inquiry_terms_acceptances(id,inquiry_id,subject_id,user_id,document_kind,
          version,ip_hash,accepted_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
        [input.id,input.subjectId,input.userId,kind,version,input.ipHash,input.now]);
      }
      await this.audit(client, input.userId, 'RESOURCE_INQUIRY_SUBMITTED', input.id, input.requestId, input.ipHash,
        input.payloadDigest, { subjectId: input.subjectId, candidateId: input.candidateId, status: 'submitted' });
      await this.outbox(client, 'resource_inquiry.submitted', input.id, { inquiryId: input.id, subjectId: input.subjectId, status: 'submitted' });
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
      JOIN candidate_resources c ON c.id=i.candidate_id WHERE ${where.join(' AND ')}
      ORDER BY i.created_at DESC,i.id DESC LIMIT ${limit}`, values);
    return rows.rows.map(inquiry);
  }

  async get(subjectId: string, id: string) {
    const result = await this.database.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.subject_id=$1 AND i.id=$2`, [subjectId,id]);
    return result.rows[0] ? inquiry(result.rows[0]) : null;
  }

  async listOperator(input: Readonly<{ status?: InquiryStatus; assignment?: 'assigned' | 'unassigned';
    cursor: ListingCursor | null; limit: number }>) {
    return this.listByScope('', input, 'operator');
  }

  async getOperator(id: string) {
    const result = await this.database.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.id=$1`, [id]);
    return result.rows[0] ? inquiry(result.rows[0]) : null;
  }

  async listSupplier(supplierSubjectId: string, input: Readonly<{ status?: InquiryStatus;
    cursor: ListingCursor | null; limit: number }>) {
    return this.listByScope(supplierSubjectId, input, 'supplier');
  }

  async getSupplier(supplierSubjectId: string, id: string) {
    const result = await this.database.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.supplier_subject_id=$1 AND i.id=$2`,
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
      const supplier=await client.query(`SELECT 1 FROM supplier_profiles p JOIN trading_subjects s ON s.id=p.subject_id
        WHERE p.subject_id=$1 AND p.status='approved' AND s.status='active' FOR SHARE`,[input.supplierSubjectId]);
      if(!supplier.rowCount){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'invalid_supplier' as const};}
      const claimed=await client.query<{supplier_subject_id:string|null}>(`SELECT supplier_subject_id FROM candidate_resources
        WHERE id=$1 FOR UPDATE`,[current.candidate_id]);
      const bound=claimed.rows[0]?.supplier_subject_id;
      if(bound&&bound!==input.supplierSubjectId){await this.releaseIdempotency(client,input.actorId,scope,input.idempotencyKey);return{status:'assignment_conflict' as const};}
      if(!bound)await client.query(`UPDATE candidate_resources SET supplier_subject_id=$2,claimed_at=$3,claimed_by=$4
        WHERE id=$1`,[current.candidate_id,input.supplierSubjectId,input.now,input.actorId]);
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
      JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.confirm_by<=$1
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
      FROM resource_inquiries i JOIN candidate_resources c ON c.id=i.candidate_id
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
      JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.subject_id=$1 AND i.client_request_id=$2 FOR UPDATE OF i`,
    [subjectId,key]);
    return result.rows[0] ?? null;
  }

  private async getForSubject(client: PoolClient, subjectId: string, id: string, lock = false) {
    const result = await client.query<InquiryRow>(`SELECT ${inquirySelect} FROM resource_inquiries i
      JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.subject_id=$1 AND i.id=$2${lock ? ' FOR UPDATE OF i' : ''}`,
    [subjectId,id]);
    return result.rows[0] ?? null;
  }

  private async getAny(client:PoolClient,id:string,lock=false){const result=await client.query<InquiryRow>(`SELECT ${inquirySelect}
    FROM resource_inquiries i JOIN candidate_resources c ON c.id=i.candidate_id WHERE i.id=$1${lock?' FOR UPDATE OF i':''}`,[id]);
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
