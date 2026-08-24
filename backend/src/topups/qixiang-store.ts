import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { QixiangCheckoutCiphertext } from '../payment/qixiang-checkout-crypto.js';
import type {
  QixiangCreatePreparation, QixiangCursor, QixiangMutationResult, QixiangQueryAttempt,
  QixiangQueryProcessingResult, QixiangTopupRecord, QixiangTopupStatus,
} from './qixiang-types.js';

type TopupRow = QueryResultRow & {
  id: string; subject_id: string; created_by_user_id: string; client_request_id: string; payload_digest: string;
  provider_reference: string; provider_payment_id: string | null; provider_transaction_id: string | null;
  status: QixiangTopupStatus; version: number; amount_cents: string; card_hour_cents: string; credit_micros: string;
  checkout_cipher_version: number | null; checkout_key_id: string | null; checkout_nonce: Uint8Array | null;
  checkout_ciphertext: Uint8Array | null; checkout_auth_tag: Uint8Array | null; expires_at: Date;
  entitlement_expires_at: Date | null; succeeded_at: Date | null; last_reconciled_at: Date | null;
  next_reconcile_at: Date; reconciliation_attempts: number; reconciliation_dead_lettered_at: Date | null;
  created_at: Date; updated_at: Date;
};

const columns = `id,subject_id,created_by_user_id,client_request_id,payload_digest,provider_reference,
  provider_payment_id,provider_transaction_id,status,version,amount_cents::text,card_hour_cents::text,
  credit_micros::text,checkout_cipher_version,checkout_key_id,checkout_nonce,checkout_ciphertext,
  checkout_auth_tag,expires_at,entitlement_expires_at,succeeded_at,last_reconciled_at,next_reconcile_at,
  reconciliation_attempts,reconciliation_dead_lettered_at,created_at,updated_at`;

function date(value: Date | string) { return new Date(value); }
function map(row: TopupRow): QixiangTopupRecord {
  const encrypted = row.checkout_cipher_version === null ? null : {
    cipherVersion: row.checkout_cipher_version as 1,
    keyId: row.checkout_key_id!, nonce: Buffer.from(row.checkout_nonce!),
    ciphertext: Buffer.from(row.checkout_ciphertext!), authTag: Buffer.from(row.checkout_auth_tag!),
  };
  return {
    id: row.id, subjectId: row.subject_id, createdByUserId: row.created_by_user_id,
    clientRequestId: row.client_request_id, payloadDigest: row.payload_digest,
    providerReference: row.provider_reference, providerPaymentId: row.provider_payment_id,
    providerTransactionId: row.provider_transaction_id, status: row.status, version: row.version,
    amountCents: Number(row.amount_cents), cardHourCents: Number(row.card_hour_cents),
    creditMicros: BigInt(row.credit_micros), checkout: encrypted,
    checkoutExpiresAt: date(row.expires_at), entitlementExpiresAt: row.entitlement_expires_at ? date(row.entitlement_expires_at) : null,
    succeededAt: row.succeeded_at ? date(row.succeeded_at) : null,
    lastCheckedAt: row.last_reconciled_at ? date(row.last_reconciled_at) : null,
    nextReconcileAt: date(row.next_reconcile_at), reconciliationAttempts: row.reconciliation_attempts,
    reconciliationDeadLetteredAt: row.reconciliation_dead_lettered_at ? date(row.reconciliation_dead_lettered_at) : null,
    createdAt: date(row.created_at), updatedAt: date(row.updated_at),
  };
}

type MutationContext = Readonly<{
  actorId: string; requestId: string; ipHash: string; payloadDigest: string; now: Date;
}>;

export class PostgresQixiangTopupStore {
  constructor(private readonly database: Database) {}

  async recordQueryWorkerHealth(input: Readonly<{ instanceId:string; schedulerSucceeded:boolean;
    providerOutcome:'success'|'failure'|'none'; consecutiveFailures:number; errorCode:string|null }>) {
    const action=input.schedulerSucceeded?'QIXIANG_QUERY_WORKER_HEARTBEAT':'QIXIANG_QUERY_WORKER_FAILURE';
    const payloadDigest=createHash('sha256').update(
      `qixiang-query-worker:${input.instanceId}:${action}:${input.providerOutcome}:${randomUUID()}`).digest('hex');
    await this.database.query(`INSERT INTO audit_events(id,actor_id,actor_kind,action,entity_type,entity_id,
      request_id,ip_hash,payload_digest,metadata,created_at)
      VALUES($1,NULL,'system',$2,'QIXIANG_QUERY_WORKER','active-query',$3,NULL,
        $4,$5::jsonb,clock_timestamp())`,[
      randomUUID(),action,`qixiang-query-worker:${input.instanceId}`,payloadDigest,JSON.stringify({
        instanceId:input.instanceId,consecutiveFailures:input.consecutiveFailures,
        providerOutcome:input.providerOutcome,errorCode:input.errorCode,
      }),
    ]);
  }

