import { createHash,randomUUID } from 'node:crypto';
import type { PoolClient,QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../credits/types.js';
import { parsePolicySnapshot,rewardMicros } from './types.js';
import type { CommerceNetEvent,RewardDomain,RewardMode,RewardOrderClaimInput,RewardOrderKind } from './types.js';

const PLATFORM_CLEARING:Record<RewardDomain,string>={
  streamer:'00000000-0000-4000-8000-000000000301',
  invite:'00000000-0000-4000-8000-000000000302',
};
const DAY_MS=86_400_000;

type ClaimRow=QueryResultRow&{id:string;domain:RewardDomain;domain_order_id:string;order_kind:RewardOrderKind;order_id:string;
  buyer_user_id:string;buyer_subject_id:string;product_kind:string;product_id:string;policy_version:string;policy_snapshot:unknown;
  claimed_at:Date};
type OrderRow=QueryResultRow&{id:string;owner_user_id:string;status:'attributed'|'observation'|'available'|'transferred'|'reversed'|'recovery_required';
  reward_micros:string|null;final_net_consumed_micros:string|null;source_version:string|null;policy_version:string;
  basis_points:number;observation_days:number;available_at:Date|null;transferred_at:Date|null};
type ReceiptRow=QueryResultRow&{id:string;payload_digest:string;state:'claimed'|'processed'|'ignored'};

export type RewardClaimResult=Readonly<{
  status:'claimed'|'existing'|'unattributed'|'shadow_qualified'|'invite_already_rewarded';
  domain?:RewardDomain;
  claimId?:string;
  domainOrderId?:string;
}>;
export type RewardEventResult=Readonly<{
  status:'processed'|'replayed'|'ignored'|'retryable'|'conflict'|'unattributed'|'off'|'shadowed';
  domain?:RewardDomain;
  orderStatus?:OrderRow['status'];
  rewardMicros?:bigint;
}>;

export interface DualRewardStore {
  claimForOrder(input:RewardOrderClaimInput,modes?:Readonly<Record<RewardDomain,RewardMode>>):Promise<RewardClaimResult>;
  consume(event:CommerceNetEvent,modes:Readonly<Record<RewardDomain,RewardMode>>):Promise<RewardEventResult>;
  matureDue(now:Date,limit:number,modes:Readonly<Record<RewardDomain,RewardMode>>):Promise<number>;
  transferAvailable(input:Readonly<{domain:RewardDomain;ownerUserId:string;targetSubjectId:string;
    clientRequestId:string;payloadDigest:string;now:Date}>):Promise<Readonly<{
      status:'created'|'replayed'|'conflict'|'nothing_available'|'frozen';rewardMicros?:bigint;transferId?:string;
    }>>;
}

export class PostgresDualRewardStore implements DualRewardStore {
  constructor(private readonly database:Database) {}

  async claimForOrder(input:RewardOrderClaimInput,modes:Readonly<Record<RewardDomain,RewardMode>>={streamer:'on',invite:'on'}):Promise<RewardClaimResult> {
    if(modes.streamer==='off'&&modes.invite==='off')return{status:'unattributed'};
    return this.database.transaction(async(client)=>this.claimForOrderWithClient(client,input,modes));
  }

  // Commerce order stores can call this method with their own transaction client so
  // attribution and the immutable order claim commit atomically with order creation.
  async claimForOrderWithClient(client:PoolClient,input:RewardOrderClaimInput,
    modes:Readonly<Record<RewardDomain,RewardMode>>={streamer:'on',invite:'on'}):Promise<RewardClaimResult> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`reward-claim:${input.orderKind}:${input.orderId}`]);
    const existing=await client.query<ClaimRow>(`SELECT id,domain,domain_order_id,order_kind,order_id,buyer_user_id,
      buyer_subject_id,product_kind,product_id,policy_version,policy_snapshot,claimed_at FROM reward_order_claims
      WHERE order_kind=$1 AND order_id=$2 FOR UPDATE`,[input.orderKind,input.orderId]);
    if(existing.rows[0])return{status:'existing',domain:existing.rows[0].domain,claimId:existing.rows[0].id,
      domainOrderId:existing.rows[0].domain_order_id};

    const streamer=modes.streamer==='off'?{rows:[]} : await client.query<QueryResultRow&{attribution_id:string;promotion_code_id:string;partner_id:string;
      owner_user_id:string;policy_version:string;policy_snapshot:unknown}>(`SELECT a.id attribution_id,a.promotion_code_id,
      a.partner_id,a.owner_user_id,a.policy_version,a.policy_snapshot FROM streamer_attributions a
      JOIN streamer_partners p ON p.id=a.partner_id AND p.status='approved'
      JOIN streamer_promotion_codes c ON c.id=a.promotion_code_id AND c.status='active'
      WHERE a.buyer_user_id=$1 AND a.buyer_subject_id=$2 AND a.product_kind=$3 AND a.product_id=$4
        AND a.status='active' AND a.attributed_at<=$5 AND a.expires_at>$5 AND c.expires_at>$5
      ORDER BY a.attributed_at DESC,a.id DESC LIMIT 1 FOR UPDATE OF a`,[
      input.buyerUserId,input.buyerSubjectId,input.productKind,input.productId,input.orderedAt,
    ]);
    let shadowQualified=false;
    if(streamer.rows[0]&&modes.streamer==='shadow') {
      shadowQualified=true;
      await auditOnce(client,'STREAMER_REWARD_SHADOW_QUALIFIED','streamer',input.orderId,
        `shadow-claim:${input.orderKind}:${input.orderId}`,digestValue({policyVersion:streamer.rows[0].policy_version}),
        {orderKind:input.orderKind,orderId:input.orderId,productKind:input.productKind,productId:input.productId,
          policyVersion:streamer.rows[0].policy_version});
    }
    if(streamer.rows[0]&&modes.streamer==='on') {
      const row=streamer.rows[0],policy=parsePolicySnapshot('streamer',row.policy_snapshot);
      if(policy.version!==row.policy_version)throw new Error('STREAMER_POLICY_SNAPSHOT_VERSION_MISMATCH');
      const domainOrderId=randomUUID();
      await client.query(`INSERT INTO streamer_commission_orders(id,order_kind,order_id,attribution_id,
        promotion_code_id,partner_id,owner_user_id,buyer_user_id,buyer_subject_id,product_kind,product_id,
        policy_version,policy_snapshot,basis_points,observation_days,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$16)`,[
        domainOrderId,input.orderKind,input.orderId,row.attribution_id,row.promotion_code_id,row.partner_id,row.owner_user_id,
        input.buyerUserId,input.buyerSubjectId,input.productKind,input.productId,row.policy_version,JSON.stringify(policy),
        policy.basisPoints,policy.refundObservationDays,input.orderedAt,
      ]);
      return this.insertClaim(client,'streamer',domainOrderId,input,row.policy_version,policy);
    }

    const invite=modes.invite==='off'?{rows:[]} : await client.query<QueryResultRow&{attribution_id:string;invite_code_id:string;inviter_user_id:string;
      policy_version:string;policy_snapshot:unknown}>(`SELECT a.id attribution_id,a.invite_code_id,a.inviter_user_id,
      a.policy_version,a.policy_snapshot FROM invite_attributions a
      JOIN invite_codes c ON c.id=a.invite_code_id AND c.status='active'
      JOIN users u ON u.id=a.inviter_user_id AND u.status='active'
      JOIN trading_subjects s ON s.id=a.inviter_subject_id AND s.status='active'
      WHERE a.invitee_user_id=$1 AND a.invitee_subject_id=$2 AND a.registered_at<=$3
        AND a.first_order_deadline>=$3 AND c.expires_at>$3
      LIMIT 1 FOR UPDATE OF a`,[input.buyerUserId,input.buyerSubjectId,input.orderedAt]);
    if(!invite.rows[0])return{status:shadowQualified?'shadow_qualified':'unattributed'};
    if(modes.invite==='shadow') {
      await auditOnce(client,'INVITE_REWARD_SHADOW_QUALIFIED','invite',input.orderId,
        `shadow-claim:${input.orderKind}:${input.orderId}`,digestValue({policyVersion:invite.rows[0].policy_version}),
        {orderKind:input.orderKind,orderId:input.orderId,productKind:input.productKind,productId:input.productId,
          policyVersion:invite.rows[0].policy_version});
      return{status:'shadow_qualified'};
    }
    const row=invite.rows[0],policy=parsePolicySnapshot('invite',row.policy_snapshot);
    if(policy.version!==row.policy_version)throw new Error('INVITE_POLICY_SNAPSHOT_VERSION_MISMATCH');
    const prior=await client.query(`SELECT id FROM invite_reward_orders WHERE invitee_user_id=$1 LIMIT 1 FOR UPDATE`,[input.buyerUserId]);
    if(prior.rows[0])return{status:'invite_already_rewarded'};
    const domainOrderId=randomUUID();
    await client.query(`INSERT INTO invite_reward_orders(id,order_kind,order_id,attribution_id,invite_code_id,
      inviter_user_id,invitee_user_id,buyer_subject_id,product_kind,product_id,policy_version,policy_snapshot,
      basis_points,observation_days,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$15)`,[
      domainOrderId,input.orderKind,input.orderId,row.attribution_id,row.invite_code_id,row.inviter_user_id,
      input.buyerUserId,input.buyerSubjectId,input.productKind,input.productId,row.policy_version,JSON.stringify(policy),
      policy.basisPoints,policy.refundObservationDays,input.orderedAt,
    ]);
    return this.insertClaim(client,'invite',domainOrderId,input,row.policy_version,policy);
  }

  async consume(event:CommerceNetEvent,modes:Readonly<Record<RewardDomain,RewardMode>>):Promise<RewardEventResult> {
    if(modes.streamer==='off'&&modes.invite==='off')return{status:'off'};
    return this.database.transaction(async(client)=>{
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`reward-event:${event.source}:${event.eventId}`]);
      const claimResult=await client.query<ClaimRow>(`SELECT id,domain,domain_order_id,order_kind,order_id,buyer_user_id,
        buyer_subject_id,product_kind,product_id,policy_version,policy_snapshot,claimed_at FROM reward_order_claims
        WHERE order_kind=$1 AND order_id=$2 FOR UPDATE`,[event.orderKind,event.orderId]);
      const claim=claimResult.rows[0];
      if(!claim)return{status:'unattributed'};
      const mode=modes[claim.domain];
      if(mode==='off')return{status:'off',domain:claim.domain};
      const payloadDigest=eventDigest(event);
      const existingReceipt=await this.existingReceipt(client,claim.domain,event,payloadDigest);
      if(existingReceipt)return{status:existingReceipt,domain:claim.domain};
      if(mode==='shadow') {
        const receipt=await this.claimReceipt(client,claim.domain,event,payloadDigest);
        if(receipt.status!=='claimed')return{status:receipt.status,domain:claim.domain};
        await this.finishReceipt(client,receipt.id,'ignored',eventTime(event));
        await auditOnce(client,`${claim.domain.toUpperCase()}_REWARD_SHADOW_EVENT`,claim.domain,claim.domain_order_id,
          event.eventId,payloadDigest,{sourceVersion:event.sourceVersion.toString(),eventType:event.type});
        return{status:'shadowed',domain:claim.domain};
      }
      if(!matchesClaim(claim,event)) {
        const receipt=await this.claimReceipt(client,claim.domain,event,payloadDigest);
        if(receipt.status!=='claimed')return{status:receipt.status,domain:claim.domain};
        await this.finishReceipt(client,receipt.id,'ignored',eventTime(event));
        await auditOnce(client,`${claim.domain.toUpperCase()}_REWARD_EVENT_MISMATCH`,claim.domain,claim.domain_order_id,
          event.eventId,payloadDigest,{sourceVersion:event.sourceVersion.toString()});
        return{status:'ignored',domain:claim.domain};
      }
      const order=await this.lockOrder(client,claim.domain,claim.domain_order_id);
      if(order.source_version!==null&&event.sourceVersion<=BigInt(order.source_version)) {
        const receipt=await this.claimReceipt(client,claim.domain,event,payloadDigest);
        if(receipt.status!=='claimed')return{status:receipt.status,domain:claim.domain};
        await this.finishReceipt(client,receipt.id,'ignored',eventTime(event));
        await auditOnce(client,`${claim.domain.toUpperCase()}_REWARD_OLD_SOURCE_VERSION`,claim.domain,order.id,
          event.eventId,payloadDigest,{sourceVersion:event.sourceVersion.toString(),currentSourceVersion:order.source_version});
        return{status:'ignored',domain:claim.domain,orderStatus:order.status};
      }
      if(event.type==='commerce.order.net_revised.v1') {
        const currentNet=order.final_net_consumed_micros===null?null:BigInt(order.final_net_consumed_micros);
        if(order.status==='attributed'||(['observation','available','transferred','recovery_required'].includes(order.status)
          &&currentNet!==event.previousNetConsumedMicros)) {
          await auditOnce(client,`${claim.domain.toUpperCase()}_REWARD_REVISION_DEFERRED`,claim.domain,order.id,
            event.eventId,payloadDigest,{sourceVersion:event.sourceVersion.toString(),
              currentSourceVersion:order.source_version,currentNetConsumedMicros:currentNet?.toString()??null,
              expectedPreviousNetConsumedMicros:event.previousNetConsumedMicros.toString()});
          return{status:'retryable',domain:claim.domain,orderStatus:order.status};
        }
      }
      const receipt=await this.claimReceipt(client,claim.domain,event,payloadDigest);
      if(receipt.status!=='claimed')return{status:receipt.status,domain:claim.domain};
      const result=event.type==='commerce.order.net_settled.v1'
        ?await this.applySettled(client,claim,order,event,payloadDigest)
        :await this.applyRevised(client,claim,order,event,payloadDigest);
      await this.finishReceipt(client,receipt.id,result.status==='ignored'?'ignored':'processed',eventTime(event));
      return result;
    });
  }

  async matureDue(now:Date,limit:number,modes:Readonly<Record<RewardDomain,RewardMode>>) {
    let matured=0;
    for(const domain of ['streamer','invite'] as const) {
      if(modes[domain]!=='on')continue;
      let domainMatured=0;
      while(domainMatured<limit) {
        const changed=await this.database.transaction(async(client)=>{
          const table=orderTable(domain),owner=ownerColumn(domain);
          const result=await client.query<OrderRow>(`SELECT o.id,o.${owner} owner_user_id,o.status,o.reward_micros::text,
            o.final_net_consumed_micros::text,o.source_version::text,o.policy_version,o.basis_points,o.observation_days,
            o.available_at,o.transferred_at FROM ${table} o
            WHERE o.status='observation' AND o.observation_ends_at<=$1
            ORDER BY o.observation_ends_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`,[now]);
          const order=result.rows[0];if(!order)return false;
          const amount=BigInt(order.reward_micros??'0');
          if(amount<=0n)throw new Error('REWARD_MATURE_AMOUNT_INVALID');
          const accounts=await ensureAccounts(client,domain,order.owner_user_id);
          const tx=await postReward(client,{domain,owner:`${domain}:${order.owner_user_id}`,scope:'REWARD_MATURE',
            key:`mature:${order.id}`,digest:`reward:${domain}:${order.id}:mature`,associationId:order.id,
            description:'返佣观察期结束',entries:[{accountId:accounts.pending,amount:-amount,memo:'待观察转出'},
              {accountId:accounts.available,amount,memo:'返佣可转入'}]},now);
          await client.query(`UPDATE ${table} SET status='available',available_at=$2 WHERE id=$1`,[order.id,now]);
          await economicEvent(client,domain,'matured','available',order,amount,tx,order.source_version??'0',now);
          return true;
        });
        if(!changed)break;
        domainMatured+=1;
        matured+=1;
      }
    }
    return matured;
  }

  async transferAvailable(input:Readonly<{domain:RewardDomain;ownerUserId:string;targetSubjectId:string;
    clientRequestId:string;payloadDigest:string;now:Date}>) {
    return this.database.transaction(async(client)=>{
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[
        `reward-transfer:${input.domain}:${input.ownerUserId}:${input.clientRequestId}`,
      ]);
      const scope=`${input.domain.toUpperCase()}_REWARD_TRANSFER`;
      const inserted=await client.query(`INSERT INTO idempotency_records(id,actor_id,scope,idempotency_key,payload_hash,
        state,expires_at) VALUES($1,$2,$3,$4,$5,'processing',$6) ON CONFLICT(actor_id,scope,idempotency_key) DO NOTHING
        RETURNING id`,[randomUUID(),input.ownerUserId,scope,input.clientRequestId,input.payloadDigest,
        new Date(input.now.getTime()+DAY_MS)]);
      if(!inserted.rows[0]) {
        const prior=await client.query<{payload_hash:string;state:string;response_body:Record<string,string>|null}>(`SELECT
          payload_hash,state,response_body FROM idempotency_records WHERE actor_id=$1 AND scope=$2 AND idempotency_key=$3
          FOR UPDATE`,[input.ownerUserId,scope,input.clientRequestId]);
        if(!prior.rows[0]||prior.rows[0].payload_hash!==input.payloadDigest)return{status:'conflict' as const};
        if(prior.rows[0].state==='completed'&&prior.rows[0].response_body?.rewardMicros
          &&prior.rows[0].response_body.transferId)return{status:'replayed' as const,
          rewardMicros:BigInt(prior.rows[0].response_body.rewardMicros),transferId:prior.rows[0].response_body.transferId};
        return{status:'conflict' as const};
      }
      const accounts=await ensureAccounts(client,input.domain,input.ownerUserId);
      const states=await client.query<{account_kind:string;status:string}>(`SELECT account_kind,status FROM reward_accounts
        WHERE id=ANY($1::uuid[]) FOR UPDATE`,[[accounts.pending,accounts.available,accounts.transferred]]);
      if(states.rows.some(row=>row.status!=='active')) {
        await releaseIdempotency(client,input.ownerUserId,scope,input.clientRequestId);
        return{status:'frozen' as const};
      }
      const amount=await accountBalance(client,accounts.available);
      if(amount<=0n) {
        await releaseIdempotency(client,input.ownerUserId,scope,input.clientRequestId);
        return{status:'nothing_available' as const};
      }
      const transferId=randomUUID(),rewardTransactionId=randomUUID(),kaiTransactionId=randomUUID();
      await postReward(client,{id:rewardTransactionId,domain:input.domain,owner:`${input.domain}:${input.ownerUserId}`,
        scope:'REWARD_TRANSFER',key:`transfer:${transferId}`,digest:input.payloadDigest,associationId:null,
        description:'返佣转入 KAI 卡时',entries:[{accountId:accounts.available,amount:-amount,memo:'可用返佣转出'},
          {accountId:accounts.transferred,amount,memo:'累计已转入'}]},input.now);
      const kaiAccount=await ensureKaiAvailable(client,input.targetSubjectId);
      await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
        reference_type,reference_id,description,status) VALUES($1,$2,$3,$4,$5,'adjustment',$6,'返佣转入卡时','pending')`,[
        kaiTransactionId,`subject:${input.targetSubjectId}`,scope,`reward-transfer:${transferId}`,input.payloadDigest,transferId,
      ]);
      await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
        ($1,$2,$3,$4,'返佣到账'),($5,$2,$6,$7,'返佣发行')`,[randomUUID(),kaiTransactionId,kaiAccount,amount.toString(),
        randomUUID(),KAI_CREDIT_PLATFORM_ACCOUNTS.issuance,(-amount).toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[kaiTransactionId,input.now]);
      await client.query(`INSERT INTO reward_transfers(id,domain,owner_user_id,target_subject_id,client_request_id,
        payload_digest,reward_micros,reward_transaction_id,kai_credit_transaction_id,status,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'succeeded',$10)`,[transferId,input.domain,input.ownerUserId,
        input.targetSubjectId,input.clientRequestId,input.payloadDigest,amount.toString(),rewardTransactionId,kaiTransactionId,input.now]);
      const table=orderTable(input.domain),owner=ownerColumn(input.domain);
      await client.query(`UPDATE ${table} SET status='transferred',transferred_at=$2
        WHERE ${owner}=$1 AND status='available'`,[input.ownerUserId,input.now]);
      await auditOnce(client,`${input.domain.toUpperCase()}_REWARD_TRANSFERRED`,input.domain,transferId,
        input.clientRequestId,input.payloadDigest,{rewardMicros:amount.toString(),policyVersion:null});
      await outbox(client,'reward.ledger.transferred',input.domain,transferId,
        {transferId,status:'transferred',micros:amount.toString(),policyVersion:null,sourceVersion:null,
          transactionId:rewardTransactionId});
      await outbox(client,`${input.domain}.reward.transferred`,input.domain,transferId,
        {transferId,status:'transferred',micros:amount.toString(),policyVersion:null,sourceVersion:null});
      const response={rewardMicros:amount.toString(),transferId};
      await client.query(`UPDATE idempotency_records SET state='completed',response_status=201,response_body=$4::jsonb,
        updated_at=$5 WHERE actor_id=$1 AND scope=$2 AND idempotency_key=$3`,[input.ownerUserId,scope,input.clientRequestId,
        JSON.stringify(response),input.now]);
      return{status:'created' as const,rewardMicros:amount,transferId};
    });
  }

  private async insertClaim(client:PoolClient,domain:RewardDomain,domainOrderId:string,input:RewardOrderClaimInput,
    policyVersion:string,policySnapshot:unknown):Promise<RewardClaimResult> {
    const claimId=randomUUID();
    await client.query(`INSERT INTO reward_order_claims(id,domain,order_kind,order_id,domain_order_id,buyer_user_id,
      buyer_subject_id,product_kind,product_id,policy_version,policy_snapshot,claimed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,[claimId,domain,input.orderKind,input.orderId,
      domainOrderId,input.buyerUserId,input.buyerSubjectId,input.productKind,input.productId,policyVersion,
      JSON.stringify(policySnapshot),input.orderedAt]);
    await auditOnce(client,`${domain.toUpperCase()}_REWARD_ORDER_CLAIMED`,domain,domainOrderId,
      `claim:${input.orderKind}:${input.orderId}`,digestValue(policySnapshot),{orderKind:input.orderKind,orderId:input.orderId,
        productKind:input.productKind,productId:input.productId,policyVersion});
    await outbox(client,`${domain}.order.claimed`,domain,domainOrderId,{domainOrderId,status:'attributed',
      policyVersion,sourceVersion:null});
    return{status:'claimed',domain,claimId,domainOrderId};
  }

  private async claimReceipt(client:PoolClient,domain:RewardDomain,event:CommerceNetEvent,payloadDigest:string):Promise<
    {status:'claimed';id:string}|{status:'replayed'|'conflict'}> {
    const id=randomUUID();
    const inserted=await client.query<ReceiptRow>(`INSERT INTO reward_event_receipts(id,domain,source,event_id,order_kind,
      order_id,payload_digest,source_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING
      RETURNING id,payload_digest,state`,[id,domain,event.source,event.eventId,event.orderKind,event.orderId,payloadDigest,
      event.sourceVersion.toString()]);
    if(inserted.rows[0])return{status:'claimed',id};
    const sameEvent=await client.query<ReceiptRow>(`SELECT id,payload_digest,state FROM reward_event_receipts
      WHERE domain=$1 AND source=$2 AND event_id=$3 FOR UPDATE`,[domain,event.source,event.eventId]);
    if(sameEvent.rows[0]?.payload_digest===payloadDigest)return{status:'replayed'};
    await auditOnce(client,`${domain.toUpperCase()}_REWARD_EVENT_CONFLICT`,domain,event.orderId,event.eventId,payloadDigest,
      {sourceVersion:event.sourceVersion.toString()});
    return{status:'conflict'};
  }

  private async existingReceipt(client:PoolClient,domain:RewardDomain,event:CommerceNetEvent,payloadDigest:string) {
    const result=await client.query<ReceiptRow>(`SELECT id,payload_digest,state FROM reward_event_receipts
      WHERE domain=$1 AND source=$2 AND event_id=$3 FOR UPDATE`,[domain,event.source,event.eventId]);
    if(!result.rows[0])return null;
    if(result.rows[0].payload_digest===payloadDigest)return'replayed' as const;
    await auditOnce(client,`${domain.toUpperCase()}_REWARD_EVENT_CONFLICT`,domain,event.orderId,event.eventId,payloadDigest,
      {sourceVersion:event.sourceVersion.toString()});
    return'conflict' as const;
  }

  private async finishReceipt(client:PoolClient,id:string,state:'processed'|'ignored',at:Date) {
    await client.query(`UPDATE reward_event_receipts SET state=$2,processed_at=$3 WHERE id=$1 AND state='claimed'`,[id,state,at]);
  }

  private async lockOrder(client:PoolClient,domain:RewardDomain,id:string):Promise<OrderRow> {
    const table=orderTable(domain),owner=ownerColumn(domain);
    const result=await client.query<OrderRow>(`SELECT id,${owner} owner_user_id,status,reward_micros::text,
      final_net_consumed_micros::text,source_version::text,policy_version,basis_points,observation_days,available_at,
      transferred_at FROM ${table} WHERE id=$1 FOR UPDATE`,[id]);
    if(!result.rows[0])throw new Error('REWARD_DOMAIN_ORDER_NOT_FOUND');return result.rows[0];
  }

  private async applySettled(client:PoolClient,claim:ClaimRow,order:OrderRow,event:Extract<CommerceNetEvent,
    {type:'commerce.order.net_settled.v1'}>,payloadDigest:string):Promise<RewardEventResult> {
    if(order.status!=='attributed')return{status:'ignored',domain:claim.domain,orderStatus:order.status};
    const amount=rewardMicros(event.finalNetConsumedMicros,order.basis_points),at=event.settledAt,table=orderTable(claim.domain);
    if(amount===0n) {
      await client.query(`UPDATE ${table} SET status='reversed',final_net_consumed_micros=$2,reward_micros=0,
        source_version=$3,source_event_id=$4,settled_at=$5,reversed_at=$5 WHERE id=$1`,[order.id,
        event.finalNetConsumedMicros.toString(),event.sourceVersion.toString(),event.eventId,at]);
      await auditOnce(client,`${claim.domain.toUpperCase()}_REWARD_ZERO_DISQUALIFIED`,claim.domain,order.id,event.eventId,
        payloadDigest,{sourceVersion:event.sourceVersion.toString(),finalNetConsumedMicros:event.finalNetConsumedMicros.toString(),
          rewardMicros:'0',policyVersion:order.policy_version});
      await outbox(client,`${claim.domain}.reward.reversed`,claim.domain,order.id,{domainOrderId:order.id,status:'reversed',
        micros:'0',policyVersion:order.policy_version,sourceVersion:event.sourceVersion.toString()});
      return{status:'processed',domain:claim.domain,orderStatus:'reversed',rewardMicros:0n};
    }
    const accounts=await ensureAccounts(client,claim.domain,order.owner_user_id);
    const tx=await postReward(client,{domain:claim.domain,owner:`${claim.domain}:${order.owner_user_id}`,
      scope:'REWARD_EARN',key:`earn:${event.source}:${event.eventId}`,digest:payloadDigest,associationId:order.id,
      description:'最终净消耗返佣待观察',entries:[{accountId:accounts.pending,amount,memo:'返佣待观察'},
        {accountId:PLATFORM_CLEARING[claim.domain],amount:-amount,memo:'平台返佣负债'}]},at);
    const observationEndsAt=new Date(at.getTime()+order.observation_days*DAY_MS);
    await client.query(`UPDATE ${table} SET status='observation',final_net_consumed_micros=$2,reward_micros=$3,
      source_version=$4,source_event_id=$5,settled_at=$6,observation_ends_at=$7 WHERE id=$1`,[order.id,
      event.finalNetConsumedMicros.toString(),amount.toString(),event.sourceVersion.toString(),event.eventId,at,observationEndsAt]);
    await economicEvent(client,claim.domain,'earned','observation',order,amount,tx,event.sourceVersion.toString(),at);
    return{status:'processed',domain:claim.domain,orderStatus:'observation',rewardMicros:amount};
  }

  private async applyRevised(client:PoolClient,claim:ClaimRow,order:OrderRow,event:Extract<CommerceNetEvent,
    {type:'commerce.order.net_revised.v1'}>,payloadDigest:string):Promise<RewardEventResult> {
    const currentNet=order.final_net_consumed_micros===null?null:BigInt(order.final_net_consumed_micros);
    const oldReward=order.reward_micros===null?0n:BigInt(order.reward_micros);
    if(currentNet===null||currentNet!==event.previousNetConsumedMicros
      || !['observation','available','transferred','recovery_required'].includes(order.status)) {
      await auditOnce(client,`${claim.domain.toUpperCase()}_REWARD_REVISION_IGNORED`,claim.domain,order.id,event.eventId,
        payloadDigest,{sourceVersion:event.sourceVersion.toString(),currentNetConsumedMicros:currentNet?.toString()??null});
      return{status:'ignored',domain:claim.domain,orderStatus:order.status};
    }
    const nextReward=rewardMicros(event.newNetConsumedMicros,order.basis_points);
    if(nextReward>=oldReward) {
      await auditOnce(client,`${claim.domain.toUpperCase()}_REWARD_NON_DECREASING_REVISION`,claim.domain,order.id,event.eventId,
        payloadDigest,{sourceVersion:event.sourceVersion.toString()});
      return{status:'ignored',domain:claim.domain,orderStatus:order.status};
    }
    const table=orderTable(claim.domain),at=event.revisedAt;
    if(order.status==='transferred'||order.status==='recovery_required') {
      await client.query(`UPDATE ${table} SET status='recovery_required',final_net_consumed_micros=$2,reward_micros=$3,
        source_version=$4,source_event_id=$5,recovery_required_at=COALESCE(recovery_required_at,$6) WHERE id=$1`,[order.id,event.newNetConsumedMicros.toString(),
        nextReward.toString(),event.sourceVersion.toString(),event.eventId,at]);
      await client.query(`UPDATE reward_accounts SET status='frozen' WHERE domain=$1 AND owner_user_id=$2
        AND account_kind IN ('pending','available') AND status='active'`,[claim.domain,order.owner_user_id]);
      await auditOnce(client,`${claim.domain.toUpperCase()}_REWARD_RECOVERY_REQUIRED`,claim.domain,order.id,event.eventId,
        payloadDigest,{sourceVersion:event.sourceVersion.toString(),previousRewardMicros:oldReward.toString(),
          revisedRewardMicros:nextReward.toString(),policyVersion:order.policy_version});
      await outbox(client,`${claim.domain}.reward.recovery_required`,claim.domain,order.id,{domainOrderId:order.id,
        status:'recovery_required',micros:(oldReward-nextReward).toString(),policyVersion:order.policy_version,
        sourceVersion:event.sourceVersion.toString()});
      return{status:'processed',domain:claim.domain,orderStatus:'recovery_required',rewardMicros:nextReward};
    }
    const reversal=oldReward-nextReward,accounts=await ensureAccounts(client,claim.domain,order.owner_user_id);
    const sourceAccount=order.status==='available'?accounts.available:accounts.pending;
    const tx=await postReward(client,{domain:claim.domain,owner:`${claim.domain}:${order.owner_user_id}`,
      scope:'REWARD_REVERSE',key:`reverse:${event.source}:${event.eventId}`,digest:payloadDigest,associationId:order.id,
      description:'净消耗修订返佣冲正',entries:[{accountId:sourceAccount,amount:-reversal,memo:'返佣冲正'},
        {accountId:PLATFORM_CLEARING[claim.domain],amount:reversal,memo:'平台负债冲回'}]},at);
    const nextStatus=nextReward===0n?'reversed':order.status;
    await client.query(`UPDATE ${table} SET status=$2,final_net_consumed_micros=$3,reward_micros=$4,source_version=$5,
      source_event_id=$6,reversed_at=CASE WHEN $2='reversed' THEN $7 ELSE reversed_at END,
      observation_ends_at=CASE WHEN $2='reversed' THEN NULL ELSE observation_ends_at END,
      available_at=CASE WHEN $2='reversed' THEN NULL ELSE available_at END WHERE id=$1`,[order.id,nextStatus,
      event.newNetConsumedMicros.toString(),nextReward.toString(),event.sourceVersion.toString(),event.eventId,at]);
    await economicEvent(client,claim.domain,'reversed',nextStatus,order,reversal,tx,event.sourceVersion.toString(),at);
    return{status:'processed',domain:claim.domain,orderStatus:nextStatus,rewardMicros:nextReward};
  }
}

function orderTable(domain:RewardDomain){return domain==='streamer'?'streamer_commission_orders':'invite_reward_orders';}
function ownerColumn(domain:RewardDomain){return domain==='streamer'?'owner_user_id':'inviter_user_id';}
function eventTime(event:CommerceNetEvent){return event.type==='commerce.order.net_settled.v1'?event.settledAt:event.revisedAt;}
function matchesClaim(claim:ClaimRow,event:CommerceNetEvent){return claim.buyer_user_id===event.buyerUserId
  &&claim.buyer_subject_id===event.buyerSubjectId&&claim.product_kind===event.productKind&&claim.product_id===event.productId
  &&eventTime(event)>=new Date(claim.claimed_at);}

function eventDigest(event:CommerceNetEvent) {
  return digestValue(event.type==='commerce.order.net_settled.v1'?{
    ...event,sourceVersion:event.sourceVersion.toString(),finalNetConsumedMicros:event.finalNetConsumedMicros.toString(),
    settledAt:event.settledAt.toISOString(),
  }:{...event,sourceVersion:event.sourceVersion.toString(),previousNetConsumedMicros:event.previousNetConsumedMicros.toString(),
    newNetConsumedMicros:event.newNetConsumedMicros.toString(),revisedAt:event.revisedAt.toISOString()});
}
function digestValue(value:unknown){return`sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;}

async function ensureAccounts(client:PoolClient,domain:RewardDomain,userId:string) {
  for(const kind of ['pending','available','transferred'] as const)await client.query(`INSERT INTO reward_accounts(
    id,domain,owner_kind,owner_user_id,code,account_kind,allow_negative) VALUES($1,$2,'user',$3,$4,$5,false)
    ON CONFLICT(domain,owner_user_id,account_kind) WHERE owner_user_id IS NOT NULL DO NOTHING`,[
    randomUUID(),domain,userId,`reward:${domain}:${userId}:${kind}`,kind,
  ]);
  const result=await client.query<{id:string;account_kind:string}>(`SELECT id,account_kind FROM reward_accounts
    WHERE domain=$1 AND owner_user_id=$2 ORDER BY id FOR UPDATE`,[domain,userId]);
  const id=(kind:string)=>{const value=result.rows.find(row=>row.account_kind===kind)?.id;if(!value)throw new Error('REWARD_ACCOUNT_REQUIRED');return value;};
  return{pending:id('pending'),available:id('available'),transferred:id('transferred')};
}

async function postReward(client:PoolClient,input:{id?:string;domain:RewardDomain;owner:string;scope:'REWARD_EARN'|'REWARD_MATURE'|'REWARD_REVERSE'|'REWARD_TRANSFER';
  key:string;digest:string;associationId:string|null;description:string;entries:Array<{accountId:string;amount:bigint;memo:string}>},now:Date) {
  if(input.entries.length<2||input.entries.some(entry=>entry.amount===0n||entry.amount%10_000n!==0n)
    ||input.entries.reduce((sum,entry)=>sum+entry.amount,0n)!==0n)throw new Error('REWARD_LEDGER_CENT_BALANCE_REQUIRED');
  const id=input.id??randomUUID();
  await client.query(`INSERT INTO reward_transactions(id,domain,idempotency_owner,scope,idempotency_key,payload_digest,
    association_id,description,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,[id,input.domain,input.owner,
    input.scope,input.key,input.digest,input.associationId,input.description]);
  for(const entry of input.entries)await client.query(`INSERT INTO reward_entries(id,domain,transaction_id,account_id,
    amount_micros,memo) VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),input.domain,id,entry.accountId,entry.amount.toString(),entry.memo]);
  await client.query(`UPDATE reward_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[id,now]);
  return id;
}

async function accountBalance(client:PoolClient,accountId:string) {
  const result=await client.query<{amount:string}>(`SELECT COALESCE(sum(e.amount_micros)
    FILTER(WHERE t.status='posted'),0)::text amount FROM reward_entries e JOIN reward_transactions t ON t.id=e.transaction_id
    WHERE e.account_id=$1`,[accountId]);return BigInt(result.rows[0]?.amount??'0');
}

async function ensureKaiAvailable(client:PoolClient,subjectId:string) {
  await client.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
    VALUES($1,'subject',$2,$3,'available',false) ON CONFLICT(subject_id,account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
  [randomUUID(),subjectId,`subject:${subjectId}:available`]);
  const result=await client.query<{id:string}>(`SELECT id FROM kai_credit_accounts WHERE subject_id=$1
    AND account_kind='available' FOR UPDATE`,[subjectId]);
  if(!result.rows[0])throw new Error('KAI_AVAILABLE_ACCOUNT_REQUIRED');return result.rows[0].id;
}

async function releaseIdempotency(client:PoolClient,actorId:string,scope:string,key:string) {
  await client.query(`DELETE FROM idempotency_records WHERE actor_id=$1 AND scope=$2 AND idempotency_key=$3
    AND state='processing'`,[actorId,scope,key]);
}

async function economicEvent(client:PoolClient,domain:RewardDomain,ledgerEvent:'earned'|'matured'|'reversed',
  orderStatus:string,order:OrderRow,amount:bigint,
  transactionId:string,sourceVersion:string,now:Date) {
  await auditOnce(client,`${domain.toUpperCase()}_REWARD_${ledgerEvent.toUpperCase()}`,domain,order.id,
    `${ledgerEvent}:${order.id}:${sourceVersion}`,`reward:${domain}:${order.id}:${ledgerEvent}:${sourceVersion}`,
    {status:orderStatus,micros:amount.toString(),policyVersion:order.policy_version,sourceVersion,transactionId});
  await outbox(client,`reward.ledger.${ledgerEvent}`,domain,order.id,{domainOrderId:order.id,status:orderStatus,micros:amount.toString(),
    policyVersion:order.policy_version,sourceVersion,transactionId,occurredAt:now.toISOString()});
  await outbox(client,`${domain}.reward.${orderStatus}`,domain,order.id,{domainOrderId:order.id,status:orderStatus,
    micros:amount.toString(),policyVersion:order.policy_version,sourceVersion});
}

async function auditOnce(client:PoolClient,action:string,domain:RewardDomain,entityId:string,requestId:string,
  payloadDigest:string,metadata:Record<string,unknown>) {
  const existing=await client.query(`SELECT id FROM audit_events WHERE action=$1 AND entity_type=$2 AND entity_id=$3
    AND request_id=$4 LIMIT 1`,[action,`${domain}_reward`,entityId,requestId]);
  if(existing.rows[0])return;
  await client.query(`INSERT INTO audit_events(id,actor_id,actor_kind,action,entity_type,entity_id,request_id,
    payload_digest,metadata) VALUES($1,NULL,'system',$2,$3,$4,$5,$6,$7::jsonb)`,[randomUUID(),action,
    `${domain}_reward`,entityId,requestId,payloadDigest,JSON.stringify(metadata)]);
}

async function outbox(client:PoolClient,topic:string,domain:RewardDomain,aggregateId:string,payload:Record<string,unknown>) {
  await client.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,payload)
    VALUES($1,$2,$3,$4,$5::jsonb)`,[randomUUID(),topic,`${domain}_reward`,aggregateId,JSON.stringify(payload)]);
}
