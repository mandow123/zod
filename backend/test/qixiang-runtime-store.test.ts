import { randomUUID } from 'node:crypto';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { migrationManifest } from '../src/schema.js';
import { PostgresQixiangTopupStore } from '../src/topups/qixiang-store.js';

function result<T>(value:Results<T>){return{...value,rowCount:value.rows.length||value.affectedRows||0,
  command:'',oid:0,rowAsArray:false};}
function databaseAdapter(pglite:PGlite):Database{return{health:async()=>true,
  schemaReadiness:async()=>({ready:true,expected:null,applied:null,missing:[],mismatched:[]}),
  query:async<Row extends Record<string,unknown>>(text:string,values?:unknown[])=>result(await pglite.query<Row>(text,values)),
  transaction:async<T>(work:(client:PoolClient)=>Promise<T>)=>pglite.transaction(async(transaction:Transaction)=>work({
    query:async(text:string,values?:unknown[])=>result(await transaction.query(text,values)),
  }as unknown as PoolClient)),close:()=>pglite.close()}as unknown as Database;}

let pglite:PGlite;let store:PostgresQixiangTopupStore;let userId:string;let subjectId:string;
const now=new Date('2026-08-21T08:00:00.000Z');
function context(){return{requestId:`request-${randomUUID()}`,ipHash:'a'.repeat(64),now};}
function preparation(overrides:Record<string,unknown>={}){const amountCents=1002;const cardHourCents=1000;
  return{id:randomUUID(),subjectId,userId,idempotencyKey:`create-${randomUUID()}`,payloadDigest:'b'.repeat(128),
    providerReference:`QX${randomUUID().replaceAll('-','').slice(0,30).toUpperCase()}`,amountCents,cardHourCents,
    creditMicros:10_000_000n,checkoutExpiresAt:new Date(now.getTime()+30*60_000),context:context(),...overrides};}

