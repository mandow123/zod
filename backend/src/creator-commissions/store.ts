import { randomUUID } from 'node:crypto';
import type { PoolClient,QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../credits/types.js';
import type { CommissionOrderKind,CommissionOrderStatus,CreatorCommissionPolicy,ReferralProviderSource } from './types.js';

const COMMISSION_CLEARING='00000000-0000-4000-8000-000000000201';

export type ReferralLinkRecord=Readonly<{ id:string;creatorUserId:string;code:string;clientRequestId:string;
  payloadDigest:string;policyVersion:string;commissionBasisPoints:number;status:'active'|'revoked'|'expired';expiresAt:Date;createdAt:Date }>;
export type AttributionRecord=Readonly<{ id:string;buyerUserId:string;buyerSubjectId:string;linkId:string;creatorUserId:string;
  providerSource:ReferralProviderSource;providerEventId:string;payloadDigest:string;status:'active'|'replaced'|'revoked'|'expired';
  attributedAt:Date;expiresAt:Date }>;
export type CommissionOrderRecord=Readonly<{ id:string;orderKind:CommissionOrderKind;orderId:string;creatorUserId:string;
  buyerSubjectId:string;grossCreditMicros:bigint;commissionCreditMicros:bigint;policyVersion:string;
  status:CommissionOrderStatus;completedAt:Date|null;observationEndsAt:Date|null;availableAt:Date|null;createdAt:Date;updatedAt:Date }>;
export type RewardEventRecord=Readonly<{ id:string;creatorUserId:string;transferId:string;creditMicros:bigint;
  status:'unconsumed'|'consumed';createdAt:Date;consumedAt:Date|null }>;

export interface CreatorCommissionStore {
  createLink(input:Readonly<{ id:string;creatorUserId:string;code:string;clientRequestId:string;payloadDigest:string;
    policy:CreatorCommissionPolicy;expiresAt:Date;now:Date }>):Promise<{ status:'created'|'replayed';link:ReferralLinkRecord }|{ status:'conflict' }>;
  linkByCode(code:string):Promise<ReferralLinkRecord|null>;
  attribute(input:Readonly<{ id:string;buyerUserId:string;buyerSubjectId:string;link:ReferralLinkRecord;
    providerSource:ReferralProviderSource;providerEventId:string;payloadDigest:string;expiresAt:Date;now:Date }> ):
    Promise<{ status:'created'|'replayed'|'existing';attribution:AttributionRecord }|{ status:'conflict'|'self_referral' }>;
  discoverEligibleOrders(now:Date):Promise<number>;
  reconcileLifecycle(now:Date,refundObservationDays:number,limit:number):Promise<Readonly<{ completed:number;matured:number;reversed:number }>>;
  summary(creatorUserId:string):Promise<Readonly<{ pendingMicros:bigint;availableMicros:bigint;transferredMicros:bigint;
    orders:CommissionOrderRecord[] }>>;
  transferAvailable(input:Readonly<{ creatorUserId:string;targetSubjectId:string;clientRequestId:string;payloadDigest:string;now:Date }> ):
    Promise<{ status:'created'|'replayed';creditMicros:bigint;reward:RewardEventRecord }|{ status:'conflict'|'nothing_available' }>;
  rewardEvents(creatorUserId:string,limit:number):Promise<RewardEventRecord[]>;
  consumeReward(creatorUserId:string,eventId:string,now:Date):Promise<RewardEventRecord|null>;
}

type LinkRow=QueryResultRow&{id:string;creator_user_id:string;code:string;client_request_id:string;payload_digest:string;
  policy_version:string;commission_basis_points:number;status:ReferralLinkRecord['status'];expires_at:Date;created_at:Date};
type AttributionRow=QueryResultRow&{id:string;buyer_user_id:string;buyer_subject_id:string;link_id:string;creator_user_id:string;
  provider_source:ReferralProviderSource;provider_event_id:string;payload_digest:string;status:AttributionRecord['status'];
  attributed_at:Date;expires_at:Date};
type OrderRow=QueryResultRow&{id:string;order_kind:CommissionOrderKind;order_id:string;creator_user_id:string;buyer_subject_id:string;
  gross_credit_micros:string;commission_credit_micros:string;policy_version:string;status:CommissionOrderStatus;
  completed_at:Date|null;observation_ends_at:Date|null;available_at:Date|null;created_at:Date;updated_at:Date};
type RewardRow=QueryResultRow&{id:string;creator_user_id:string;transfer_id:string;credit_micros:string;status:RewardEventRecord['status'];
  created_at:Date;consumed_at:Date|null};
const linkColumns=`id,creator_user_id,code,client_request_id,payload_digest,policy_version,commission_basis_points,status,expires_at,created_at`;
const attributionColumns=`id,buyer_user_id,buyer_subject_id,link_id,creator_user_id,provider_source,provider_event_id,payload_digest,status,attributed_at,expires_at`;
const orderColumns=`id,order_kind,order_id::text,creator_user_id,buyer_subject_id,gross_credit_micros::text,
  commission_credit_micros::text,policy_version,status,completed_at,observation_ends_at,available_at,created_at,updated_at`;
const rewardColumns=`id,creator_user_id,transfer_id,credit_micros::text,status,created_at,consumed_at`;

export class PostgresCreatorCommissionStore implements CreatorCommissionStore {
  constructor(private readonly database:Database) {}

  async createLink(input:Parameters<CreatorCommissionStore['createLink']>[0]) {
    return this.database.transaction(async(client)=>{
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`creator-link:${input.creatorUserId}:${input.clientRequestId}`]);
      const existing=await client.query<LinkRow>(`SELECT ${linkColumns} FROM creator_referral_links
        WHERE creator_user_id=$1 AND client_request_id=$2 FOR UPDATE`,[input.creatorUserId,input.clientRequestId]);
      if(existing.rows[0]) return existing.rows[0].payload_digest===input.payloadDigest
        ? {status:'replayed' as const,link:mapLink(existing.rows[0])}:{status:'conflict' as const};
      const result=await client.query<LinkRow>(`INSERT INTO creator_referral_links(id,creator_user_id,code,client_request_id,
        payload_digest,policy_version,commission_basis_points,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING ${linkColumns}`,[input.id,input.creatorUserId,input.code,input.clientRequestId,input.payloadDigest,
        input.policy.version,input.policy.commissionBasisPoints,input.expiresAt,input.now]);
      await audit(client,'REFERRAL_LINK_CREATED',input.creatorUserId,input.creatorUserId,null,null,input.clientRequestId,{linkId:input.id});
      return {status:'created' as const,link:mapLink(result.rows[0]!)};
    });
  }
  async linkByCode(code:string){const r=await this.database.query<LinkRow>(`SELECT ${linkColumns} FROM creator_referral_links WHERE code=$1`,[code]);return r.rows[0]?mapLink(r.rows[0]):null;}

  async attribute(input:Parameters<CreatorCommissionStore['attribute']>[0]) {
    return this.database.transaction(async(client)=>{
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`creator-attribution:${input.buyerSubjectId}`]);
      if(input.buyerUserId===input.link.creatorUserId)return {status:'self_referral' as const};
      const replay=await client.query<AttributionRow>(`SELECT ${attributionColumns} FROM creator_referral_attributions
        WHERE provider_source=$1 AND provider_event_id=$2 FOR UPDATE`,[input.providerSource,input.providerEventId]);
      if(replay.rows[0])return replay.rows[0].payload_digest===input.payloadDigest
        ?{status:'replayed' as const,attribution:mapAttribution(replay.rows[0])}:{status:'conflict' as const};
      await client.query(`UPDATE creator_referral_attributions SET status='expired'
        WHERE buyer_subject_id=$1 AND status='active' AND expires_at<=$2`,[input.buyerSubjectId,input.now]);
      const active=await client.query<AttributionRow>(`SELECT ${attributionColumns} FROM creator_referral_attributions
        WHERE buyer_subject_id=$1 AND status='active' FOR UPDATE`,[input.buyerSubjectId]);
      if(active.rows[0])return {status:'existing' as const,attribution:mapAttribution(active.rows[0])};
      const result=await client.query<AttributionRow>(`INSERT INTO creator_referral_attributions(id,buyer_user_id,
        buyer_subject_id,link_id,creator_user_id,provider_source,provider_event_id,payload_digest,attributed_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${attributionColumns}`,[input.id,input.buyerUserId,
        input.buyerSubjectId,input.link.id,input.link.creatorUserId,input.providerSource,input.providerEventId,input.payloadDigest,input.now,input.expiresAt]);
      await audit(client,'REFERRAL_ATTRIBUTED',input.link.creatorUserId,input.buyerUserId,null,input.id,input.providerEventId,{buyerSubjectId:input.buyerSubjectId});
      return {status:'created' as const,attribution:mapAttribution(result.rows[0]!)};
    });
  }

  async discoverEligibleOrders(_now:Date) {
    const result=await this.database.query(`WITH source_orders AS (
      SELECT 'credit_order'::text order_kind,id order_id,buyer_subject_id,total_credit_micros gross_credit_micros,created_at
        FROM kai_credit_orders
      UNION ALL SELECT 'device_order',id,buyer_subject_id,gross_credit_micros,created_at FROM physical_device_orders
      UNION ALL SELECT 'vast_order',id,buyer_subject_id,total_credit_micros,created_at FROM vast_external_orders
    ), eligible AS (
      SELECT s.*,a.id attribution_id,a.creator_user_id,l.policy_version,l.commission_basis_points
      FROM source_orders s JOIN creator_referral_attributions a ON a.buyer_subject_id=s.buyer_subject_id AND a.status='active'
      JOIN creator_referral_links l ON l.id=a.link_id AND l.status='active'
      WHERE s.created_at>=a.attributed_at AND s.created_at<a.expires_at AND s.created_at<l.expires_at
    ) INSERT INTO creator_commission_orders(id,order_kind,order_id,attribution_id,creator_user_id,buyer_subject_id,
      gross_credit_micros,commission_credit_micros,policy_version)
    SELECT gen_random_uuid(),order_kind,order_id,attribution_id,creator_user_id,buyer_subject_id,gross_credit_micros,
      FLOOR((gross_credit_micros::numeric*commission_basis_points/10000)/10000)::bigint*10000,policy_version FROM eligible
    WHERE FLOOR((gross_credit_micros::numeric*commission_basis_points/10000)/10000)::bigint*10000>0
    ON CONFLICT(order_kind,order_id) DO NOTHING`,[]);
    return result.rowCount??0;
  }

  async reconcileLifecycle(now:Date,refundObservationDays:number,limit:number) {
    let completed=0,matured=0,reversed=0;
    for(let index=0;index<limit;index+=1){const action=await this.database.transaction(async(client)=>{
      const candidate=await client.query<OrderRow&{source_state:'open'|'completed'|'reversed'}>(`WITH source_states AS (
        SELECT 'credit_order'::text order_kind,id order_id,CASE
          WHEN status IN ('accepted','closed') THEN 'completed'
          WHEN status IN ('cancelled','expired','refunded') THEN 'reversed' ELSE 'open' END source_state FROM kai_credit_orders
        UNION ALL SELECT 'device_order',id,CASE WHEN status IN ('received','settled') THEN 'completed'
          WHEN status IN ('cancelled','refunded') THEN 'reversed' ELSE 'open' END FROM physical_device_orders
        UNION ALL SELECT 'vast_order',id,CASE WHEN status='provisioning' THEN 'completed'
          WHEN status='failed' THEN 'reversed' ELSE 'open' END FROM vast_external_orders
      ) SELECT c.id,c.order_kind,c.order_id::text,c.creator_user_id,c.buyer_subject_id,c.gross_credit_micros::text,
        c.commission_credit_micros::text,c.policy_version,c.status,c.completed_at,c.observation_ends_at,c.available_at,
        c.created_at,c.updated_at,s.source_state FROM creator_commission_orders c
      JOIN source_states s ON s.order_kind=c.order_kind AND s.order_id=c.order_id
      WHERE (c.status='attributed' AND s.source_state IN ('completed','reversed'))
        OR (c.status='refund_observation' AND (s.source_state='reversed'
          OR (s.source_state='completed' AND c.observation_ends_at<=$1)))
        OR (c.status='available' AND s.source_state='reversed')
      ORDER BY CASE WHEN s.source_state='reversed' THEN 0 WHEN c.status='refund_observation' THEN 1 ELSE 2 END,
        c.observation_ends_at NULLS LAST,c.created_at,c.id
      FOR UPDATE OF c SKIP LOCKED LIMIT 1`,[now]);
      const row=candidate.rows[0];if(!row)return null;
      if(row.status==='attributed'&&row.source_state==='completed'){
        await this.earnLocked(client,row,now,refundObservationDays);return 'completed' as const;
      }
      if(row.source_state==='reversed'){
        await this.reverseLocked(client,row,'source:reversed',now);return 'reversed' as const;
      }
      await this.matureLocked(client,row,now);return 'matured' as const;
    });
      if(!action)break;if(action==='completed')completed+=1;else if(action==='matured')matured+=1;else reversed+=1;
    }
    return {completed,matured,reversed};
  }

  async summary(creatorUserId:string){await this.ensureAccounts(creatorUserId);const balances=await this.database.query<{account_kind:string;amount:string}>(`SELECT a.account_kind,
    COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text amount FROM creator_commission_accounts a
    LEFT JOIN creator_commission_entries e ON e.account_id=a.id LEFT JOIN creator_commission_transactions t ON t.id=e.transaction_id
    WHERE a.creator_user_id=$1 GROUP BY a.id,a.account_kind`,[creatorUserId]);const map=new Map(balances.rows.map(r=>[r.account_kind,BigInt(r.amount)]));
    const orders=await this.database.query<OrderRow>(`SELECT ${orderColumns} FROM creator_commission_orders WHERE creator_user_id=$1 ORDER BY updated_at DESC LIMIT 50`,[creatorUserId]);
    return {pendingMicros:map.get('pending')??0n,availableMicros:map.get('available')??0n,transferredMicros:map.get('transferred')??0n,orders:orders.rows.map(mapOrder)};}

  async transferAvailable(input:Parameters<CreatorCommissionStore['transferAvailable']>[0]) {
    return this.database.transaction(async(client)=>{
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`creator-transfer:${input.creatorUserId}:${input.clientRequestId}`]);
      const existing=await client.query<{payload_digest:string;credit_micros:string;event_id:string}>(`SELECT t.payload_digest,x.credit_micros::text,e.id event_id
        FROM creator_commission_transfers x JOIN creator_commission_transactions t ON t.id=x.commission_transaction_id
        JOIN creator_reward_events e ON e.transfer_id=x.id WHERE x.creator_user_id=$1 AND x.client_request_id=$2 FOR UPDATE`,[input.creatorUserId,input.clientRequestId]);
      if(existing.rows[0]){if(existing.rows[0].payload_digest!==input.payloadDigest)return {status:'conflict' as const};
        const reward=await client.query<RewardRow>(`SELECT ${rewardColumns} FROM creator_reward_events WHERE id=$1`,[existing.rows[0].event_id]);
        return {status:'replayed' as const,creditMicros:BigInt(existing.rows[0].credit_micros),reward:mapReward(reward.rows[0]!)};}
      const accounts=await ensureCommissionAccounts(client,input.creatorUserId);const available=await accountBalance(client,accounts.available);
      if(available<=0n)return {status:'nothing_available' as const};
      const transferId=randomUUID(),commissionTransactionId=randomUUID(),kaiTransactionId=randomUUID();
      await postCommission(client,{id:commissionTransactionId,owner:`creator:${input.creatorUserId}`,scope:'COMMISSION_TRANSFER',key:`transfer:${transferId}`,
        digest:input.payloadDigest,associationId:null,description:'达人返佣转入 KAI 卡时',entries:[
          {accountId:accounts.available,amount:-available,memo:'可用返佣转出'},{accountId:accounts.transferred,amount:available,memo:'累计已转入'}]},input.now);
      const kai=await ensureKaiAvailable(client,input.targetSubjectId);
      await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
        reference_type,reference_id,description,status) VALUES($1,$2,'CREATOR_COMMISSION_TRANSFER',$3,$4,'adjustment',$5,
        '达人返佣转入卡时','pending')`,[kaiTransactionId,`subject:${input.targetSubjectId}`,`creator-commission:${transferId}`,input.payloadDigest,transferId]);
      await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
        ($1,$2,$3,$4,'达人返佣红包'),($5,$2,$6,$7,'达人返佣发行')`,[randomUUID(),kaiTransactionId,kai,available.toString(),randomUUID(),
        KAI_CREDIT_PLATFORM_ACCOUNTS.issuance,(-available).toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[kaiTransactionId,input.now]);
      await client.query(`INSERT INTO creator_commission_transfers(id,creator_user_id,target_subject_id,client_request_id,payload_digest,
        credit_micros,commission_transaction_id,kai_credit_transaction_id,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'succeeded',$9)`,
      [transferId,input.creatorUserId,input.targetSubjectId,input.clientRequestId,input.payloadDigest,available.toString(),commissionTransactionId,kaiTransactionId,input.now]);
      await client.query(`UPDATE creator_commission_orders SET status='transferred',transferred_at=$2 WHERE creator_user_id=$1 AND status='available'`,[input.creatorUserId,input.now]);
      const rewardId=randomUUID();const reward=await client.query<RewardRow>(`INSERT INTO creator_reward_events(id,creator_user_id,transfer_id,credit_micros,created_at)
        VALUES($1,$2,$3,$4,$5) RETURNING ${rewardColumns}`,[rewardId,input.creatorUserId,transferId,available.toString(),input.now]);
      await audit(client,'COMMISSION_TRANSFERRED',input.creatorUserId,input.creatorUserId,null,null,input.clientRequestId,{transferId,kaiTransactionId,rewardEventId:rewardId,creditMicros:available.toString()});
      return {status:'created' as const,creditMicros:available,reward:mapReward(reward.rows[0]!)};
    });
  }

  async rewardEvents(creatorUserId:string,limit:number){const r=await this.database.query<RewardRow>(`SELECT ${rewardColumns} FROM creator_reward_events
    WHERE creator_user_id=$1 AND status='unconsumed' ORDER BY created_at,id LIMIT $2`,[creatorUserId,limit]);return r.rows.map(mapReward);}
  async consumeReward(creatorUserId:string,eventId:string,now:Date){const r=await this.database.query<RewardRow>(`UPDATE creator_reward_events SET status='consumed',consumed_at=$3
    WHERE id=$1 AND creator_user_id=$2 AND status='unconsumed' RETURNING ${rewardColumns}`,[eventId,creatorUserId,now]);return r.rows[0]?mapReward(r.rows[0]):null;}

  private async ensureAccounts(userId:string){await this.database.transaction(client=>ensureCommissionAccounts(client,userId).then(()=>undefined));}
  private async earnLocked(client:PoolClient,row:OrderRow,now:Date,days:number){
    const accounts=await ensureCommissionAccounts(client,row.creator_user_id);await postCommission(client,{id:randomUUID(),owner:`creator:${row.creator_user_id}`,scope:'COMMISSION_EARN',key:`earn:${row.order_kind}:${row.order_id}`,digest:`commission:${row.id}:earn`,associationId:row.id,description:'订单完成返佣待观察',entries:[
      {accountId:accounts.pending,amount:BigInt(row.commission_credit_micros),memo:'返佣待观察'},{accountId:COMMISSION_CLEARING,amount:-BigInt(row.commission_credit_micros),memo:'平台返佣负债'}]},now);
    const ends=new Date(now.getTime()+days*86_400_000);await client.query(`UPDATE creator_commission_orders SET status='refund_observation',completion_event_key=$2,completed_at=$3,observation_ends_at=$4 WHERE id=$1`,[row.id,`complete:${row.order_kind}:${row.order_id}`,now,ends]);
    await audit(client,'COMMISSION_REFUND_OBSERVATION',row.creator_user_id,null,row.id,null,`complete:${row.order_kind}:${row.order_id}`,{observationEndsAt:ends.toISOString()});
  }
  private async matureLocked(client:PoolClient,row:OrderRow,now:Date){
    const accounts=await ensureCommissionAccounts(client,row.creator_user_id);await client.query(`UPDATE creator_commission_orders SET status='pending' WHERE id=$1`,[row.id]);await postCommission(client,{id:randomUUID(),owner:`creator:${row.creator_user_id}`,scope:'COMMISSION_MATURE',key:`mature:${row.order_kind}:${row.order_id}`,digest:`commission:${row.id}:mature`,associationId:row.id,description:'返佣观察期结束',entries:[
      {accountId:accounts.pending,amount:-BigInt(row.commission_credit_micros),memo:'待观察转出'},{accountId:accounts.available,amount:BigInt(row.commission_credit_micros),memo:'返佣可转入'}]},now);
    await client.query(`UPDATE creator_commission_orders SET status='available',available_at=$2 WHERE id=$1`,[row.id,now]);await audit(client,'COMMISSION_AVAILABLE',row.creator_user_id,null,row.id,null,`mature:${row.order_kind}:${row.order_id}`,{});
  }
  private async reverseLocked(client:PoolClient,row:OrderRow,event:string,now:Date){
    if(row.status==='refund_observation'||row.status==='available'){const accounts=await ensureCommissionAccounts(client,row.creator_user_id);const source=row.status==='available'?accounts.available:accounts.pending;await postCommission(client,{id:randomUUID(),owner:`creator:${row.creator_user_id}`,scope:'COMMISSION_REVERSE',key:`reverse:${row.order_kind}:${row.order_id}`,digest:`commission:${row.id}:reverse`,associationId:row.id,description:'订单退款返佣冲正',entries:[
      {accountId:source,amount:-BigInt(row.commission_credit_micros),memo:'返佣冲正'},{accountId:COMMISSION_CLEARING,amount:BigInt(row.commission_credit_micros),memo:'平台负债冲回'}]},now);}
    await client.query(`UPDATE creator_commission_orders SET status='reversed',reversal_event_key=$2,reversed_at=$3,
      observation_ends_at=NULL,available_at=NULL WHERE id=$1`,[row.id,event,now]);await audit(client,'COMMISSION_REVERSED',row.creator_user_id,null,row.id,null,event,{});
  }
}

