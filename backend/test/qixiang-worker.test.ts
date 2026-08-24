import { randomUUID } from 'node:crypto';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { lookupHash } from '../src/account/crypto.js';
import type { Database } from '../src/database.js';
import { QixiangProvider } from '../src/payment/qixiang-provider.js';
import { migrationManifest } from '../src/schema.js';
import { PostgresQixiangTopupStore } from '../src/topups/qixiang-store.js';
import { QixiangQueryWorker } from '../src/topups/qixiang-worker.js';

function result<T>(value:Results<T>){return{...value,rowCount:value.rows.length||value.affectedRows||0,
  command:'',oid:0,rowAsArray:false};}
function adapter(pglite:PGlite):Database{return{health:async()=>true,
  schemaReadiness:async()=>({ready:true,expected:null,applied:null,missing:[],mismatched:[]}),
  query:async<Row extends Record<string,unknown>>(text:string,values?:unknown[])=>result(await pglite.query<Row>(text,values)),
  transaction:async<T>(work:(client:PoolClient)=>Promise<T>)=>pglite.transaction(async(transaction:Transaction)=>work({
    query:async(text:string,values?:unknown[])=>result(await transaction.query(text,values)),
  }as unknown as PoolClient)),close:()=>pglite.close()}as unknown as Database;}
const pepper='qixiang-worker-audit-pepper-for-tests';
const silent={info:()=>undefined,error:()=>undefined};
const databases:PGlite[]=[];