beforeAll(async()=>{pglite=new PGlite();for(const migration of await migrationManifest())await pglite.exec(migration.sql);
  const database=databaseAdapter(pglite);store=new PostgresQixiangTopupStore(database);userId=randomUUID();subjectId=randomUUID();
  await database.query(`INSERT INTO users(id,email_ciphertext,display_name)VALUES($1,'runtime','七相运行时')`,[userId]);
  await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)VALUES($1,'personal','七相主体',$2)`,
  [subjectId,userId]);});
afterAll(()=>pglite.close());

describe('Qixiang dedicated runtime store',()=>{
  it('claims create idempotency atomically and never duplicates the provider order',async()=>{
    const input=preparation();const first=await store.prepare(input);expect(first.status).toBe('created');
    const replay=await store.prepare({...input,id:randomUUID()});expect(replay.status).toBe('replayed');
    expect(replay.status==='replayed'&&replay.topup.id).toBe(first.status==='created'&&first.topup.id);
    expect((await pglite.query<{count:string}>(`SELECT count(*)::text count FROM kai_credit_topups
      WHERE client_request_id=$1`,[input.idempotencyKey])).rows[0]?.count).toBe('1');
    await expect(store.prepare({...input,id:randomUUID(),payloadDigest:'c'.repeat(128)})).resolves.toEqual({status:'conflict'});
  });

  it('moves to verifying before any create outcome and preserves an empty checkout tuple on ambiguity',async()=>{
    const prepared=await store.prepare(preparation());if(prepared.status!=='created')throw new Error('fixture');
    const started=await store.startCreate(prepared.topup.id,prepared.topup.version,new Date(now.getTime()+11_000),{
      actorId:userId,requestId:'start',ipHash:'d'.repeat(64),payloadDigest:'e'.repeat(128),now});
    expect(started).toMatchObject({status:'verifying',version:2,providerPaymentId:null,checkout:null});
    const unknown=await store.recordCreateUnknown(started!.id,started!.version,new Date(now.getTime()+30_000),{
      actorId:userId,requestId:'unknown',ipHash:'d'.repeat(64),payloadDigest:'e'.repeat(128),now});
    expect(unknown).toMatchObject({status:'verifying',version:3,providerPaymentId:null,checkout:null});
    expect((await pglite.query<{count:string}>(`SELECT count(*)::text count FROM outbox_events
      WHERE aggregate_id=$1`,[prepared.topup.id])).rows[0]?.count).toBe('3');
    await expect(store.hasUnresolved(subjectId)).resolves.toBe(true);
  });

  it('saves a checkout once and ignores a late create response without overwriting it',async()=>{
    const prepared=await store.prepare(preparation());if(prepared.status!=='created')throw new Error('fixture');
    const mutation={actorId:userId,requestId:'save',ipHash:'d'.repeat(64),payloadDigest:'e'.repeat(128),now};
    const started=await store.startCreate(prepared.topup.id,prepared.topup.version,new Date(now.getTime()+11_000),mutation);
    const saved=await store.saveCheckout(started!.id,started!.version,`TRADE${prepared.topup.providerReference}`,{
      cipherVersion:1,keyId:'qixiang-checkout-2026a',nonce:Buffer.alloc(12,1),ciphertext:Buffer.alloc(32,2),authTag:Buffer.alloc(16,3),
    },mutation);expect(saved).toMatchObject({status:'pending',version:3});
    await expect(store.recordCreateUnknown(started!.id,started!.version,new Date(now.getTime()+60_000),mutation)).resolves.toBeNull();
    expect(await store.get(subjectId,started!.id)).toMatchObject({status:'pending',providerPaymentId:`TRADE${prepared.topup.providerReference}`});
  });

  it('rechecks with owner idempotency, expected version and subject isolation',async()=>{
    const prepared=await store.prepare(preparation());if(prepared.status!=='created')throw new Error('fixture');
    const mutation={actorId:userId,requestId:'save',ipHash:'d'.repeat(64),payloadDigest:'e'.repeat(128),now};
    const started=await store.startCreate(prepared.topup.id,prepared.topup.version,new Date(now.getTime()+11_000),mutation);
    const saved=await store.saveCheckout(started!.id,started!.version,`TRADE${prepared.topup.providerReference}`,{
      cipherVersion:1,keyId:'qixiang-checkout-2026a',nonce:Buffer.alloc(12,1),ciphertext:Buffer.alloc(32,2),authTag:Buffer.alloc(16,3),
    },mutation);await pglite.query(`UPDATE kai_credit_topups SET status='manual_review',
      reconciliation_dead_lettered_at=$2 WHERE id=$1`,[saved!.id,now]);
    const manual=await store.get(subjectId,saved!.id);const key=`recheck-${randomUUID()}`;
    const base={topupId:saved!.id,subjectId,userId,expectedVersion:manual!.version,
      idempotencyKey:key,payloadDigest:'f'.repeat(128),requestId:'recheck',ipHash:'a'.repeat(64),now};
    const first=await store.recheck(base);expect(first.status).toBe('updated');
    expect((await pglite.query<{dead:Date|null}>(`SELECT reconciliation_dead_lettered_at dead
      FROM kai_credit_topups WHERE id=$1`,[saved!.id])).rows[0]?.dead).toBeNull();
    const replay=await store.recheck(base);expect(replay.status).toBe('replayed');
    await expect(store.recheck({...base,payloadDigest:'0'.repeat(128)})).resolves.toEqual({status:'conflict'});
    await expect(store.get(randomUUID(),saved!.id)).resolves.toBeNull();
  });

  it('atomically converges duplicate concurrent callbacks to one receipt and one query outbox',async()=>{
    const prepared=await store.prepare(preparation());if(prepared.status!=='created')throw new Error('fixture');
    const mutation={actorId:userId,requestId:'save',ipHash:'d'.repeat(64),payloadDigest:'e'.repeat(128),now};
    const started=await store.startCreate(prepared.topup.id,prepared.topup.version,new Date(now.getTime()+11_000),mutation);
    const paymentId=`TRADE${prepared.topup.providerReference}`;await store.saveCheckout(started!.id,started!.version,paymentId,{
      cipherVersion:1,keyId:'qixiang-checkout-2026a',nonce:Buffer.alloc(12,1),ciphertext:Buffer.alloc(32,2),authTag:Buffer.alloc(16,3),
    },mutation);const callback={receiptKey:`callback:${'1'.repeat(64)}`,providerReference:prepared.topup.providerReference,
      providerTransactionId:paymentId,paymentType:'alipay' as const,amountCents:prepared.topup.amountCents,
      payloadDigest:'1'.repeat(64),snapshotMatched:true,processingResult:'accepted' as const,requestId:'callback',
      ipHash:'2'.repeat(64),now};const outcomes=await Promise.all([store.recordCallback(callback),store.recordCallback(callback)]);
    expect(outcomes.map((item)=>item.result).sort()).toEqual(['accepted','duplicate']);
    const counts=await pglite.query<{receipts:string;outbox:string}>(`SELECT
      (SELECT count(*)::text FROM qixiang_payment_receipts WHERE receipt_key=$1)receipts,
      (SELECT count(*)::text FROM outbox_events WHERE aggregate_id=$2 AND topic='qixiang.topup.query_requested')outbox`,
    [callback.receiptKey,prepared.topup.id]);expect(counts.rows[0]).toEqual({receipts:'1',outbox:'1'});
  });

  it('claims due queries once and requires two accepted unpaid confirmations before expiry',async()=>{
    const base=new Date(Date.now()-60*60_000);const prepared=await store.prepare(preparation({checkoutExpiresAt:new Date(base.getTime()+60_000),
      context:{requestId:'expiry-create',ipHash:'a'.repeat(64),now:base}}));
    if(prepared.status!=='created')throw new Error('fixture');
    const first=(await store.claimQueries({now:base,staleBefore:new Date(base.getTime()-120_000),limit:10}))
      .find((item)=>item.topup.id===prepared.topup.id);expect(first).toBeDefined();
    expect((await store.claimQueries({now:base,staleBefore:new Date(base.getTime()-120_000),limit:10}))
      .some((item)=>item.topup.id===prepared.topup.id)).toBe(false);
    const once=await store.recordUnpaidQuery({attemptId:first!.attemptId,claimedAt:first!.claimedAt,
      topupId:prepared.topup.id,payloadDigest:'4'.repeat(64),now:base,
      nextAttemptAt:new Date(base.getTime()+31_000)});expect(once).toMatchObject({status:'verifying',topup:{status:'verifying'}});
    const secondNow=new Date(base.getTime()+61_000);const second=(await store.claimQueries({now:secondNow,
      staleBefore:new Date(secondNow.getTime()-120_000),limit:100})).find((item)=>item.topup.id===prepared.topup.id);
    const expired=await store.recordUnpaidQuery({attemptId:second!.attemptId,claimedAt:second!.claimedAt,
      topupId:prepared.topup.id,payloadDigest:'5'.repeat(64),now:secondNow,
      nextAttemptAt:new Date(secondNow.getTime()+60_000)});expect(expired).toMatchObject({status:'expired',
        topup:{status:'expired'}});
    const evidence=await pglite.query<{status:string;unpaid:number;receipts:string}>(`SELECT t.status,
      t.unpaid_query_confirmations unpaid,(SELECT count(*)::text FROM qixiang_payment_receipts r
      WHERE r.topup_id=t.id AND r.source='query' AND r.provider_status=0)receipts FROM kai_credit_topups t WHERE t.id=$1`,
    [prepared.topup.id]);expect(evidence.rows[0]).toEqual({status:'expired',unpaid:2,receipts:'2'});
  });

  it('bootstrap query claim touches only the signed canary topup',async()=>{
    const base=new Date(Date.now()-60_000);const canary=await store.prepare(preparation({context:{requestId:'canary',
      ipHash:'a'.repeat(64),now:base}}));const historical=await store.prepare(preparation({context:{requestId:'historical',
      ipHash:'a'.repeat(64),now:base}}));
    if(canary.status!=='created'||historical.status!=='created')throw new Error('fixture');
    const claimed=await store.claimQueries({now:new Date(base.getTime()+1),staleBefore:new Date(base.getTime()-120_000),
      limit:10,topupId:canary.topup.id});
    expect(claimed.map((item)=>item.topup.id)).toEqual([canary.topup.id]);
    expect(await store.get(subjectId,historical.topup.id)).toMatchObject({status:'created',version:1});
  });

  it('returns a known checkout to pending on unpaid query and keeps unknown checkout verifying',async()=>{
    const prepared=await store.prepare(preparation());if(prepared.status!=='created')throw new Error('fixture');
    const mutation={actorId:userId,requestId:'known',ipHash:'d'.repeat(64),payloadDigest:'e'.repeat(128),now};
    const started=await store.startCreate(prepared.topup.id,prepared.topup.version,now,mutation);
    await store.saveCheckout(started!.id,started!.version,`TRADE${prepared.topup.providerReference}`,{
      cipherVersion:1,keyId:'qixiang-checkout-2026a',nonce:Buffer.alloc(12,1),ciphertext:Buffer.alloc(32,2),authTag:Buffer.alloc(16,3),
    },mutation);const claimed=(await store.claimQueries({now:new Date(now.getTime()+1),
      staleBefore:new Date(now.getTime()-120_000),limit:100})).find((item)=>item.topup.id===prepared.topup.id);
    const result=await store.recordUnpaidQuery({attemptId:claimed!.attemptId,claimedAt:claimed!.claimedAt,
      topupId:prepared.topup.id,payloadDigest:'6'.repeat(64),now:new Date(now.getTime()+1),
      nextAttemptAt:new Date(now.getTime()+60_000)});expect(result).toMatchObject({topup:{status:'pending'}});
  });

  it('posts a paid active query as one claim, balanced grant, 364-day lot and success outbox',async()=>{
    const createNow=new Date(Date.now()-120_000);const prepared=await store.prepare(preparation({context:{requestId:'paid-create',
      ipHash:'a'.repeat(64),now:createNow}}));if(prepared.status!=='created')throw new Error('fixture');
    const attempt=(await store.claimQueries({now:new Date(createNow.getTime()+1),
      staleBefore:new Date(createNow.getTime()-120_000),limit:100})).find((item)=>item.topup.id===prepared.topup.id);
    const paidAt=new Date(createNow.getTime()+2_000);const trade=`TRADE${prepared.topup.providerReference}`;
    const paid=await store.recordPaidQuery({attemptId:attempt!.attemptId,claimedAt:attempt!.claimedAt,
      topupId:prepared.topup.id,providerTransactionId:trade,apiTradeNo:'API-QIXIANG-PAID-1',
      queryPayloadDigest:'7'.repeat(64),grantPayloadDigest:'8'.repeat(64),now:paidAt});
    expect(paid).toMatchObject({status:'succeeded',topup:{status:'succeeded',providerPaymentId:trade,
      providerTransactionId:trade}});const closure=await pglite.query<{claims:string;events:string;transactions:string;
      entries:string;lots:string;movements:string;outbox:string;balance:string}>(`SELECT
      (SELECT count(*)::text FROM kai_credit_topup_provider_claims WHERE topup_id=$1)claims,
      (SELECT count(*)::text FROM kai_credit_topup_events WHERE topup_id=$1 AND processing_result='succeeded')events,
      (SELECT count(*)::text FROM kai_credit_transactions WHERE scope='QIXIANG_TOPUP_CAPTURE' AND reference_id=$1::text)transactions,
      (SELECT count(*)::text FROM kai_credit_entries e JOIN kai_credit_transactions t ON t.id=e.transaction_id
        WHERE t.scope='QIXIANG_TOPUP_CAPTURE' AND t.reference_id=$1::text)entries,
      (SELECT count(*)::text FROM kai_credit_lots WHERE source_topup_id=$1)lots,
      (SELECT count(*)::text FROM kai_credit_lot_movements m JOIN kai_credit_lots l ON l.id=m.lot_id
        WHERE l.source_topup_id=$1 AND m.kind='grant')movements,
      (SELECT count(*)::text FROM outbox_events WHERE aggregate_id=$1::text AND topic='qixiang.topup.succeeded')outbox,
      (SELECT sum(e.amount_micros)::text FROM kai_credit_entries e JOIN kai_credit_transactions t ON t.id=e.transaction_id
        WHERE t.scope='QIXIANG_TOPUP_CAPTURE' AND t.reference_id=$1::text)balance`,[prepared.topup.id]);
    expect(closure.rows[0]).toEqual({claims:'1',events:'1',transactions:'1',entries:'2',lots:'1',movements:'1',outbox:'1',balance:'0'});
    await expect(store.recordPaidQuery({attemptId:attempt!.attemptId,claimedAt:attempt!.claimedAt,
      topupId:prepared.topup.id,providerTransactionId:trade,apiTradeNo:'API-QIXIANG-PAID-1',
      queryPayloadDigest:'7'.repeat(64),grantPayloadDigest:'8'.repeat(64),now:paidAt}))
      .resolves.toMatchObject({status:'duplicate'});
  });
});
