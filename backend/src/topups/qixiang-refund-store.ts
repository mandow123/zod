import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../credits/types.js';

export type QixiangRefundStatus='requested'|'approved'|'provider_pending'|'pending_confirmation'|'manual_review'|'confirmed'|'rejected';
export type QixiangRefundRecord=Readonly<{id:string;topupId:string;subjectId:string;providerReference:string;
  providerPaymentId:string;providerTransactionId:string;amountCents:number;creditMicros:bigint;status:QixiangRefundStatus;
  version:number;reasonCode:'customer_request'|'service_unavailable'|'duplicate_payment'|'fraud_confirmed'|'other';
  requestedByOperatorId:string;approvedByOperatorId:string|null;confirmedByOperatorId:string|null;
  providerResponseCode:0|1|null;providerCallId:string|null;holdTransactionId:string;reversalTransactionId:string|null;
  requestedAt:Date;approvedAt:Date|null;providerSubmittedAt:Date|null;confirmedAt:Date|null;updatedAt:Date}>;
type RefundRow=QueryResultRow&{id:string;topup_id:string;subject_id:string;provider_reference:string;
  provider_payment_id:string;provider_transaction_id:string;amount_cents:string;credit_micros:string;status:QixiangRefundStatus;
  version:number;reason_code:QixiangRefundRecord['reasonCode'];requested_by_operator_id:string;
  approved_by_operator_id:string|null;confirmed_by_operator_id:string|null;provider_response_code:0|1|null;
  provider_call_id:string|null;hold_transaction_id:string;reversal_transaction_id:string|null;requested_at:Date;
  approved_at:Date|null;provider_submitted_at:Date|null;confirmed_at:Date|null;updated_at:Date};
const columns=`id,topup_id,subject_id,provider_reference,provider_payment_id,provider_transaction_id,
  amount_cents::text,credit_micros::text,status,version,reason_code,requested_by_operator_id,
  approved_by_operator_id,confirmed_by_operator_id,provider_response_code,provider_call_id,
  hold_transaction_id,reversal_transaction_id,requested_at,approved_at,provider_submitted_at,confirmed_at,updated_at`;

function map(row:RefundRow):QixiangRefundRecord{return{id:row.id,topupId:row.topup_id,subjectId:row.subject_id,
  providerReference:row.provider_reference,providerPaymentId:row.provider_payment_id,
  providerTransactionId:row.provider_transaction_id,amountCents:Number(row.amount_cents),creditMicros:BigInt(row.credit_micros),
  status:row.status,version:row.version,reasonCode:row.reason_code,requestedByOperatorId:row.requested_by_operator_id,
  approvedByOperatorId:row.approved_by_operator_id,confirmedByOperatorId:row.confirmed_by_operator_id,
  providerResponseCode:row.provider_response_code,providerCallId:row.provider_call_id,
  holdTransactionId:row.hold_transaction_id,reversalTransactionId:row.reversal_transaction_id,
  requestedAt:new Date(row.requested_at),approvedAt:row.approved_at?new Date(row.approved_at):null,
  providerSubmittedAt:row.provider_submitted_at?new Date(row.provider_submitted_at):null,
  confirmedAt:row.confirmed_at?new Date(row.confirmed_at):null,updatedAt:new Date(row.updated_at)}}

type MutationResult={status:'created'|'updated'|'replayed';refund:QixiangRefundRecord}|{status:'conflict'|'not_found'|'invalid_state'|'same_operator'|'credits_in_use'};
export class PostgresQixiangRefundStore{
  constructor(private readonly database:Database){}

  get(id:string){return this.database.query<RefundRow>(`SELECT ${columns} FROM qixiang_refund_requests WHERE id=$1`,[id])
    .then((result)=>result.rows[0]?map(result.rows[0]):null)}