async function ensureCommissionAccounts(client:PoolClient,userId:string){for(const kind of ['pending','available','transferred'] as const)await client.query(`INSERT INTO creator_commission_accounts(id,owner_kind,creator_user_id,code,account_kind,allow_negative)
  VALUES($1,'creator',$2,$3,$4,false) ON CONFLICT(creator_user_id,account_kind) WHERE creator_user_id IS NOT NULL DO NOTHING`,[randomUUID(),userId,`creator-commission:${userId}:${kind}`,kind]);const r=await client.query<{id:string;account_kind:string}>(`SELECT id,account_kind FROM creator_commission_accounts WHERE creator_user_id=$1 ORDER BY id FOR UPDATE`,[userId]);return {pending:r.rows.find(x=>x.account_kind==='pending')!.id,available:r.rows.find(x=>x.account_kind==='available')!.id,transferred:r.rows.find(x=>x.account_kind==='transferred')!.id};}
async function accountBalance(client:PoolClient,id:string){const r=await client.query<{amount:string}>(`SELECT COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text amount FROM creator_commission_entries e JOIN creator_commission_transactions t ON t.id=e.transaction_id WHERE e.account_id=$1`,[id]);return BigInt(r.rows[0]?.amount??'0');}
async function ensureKaiAvailable(client:PoolClient,subjectId:string){await client.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative) VALUES($1,'subject',$2,$3,'available',false) ON CONFLICT(subject_id,account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,[randomUUID(),subjectId,`subject:${subjectId}:available`]);const r=await client.query<{id:string}>(`SELECT id FROM kai_credit_accounts WHERE subject_id=$1 AND account_kind='available' FOR UPDATE`,[subjectId]);if(!r.rows[0])throw new Error('KAI_AVAILABLE_ACCOUNT_REQUIRED');return r.rows[0].id;}
async function postCommission(client:PoolClient,input:{id:string;owner:string;scope:string;key:string;digest:string;associationId:string|null;description:string;entries:{accountId:string;amount:bigint;memo:string}[]},now:Date){if(input.entries.length<2||input.entries.some(e=>e.amount===0n||e.amount%10000n!==0n)||input.entries.reduce((s,e)=>s+e.amount,0n)!==0n)throw new Error('COMMISSION_LEDGER_CENT_BALANCE_REQUIRED');await client.query(`INSERT INTO creator_commission_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,association_id,description,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending')`,[input.id,input.owner,input.scope,input.key,input.digest,input.associationId,input.description]);for(const e of input.entries)await client.query(`INSERT INTO creator_commission_entries(id,transaction_id,account_id,amount_micros,memo) VALUES($1,$2,$3,$4,$5)`,[randomUUID(),input.id,e.accountId,e.amount.toString(),e.memo]);await client.query(`UPDATE creator_commission_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[input.id,now]);}
async function audit(client:PoolClient,type:string,creator:string|null,actor:string|null,association:string|null,attribution:string|null,key:string|null,payload:unknown){await client.query(`INSERT INTO creator_commission_audit_events(id,event_type,creator_user_id,actor_user_id,association_id,attribution_id,idempotency_key,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,[randomUUID(),type,creator,actor,association,attribution,key,JSON.stringify(payload)]);}
function mapLink(r:LinkRow):ReferralLinkRecord{return{id:r.id,creatorUserId:r.creator_user_id,code:r.code,clientRequestId:r.client_request_id,payloadDigest:r.payload_digest,policyVersion:r.policy_version,commissionBasisPoints:r.commission_basis_points,status:r.status,expiresAt:new Date(r.expires_at),createdAt:new Date(r.created_at)}}
function mapAttribution(r:AttributionRow):AttributionRecord{return{id:r.id,buyerUserId:r.buyer_user_id,buyerSubjectId:r.buyer_subject_id,linkId:r.link_id,creatorUserId:r.creator_user_id,providerSource:r.provider_source,providerEventId:r.provider_event_id,payloadDigest:r.payload_digest,status:r.status,attributedAt:new Date(r.attributed_at),expiresAt:new Date(r.expires_at)}}
function mapOrder(r:OrderRow):CommissionOrderRecord{return{id:r.id,orderKind:r.order_kind,orderId:r.order_id,creatorUserId:r.creator_user_id,buyerSubjectId:r.buyer_subject_id,grossCreditMicros:BigInt(r.gross_credit_micros),commissionCreditMicros:BigInt(r.commission_credit_micros),policyVersion:r.policy_version,status:r.status,completedAt:r.completed_at?new Date(r.completed_at):null,observationEndsAt:r.observation_ends_at?new Date(r.observation_ends_at):null,availableAt:r.available_at?new Date(r.available_at):null,createdAt:new Date(r.created_at),updatedAt:new Date(r.updated_at)}}
function mapReward(r:RewardRow):RewardEventRecord{return{id:r.id,creatorUserId:r.creator_user_id,transferId:r.transfer_id,creditMicros:BigInt(r.credit_micros),status:r.status,createdAt:new Date(r.created_at),consumedAt:r.consumed_at?new Date(r.consumed_at):null}}