  async queryWorkerHealth(input:Readonly<{staleAfterMs:number}>) {
    const result=await this.database.query<{healthy_instances:string;last_success_at:Date|null;
      observed_instances:string;provider_outcomes:string[]}>(`WITH worker_events AS(
        SELECT id,action,created_at,metadata FROM audit_events
        WHERE entity_type='QIXIANG_QUERY_WORKER' AND entity_id='active-query'
          AND action IN('QIXIANG_QUERY_WORKER_HEARTBEAT','QIXIANG_QUERY_WORKER_FAILURE')
          AND jsonb_typeof(metadata)='object' AND metadata?'instanceId'
          AND created_at<=clock_timestamp()+interval '5 seconds'),latest AS(
        SELECT DISTINCT ON(metadata->>'instanceId') action,created_at,metadata
        FROM worker_events
        ORDER BY metadata->>'instanceId',created_at DESC,id DESC)
      SELECT count(*)::text observed_instances,
      count(*)FILTER(WHERE action='QIXIANG_QUERY_WORKER_HEARTBEAT'
          AND created_at>=clock_timestamp()-($1::bigint*interval '1 millisecond'))::text healthy_instances,
        max(created_at)FILTER(WHERE action='QIXIANG_QUERY_WORKER_HEARTBEAT') last_success_at,
        ARRAY(SELECT metadata->>'providerOutcome' FROM worker_events
          WHERE metadata->>'providerOutcome' IN('success','failure')
          ORDER BY created_at DESC,id DESC LIMIT 100) provider_outcomes FROM latest`,[
      input.staleAfterMs,
    ]);const row=result.rows[0];return{healthyInstances:Number(row?.healthy_instances??0),
      observedInstances:Number(row?.observed_instances??0),lastSuccessAt:row?.last_success_at?date(row.last_success_at):null,
      providerConsecutiveFailures:(row?.provider_outcomes??[]).findIndex((outcome)=>outcome==='success')<0
        ?(row?.provider_outcomes??[]).filter((outcome)=>outcome==='failure').length
        :(row?.provider_outcomes??[]).slice(0,(row?.provider_outcomes??[]).findIndex((outcome)=>outcome==='success'))
          .filter((outcome)=>outcome==='failure').length};
  }

  async prepare(input: Readonly<{
    id: string; subjectId: string; userId: string; idempotencyKey: string; payloadDigest: string;
    providerReference: string; amountCents: number; cardHourCents: number; creditMicros: bigint;
    checkoutExpiresAt: Date; context: Omit<MutationContext, 'actorId' | 'payloadDigest'>;
  }>): Promise<QixiangCreatePreparation> {
    return this.database.transaction(async (client) => {
      const claim = await this.claim(client, input.userId, 'QIXIANG_TOPUP_CREATE', input.idempotencyKey,
        input.payloadDigest, input.context.now);
      if (claim === 'conflict') return { status: 'conflict' };
      const prior = await this.findByClientRequest(client, input.subjectId, input.idempotencyKey);
      if (claim === 'replayed') {
        if (!prior || prior.payload_digest !== input.payloadDigest) return { status: 'conflict' };
        return { status: 'replayed', topup: map(prior) };
      }
      if (prior) {
        if (prior.payload_digest !== input.payloadDigest) return { status: 'conflict' };
        await this.complete(client, input.userId, 'QIXIANG_TOPUP_CREATE', input.idempotencyKey, 200,
          { topupId: prior.id });
        return { status: 'replayed', topup: map(prior) };
      }
      const inserted = await client.query<TopupRow>(`INSERT INTO kai_credit_topups(
        id,subject_id,created_by_user_id,client_request_id,payload_digest,provider,channel,provider_reference,
        amount_cents,currency,credit_micros,conversion_cny_micros_per_credit,status,expires_at,payment_rail,
        card_hour_cents,conversion_numerator,conversion_denominator,next_reconcile_at)
        VALUES($1,$2,$3,$4,$5,'qixiang','app',$6,$7,'CNY',$8,1002000,'created',$9,
          'qixiang_alipay',$10,1000,1002,$11) RETURNING ${columns}`, [
        input.id,input.subjectId,input.userId,input.idempotencyKey,input.payloadDigest,input.providerReference,
        input.amountCents,input.creditMicros.toString(),input.checkoutExpiresAt,input.cardHourCents,input.context.now,
      ]);
      const topup = map(inserted.rows[0]!);
      await this.audit(client, { actorId: input.userId, requestId: input.context.requestId,
        ipHash: input.context.ipHash, payloadDigest: input.payloadDigest, now: input.context.now },
      'QIXIANG_TOPUP_CREATED', topup, { status: topup.status, version: topup.version, amountCents: topup.amountCents });
      await this.outbox(client, 'qixiang.topup.created', topup,
        { topupId: topup.id, subjectId: topup.subjectId, status: topup.status, version: topup.version });
      await this.complete(client, input.userId, 'QIXIANG_TOPUP_CREATE', input.idempotencyKey, 201,
        { topupId: topup.id });
      return { status: 'created', topup };
    });
  }

  async startCreate(topupId: string, expectedVersion: number, deadline: Date, context: MutationContext) {
    return this.database.transaction(async (client) => {
      const result = await client.query<TopupRow>(`UPDATE kai_credit_topups SET status='verifying',
        next_reconcile_at=$3,last_reconciliation_error=NULL WHERE id=$1 AND provider='qixiang'
        AND status='created' AND version=$2 RETURNING ${columns}`, [topupId,expectedVersion,deadline]);
      const topup = result.rows[0] ? map(result.rows[0]) : null;
      if (!topup) return null;
      await this.audit(client,context,'QIXIANG_CREATE_REQUEST_STARTED',topup,
        { status:topup.status,version:topup.version });
      await this.outbox(client,'qixiang.topup.create_request_started',topup,
        {topupId:topup.id,subjectId:topup.subjectId,status:topup.status,version:topup.version});
      return topup;
    });
  }

  async saveCheckout(topupId:string,expectedVersion:number,providerPaymentId:string,
  checkout:QixiangCheckoutCiphertext,context:MutationContext){
    return this.createOutcome(topupId,expectedVersion,context,`status='pending',provider_payment_id=$4,
      checkout_cipher_version=$5,checkout_key_id=$6,checkout_nonce=$7,checkout_ciphertext=$8,checkout_auth_tag=$9,
      next_reconcile_at=$3,last_reconciliation_error=NULL`,[
      providerPaymentId,checkout.cipherVersion,checkout.keyId,checkout.nonce,checkout.ciphertext,checkout.authTag,
    ],'QIXIANG_CREATE_CHECKOUT_READY','qixiang.topup.checkout_ready');
  }