  request(input:Readonly<{id:string;topupId:string;operatorId:string;reasonCode:QixiangRefundRecord['reasonCode'];
    evidenceDigest:string;idempotencyKey:string;payloadDigest:string;now:Date}>):Promise<MutationResult>{
    return this.database.transaction(async(client)=>{
      const replay=await this.replay(client,input.operatorId,'QIXIANG_REFUND_REQUEST',input.idempotencyKey,input.payloadDigest);
      if(replay)return replay;
      const topup=await client.query<{id:string;subject_id:string;provider_reference:string;provider_payment_id:string|null;
        provider_transaction_id:string|null;amount_cents:string;credit_micros:string;status:string;
        reversed_amount_cents:string;reversed_credit_micros:string}>(`SELECT id,subject_id,provider_reference,
          provider_payment_id,provider_transaction_id,amount_cents::text,credit_micros::text,status,
          reversed_amount_cents::text,reversed_credit_micros::text FROM kai_credit_topups WHERE id=$1 FOR UPDATE`,[input.topupId]);
      const t=topup.rows[0];if(!t)return{status:'not_found'};
      if(t.status!=='succeeded'||!t.provider_payment_id||!t.provider_transaction_id
        ||BigInt(t.reversed_amount_cents)!==0n||BigInt(t.reversed_credit_micros)!==0n)return{status:'invalid_state'};
      const lot=await client.query<{id:string;granted_micros:string;available_micros:string;reserved_micros:string;
        refund_pending_micros:string;consumed_micros:string;expired_micros:string;refunded_micros:string}>(`SELECT id,
          granted_micros::text,available_micros::text,reserved_micros::text,refund_pending_micros::text,
          consumed_micros::text,expired_micros::text,refunded_micros::text FROM kai_credit_lots
          WHERE source_topup_id=$1 FOR UPDATE`,[input.topupId]);
      const l=lot.rows[0];const credit=BigInt(t.credit_micros);
      if(!l||BigInt(l.granted_micros)!==credit||BigInt(l.available_micros)!==credit
        ||[l.reserved_micros,l.refund_pending_micros,l.consumed_micros,l.expired_micros,l.refunded_micros]
          .some((value)=>BigInt(value)!==0n))return{status:'credits_in_use'};
      await this.ensureHoldAccount(client,t.subject_id);
      const accounts=await client.query<{id:string;account_kind:string}>(`SELECT id,account_kind FROM kai_credit_accounts
        WHERE subject_id=$1 AND account_kind IN('available','refund_hold') ORDER BY id FOR UPDATE`,[t.subject_id]);
      const available=accounts.rows.find((row)=>row.account_kind==='available')?.id;
      const hold=accounts.rows.find((row)=>row.account_kind==='refund_hold')?.id;
      if(!available||!hold)throw new Error('QIXIANG_REFUND_ACCOUNTS_UNAVAILABLE');
      const transactionId=randomUUID();const owner=`operator:${input.operatorId}`;
      await this.transaction(client,{id:transactionId,owner,scope:'QIXIANG_REFUND_HOLD',key:input.idempotencyKey,
        digest:input.payloadDigest,referenceId:input.id,description:'七相全额退款卡时冻结',now:input.now,
        entries:[{accountId:available,amount:-credit,memo:'退款冻结'},{accountId:hold,amount:credit,memo:'退款冻结'}]});
      await client.query(`UPDATE kai_credit_lots SET available_micros=0,refund_pending_micros=$2 WHERE id=$1`,[l.id,credit.toString()]);
      await this.movement(client,{lotId:l.id,transactionId,kind:'refund_hold',amount:credit,from:'available',to:'refund_pending',
        owner,scope:'QIXIANG_REFUND_HOLD',key:input.idempotencyKey,digest:input.payloadDigest,now:input.now});
      await client.query(`INSERT INTO qixiang_refund_requests(id,topup_id,subject_id,provider_reference,
          provider_payment_id,provider_transaction_id,amount_cents,credit_micros,status,reason_code,
          request_evidence_digest,requested_by_operator_id,hold_transaction_id,client_request_id,payload_digest,requested_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'requested',$9,$10,$11,$12,$13,$14,$15)`,[input.id,input.topupId,t.subject_id,
        t.provider_reference,t.provider_payment_id,t.provider_transaction_id,t.amount_cents,t.credit_micros,input.reasonCode,
        input.evidenceDigest,input.operatorId,transactionId,input.idempotencyKey,input.payloadDigest,input.now]);
      await this.action(client,input.id,input.operatorId,'request',owner,'QIXIANG_REFUND_REQUEST',input.idempotencyKey,
        input.payloadDigest,input.evidenceDigest,input.now);
      return{status:'created',refund:await this.lock(client,input.id)};
    })}