async function fixture(input:Readonly<{now:Date;fetcher:typeof fetch}>){
  const pglite=new PGlite();databases.push(pglite);for(const migration of await migrationManifest())await pglite.exec(migration.sql);
  const database=adapter(pglite),store=new PostgresQixiangTopupStore(database);const userId=randomUUID(),subjectId=randomUUID();
  await database.query(`INSERT INTO users(id,email_ciphertext,display_name)VALUES($1,'worker','查单用户')`,[userId]);
  await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)VALUES($1,'personal','查单主体',$2)`,
  [subjectId,userId]);const providerReference=`QX${randomUUID().replaceAll('-','').slice(0,30).toUpperCase()}`;
  const created=await store.prepare({id:randomUUID(),subjectId,userId,idempotencyKey:`create-${randomUUID()}`,
    payloadDigest:'a'.repeat(128),providerReference,amountCents:1002,cardHourCents:1000,
    creditMicros:10_000_000n,checkoutExpiresAt:new Date(input.now.getTime()+10_000),
    context:{requestId:'worker-create',ipHash:'b'.repeat(64),now:input.now}});
  if(created.status!=='created')throw new Error('fixture');let clock=input.now;const provider=new QixiangProvider(
    'qixiang-worker-unit-test-key',pepper,input.fetcher);const worker=new QixiangQueryWorker(store,provider,pepper,silent,15_000,()=>clock);
  return{pglite,database,store,providerReference,topup:created.topup,worker,setNow:(value:Date)=>{clock=value;},subjectId,userId};
}
afterEach(async()=>{while(databases.length)await databases.pop()!.close();});
function json(value:unknown){return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});}
function unpaid(reference:string){return{code:1,msg:'ok',pid:4611,out_trade_no:reference,status:0};}

describe('Qixiang active-query worker',()=>{
  it('bootstrap worker never claims or queries a historical non-canary topup',async()=>{
    const base=new Date(Date.now()-300_000);let reference='';let calls=0;
    const fetcher=(async()=>{calls+=1;return json(unpaid(reference));})as typeof fetch;
    const f=await fixture({now:base,fetcher});reference=f.providerReference;
    const historical=await f.store.prepare({id:randomUUID(),subjectId:f.subjectId,userId:f.userId,
      idempotencyKey:`historical-${randomUUID()}`,payloadDigest:'d'.repeat(128),
      providerReference:`QX${randomUUID().replaceAll('-','').slice(0,30).toUpperCase()}`,
      amountCents:1002,cardHourCents:1000,creditMicros:10_000_000n,
      checkoutExpiresAt:new Date(base.getTime()+10_000),context:{requestId:'historical',ipHash:'e'.repeat(64),now:base}});
    if(historical.status!=='created')throw new Error('fixture');
    const scoped=new QixiangQueryWorker(f.store,new QixiangProvider('qixiang-worker-unit-test-key',pepper,fetcher),
      pepper,silent,15_000,()=>base,f.topup.id);
    await expect(scoped.runBatch(10)).resolves.toBe(1);expect(calls).toBe(1);
    expect(await f.store.get(f.subjectId,historical.topup.id)).toMatchObject({status:'created',version:1});
    expect((await f.database.query<{count:string}>(`SELECT count(*)::text count FROM qixiang_payment_receipts
      WHERE topup_id=$1`,[historical.topup.id])).rows[0]?.count).toBe('0');
  });

  it('leases one topup at a time so two workers never query the same slow order concurrently',async()=>{
    const base=new Date(Date.now()-300_000);let release!:()=>void;const gate=new Promise<void>((resolve)=>{release=resolve;});let calls=0;
    let reference='';const fetcher=(async()=>{calls+=1;await gate;return json(unpaid(reference));}) as typeof fetch;
    const f=await fixture({now:base,fetcher});reference=f.providerReference;
    const other=new QixiangQueryWorker(f.store,new QixiangProvider('qixiang-worker-unit-test-key',pepper,fetcher),
      pepper,silent,15_000,()=>base);const first=f.worker.runBatch(1);await new Promise((resolve)=>setTimeout(resolve,10));
    await expect(other.runBatch(1)).resolves.toBe(0);expect(calls).toBe(1);release();await expect(first).resolves.toBe(1);
    expect((await f.database.query<{count:string}>(`SELECT count(*)::text count FROM qixiang_payment_receipts
      WHERE topup_id=$1 AND source='query'`,[f.topup.id])).rows[0]?.count).toBe('1');
  });

  it('does not count provider rejection, HTML or transport errors as unpaid confirmations',async()=>{
    const base=new Date(Date.now()-300_000);const responses:Array<()=>Promise<Response>>=[
      async()=>json({code:2,msg:'provider rejected'}),
      async()=>new Response('<html>no</html>',{status:200,headers:{'content-type':'text/html'}}),
      async()=>{throw new Error('socket closed');},
    ];let reference='';const fetcher=(async()=>responses.shift()!()) as typeof fetch;const f=await fixture({now:base,fetcher});reference=f.providerReference;
    await f.worker.runBatch(1);f.setNow(new Date(base.getTime()+61_000));await f.worker.runBatch(1);
    f.setNow(new Date(base.getTime()+182_000));await f.worker.runBatch(1);
    const row=await f.database.query<{unpaid:number;status:string;provider_rejected:string}>(`SELECT unpaid_query_confirmations unpaid,
      status,(SELECT count(*)::text FROM qixiang_payment_receipts WHERE topup_id=$1 AND processing_result='provider_rejected')
      provider_rejected FROM kai_credit_topups WHERE id=$1`,[f.topup.id]);
    expect(row.rows[0]).toEqual({unpaid:0,status:'verifying',provider_rejected:'1'});expect(responses).toHaveLength(0);
    expect(reference).toBe(f.providerReference);
  });

  it('expires only after two spaced unpaid results and grants exactly once on a late paid query',async()=>{
    const base=new Date(Date.now()-300_000);let reference='',topupId='',step=0;const trade=()=>`TRADE${reference}`;
    const fetcher=(async()=>{step+=1;if(step<3)return json(unpaid(reference));return json({code:1,msg:'ok',trade_no:trade(),
      out_trade_no:reference,api_trade_no:`API-${trade()}`,type:'alipay',pid:'4611',addtime:'2026-08-21 08:00:00',
      endtime:'2026-08-21 08:01:00',name:`算力服务卡时权益（364天） ${reference.slice(-12)}`,money:'10.02',status:1,
      param:lookupHash(`qixiang-attempt:${topupId}`,pepper),buyer:null});}) as typeof fetch;
    const f=await fixture({now:base,fetcher});reference=f.providerReference;topupId=f.topup.id;
    await f.worker.runBatch(1);f.setNow(new Date(base.getTime()+61_000));await f.worker.runBatch(1);
    expect(await f.store.get(f.subjectId,f.topup.id)).toMatchObject({status:'expired'});
    f.setNow(new Date(base.getTime()+182_000));await Promise.all([f.worker.runBatch(1),f.worker.runBatch(1)]);
    expect(await f.store.get(f.subjectId,f.topup.id)).toMatchObject({status:'succeeded',providerTransactionId:trade()});
    const exact=await f.database.query<{receipts:string;claims:string;grants:string;lots:string}>(`SELECT
      (SELECT count(*)::text FROM qixiang_payment_receipts WHERE topup_id=$1 AND source='query')receipts,
      (SELECT count(*)::text FROM kai_credit_topup_provider_claims WHERE topup_id=$1)claims,
      (SELECT count(*)::text FROM kai_credit_transactions WHERE scope='QIXIANG_TOPUP_CAPTURE' AND reference_id=$1::text)grants,
      (SELECT count(*)::text FROM kai_credit_lots WHERE source_topup_id=$1)lots`,[f.topup.id]);
    expect(exact.rows[0]).toEqual({receipts:'3',claims:'1',grants:'1',lots:'1'});expect(step).toBe(3);
  });

  it('uses an accepted callback for attribution only after an exact paid active query',async()=>{
    const base=new Date(Date.now()-300_000);let reference='',topupId='';const trade=()=>`TRADE${reference}`;
    const fetcher=(async()=>json({code:1,msg:'ok',trade_no:trade(),out_trade_no:reference,api_trade_no:`API-${trade()}`,
      type:'alipay',pid:4611,addtime:'2026-08-21 08:00:00',endtime:'2026-08-21 08:01:00',
      name:`算力服务卡时权益（364天） ${reference.slice(-12)}`,money:'10.02',status:1,
      param:lookupHash(`qixiang-attempt:${topupId}`,pepper),buyer:null})) as typeof fetch;
    const f=await fixture({now:base,fetcher});reference=f.providerReference;topupId=f.topup.id;
    await f.store.recordCallback({receiptKey:`callback:${'c'.repeat(64)}`,providerReference:reference,
      providerTransactionId:trade(),paymentType:'alipay',amountCents:1002,payloadDigest:'c'.repeat(64),
      snapshotMatched:true,processingResult:'accepted',requestId:'callback',ipHash:'d'.repeat(64),now:base});
    await f.worker.runBatch(1);const row=await f.database.query<{source:string;query_count:string;confirmation:string}>(`SELECT
      t.success_confirmation_source source,(SELECT count(*)::text FROM qixiang_payment_receipts r WHERE r.topup_id=t.id
        AND r.source='query' AND r.provider_status=1 AND r.processing_result='accepted')query_count,
      e.normalized_payload->>'confirmation' confirmation FROM kai_credit_topups t JOIN kai_credit_topup_events e
      ON e.topup_id=t.id AND e.processing_result='succeeded' WHERE t.id=$1`,[f.topup.id]);
    expect(row.rows[0]).toEqual({source:'callback',query_count:'1',confirmation:'TRADE_SUCCESS'});
  });

  it.each([1,2])('sends a topup with %i conflicting accepted callback(s) to manual review with zero economic writes',async(callbacks)=>{
    const base=new Date(Date.now()-300_000);let reference='',topupId='';const paidTrade=()=>`PAID${reference}`;
    const fetcher=(async()=>json({code:1,msg:'ok',trade_no:paidTrade(),out_trade_no:reference,
      api_trade_no:`API-${paidTrade()}`,type:'alipay',pid:4611,addtime:'2026-08-21 08:00:00',
      endtime:'2026-08-21 08:01:00',name:`算力服务卡时权益（364天） ${reference.slice(-12)}`,
      money:'10.02',status:1,param:lookupHash(`qixiang-attempt:${topupId}`,pepper),buyer:null})) as typeof fetch;
    const f=await fixture({now:base,fetcher});reference=f.providerReference;topupId=f.topup.id;
    for(let index=0;index<callbacks;index+=1)await f.store.recordCallback({
      receiptKey:`callback:${String(index+1).repeat(64)}`,providerReference:reference,
      providerTransactionId:`CALLBACK${index}${reference}`,paymentType:'alipay',amountCents:1002,
      payloadDigest:String(index+1).repeat(64),snapshotMatched:true,processingResult:'accepted',
      requestId:`callback-${index}`,ipHash:'d'.repeat(64),now:base,
    });await f.worker.runBatch(1);const result=await f.database.query<{status:string;claims:string;grants:string;
      lots:string;conflicts:string}>(`SELECT t.status,
      (SELECT count(*)::text FROM kai_credit_topup_provider_claims WHERE topup_id=t.id)claims,
      (SELECT count(*)::text FROM kai_credit_transactions WHERE scope='QIXIANG_TOPUP_CAPTURE' AND reference_id=t.id::text)grants,
      (SELECT count(*)::text FROM kai_credit_lots WHERE source_topup_id=t.id)lots,
      (SELECT count(*)::text FROM qixiang_payment_receipts WHERE topup_id=t.id AND source='query'
        AND processing_result='trade_conflict')conflicts FROM kai_credit_topups t WHERE t.id=$1`,[f.topup.id]);
    expect(result.rows[0]).toEqual({status:'manual_review',claims:'0',grants:'0',lots:'0',conflicts:'1'});
  });

  it('shares a healthy heartbeat across instances and fails closed after the shared heartbeat becomes stale',async()=>{
    const base=new Date(Date.now()-300_000);let reference='';const fetcher=(async()=>json(unpaid(reference)))as typeof fetch;
    const f=await fixture({now:base,fetcher});reference=f.providerReference;
    await f.worker.runBatch(1);const other=new QixiangQueryWorker(f.store,
      new QixiangProvider('qixiang-worker-unit-test-key',pepper,fetcher),pepper,silent,10,()=>new Date());
    await expect(other.health()).resolves.toMatchObject({ready:true,healthyInstances:1,observedInstances:1});
    await new Promise((resolve)=>setTimeout(resolve,130));
    await expect(other.health()).resolves.toMatchObject({ready:false,healthyInstances:0,observedInstances:1});
  });

  it('blocks after three provider-wide query failures and recovers on the next durable success heartbeat',async()=>{
    const base=new Date(Date.now()-300_000);let clock=base,reference='',step=0;
    const fetcher=(async()=>{step+=1;if(step<=3)throw new Error(`provider-down-${step}`);return json(unpaid(reference));})as typeof fetch;
    const f=await fixture({now:base,fetcher});reference=f.providerReference;
    const empty=new QixiangQueryWorker(f.store,
      new QixiangProvider('qixiang-worker-unit-test-key',pepper,fetcher),pepper,silent,15_000,()=>clock);
    for(const offset of [0,61_000,182_000]){clock=new Date(base.getTime()+offset);f.setNow(clock);
      await f.worker.runBatch(1);await empty.runBatch(1);}
    await expect(f.worker.health(clock)).resolves.toMatchObject({ready:false,consecutiveFailures:3,
      healthyInstances:2,observedInstances:2});
    clock=new Date(base.getTime()+423_000);f.setNow(clock);await f.worker.runBatch(1);
    await expect(f.worker.health(clock)).resolves.toMatchObject({ready:true,consecutiveFailures:0,
      healthyInstances:2,observedInstances:2});
  });

  it('fails health closed when database claiming and shared health evidence are unavailable',async()=>{
    const unavailable={claimQueries:async()=>{throw new Error('database unavailable');},
      recordQueryWorkerHealth:async()=>{throw new Error('database unavailable');},
      queryWorkerHealth:async()=>{throw new Error('database unavailable');}}as unknown as PostgresQixiangTopupStore;
    const provider=new QixiangProvider('qixiang-worker-unit-test-key',pepper,
      (async()=>json({code:1,msg:'ok'}))as typeof fetch);const now=new Date('2026-08-21T08:00:00.000Z');
    const worker=new QixiangQueryWorker(unavailable,provider,pepper,silent,15_000,()=>now);
    await expect(worker.runBatch(1)).rejects.toThrow('database unavailable');
    await expect(worker.health(now)).resolves.toMatchObject({ready:false,consecutiveFailures:0,schedulerFailures:1,
      healthyInstances:0,observedInstances:0});
  });
});
