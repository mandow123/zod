import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite,type Results,type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe,expect,it } from 'vitest';
import type { Database } from '../src/database.js';
import { loadConfig } from '../src/config.js';
import { FirstPartyAttributionProvider } from '../src/creator-commissions/provider.js';
import { PostgresCreatorCommissionStore } from '../src/creator-commissions/store.js';
import type { CreatorCommissionStore } from '../src/creator-commissions/store.js';
import { CreatorCommissionService } from '../src/creator-commissions/service.js';
import { PostgresCreditLedgerStore } from '../src/credits/store.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../src/credits/types.js';
import { PostgresVastMarketStore,type VastQuoteRecord } from '../src/vast-market/store.js';

function result<T>(value:Results<T>){return{...value,rowCount:value.rows.length||value.affectedRows||0,command:'',oid:0,rowAsArray:false};}
function adapter(p:PGlite):Database{return{health:async()=>true,schemaReadiness:async()=>({ready:true,expected:null,applied:null,missing:[],mismatched:[]}),
  query:async<Row extends Record<string,unknown>>(text:string,values?:unknown[])=>result(await p.query<Row>(text,values)),
  transaction:async<T>(work:(client:PoolClient)=>Promise<T>)=>p.transaction(async(tx:Transaction)=>work({query:async(text:string,values?:unknown[])=>result(await tx.query(text,values))}as unknown as PoolClient)),close:()=>p.close()}as unknown as Database;}