  approve(input:Readonly<{refundId:string;operatorId:string;evidenceDigest:string;idempotencyKey:string;
    payloadDigest:string;now:Date}>):Promise<MutationResult>{return this.stage(input,'QIXIANG_REFUND_APPROVE','approve',async(client,row)=>{
      if(row.status!=='requested')return'invalid_state';if(row.requested_by_operator_id===input.operatorId)return'same_operator';
      await client.query(`UPDATE qixiang_refund_requests SET status='approved',approved_by_operator_id=$2,
        approval_evidence_digest=$3,approved_at=$4 WHERE id=$1`,[row.id,input.operatorId,input.evidenceDigest,input.now]);return null;})}

  beginSubmit(input:Readonly<{refundId:string;operatorId:string;providerCallId:string;idempotencyKey:string;
    payloadDigest:string;now:Date}>):Promise<MutationResult>{return this.stage(input,'QIXIANG_REFUND_SUBMIT','submit',async(client,row)=>{
      if(row.status!=='approved')return'invalid_state';
      await client.query(`UPDATE qixiang_refund_requests SET status='provider_pending',provider_call_id=$2,
        provider_submitted_at=$3 WHERE id=$1`,[row.id,input.providerCallId,input.now]);return null;})}

  recordProviderResponse(refundId:string,providerCallId:string,code:0|1,digest:string,now:Date){return this.database.transaction(async(client)=>{
    const row=await this.lock(client,refundId);if(row.status!=='provider_pending'||row.providerCallId!==providerCallId)return null;
    const updated=await client.query<RefundRow>(`UPDATE qixiang_refund_requests SET status='pending_confirmation',
      provider_response_code=$2,provider_response_digest=$3 WHERE id=$1 RETURNING ${columns}`,[refundId,code,digest]);
    return updated.rows[0]?map(updated.rows[0]):null;})}

  markManualReview(refundId:string,providerCallId:string,operatorId:string,payloadDigest:string,now:Date){
    return this.database.transaction(async(client)=>{const row=await this.lock(client,refundId);
      if(row.status!=='provider_pending'||row.providerCallId!==providerCallId)return row;
      await client.query(`UPDATE qixiang_refund_requests SET status='manual_review' WHERE id=$1`,[refundId]);
      await this.action(client,refundId,operatorId,'mark_manual_review',`operator:${operatorId}`,'QIXIANG_REFUND_MANUAL_REVIEW',
        `manual:${providerCallId}`,payloadDigest,null,now);return this.lock(client,refundId);})}

  manualTakeover(input:Readonly<{refundId:string;operatorId:string;evidenceDigest:string;idempotencyKey:string;
    payloadDigest:string;staleBefore:Date;now:Date}>):Promise<MutationResult>{
    return this.stage(input,'QIXIANG_REFUND_MANUAL_TAKEOVER','mark_manual_review',async(client,row)=>{
      if(row.status!=='provider_pending'||!row.provider_submitted_at
        ||new Date(row.provider_submitted_at)>input.staleBefore)return'invalid_state';
      await client.query(`UPDATE qixiang_refund_requests SET status='manual_review' WHERE id=$1`,[row.id]);
      return null;
    });
  }

  confirm(input:Readonly<{refundId:string;operatorId:string;evidenceDigest:string;idempotencyKey:string;
    payloadDigest:string;now:Date}>):Promise<MutationResult>{return this.stage(input,'QIXIANG_REFUND_CONFIRM','confirm',async(client,row)=>{
      if(!['pending_confirmation','manual_review'].includes(row.status))return'invalid_state';
      if(row.requested_by_operator_id===input.operatorId)return'same_operator';
      const lot=await client.query<{id:string;refund_pending_micros:string}>(`SELECT id,refund_pending_micros::text
        FROM kai_credit_lots WHERE source_topup_id=$1 FOR UPDATE`,[row.topup_id]);
      if(!lot.rows[0]||BigInt(lot.rows[0].refund_pending_micros)!==BigInt(row.credit_micros))throw new Error('QIXIANG_REFUND_LOT_MISMATCH');
      const accounts=await this.holdAndIssuance(client,row.subject_id);const transactionId=randomUUID();const owner=`operator:${input.operatorId}`;
      await this.transaction(client,{id:transactionId,owner,scope:'QIXIANG_REFUND_CONFIRM',key:input.idempotencyKey,
        digest:input.payloadDigest,referenceId:row.id,description:'七相退款确认并核销卡时',now:input.now,
        entries:[{accountId:accounts.hold,amount:-BigInt(row.credit_micros),memo:'退款卡时核销'},
          {accountId:accounts.issuance,amount:BigInt(row.credit_micros),memo:'退款卡时核销'}]});
      await client.query(`UPDATE kai_credit_lots SET refund_pending_micros=0,refunded_micros=$2 WHERE id=$1`,
        [lot.rows[0].id,row.credit_micros]);
      await this.movement(client,{lotId:lot.rows[0].id,transactionId,kind:'refund_confirm',amount:BigInt(row.credit_micros),
        from:'refund_pending',to:'refunded',owner,scope:'QIXIANG_REFUND_CONFIRM',key:input.idempotencyKey,
        digest:input.payloadDigest,now:input.now});
      await client.query(`UPDATE kai_credit_topups SET reversed_amount_cents=amount_cents,reversed_credit_micros=credit_micros,
        updated_at=$2 WHERE id=$1`,[row.topup_id,input.now]);
      await client.query(`UPDATE qixiang_refund_requests SET status='confirmed',confirmed_by_operator_id=$2,
        confirmation_evidence_digest=$3,confirmed_at=$4,reversal_transaction_id=$5 WHERE id=$1`,
      [row.id,input.operatorId,input.evidenceDigest,input.now,transactionId]);return null;})}

