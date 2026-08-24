import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type RuntimeConfig } from '../src/config.js';
import type { AccountService } from '../src/account/service.js';
import type { Database } from '../src/database.js';
import { lookupHash } from '../src/account/crypto.js';
import { QixiangProvider } from '../src/payment/qixiang-provider.js';
import { qixiangMd5Signature } from '../src/payment/qixiang.js';
import { migrationManifest } from '../src/schema.js';
import type { SubjectAccess } from '../src/subjects/types.js';
import type { QixiangEvidenceService } from '../src/topups/qixiang-evidence.js';
import { registerQixiangTopupRoutes } from '../src/topups/qixiang-routes.js';
import { QixiangTopupService } from '../src/topups/qixiang-service.js';
import { PostgresQixiangTopupStore } from '../src/topups/qixiang-store.js';
import { AppError } from '../src/errors.js';
import type { QixiangProductionGate } from '../src/topups/qixiang-production-gate.js';

function result<T>(value:Results<T>){return{...value,rowCount:value.rows.length||value.affectedRows||0,
  command:'',oid:0,rowAsArray:false};}
function adapter(pglite:PGlite):Database{return{health:async()=>true,
  schemaReadiness:async()=>({ready:true,expected:null,applied:null,missing:[],mismatched:[]}),
  query:async<Row extends Record<string,unknown>>(text:string,values?:unknown[])=>result(await pglite.query<Row>(text,values)),
  transaction:async<T>(work:(client:PoolClient)=>Promise<T>)=>pglite.transaction(async(transaction:Transaction)=>work({
    query:async(text:string,values?:unknown[])=>result(await transaction.query(text,values)),
  }as unknown as PoolClient)),close:()=>pglite.close()}as unknown as Database;}

let pglite:PGlite;let store:PostgresQixiangTopupStore;const userId=randomUUID();const subjectId=randomUUID();
const principal={userId,sessionId:'session',role:'member' as const};
const subjects={current:async()=>({subjectId,userId,kind:'personal',displayName:'主体',subjectStatus:'active',role:'owner',
  permissions:['credits.read','credits.redeem']})}as unknown as SubjectAccess;
function runtime(){const base=loadConfig({NODE_ENV:'test',MOBILE_API_PROFILE:'full_commerce',QIXIANG_TOPUP_MODE:'on',
  AUDIT_PEPPER:'a'.repeat(64),QIXIANG_CHECKOUT_KEY_ID:'qixiang-checkout-2026a'});return{...base,
    readiness:{...base.readiness,capabilities:{...base.readiness.capabilities,qixiangTopups:{
      ...base.readiness.capabilities.qixiangTopups,available:true,maxAmountCents:4_999_999,blockers:[],
    }}}}as unknown as RuntimeConfig;}
const evidence={readiness:async()=>({ready:true,maxAmountCents:4_999_999,blockers:[]})}as unknown as QixiangEvidenceService;