  async recordCreateUnknown(topupId:string,expectedVersion:number,nextAttempt:Date,context:MutationContext){
    return this.createOutcome(topupId,expectedVersion,context,`status='verifying',next_reconcile_at=$3,
      last_reconciliation_error='CREATE_OUTCOME_UNKNOWN'`,[],
    'QIXIANG_CREATE_OUTCOME_UNKNOWN','qixiang.topup.create_outcome_unknown');
  }

  async recordCreateRejected(topupId:string,expectedVersion:number,context:MutationContext){
    return this.createOutcome(topupId,expectedVersion,context,`status='failed',next_reconcile_at=$3,
      last_reconciliation_error='PROVIDER_REJECTED'`,[],
    'QIXIANG_CREATE_REJECTED','qixiang.topup.create_rejected');
  }

  async recordGateClosed(topupId:string,expectedVersion:number,blockers:readonly string[],context:MutationContext){
    return this.createOutcome(topupId,expectedVersion,context,`status='created',next_reconcile_at=$3,
      last_reconciliation_error='GATE_CLOSED'`,[],
    'QIXIANG_CREATE_GATE_CLOSED','qixiang.topup.gate_closed',{gateBlockers:[...new Set(blockers)].slice(0,12)});
  }

  async recheck(input: Readonly<{ topupId:string; subjectId:string; userId:string; expectedVersion:number;
    idempotencyKey:string; payloadDigest:string; requestId:string; ipHash:string; now:Date }>):Promise<QixiangMutationResult>{
    return this.database.transaction(async(client)=>{
      const scope='QIXIANG_TOPUP_RECHECK';
      const claim=await this.claim(client,input.userId,scope,input.idempotencyKey,input.payloadDigest,input.now);
      if(claim==='conflict')return{status:'conflict'};
      const current=await client.query<TopupRow>(`SELECT ${columns} FROM kai_credit_topups WHERE id=$1
        AND subject_id=$2 AND provider='qixiang' FOR UPDATE`,[input.topupId,input.subjectId]);
      if(!current.rows[0]){await this.release(client,input.userId,scope,input.idempotencyKey);return{status:'not_found'};}
      if(claim==='replayed')return{status:'replayed',topup:map(current.rows[0])};
      if(current.rows[0].version!==input.expectedVersion){
        await this.release(client,input.userId,scope,input.idempotencyKey);return{status:'version_conflict'};
      }
      if(!['pending','verifying','expired','manual_review'].includes(current.rows[0].status)){
        await this.release(client,input.userId,scope,input.idempotencyKey);return{status:'version_conflict'};
      }
      const updated=await client.query<TopupRow>(`UPDATE kai_credit_topups SET status='verifying',
        next_reconcile_at=$3,last_reconciliation_error=NULL WHERE id=$1 AND version=$2 RETURNING ${columns}`,
      [input.topupId,input.expectedVersion,input.now]);
      if(!updated.rows[0]){await this.release(client,input.userId,scope,input.idempotencyKey);return{status:'version_conflict'};}
      const topup=map(updated.rows[0]);const context={actorId:input.userId,requestId:input.requestId,
        ipHash:input.ipHash,payloadDigest:input.payloadDigest,now:input.now};
      await this.audit(client,context,'QIXIANG_TOPUP_RECHECK_REQUESTED',topup,{status:topup.status,version:topup.version});
      await this.outbox(client,'qixiang.topup.query_requested',topup,
        {topupId:topup.id,subjectId:topup.subjectId,status:topup.status,version:topup.version});
      await this.complete(client,input.userId,scope,input.idempotencyKey,202,{topupId:topup.id});
      return{status:'updated',topup};
    });
  }

  async get(subjectId:string,topupId:string){
    const result=await this.database.query<TopupRow>(`SELECT ${columns} FROM kai_credit_topups
      WHERE id=$1 AND subject_id=$2 AND provider='qixiang'`,[topupId,subjectId]);
    return result.rows[0]?map(result.rows[0]):null;
  }

  async findByReference(providerReference:string){const result=await this.database.query<TopupRow>(`SELECT ${columns}
    FROM kai_credit_topups WHERE provider='qixiang' AND provider_reference=$1`,[providerReference]);
    return result.rows[0]?map(result.rows[0]):null;}