  reject(input:Readonly<{refundId:string;operatorId:string;evidenceDigest:string;idempotencyKey:string;
    payloadDigest:string;now:Date}>):Promise<MutationResult>{return this.stage(input,'QIXIANG_REFUND_REJECT','reject',async(client,row)=>{
      if(row.status!=='requested')return'invalid_state';
      const lot=await client.query<{id:string;refund_pending_micros:string;expires_at:Date}>(`SELECT id,
        refund_pending_micros::text,expires_at FROM kai_credit_lots WHERE source_topup_id=$1 FOR UPDATE`,[row.topup_id]);
      if(!lot.rows[0]||BigInt(lot.rows[0].refund_pending_micros)!==BigInt(row.credit_micros))throw new Error('QIXIANG_REFUND_LOT_MISMATCH');
      const expired=new Date(lot.rows[0].expires_at)<=input.now;const accounts=await this.holdAndIssuance(client,row.subject_id);
      const available=expired?null:(await client.query<{id:string}>(`SELECT id FROM kai_credit_accounts WHERE subject_id=$1
        AND account_kind='available' FOR UPDATE`,[row.subject_id])).rows[0]?.id;
      if(!expired&&!available)throw new Error('QIXIANG_REFUND_ACCOUNTS_UNAVAILABLE');
      const amount=BigInt(row.credit_micros);const transactionId=randomUUID();const owner=`operator:${input.operatorId}`;
      await this.transaction(client,{id:transactionId,owner,scope:'QIXIANG_REFUND_RELEASE',key:input.idempotencyKey,
        digest:input.payloadDigest,referenceId:row.id,description:'七相退款驳回并释放卡时',now:input.now,
        entries:[{accountId:accounts.hold,amount:-amount,memo:'退款冻结释放'},
          {accountId:expired?accounts.issuance:available!,amount,memo:expired?'到期卡时核销':'卡时恢复可用'}]});
      await client.query(`UPDATE kai_credit_lots SET refund_pending_micros=0,available_micros=available_micros+$2,
        expired_micros=expired_micros+$3 WHERE id=$1`,[lot.rows[0].id,expired?'0':amount.toString(),expired?amount.toString():'0']);
      await this.movement(client,{lotId:lot.rows[0].id,transactionId,kind:expired?'refund_release_expired':'refund_release_available',
        amount,from:'refund_pending',to:expired?'expired':'available',owner,scope:'QIXIANG_REFUND_RELEASE',
        key:input.idempotencyKey,digest:input.payloadDigest,now:input.now});
      await client.query(`UPDATE qixiang_refund_requests SET status='rejected',reversal_transaction_id=$2 WHERE id=$1`,
        [row.id,transactionId]);return null;})}