async function migrate(p:PGlite){for(const name of(await readdir(new URL('../migrations',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())
  await p.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`,import.meta.url)),'utf8'));}

describe('creator commission contract',()=>{
  it('fails closed unless the signed-link secret and strict policy are both valid',()=>{
    const valid=loadConfig({CREATOR_REFERRAL_SIGNING_SECRET:'s'.repeat(32),CREATOR_COMMISSION_POLICY_JSON:JSON.stringify({
      version:'creator-v1',commissionBasisPoints:1000,attributionTtlDays:30,refundObservationDays:7,
    })});
    expect(valid.readiness.capabilities.creatorCommissions.available).toBe(true);
    expect(valid.creatorCommissionPolicy).toMatchObject({version:'creator-v1',commissionBasisPoints:1000});
    const invalid=loadConfig({CREATOR_REFERRAL_SIGNING_SECRET:'short',CREATOR_COMMISSION_POLICY_JSON:'{}'});
    expect(invalid.readiness.capabilities.creatorCommissions.available).toBe(false);
    expect(invalid.creatorCommissionPolicy).toBeNull();
  });
  it('signs first-party attribution without accepting tampering or expiry',async()=>{
    const provider=new FirstPartyAttributionProvider('creator-referral-secret-that-is-long-enough');
    const expiresAt=new Date(Date.now()+60_000),linkId=randomUUID();
    const token=provider.issue({code:'CREATOR12345',linkId,expiresAt});
    await expect(provider.verify(token,new Date())).resolves.toMatchObject({providerSource:'first_party',code:'CREATOR12345',linkId});
    await expect(provider.verify(`${token.slice(0,-1)}x`,new Date())).rejects.toThrow('REFERRAL_SIGNATURE_INVALID');
    await expect(provider.verify(token,new Date(expiresAt.getTime()+1))).rejects.toThrow('REFERRAL_TOKEN_EXPIRED');
  });

  it('serializes only fixed two-decimal card-hours',async()=>{
    const userId=randomUUID(),subjectId=randomUUID(),now=new Date();
    const store={summary:async()=>({pendingMicros:1_200_000n,availableMicros:340_000n,transferredMicros:0n,orders:[{
      id:randomUUID(),orderKind:'vast_order' as const,orderId:randomUUID(),creatorUserId:userId,buyerSubjectId:randomUUID(),
      grossCreditMicros:3_000_000n,commissionCreditMicros:300_000n,policyVersion:'creator-v1',status:'available' as const,
      completedAt:now,observationEndsAt:now,availableAt:now,createdAt:now,updatedAt:now,
    }]})}as unknown as CreatorCommissionStore;
    const subjects={current:async()=>({subjectId,userId,kind:'personal' as const,displayName:'达人',subjectStatus:'active' as const,
      role:'owner' as const,permissions:['credits.read' as const]})};
    const service=new CreatorCommissionService(store,subjects,new FirstPartyAttributionProvider('creator-referral-secret-that-is-long-enough'),null,'https://cloudpay.kai.com');
    const response=await service.summary({userId,sessionId:randomUUID(),role:'member'});
    expect(response).toMatchObject({unit:'KAI_CARD_HOUR',precision:2,balances:{pendingCardHours:'1.20',availableCardHours:'0.34',
      transferredCardHours:'0.00'},commissions:[{commissionCardHours:'0.30'}]});
    expect(JSON.stringify(response)).not.toMatch(/(?:cny|rmb|yuan|referencePrice)/iu);
  });

  it('does not let more than 100 old open orders starve later completion, maturity, or reversal',{timeout:30_000},async()=>{
    const p=new PGlite();await migrate(p);const db=adapter(p),store=new PostgresCreatorCommissionStore(db);
    const creatorUser=randomUUID(),buyerUser=randomUUID(),creatorSubject=randomUUID(),buyerSubject=randomUUID();
    await db.query(`INSERT INTO users(id,phone_ciphertext,display_name)VALUES($1,'creator-starve','达人'),($2,'buyer-starve','买家')`,[creatorUser,buyerUser]);
    await db.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)VALUES($1,'personal','达人',$2),($3,'personal','买家',$4)`,[creatorSubject,creatorUser,buyerSubject,buyerUser]);
    const base=new Date(),attributedAt=new Date(base.getTime()-10_000),linkId=randomUUID();
    const link=await store.createLink({id:linkId,creatorUserId:creatorUser,code:'STARVE123456',clientRequestId:'creator-starve-link-0001',
      payloadDigest:`sha256:${'1'.repeat(64)}`,policy:{version:'creator-v1',commissionBasisPoints:1000,attributionTtlDays:30,refundObservationDays:1},
      expiresAt:new Date(base.getTime()+30*86_400_000),now:attributedAt});
    if(link.status==='conflict')throw new Error('missing starvation link');
    await store.attribute({id:randomUUID(),buyerUserId:buyerUser,buyerSubjectId:buyerSubject,link:link.link,
      providerSource:'first_party',providerEventId:`first-party:${linkId}:${buyerSubject}`,payloadDigest:`sha256:${'2'.repeat(64)}`,
      expiresAt:new Date(base.getTime()+30*86_400_000),now:attributedAt});
    const actionable:Array<{orderId:string;reservationId:string}>=[];
    for(let index=0;index<103;index+=1){const quoteId=randomUUID(),orderId=randomUUID(),reservationId=randomUUID();
      const captureId=index>=101?randomUUID():null,createdAt=new Date(base.getTime()+index);
      await db.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
        reference_type,description,status) VALUES($1,'creator-starve','STARVE_RESERVE',$2,$3,'adjustment','测试预留','pending')`,
      [reservationId,`starve-reserve-${reservationId}`,`sha256:${'3'.repeat(64)}`]);
      if(captureId)await db.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
        reference_type,description,status) VALUES($1,'creator-starve','STARVE_CAPTURE',$2,$3,'adjustment','测试扣除','pending')`,
      [captureId,`starve-capture-${captureId}`,`sha256:${'4'.repeat(64)}`]);
      await db.query(`INSERT INTO vast_external_quotes(id,buyer_subject_id,provider_source,provider_offer_id,configuration,
        provider_snapshot,provider_cost_micros_per_hour,credit_micros_per_hour,duration_hours,total_credit_micros,
        pricing_policy_version,status,quoted_at,expires_at,created_at) VALUES($1,$2,'vast_ai',$3,'{}'::jsonb,$4::jsonb,
        100000,1000000,1,1000000,'starve-v1','consumed',$5,$6,$5)`,[quoteId,buyerSubject,String(10_000+index),
        JSON.stringify({gpuName:'H100',gpuCount:1,gpuMemoryMb:81920,region:'CN',reliability:1,updatedAt:createdAt.toISOString()}),
        createdAt,new Date(createdAt.getTime()+60_000)]);
      await db.query(`INSERT INTO vast_external_orders(id,order_number,buyer_subject_id,created_by_user_id,quote_id,
        client_request_id,payload_digest,provider_source,provider_offer_id,provider_request_key,provider_contract_id,
        configuration,status,total_credit_micros,reservation_transaction_id,capture_transaction_id,
        reconciliation_deadline_at,provisioning_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'vast_ai',$8,$9,$10,
        '{}'::jsonb,$11,1000000,$12,$13,$14,$15,$16,$16)`,[orderId,`ZVSTARVE${String(index).padStart(6,'0')}`,
        buyerSubject,buyerUser,quoteId,`starve-order-${orderId}`,`sha256:${'5'.repeat(64)}`,String(10_000+index),randomUUID(),
        captureId?String(20_000+index):null,captureId?'provisioning':'reserved',reservationId,captureId,
        new Date(createdAt.getTime()+300_000),captureId?createdAt:null,createdAt]);
      if(captureId)actionable.push({orderId,reservationId});
    }
    expect(await store.discoverEligibleOrders(base)).toBe(103);
    const concurrent=await Promise.all([store.reconcileLifecycle(base,1,100),store.reconcileLifecycle(base,1,100)]);
    expect(concurrent.reduce((sum,item)=>sum+item.completed,0)).toBe(2);
    expect(concurrent.reduce((sum,item)=>sum+item.matured+item.reversed,0)).toBe(0);
    const refunded=actionable[1]!;await db.query(`ALTER TABLE vast_external_orders DISABLE TRIGGER USER`);
    await db.query(`UPDATE vast_external_orders SET status='failed',provider_contract_id=NULL,capture_transaction_id=NULL,
      release_transaction_id=$2,provisioning_at=NULL,failure_code='PROVIDER_REFUND',failed_at=$3 WHERE id=$1`,
    [refunded.orderId,refunded.reservationId,new Date(base.getTime()+1_000)]);
    await db.query(`ALTER TABLE vast_external_orders ENABLE TRIGGER USER`);
    expect(await store.reconcileLifecycle(new Date(base.getTime()+2_000),1,100)).toEqual({completed:0,matured:0,reversed:1});
    expect(await store.reconcileLifecycle(new Date(base.getTime()+2*86_400_000),1,100)).toEqual({completed:0,matured:1,reversed:0});
    const states=await db.query<{status:string;count:string}>(`SELECT status,count(*)::text count FROM creator_commission_orders GROUP BY status`);
    expect(new Map(states.rows.map(row=>[row.status,row.count]))).toMatchObject(new Map([['attributed','101'],['available','1'],['reversed','1']]));
    await db.close();
  });

  it('keeps commission independent until explicit transfer and emits one consumable reward',{timeout:30_000},async()=>{
    const p=new PGlite();await migrate(p);const db=adapter(p);const store=new PostgresCreatorCommissionStore(db);
    const creatorUser=randomUUID(),buyerUser=randomUUID(),creatorSubject=randomUUID(),buyerSubject=randomUUID();
    await db.query(`INSERT INTO users(id,phone_ciphertext,display_name)VALUES($1,'creator-user','达人'),($2,'creator-buyer','买家')`,[creatorUser,buyerUser]);
    await db.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)VALUES($1,'personal','达人',$2),($3,'personal','买家',$4)`,[creatorSubject,creatorUser,buyerSubject,buyerUser]);
    const attributedAt=new Date(Date.now()-2_000),linkId=randomUUID();
    const created=await store.createLink({id:linkId,creatorUserId:creatorUser,code:'CREATOR12345',clientRequestId:'creator-link-request-0001',
      payloadDigest:`sha256:${'a'.repeat(64)}`,policy:{version:'creator-v1',commissionBasisPoints:1000,attributionTtlDays:30,refundObservationDays:1},
      expiresAt:new Date(Date.now()+30*86_400_000),now:attributedAt});
    if(created.status==='conflict')throw new Error('missing referral link');
    const attributed=await store.attribute({id:randomUUID(),buyerUserId:buyerUser,buyerSubjectId:buyerSubject,link:created.link,
      providerSource:'first_party',providerEventId:`first-party:${linkId}:${buyerSubject}`,payloadDigest:`sha256:${'b'.repeat(64)}`,
      expiresAt:new Date(Date.now()+30*86_400_000),now:attributedAt});
    expect(attributed.status).toBe('created');
    const ledger=new PostgresCreditLedgerStore(db),buyerAccounts=await ledger.ensureSubjectAccounts(buyerSubject);
    await ledger.post({id:randomUUID(),idempotencyOwner:`subject:${buyerSubject}`,scope:'CREATOR_TEST_FUND',
      idempotencyKey:`creator-fund-${randomUUID()}`,payloadDigest:`sha256:${'c'.repeat(64)}`,referenceType:'adjustment',description:'测试卡时',entries:[
        {accountId:buyerAccounts.find(account=>account.kind==='available')!.accountId,amountMicros:10_000_000n,memo:'测试入账'},
        {accountId:KAI_CREDIT_PLATFORM_ACCOUNTS.issuance,amountMicros:-10_000_000n,memo:'测试发行'}]});
    const vast=new PostgresVastMarketStore(db),quotedAt=new Date(),quoteId=randomUUID();
    const quote:VastQuoteRecord={id:quoteId,buyerSubjectId:buyerSubject,offer:{offerId:'7001',gpuName:'H100',gpuCount:1,gpuMemoryMb:81920,
      region:'Shanghai, CN',reliability:0.999,providerCostMicrosPerHour:500_000n,updatedAt:quotedAt},configuration:{image:'test',diskGb:32,runtype:'ssh'},
      creditMicrosPerHour:1_000_000n,durationHours:2,totalCreditMicros:2_000_000n,pricingPolicyVersion:'test-v1',status:'active',quotedAt,
      expiresAt:new Date(quotedAt.getTime()+120_000)};
    await vast.createQuote(quote);const orderId=randomUUID();const reserved=await vast.reserve({id:orderId,
      orderNumber:`ZV${orderId.replaceAll('-','').slice(0,20)}`,buyerSubjectId:buyerSubject,userId:buyerUser,quoteId,
      clientRequestId:`creator-order-${randomUUID()}`,payloadDigest:`sha256:${'d'.repeat(64)}`,providerRequestKey:randomUUID(),
      reconciliationDeadlineAt:new Date(Date.now()+300_000),now:new Date()});
    expect(reserved.status).toBe('created');await vast.markProvisioning(orderId,'7001',new Date());
    expect(await store.discoverEligibleOrders(new Date())).toBe(1);
    const earnedAt=new Date();expect(await store.reconcileLifecycle(earnedAt,1,100)).toMatchObject({completed:1});
    expect(await store.summary(creatorUser)).toMatchObject({pendingMicros:200_000n,availableMicros:0n,transferredMicros:0n});
    const preTransfer=await db.query<{count:string}>(`SELECT count(*)::text count FROM kai_credit_transactions WHERE scope='CREATOR_COMMISSION_TRANSFER'`);
    expect(preTransfer.rows[0]?.count).toBe('0');
    expect(await store.reconcileLifecycle(new Date(earnedAt.getTime()+2*86_400_000),1,100)).toMatchObject({matured:1});
    expect(await store.summary(creatorUser)).toMatchObject({pendingMicros:0n,availableMicros:200_000n,transferredMicros:0n});
    const transferInput={creatorUserId:creatorUser,targetSubjectId:creatorSubject,clientRequestId:'creator-transfer-request-0001',
      payloadDigest:`sha256:${'e'.repeat(64)}`,now:new Date()};
    const transfer=await store.transferAvailable(transferInput);expect(transfer).toMatchObject({status:'created',creditMicros:200_000n,reward:{status:'unconsumed'}});
    expect(await store.transferAvailable(transferInput)).toMatchObject({status:'replayed',creditMicros:200_000n});
    const rewards=await store.rewardEvents(creatorUser,20);expect(rewards).toHaveLength(1);
    expect(await store.consumeReward(creatorUser,rewards[0]!.id,new Date())).toMatchObject({status:'consumed'});
    expect(await store.consumeReward(creatorUser,rewards[0]!.id,new Date())).toBeNull();
    expect(await store.rewardEvents(creatorUser,20)).toEqual([]);
    const creatorAccounts=await ledger.ensureSubjectAccounts(creatorSubject);
    expect(creatorAccounts.find(account=>account.kind==='available')?.amountMicros).toBe(200_000n);
    const summary=await store.summary(creatorUser);expect(summary).toMatchObject({pendingMicros:0n,availableMicros:0n,transferredMicros:200_000n});

    const refundQuoteId=randomUUID(),refundOrderId=randomUUID();
    await vast.createQuote({...quote,id:refundQuoteId,offer:{...quote.offer,offerId:'7002'},quotedAt:new Date(),expiresAt:new Date(Date.now()+120_000)});
    const refundReserved=await vast.reserve({id:refundOrderId,orderNumber:`ZV${refundOrderId.replaceAll('-','').slice(0,20)}`,
      buyerSubjectId:buyerSubject,userId:buyerUser,quoteId:refundQuoteId,clientRequestId:`creator-refund-${randomUUID()}`,
      payloadDigest:`sha256:${'f'.repeat(64)}`,providerRequestKey:randomUUID(),reconciliationDeadlineAt:new Date(Date.now()+300_000),now:new Date()});
    expect(refundReserved.status).toBe('created');await vast.markProvisioning(refundOrderId,'7002',new Date());
    expect(await store.discoverEligibleOrders(new Date())).toBe(1);
    expect(await store.reconcileLifecycle(new Date(),1,100)).toMatchObject({completed:1});
    expect(await store.summary(creatorUser)).toMatchObject({pendingMicros:200_000n});
    const capture=await db.query<{capture_transaction_id:string}>(`SELECT capture_transaction_id::text FROM vast_external_orders WHERE id=$1`,[refundOrderId]);
    await db.query(`ALTER TABLE vast_external_orders DISABLE TRIGGER USER`);
    await db.query(`UPDATE vast_external_orders SET status='failed',provider_contract_id=NULL,capture_transaction_id=NULL,
      release_transaction_id=$2,provisioning_at=NULL,failure_code='PROVIDER_REFUND',failed_at=now() WHERE id=$1`,
    [refundOrderId,capture.rows[0]!.capture_transaction_id]);
    await db.query(`ALTER TABLE vast_external_orders ENABLE TRIGGER USER`);
    expect(await store.reconcileLifecycle(new Date(),1,100)).toMatchObject({reversed:1});
    expect(await store.summary(creatorUser)).toMatchObject({pendingMicros:0n,availableMicros:0n,transferredMicros:200_000n,
      orders:expect.arrayContaining([expect.objectContaining({orderId:refundOrderId,status:'reversed'})])});
    await db.close();
  });
});