beforeAll(async()=>{pglite=new PGlite();for(const migration of await migrationManifest())await pglite.exec(migration.sql);
  const database=adapter(pglite);store=new PostgresQixiangTopupStore(database);
  await database.query(`INSERT INTO users(id,email_ciphertext,display_name)VALUES($1,'service','七相服务')`,[userId]);
  await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)VALUES($1,'personal','主体',$2)`,
  [subjectId,userId]);});afterAll(()=>pglite.close());

describe('Qixiang create runtime orchestration',()=>{
  it('rechecks the live database immediately before provider create and closes the prepared row on drift',async()=>{
    const canaryTopupId=randomUUID();const createCheckout=vi.fn().mockResolvedValue({
      providerPaymentId:'TRADEBOOTSTRAP1234567890',state:'pending',
      checkoutUrl:'https://api.payqixiang.cn/pay/submit/bootstrap/',responseDigest:'b'.repeat(128)});let calls=0;
    const productionGate={require:vi.fn(async()=>{calls+=1;if(calls!==2)return{ready:true,canaryTopupId};
      throw new AppError('QIXIANG_TOPUP_PRODUCTION_GATE_CLOSED',503,'drift');}),
      readinessWithDatabase:vi.fn(async()=>({ready:true,blockers:[],expiresAt:'2026-08-21T08:30:00.000Z'}))
    }as unknown as QixiangProductionGate;
    const config={...runtime(),NODE_ENV:'production'}as RuntimeConfig;
    const service=new QixiangTopupService(store,subjects,{createCheckout}as unknown as QixiangProvider,evidence,
      Buffer.alloc(32,6),config,()=>new Date('2026-08-21T08:00:00.000Z'),productionGate);
    await expect(service.create(principal,{amountCents:501,rail:'qixiang_alipay',idempotencyKey:`drift-${randomUUID()}`},
      {requestId:'drift',ip:'203.0.113.9'})).rejects.toMatchObject({code:'QIXIANG_TOPUP_PRODUCTION_GATE_CLOSED'});
    expect(productionGate.require).toHaveBeenCalledTimes(2);expect(createCheckout).not.toHaveBeenCalled();
    expect(await store.get(subjectId,canaryTopupId)).toMatchObject({status:'created'});
    expect((await pglite.query<{reason:string}>(`SELECT last_reconciliation_error reason FROM kai_credit_topups
      WHERE id=$1`,[canaryTopupId])).rows[0]?.reason).toBe('GATE_CLOSED');
    await expect(service.create(principal,{amountCents:501,rail:'qixiang_alipay',idempotencyKey:
      (await store.get(subjectId,canaryTopupId))!.clientRequestId},{requestId:'retry',ip:'203.0.113.9'}))
      .resolves.toMatchObject({topup:{id:canaryTopupId,status:'pending'}});
    expect(createCheckout).toHaveBeenCalledTimes(1);
  });
  it('bootstrap callback for a historical non-canary topup makes zero economic writes',async()=>{
    const timestamp=new Date('2026-08-21T08:05:00.000Z');const canaryTopupId=randomUUID();
    const historical=await store.prepare({id:randomUUID(),subjectId,userId,idempotencyKey:`historical-${randomUUID()}`,
      payloadDigest:'9'.repeat(128),providerReference:`QX${randomUUID().replaceAll('-','').slice(0,30).toUpperCase()}`,
      amountCents:501,cardHourCents:500,creditMicros:5_000_000n,checkoutExpiresAt:new Date(timestamp.getTime()+1_800_000),
      context:{requestId:'historical',ipHash:'8'.repeat(64),now:timestamp}});
    if(historical.status!=='created')throw new Error('fixture');const merchantKey='qixiang-unit-test-bootstrap-key';
    const productionGate={require:vi.fn(async()=>({ready:true,phase:'bootstrap_canary',canaryTopupId}))} as unknown as QixiangProductionGate;
    const service=new QixiangTopupService(store,subjects,new QixiangProvider(merchantKey,'a'.repeat(64)),evidence,
      Buffer.alloc(32,10),{...runtime(),NODE_ENV:'production'}as RuntimeConfig,()=>timestamp,productionGate);
    const fields={pid:'4611',trade_no:`TRADE${randomUUID().replaceAll('-','').toUpperCase()}`,
      out_trade_no:historical.topup.providerReference,type:'alipay',
      name:`算力服务卡时权益（364天） ${historical.topup.providerReference.slice(-12)}`,money:'5.01',
      trade_status:'TRADE_SUCCESS',param:lookupHash(`qixiang-attempt:${historical.topup.id}`,'a'.repeat(64))};
    const raw=new URLSearchParams({...fields,sign:qixiangMd5Signature(fields,merchantKey),sign_type:'MD5'}).toString();
    await expect(service.notification(raw,{requestId:'bootstrap-callback',ip:'203.0.113.12'})).rejects.toMatchObject({
      code:'QIXIANG_CALLBACK_BOOTSTRAP_CANARY_ONLY'});
    expect(await store.get(subjectId,historical.topup.id)).toMatchObject({status:'created',version:1});
    const counts=await pglite.query<{receipts:string;grants:string;lots:string}>(`SELECT
      (SELECT count(*)::text FROM qixiang_payment_receipts WHERE topup_id=$1)receipts,
      (SELECT count(*)::text FROM kai_credit_transactions WHERE scope='QIXIANG_TOPUP_CAPTURE' AND reference_id=$1::text)grants,
      (SELECT count(*)::text FROM kai_credit_lots WHERE source_topup_id=$1)lots`,[historical.topup.id]);
    expect(counts.rows[0]).toEqual({receipts:'0',grants:'0',lots:'0'});
  });
  it('uses one provider create call for concurrent identical idempotency requests',async()=>{let release!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});const createCheckout=vi.fn().mockImplementation(async()=>{
      await gate;return{providerPaymentId:'TRADE12345678901234567890',state:'pending',
        checkoutUrl:'https://api.payqixiang.cn/pay/submit/opaque-one/',responseDigest:'b'.repeat(128)};});
    const service=new QixiangTopupService(store,subjects,{createCheckout}as unknown as QixiangProvider,evidence,
      Buffer.alloc(32,7),runtime(),()=>new Date('2026-08-21T08:00:00.000Z'));
    const input={amountCents:1002,rail:'qixiang_alipay' as const,idempotencyKey:`same-${randomUUID()}`};
    const first=service.create(principal,input,{requestId:'first',ip:'203.0.113.10'});
    await vi.waitFor(()=>expect(createCheckout).toHaveBeenCalledTimes(1));
    const second=service.create(principal,input,{requestId:'second',ip:'203.0.113.10'});release();
    const outcomes=await Promise.all([first,second]);expect(createCheckout).toHaveBeenCalledTimes(1);
    expect(new Set(outcomes.map((entry)=>entry.topup.id)).size).toBe(1);
    expect(outcomes.some((entry)=>entry.replayed)).toBe(true);
  });

  it('returns 409 semantics for the same key with a different immutable amount and makes no second network call',async()=>{
    const createCheckout=vi.fn().mockResolvedValue({providerPaymentId:'TRADE22345678901234567890',state:'pending',
      checkoutUrl:'https://api.payqixiang.cn/pay/submit/opaque-two/',responseDigest:'b'.repeat(128)});
    const service=new QixiangTopupService(store,subjects,{createCheckout}as unknown as QixiangProvider,evidence,
      Buffer.alloc(32,8),runtime(),()=>new Date('2026-08-21T08:10:00.000Z'));const key=`different-${randomUUID()}`;
    await service.create(principal,{amountCents:1002,rail:'qixiang_alipay',idempotencyKey:key},{requestId:'one',ip:'203.0.113.11'});
    await expect(service.create(principal,{amountCents:2004,rail:'qixiang_alipay',idempotencyKey:key},
      {requestId:'two',ip:'203.0.113.11'})).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_CONFLICT',statusCode:409});
    expect(createCheckout).toHaveBeenCalledTimes(1);
  });

  it('ACKs the same verified callback twice end-to-end while persisting one receipt and one query job',async()=>{
    const timestamp=new Date('2026-08-21T08:20:00.000Z');const reference=`QX${randomUUID().replaceAll('-','').slice(0,30).toUpperCase()}`;
    const prepared=await store.prepare({id:randomUUID(),subjectId,userId,idempotencyKey:`callback-${randomUUID()}`,
      payloadDigest:'a'.repeat(128),providerReference:reference,amountCents:1002,cardHourCents:1000,
      creditMicros:10_000_000n,checkoutExpiresAt:new Date(timestamp.getTime()+30*60_000),
      context:{requestId:'prepare-callback',ipHash:'b'.repeat(64),now:timestamp}});
    if(prepared.status!=='created')throw new Error('callback fixture');const mutation={actorId:userId,
      requestId:'start-callback',ipHash:'b'.repeat(64),payloadDigest:'a'.repeat(128),now:timestamp};
    const started=await store.startCreate(prepared.topup.id,prepared.topup.version,new Date(timestamp.getTime()+11_000),mutation);
    const providerPaymentId=`TRADE${randomUUID().replaceAll('-','').toUpperCase()}`;
    const pending=await store.saveCheckout(started!.id,started!.version,providerPaymentId,{cipherVersion:1,
      keyId:'qixiang-checkout-2026a',nonce:Buffer.alloc(12,1),ciphertext:Buffer.alloc(32,2),authTag:Buffer.alloc(16,3)},mutation);
    const merchantKey='qixiang-unit-test-merchant-key';const auditPepper='a'.repeat(64);
    const provider=new QixiangProvider(merchantKey,auditPepper);const service=new QixiangTopupService(
      store,subjects,provider,evidence,Buffer.alloc(32,9),runtime(),()=>timestamp);
    const name=`算力服务卡时权益（364天） ${reference.slice(-12)}`;
    const fields={pid:'4611',trade_no:providerPaymentId,out_trade_no:reference,type:'alipay',name,money:'10.02',
      trade_status:'TRADE_SUCCESS',param:lookupHash(`qixiang-attempt:${pending!.id}`,auditPepper)};
    const raw=new URLSearchParams({...fields,sign:qixiangMd5Signature(fields,merchantKey),sign_type:'MD5'}).toString();
    const accounts={authenticate:async()=>({principal,identity:{}})}as unknown as AccountService;
    const app=Fastify({logger:false});await registerQixiangTopupRoutes(app,accounts,service);
    const invalid=[raw.replace(/sign=[0-9a-f]{32}/u,`sign=${'0'.repeat(32)}`),`${raw}&pid=4611`,`${raw}&unknown=x`];
    for(const query of invalid){const response=await app.inject(`/mobile/v1/credits/topups/qixiang/notify?${query}`);
      expect([response.statusCode,response.body]).toEqual([400,'failure']);}
    expect(await store.get(subjectId,pending!.id)).toMatchObject({status:'pending',version:pending!.version});
    const before=await pglite.query<{receipts:string;outbox:string}>(`SELECT
      (SELECT count(*)::text FROM qixiang_payment_receipts WHERE topup_id=$1 AND source='callback')receipts,
      (SELECT count(*)::text FROM outbox_events WHERE aggregate_id=$1::text AND topic='qixiang.topup.query_requested')outbox`,
    [pending!.id]);expect(before.rows[0]).toEqual({receipts:'0',outbox:'0'});
    const url=`/mobile/v1/credits/topups/qixiang/notify?${raw}`;
    const responses=await Promise.all([app.inject(url),app.inject(url)]);
    expect(responses.map((item)=>[item.statusCode,item.body])).toEqual([[200,'success'],[200,'success']]);
    const counts=await pglite.query<{receipts:string;outbox:string}>(`SELECT
      (SELECT count(*)::text FROM qixiang_payment_receipts WHERE topup_id=$1 AND source='callback')receipts,
      (SELECT count(*)::text FROM outbox_events WHERE aggregate_id=$1::text AND topic='qixiang.topup.query_requested')outbox`,
    [pending!.id]);expect(counts.rows[0]).toEqual({receipts:'1',outbox:'1'});await app.close();
  });
});