  private async stage(input:{refundId:string;operatorId:string;evidenceDigest?:string;idempotencyKey:string;
    payloadDigest:string;now:Date},scope:string,action:'approve'|'submit'|'mark_manual_review'|'confirm'|'reject',
    mutate:(client:PoolClient,row:RefundRow)=>Promise<'invalid_state'|'same_operator'|null>):Promise<MutationResult>{
    return this.database.transaction(async(client)=>{const replay=await this.replay(client,input.operatorId,scope,input.idempotencyKey,input.payloadDigest);
      if(replay)return replay;const rows=await client.query<RefundRow>(`SELECT ${columns} FROM qixiang_refund_requests WHERE id=$1 FOR UPDATE`,[input.refundId]);
      const row=rows.rows[0];if(!row)return{status:'not_found'};const failed=await mutate(client,row);if(failed)return{status:failed};
      await this.action(client,row.id,input.operatorId,action,`operator:${input.operatorId}`,scope,input.idempotencyKey,
        input.payloadDigest,input.evidenceDigest??null,input.now);return{status:'updated',refund:await this.lock(client,row.id)};})}
  private async replay(client:PoolClient,actorId:string,scope:string,key:string,digest:string):Promise<MutationResult|null>{
    const action=await client.query<{refund_id:string;payload_digest:string}>(`SELECT refund_id,payload_digest FROM qixiang_refund_actions
      WHERE idempotency_owner=$1 AND scope=$2 AND idempotency_key=$3 FOR UPDATE`,[`operator:${actorId}`,scope,key]);
    if(!action.rows[0])return null;if(action.rows[0].payload_digest!==digest)return{status:'conflict'};
    return{status:'replayed',refund:await this.lock(client,action.rows[0].refund_id)}}
  private async lock(client:PoolClient,id:string){const result=await client.query<RefundRow>(`SELECT ${columns}
    FROM qixiang_refund_requests WHERE id=$1 FOR UPDATE`,[id]);if(!result.rows[0])throw new Error('QIXIANG_REFUND_NOT_FOUND');return map(result.rows[0])}
  private async ensureHoldAccount(client:PoolClient,subjectId:string){await client.query(`INSERT INTO kai_credit_accounts(
    id,owner_kind,subject_id,code,account_kind,allow_negative)VALUES($1,'subject',$2,$3,'refund_hold',false)
    ON CONFLICT(subject_id,account_kind)WHERE subject_id IS NOT NULL DO NOTHING`,
  [randomUUID(),subjectId,`subject:${subjectId}:refund_hold`])}
  private async holdAndIssuance(client:PoolClient,subjectId:string){const result=await client.query<{id:string;account_kind:string}>(
    `SELECT id,account_kind FROM kai_credit_accounts WHERE(id=$2 OR(subject_id=$1 AND account_kind='refund_hold'))
      ORDER BY id FOR UPDATE`,[subjectId,KAI_CREDIT_PLATFORM_ACCOUNTS.issuance]);const hold=result.rows.find((r)=>r.account_kind==='refund_hold')?.id;
    const issuance=result.rows.find((r)=>r.id===KAI_CREDIT_PLATFORM_ACCOUNTS.issuance)?.id;if(!hold||!issuance)throw new Error('QIXIANG_REFUND_ACCOUNTS_UNAVAILABLE');
    return{hold,issuance}}
  private async transaction(client:PoolClient,input:{id:string;owner:string;scope:string;key:string;digest:string;
    referenceId:string;description:string;now:Date;entries:{accountId:string;amount:bigint;memo:string}[]}){
    await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
      reference_type,reference_id,description,status)VALUES($1,$2,$3,$4,$5,'refund',$6,$7,'pending')`,
    [input.id,input.owner,input.scope,input.key,input.digest,input.referenceId,input.description]);
    for(const entry of input.entries)await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,
      amount_micros,memo)VALUES($1,$2,$3,$4,$5)`,[randomUUID(),input.id,entry.accountId,entry.amount.toString(),entry.memo]);
    await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[input.id,input.now])}
  private movement(client:PoolClient,input:{lotId:string;transactionId:string;kind:string;amount:bigint;from:string;to:string;
    owner:string;scope:string;key:string;digest:string;now:Date}){return client.query(`INSERT INTO kai_credit_lot_movements(
      id,lot_id,allocation_id,ledger_transaction_id,kind,amount_micros,from_bucket,to_bucket,idempotency_owner,scope,
      idempotency_key,payload_digest,occurred_at)VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [randomUUID(),input.lotId,input.transactionId,input.kind,input.amount.toString(),input.from,input.to,input.owner,input.scope,
      input.key,input.digest,input.now])}
  private action(client:PoolClient,refundId:string,actorId:string,action:string,owner:string,scope:string,key:string,
    digest:string,evidence:string|null,now:Date){return client.query(`INSERT INTO qixiang_refund_actions(id,refund_id,actor_id,
      action,idempotency_owner,scope,idempotency_key,payload_digest,evidence_digest,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),refundId,actorId,action,owner,scope,key,digest,evidence,now])}
}