  async recordCallback(input:Readonly<{receiptKey:string;providerReference:string;providerTransactionId:string;
    paymentType:'alipay'|'wxpay';amountCents:number;payloadDigest:string;snapshotMatched:boolean;
    processingResult:'accepted'|'snapshot_mismatch'|'trade_conflict';requestId:string;ipHash:string;now:Date}>){
    return this.database.transaction(async(client)=>{
      const found=await client.query<TopupRow>(`SELECT ${columns} FROM kai_credit_topups WHERE provider='qixiang'
        AND provider_reference=$1 FOR UPDATE`,[input.providerReference]);let row=found.rows[0]??null;
      if(!row){const inserted=await client.query<{id:string}>(`INSERT INTO qixiang_payment_receipts(id,topup_id,
        source,receipt_key,provider_reference,trade_no,api_trade_no,provider_code,provider_status,trade_status,
        payment_type,amount_cents,signature_verified,snapshot_matched,payload_digest,processing_result,received_at)
        VALUES($1,NULL,'callback',$2,$3,$4,NULL,NULL,NULL,'TRADE_SUCCESS',$5,$6,true,false,$7,
          'unknown_reference',$8) ON CONFLICT(source,receipt_key) DO NOTHING RETURNING id`,[
        randomUUID(),input.receiptKey,input.providerReference,input.providerTransactionId,input.paymentType,
        input.amountCents,input.payloadDigest,input.now]);
        if(!inserted.rows[0])return{result:'duplicate' as const,topup:null};
        await client.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,payload)
          VALUES($1,'qixiang.callback.unknown_reference','QIXIANG_CALLBACK',$2,$3::jsonb)`,[
          randomUUID(),input.receiptKey,JSON.stringify({receiptKey:input.receiptKey,result:'unknown_reference'})]);
        return{result:'unknown_reference' as const,topup:null};}
      const duplicate=await client.query<{id:string}>(`SELECT id FROM qixiang_payment_receipts
        WHERE source='callback' AND receipt_key=$1`,[input.receiptKey]);
      if(duplicate.rows[0])return{result:'duplicate' as const,topup:null};
      let processing:'accepted'|'unknown_reference'|'snapshot_mismatch'|'trade_conflict'|'duplicate';
      if(row.status==='succeeded')processing='duplicate';
      else if(row.provider_payment_id!==null&&row.provider_payment_id!==input.providerTransactionId)processing='trade_conflict';
      else processing=input.snapshotMatched?input.processingResult:'snapshot_mismatch';
      if(row&&processing==='accepted')row=await this.toVerifying(client,row,input.now);
      if(row&&(processing==='snapshot_mismatch'||processing==='trade_conflict'))row=await this.toManualReview(client,row,input.now);
      await client.query(`INSERT INTO qixiang_payment_receipts(id,topup_id,source,receipt_key,provider_reference,
        trade_no,api_trade_no,provider_code,provider_status,trade_status,payment_type,amount_cents,
        signature_verified,snapshot_matched,payload_digest,processing_result,received_at)
        VALUES($1,$2,'callback',$3,$4,$5,NULL,NULL,NULL,'TRADE_SUCCESS',$6,$7,true,$8,$9,$10,$11)`,[
        randomUUID(),row?.id??null,input.receiptKey,input.providerReference,input.providerTransactionId,input.paymentType,
        input.amountCents,processing==='accepted',input.payloadDigest,processing,input.now,
      ]);
      {const topup=map(row);await this.auditProvider(client,input.requestId,input.ipHash,input.payloadDigest,
        processing==='accepted'?'QIXIANG_CALLBACK_QUERY_ENQUEUED':'QIXIANG_CALLBACK_RECORDED',topup,
        {status:topup.status,version:topup.version,result:processing});
        if(processing==='accepted')await this.outbox(client,'qixiang.topup.query_requested',topup,
          {topupId:topup.id,subjectId:topup.subjectId,status:topup.status,version:topup.version});
        else if(processing!=='duplicate')await this.outbox(client,'qixiang.topup.manual_review',topup,
          {topupId:topup.id,subjectId:topup.subjectId,status:topup.status,version:topup.version});
        return{result:processing,topup};}
    });
  }

  async claimQueries(input:Readonly<{now:Date;staleBefore:Date;limit:number;topupId?:string|null}>):Promise<QixiangQueryAttempt[]>{
    return this.database.transaction(async(client)=>{
      const candidates=await client.query<TopupRow>(`SELECT ${columns} FROM kai_credit_topups
        WHERE provider='qixiang' AND status IN('created','pending','verifying','expired')
        AND($4::uuid IS NULL OR id=$4::uuid)
        AND reconciliation_dead_lettered_at IS NULL AND next_reconcile_at<=$1
        AND(reconciliation_locked_at IS NULL OR reconciliation_locked_at<$2)
        ORDER BY next_reconcile_at,created_at,id LIMIT $3 FOR UPDATE SKIP LOCKED`,[
        input.now,input.staleBefore,input.limit,input.topupId??null,
      ]);const attempts:QixiangQueryAttempt[]=[];
      for(const current of candidates.rows){const attemptId=randomUUID();const updated=await client.query<TopupRow>(
        `UPDATE kai_credit_topups SET status='verifying',reconciliation_locked_at=$2,
          reconciliation_attempts=reconciliation_attempts+1,last_reconciliation_error=NULL
         WHERE id=$1 RETURNING ${columns}`,[current.id,input.now]);
        const topup=map(updated.rows[0]!);await client.query(`INSERT INTO audit_events(id,actor_id,actor_kind,action,
          entity_type,entity_id,request_id,ip_hash,payload_digest,metadata,created_at)
          VALUES($1,NULL,'system','QIXIANG_QUERY_ATTEMPT_STARTED','QIXIANG_TOPUP',$2,$3,NULL,$4,$5::jsonb,$6)`,[
          attemptId,topup.id,`qixiang-query:${attemptId}`,topup.payloadDigest,
          JSON.stringify({topupId:topup.id,subjectId:topup.subjectId,attemptId,status:topup.status,
            version:topup.version,attempt:topup.reconciliationAttempts}),input.now,
        ]);await this.outbox(client,'qixiang.topup.query_started',topup,{topupId:topup.id,
          subjectId:topup.subjectId,status:topup.status,version:topup.version,queryAttemptId:attemptId});
        attempts.push({attemptId,claimedAt:input.now,topup});}
      return attempts;
    });
  }

  async recordUnpaidQuery(input:Readonly<{attemptId:string;claimedAt:Date;topupId:string;payloadDigest:string;
    now:Date;nextAttemptAt:Date}>):Promise<QixiangQueryProcessingResult>{return this.database.transaction(async(client)=>{
    const current=await this.lockClaimedTopup(client,input.topupId,input.claimedAt);if(!current)return{status:'stale'};
    const duplicate=await client.query<{id:string}>(`SELECT id FROM qixiang_payment_receipts
      WHERE source='query' AND receipt_key=$1`,[`query:${input.attemptId}`]);
    if(duplicate.rows[0])return{status:'duplicate',topup:map(current)};
    await client.query(`INSERT INTO qixiang_payment_receipts(id,topup_id,source,receipt_key,provider_reference,
      trade_no,api_trade_no,provider_code,provider_status,trade_status,payment_type,amount_cents,
      signature_verified,snapshot_matched,payload_digest,processing_result,received_at)
      VALUES($1,$2,'query',$3,$4,NULL,NULL,1,0,NULL,'alipay',$5,false,true,$6,'accepted',$7)`,[
      randomUUID(),current.id,`query:${input.attemptId}`,current.provider_reference,current.amount_cents,
      input.payloadDigest,input.now,
    ]);const evidence=await client.query<{count:string;first:Date;last:Date}>(`SELECT count(*)::text count,
      min(received_at) first,max(received_at) last FROM qixiang_payment_receipts WHERE topup_id=$1
      AND source='query' AND provider_code=1 AND provider_status=0 AND payment_type='alipay'
      AND provider_reference=$2 AND amount_cents=$3 AND snapshot_matched=true AND processing_result='accepted'`,[
      current.id,current.provider_reference,current.amount_cents,
    ]);const count=Number(evidence.rows[0]!.count),first=date(evidence.rows[0]!.first),last=date(evidence.rows[0]!.last);
    const expires=date(current.expires_at);const shouldExpire=count>=2&&last.getTime()-first.getTime()>=30_000
      && input.now>=expires;const hasCheckout=current.provider_payment_id!==null&&current.checkout_cipher_version===1;
    const status:QixiangTopupStatus=shouldExpire?'expired':hasCheckout&&input.now<expires?'pending':'verifying';
    const updated=await client.query<TopupRow>(`UPDATE kai_credit_topups SET status=$2,
      unpaid_query_confirmations=$3,first_unpaid_query_at=$4,last_unpaid_query_at=$5,
      reconciliation_locked_at=NULL,last_reconciled_at=$6,last_provider_status='0',
      last_reconciliation_error=NULL,next_reconcile_at=$7 WHERE id=$1 RETURNING ${columns}`,[
      current.id,status,count,first,last,input.now,input.nextAttemptAt,
    ]);const topup=map(updated.rows[0]!);await this.auditSystem(client,'QIXIANG_QUERY_UNPAID_RECORDED',topup,
      input.attemptId,input.payloadDigest,input.now,{status:topup.status,version:topup.version,
        unpaidQueryConfirmations:count});await this.outbox(client,status==='expired'?'qixiang.topup.expired':'qixiang.topup.query_unpaid',
      topup,{topupId:topup.id,subjectId:topup.subjectId,status:topup.status,version:topup.version,
        queryAttemptId:input.attemptId});return{status:status==='expired'?'expired':status==='pending'?'pending':'verifying',topup};
  });}

  async recordQueryFailure(input:Readonly<{attemptId:string;claimedAt:Date;topupId:string;payloadDigest:string;
    errorCode:string;providerRejected:boolean;manualReview:boolean;now:Date;nextAttemptAt:Date}>)
  :Promise<QixiangQueryProcessingResult>{return this.database.transaction(async(client)=>{
    const current=await this.lockClaimedTopup(client,input.topupId,input.claimedAt);if(!current)return{status:'stale'};
    if(input.providerRejected||input.manualReview)await client.query(`INSERT INTO qixiang_payment_receipts(
      id,topup_id,source,receipt_key,provider_reference,trade_no,api_trade_no,provider_code,provider_status,
      trade_status,payment_type,amount_cents,signature_verified,snapshot_matched,payload_digest,
      processing_result,received_at)VALUES($1,$2,'query',$3,$4,NULL,NULL,NULL,NULL,NULL,'alipay',$5,
        false,false,$6,$7,$8) ON CONFLICT(source,receipt_key) DO NOTHING`,[
      randomUUID(),current.id,`query:${input.attemptId}`,current.provider_reference,current.amount_cents,
      input.payloadDigest,input.providerRejected?'provider_rejected':'manual_review',input.now,
    ]);const manual=input.manualReview||current.reconciliation_attempts>=24;
    const updated=await client.query<TopupRow>(`UPDATE kai_credit_topups SET status=$2,
      reconciliation_locked_at=NULL,last_reconciled_at=$3::timestamptz,last_provider_status=$4,
      last_reconciliation_error=$4,next_reconcile_at=$5,
      reconciliation_dead_lettered_at=CASE WHEN $6 THEN $3::timestamptz ELSE NULL END WHERE id=$1 RETURNING ${columns}`,[
      current.id,manual?'manual_review':'verifying',input.now,input.errorCode.slice(0,80),input.nextAttemptAt,manual,
    ]);const topup=map(updated.rows[0]!);await this.auditSystem(client,manual?'QIXIANG_QUERY_MANUAL_REVIEW':'QIXIANG_QUERY_RETRY_SCHEDULED',
      topup,input.attemptId,input.payloadDigest,input.now,{status:topup.status,version:topup.version,errorCode:input.errorCode});
    await this.outbox(client,manual?'qixiang.topup.manual_review':'qixiang.topup.query_retry_scheduled',topup,
      {topupId:topup.id,subjectId:topup.subjectId,status:topup.status,version:topup.version,
        queryAttemptId:input.attemptId,errorCode:input.errorCode});return{status:manual?'manual_review':'pending',topup};
  });}

  async recordPaidQuery(input:Readonly<{attemptId:string;claimedAt:Date;topupId:string;
    providerTransactionId:string;apiTradeNo:string;queryPayloadDigest:string;grantPayloadDigest:string;
    now:Date}>):Promise<QixiangQueryProcessingResult>{return this.database.transaction(async(client)=>{
    const current=await this.lockClaimedTopup(client,input.topupId,input.claimedAt);if(!current){const existing=await client.query<TopupRow>(
      `SELECT ${columns} FROM kai_credit_topups WHERE id=$1 AND provider='qixiang'`,[input.topupId]);
      return existing.rows[0]?.status==='succeeded'?{status:'duplicate',topup:map(existing.rows[0])}:{status:'stale'};}
    const conflictingCallback=await client.query<{present:boolean}>(`SELECT EXISTS(SELECT 1
      FROM qixiang_payment_receipts WHERE topup_id=$1 AND source='callback' AND processing_result='accepted'
      AND(trade_no IS DISTINCT FROM $2 OR provider_reference IS DISTINCT FROM $3
        OR payment_type IS DISTINCT FROM 'alipay' OR amount_cents IS DISTINCT FROM $4))present`,[
      current.id,input.providerTransactionId,current.provider_reference,current.amount_cents,
    ]);if(conflictingCallback.rows[0]?.present===true)return this.manualTradeConflict(client,current,input);
    if(current.provider_payment_id!==null&&current.provider_payment_id!==input.providerTransactionId){
      return this.manualTradeConflict(client,current,input);}
    const claimed=await client.query<{topup_id:string}>(`INSERT INTO kai_credit_topup_provider_claims(
      provider,provider_transaction_id,topup_id,claimed_at)VALUES('qixiang',$1,$2,$3)
      ON CONFLICT DO NOTHING RETURNING topup_id`,[input.providerTransactionId,current.id,input.now]);
    if(!claimed.rows[0])return this.manualTradeConflict(client,current,input);
    const queryReceiptId=randomUUID(),queryReceiptKey=`query:${input.attemptId}`;
    await client.query(`INSERT INTO qixiang_payment_receipts(id,topup_id,source,receipt_key,provider_reference,
      trade_no,api_trade_no,provider_code,provider_status,trade_status,payment_type,amount_cents,
      signature_verified,snapshot_matched,payload_digest,processing_result,received_at)
      VALUES($1,$2,'query',$3,$4,$5,$6,1,1,NULL,'alipay',$7,false,true,$8,'accepted',$9)`,[
      queryReceiptId,current.id,queryReceiptKey,current.provider_reference,input.providerTransactionId,
      input.apiTradeNo,current.amount_cents,input.queryPayloadDigest,input.now,
    ]);const callback=await client.query<{id:string;receipt_key:string;payload_digest:string}>(`SELECT id,receipt_key,payload_digest
      FROM qixiang_payment_receipts WHERE topup_id=$1 AND source='callback' AND trade_no=$2
      AND provider_reference=$3 AND payment_type='alipay' AND amount_cents=$4 AND signature_verified=true
      AND snapshot_matched=true AND processing_result='accepted' ORDER BY received_at,id LIMIT 1`,[
      current.id,input.providerTransactionId,current.provider_reference,current.amount_cents,
    ]);const success=callback.rows[0]??{id:queryReceiptId,receipt_key:queryReceiptKey,payload_digest:input.queryPayloadDigest};
    const source=callback.rows[0]?'callback':'query';const confirmation=source==='callback'?'TRADE_SUCCESS':'QUERY_PAID';
    await client.query(`INSERT INTO kai_credit_topup_events(id,provider,provider_event_id,topup_id,
      provider_transaction_id,status,amount_cents,currency,payload_digest,normalized_payload,
      processing_result,processed_at)VALUES($1,'qixiang',$2,$3,$4,'succeeded',$5,'CNY',$6,$7::jsonb,'succeeded',$8)`,[
      randomUUID(),`qixiang:${source}:${success.receipt_key}`,current.id,input.providerTransactionId,current.amount_cents,
      success.payload_digest,JSON.stringify({source,providerReference:current.provider_reference,
        providerTransactionId:input.providerTransactionId,paymentType:'alipay',amountCents:Number(current.amount_cents),confirmation}),input.now,
    ]);const available=await this.ensureAvailableAccount(client,current.subject_id);const transactionId=randomUUID();
    const transactionOwner=`subject:${current.subject_id}`,transactionKey=`qixiang-topup:${current.id}`;
    await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,
      payload_digest,reference_type,reference_id,description,status)VALUES($1,$2,'QIXIANG_TOPUP_CAPTURE',$3,$4,
      'topup',$5,'七相充值卡时到账','pending')`,[transactionId,transactionOwner,transactionKey,input.grantPayloadDigest,current.id]);
    await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)VALUES
      ($1,$2,$3,$4,'七相充值卡时到账'),($5,$2,'00000000-0000-4000-8000-000000000101',$6,'七相卡时发行')`,[
      randomUUID(),transactionId,available,current.credit_micros,randomUUID(),(-BigInt(current.credit_micros)).toString(),
    ]);const lotId=randomUUID();await client.query(`INSERT INTO kai_credit_lots(id,subject_id,source_kind,
      source_topup_id,grant_transaction_id,granted_micros,available_micros,reserved_micros,
      refund_pending_micros,consumed_micros,expired_micros,refunded_micros,expires_at,created_at,updated_at)
      VALUES($1,$2,'qixiang_topup',$3,$4,$5,$5,0,0,0,0,0,$6::timestamptz+interval '364 days',$6,$6)`,[
      lotId,current.subject_id,current.id,transactionId,current.credit_micros,input.now,
    ]);await client.query(`INSERT INTO kai_credit_lot_movements(id,lot_id,ledger_transaction_id,kind,
      amount_micros,from_bucket,to_bucket,idempotency_owner,scope,idempotency_key,payload_digest,occurred_at)
      VALUES($1,$2,$3,'grant',$4,NULL,'available',$5,'QIXIANG_TOPUP_CAPTURE',$6,$7,$8)`,[
      randomUUID(),lotId,transactionId,current.credit_micros,transactionOwner,transactionKey,input.grantPayloadDigest,input.now,
    ]);await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[transactionId,input.now]);
    const updated=await client.query<TopupRow>(`UPDATE kai_credit_topups SET status='succeeded',
      provider_payment_id=COALESCE(provider_payment_id,$2),provider_transaction_id=$2,success_receipt_id=$3,
      succeeded_at=$4,entitlement_expires_at=$4::timestamptz+interval '364 days',success_confirmation_source=$5,
      reconciliation_locked_at=NULL,last_reconciled_at=$4,last_provider_status='1',last_reconciliation_error=NULL,
      next_reconcile_at=$4 WHERE id=$1 RETURNING ${columns}`,[
      current.id,input.providerTransactionId,success.id,input.now,source,
    ]);const topup=map(updated.rows[0]!);await this.auditSystem(client,'QIXIANG_TOPUP_SUCCEEDED',topup,
      input.attemptId,input.grantPayloadDigest,input.now,{status:topup.status,version:topup.version,
        successSource:source,creditMicros:topup.creditMicros.toString()});await this.outbox(client,'qixiang.topup.succeeded',topup,
      {topupId:topup.id,subjectId:topup.subjectId,status:topup.status,version:topup.version,
        creditMicros:topup.creditMicros.toString(),successSource:source});return{status:'succeeded',topup};
  });}

  async list(subjectId:string,input:Readonly<{cursor:QixiangCursor|null;limit:number}>){
    const result=await this.database.query<TopupRow>(`SELECT ${columns} FROM kai_credit_topups
      WHERE subject_id=$1 AND provider='qixiang' AND($2::timestamptz IS NULL OR(created_at,id)<($2,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $4`,[
      subjectId,input.cursor?.createdAt??null,input.cursor?.id??null,input.limit+1,
    ]);
    return result.rows.map(map);
  }

  async hasUnresolved(subjectId:string){const result=await this.database.query<{present:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM kai_credit_topups WHERE subject_id=$1 AND provider='qixiang'
    AND status IN('created','pending','verifying','expired','manual_review')) present`,[subjectId]);
    return result.rows[0]?.present===true;}

  private async createOutcome(topupId:string,expectedVersion:number,context:MutationContext,setSql:string,
  values:unknown[],action:string,topic:string,extraMetadata:Record<string,unknown>={}){
    return this.database.transaction(async(client)=>{
      const parameters=[topupId,expectedVersion,context.now,...values];
      const result=await client.query<TopupRow>(`UPDATE kai_credit_topups SET ${setSql}
        WHERE id=$1 AND provider='qixiang' AND status='verifying' AND version=$2 RETURNING ${columns}`,parameters);
      const topup=result.rows[0]?map(result.rows[0]):null;
      if(!topup){
        const current=await client.query<TopupRow>(`SELECT ${columns} FROM kai_credit_topups WHERE id=$1 AND provider='qixiang'`,
        [topupId]);
        if(current.rows[0])await this.audit(client,context,'QIXIANG_CREATE_LATE_OUTCOME_IGNORED',map(current.rows[0]),
          {status:current.rows[0].status,version:current.rows[0].version});
        return null;
      }
      await this.audit(client,context,action,topup,{status:topup.status,version:topup.version,...extraMetadata});
      await this.outbox(client,topic,topup,
        {topupId:topup.id,subjectId:topup.subjectId,status:topup.status,version:topup.version,...extraMetadata});
      return topup;
    });
  }

  private async findByClientRequest(client:PoolClient,subjectId:string,key:string){
    const result=await client.query<TopupRow>(`SELECT ${columns} FROM kai_credit_topups WHERE subject_id=$1
      AND client_request_id=$2 AND provider='qixiang' FOR UPDATE`,[subjectId,key]);return result.rows[0]??null;
  }
  private async claim(client:PoolClient,actorId:string,scope:string,key:string,digest:string,now:Date){
    const result=await client.query<{payload_hash:string;state:string}>(`INSERT INTO idempotency_records(
      id,actor_id,scope,idempotency_key,payload_hash,state,expires_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'processing',$6::timestamptz+interval '24 hours',$6,$6)
      ON CONFLICT(actor_id,scope,idempotency_key) DO UPDATE SET updated_at=idempotency_records.updated_at
      RETURNING payload_hash,state`,[randomUUID(),actorId,scope,key,digest,now]);
    const row=result.rows[0]!;return row.payload_hash!==digest?'conflict' as const:
      row.state==='completed'?'replayed' as const:'claimed' as const;
  }
  private complete(client:PoolClient,actorId:string,scope:string,key:string,status:number,response:Record<string,unknown>){
    return client.query(`UPDATE idempotency_records SET state='completed',response_status=$4,response_body=$5::jsonb,
      updated_at=now() WHERE actor_id=$1 AND scope=$2 AND idempotency_key=$3`,
    [actorId,scope,key,status,JSON.stringify(response)]);
  }
  private release(client:PoolClient,actorId:string,scope:string,key:string){return client.query(
    `DELETE FROM idempotency_records WHERE actor_id=$1 AND scope=$2 AND idempotency_key=$3 AND state='processing'`,
    [actorId,scope,key]);}
  private audit(client:PoolClient,context:MutationContext,action:string,topup:QixiangTopupRecord,
  metadata:Record<string,unknown>){return client.query(`INSERT INTO audit_events(id,actor_id,actor_kind,action,
    entity_type,entity_id,request_id,ip_hash,payload_digest,metadata,created_at)
    VALUES($1,$2,'user',$3,'QIXIANG_TOPUP',$4,$5,$6,$7,$8::jsonb,$9)`,[
    randomUUID(),context.actorId,action,topup.id,context.requestId,context.ipHash,context.payloadDigest,
    JSON.stringify({subjectId:topup.subjectId,...metadata}),context.now,
  ]);}
  private outbox(client:PoolClient,topic:string,topup:QixiangTopupRecord,payload:Record<string,unknown>){return client.query(
    `INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,payload)VALUES($1,$2,'QIXIANG_TOPUP',$3,$4::jsonb)`,
    [randomUUID(),topic,topup.id,JSON.stringify(payload)]);}
  private async toVerifying(client:PoolClient,row:TopupRow,now:Date){if(row.status==='verifying'){
    const result=await client.query<TopupRow>(`UPDATE kai_credit_topups SET status='verifying',next_reconcile_at=$2
      WHERE id=$1 RETURNING ${columns}`,[row.id,now]);return result.rows[0]!;}
    if(['created','pending','expired','manual_review'].includes(row.status)){const result=await client.query<TopupRow>(
      `UPDATE kai_credit_topups SET status='verifying',next_reconcile_at=$2 WHERE id=$1 RETURNING ${columns}`,[row.id,now]);
      return result.rows[0]!;}return row;}
  private async toManualReview(client:PoolClient,row:TopupRow,now:Date){let current=row;
    if(['created','expired'].includes(current.status))current=await this.toVerifying(client,current,now);
    if(['pending','verifying'].includes(current.status)){const result=await client.query<TopupRow>(
      `UPDATE kai_credit_topups SET status='manual_review',last_reconciliation_error='CALLBACK_SNAPSHOT_CONFLICT'
       WHERE id=$1 RETURNING ${columns}`,[current.id]);return result.rows[0]!;}return current;}
  private auditProvider(client:PoolClient,requestId:string,ipHash:string,payloadDigest:string,action:string,
  topup:QixiangTopupRecord,metadata:Record<string,unknown>){return client.query(`INSERT INTO audit_events(id,actor_id,
    actor_kind,action,entity_type,entity_id,request_id,ip_hash,payload_digest,metadata)
    VALUES($1,NULL,'provider',$2,'QIXIANG_TOPUP',$3,$4,$5,$6,$7::jsonb)`,[
    randomUUID(),action,topup.id,requestId,ipHash,payloadDigest,JSON.stringify({subjectId:topup.subjectId,...metadata}),
  ]);}
  private async lockClaimedTopup(client:PoolClient,topupId:string,claimedAt:Date){const result=await client.query<TopupRow>(
    `SELECT ${columns} FROM kai_credit_topups WHERE id=$1 AND provider='qixiang' AND status='verifying'
      AND reconciliation_locked_at=$2 FOR UPDATE`,[topupId,claimedAt]);return result.rows[0]??null;}
  private auditSystem(client:PoolClient,action:string,topup:QixiangTopupRecord,attemptId:string,
  payloadDigest:string,now:Date,metadata:Record<string,unknown>){return client.query(`INSERT INTO audit_events(
    id,actor_id,actor_kind,action,entity_type,entity_id,request_id,ip_hash,payload_digest,metadata,created_at)
    VALUES($1,NULL,'system',$2,'QIXIANG_TOPUP',$3,$4,NULL,$5,$6::jsonb,$7)`,[
    randomUUID(),action,topup.id,`qixiang-query:${attemptId}`,payloadDigest,
    JSON.stringify({subjectId:topup.subjectId,queryAttemptId:attemptId,...metadata}),now,
  ]);}
  private async ensureAvailableAccount(client:PoolClient,subjectId:string){await client.query(`INSERT INTO
    kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
    VALUES($1,'subject',$2,$3,'available',false)
    ON CONFLICT(subject_id,account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,[
    randomUUID(),subjectId,`subject:${subjectId}:available`,
  ]);const result=await client.query<{id:string}>(`SELECT id FROM kai_credit_accounts WHERE subject_id=$1
    AND account_kind='available' AND status='active' FOR UPDATE`,[subjectId]);
    if(!result.rows[0])throw new Error('QIXIANG_AVAILABLE_ACCOUNT_MISSING');return result.rows[0].id;}
  private async manualTradeConflict(client:PoolClient,current:TopupRow,input:Readonly<{attemptId:string;
    providerTransactionId:string;apiTradeNo:string;queryPayloadDigest:string;now:Date}>){
    await client.query(`INSERT INTO qixiang_payment_receipts(id,topup_id,source,receipt_key,provider_reference,
      trade_no,api_trade_no,provider_code,provider_status,trade_status,payment_type,amount_cents,
      signature_verified,snapshot_matched,payload_digest,processing_result,received_at)
      VALUES($1,$2,'query',$3,$4,$5,$6,1,1,NULL,'alipay',$7,false,true,$8,'trade_conflict',$9)
      ON CONFLICT(source,receipt_key) DO NOTHING`,[randomUUID(),current.id,`query:${input.attemptId}`,
      current.provider_reference,input.providerTransactionId,input.apiTradeNo,current.amount_cents,input.queryPayloadDigest,input.now]);
    const updated=await client.query<TopupRow>(`UPDATE kai_credit_topups SET status='manual_review',
      reconciliation_locked_at=NULL,last_reconciled_at=$2,last_provider_status='1',
      last_reconciliation_error='PROVIDER_TRANSACTION_CONFLICT',reconciliation_dead_lettered_at=$2
      WHERE id=$1 RETURNING ${columns}`,[current.id,input.now]);const topup=map(updated.rows[0]!);
    await this.auditSystem(client,'QIXIANG_QUERY_TRADE_CONFLICT',topup,input.attemptId,input.queryPayloadDigest,
      input.now,{status:topup.status,version:topup.version});await this.outbox(client,'qixiang.topup.manual_review',topup,
      {topupId:topup.id,subjectId:topup.subjectId,status:topup.status,version:topup.version,
        queryAttemptId:input.attemptId,errorCode:'PROVIDER_TRANSACTION_CONFLICT'});
    return{status:'manual_review' as const,topup};}
}
