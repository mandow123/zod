import Fastify, { type FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AccountService } from '../src/account/service.js';
import { applicationLoggerOptions, buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { installErrorHandling } from '../src/errors.js';
import { registerQixiangTopupRoutes } from '../src/topups/qixiang-routes.js';
import type { QixiangTopupService } from '../src/topups/qixiang-service.js';

const id='123e4567-e89b-42d3-a456-426614174000';
const topup={id,topupNumber:'QX12345678901234567890',provider:'qixiang',rail:'qixiang_alipay',status:'verifying',version:2,
  payment:{currency:'CNY',amountCents:1002,amount:'10.02'},credit:{unit:'KAI_CARD_HOUR',amount:'10.00',precision:2},
  conversion:{numerator:1000,denominator:1002,rounding:'floor'},entitlement:{validityDays:364,expiresAt:null},
  checkoutExpiresAt:'2026-08-21T09:00:00.000Z',createdAt:'2026-08-21T08:30:00.000Z',succeededAt:null,lastCheckedAt:null,
  allowedActions:['recheck','contact_support']};
const accounts={authenticate:async()=>({principal:{userId:id,sessionId:'session',role:'member'},identity:{}}),
  legalDocuments:()=>({})}as unknown as AccountService;
function fake(){return{create:vi.fn().mockResolvedValue({replayed:false,topup,checkout:null}),
  list:vi.fn().mockResolvedValue({items:[topup],nextCursor:null,
    creation:{allowed:false,reason:'unresolved_topup',canaryOnly:false,requiredAmountCents:null}}),
  get:vi.fn().mockResolvedValue({topup,checkout:null}),recheck:vi.fn().mockResolvedValue({topup}),
  notification:vi.fn().mockResolvedValue({result:'accepted'}),}as unknown as QixiangTopupService;}
function config(mode:'off'|'shadow'|'on',profile:'inquiry_only'|'full_commerce'='full_commerce'){return loadConfig({
  NODE_ENV:'test',MOBILE_API_PROFILE:profile,QIXIANG_TOPUP_MODE:mode,LEGAL_ENTITY_NAME:'上海申比芯人工智能科技有限公司',
  PUBLIC_ORIGIN:'https://cloudpay.kai.com',AUDIT_PEPPER:'a'.repeat(64),
});}

describe('Qixiang exact mobile routes',()=>{
  it('returns the App exact create/list/detail/recheck wire without provider fields',async()=>{const app=Fastify({logger:false});
    installErrorHandling(app);const service=fake();await registerQixiangTopupRoutes(app,accounts,service);
    const authorization={authorization:'Bearer paired','x-kai-id-token':'paired-id'};
    const created=await app.inject({method:'POST',url:'/mobile/v1/credits/topups/qixiang',headers:{...authorization,
      'idempotency-key':'create-idempotency-0001'},payload:{amountCents:1002,rail:'qixiang_alipay'}});
    expect(created.statusCode).toBe(201);expect(created.json()).toEqual({topup,checkout:null});
    const list=await app.inject({method:'GET',url:'/mobile/v1/credits/topups/qixiang?limit=30',headers:authorization});
    expect(list.json()).toEqual({items:[topup],nextCursor:null,
      creation:{allowed:false,reason:'unresolved_topup',canaryOnly:false,requiredAmountCents:null}});
    const detail=await app.inject({method:'GET',url:`/mobile/v1/credits/topups/qixiang/${id}`,headers:authorization});
    expect(detail.json()).toEqual({topup,checkout:null});
    const recheck=await app.inject({method:'POST',url:`/mobile/v1/credits/topups/qixiang/${id}/recheck`,
      headers:{...authorization,'idempotency-key':'recheck-idempotency-1'},payload:{expectedVersion:2}});
    expect(recheck.statusCode).toBe(202);expect(recheck.json()).toEqual({topup});
    expect(Object.keys(created.json())).toEqual(['topup','checkout']);await app.close();
  });

  it('serves a static no-store return page that never asserts payment success',async()=>{const app=Fastify({logger:false});
    await registerQixiangTopupRoutes(app,accounts,fake());const response=await app.inject('/payments/qixiang/return');
    expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.body).toContain('支付结果核对中');expect(response.body).not.toContain('支付成功');await app.close();});

  it('keeps history, recheck and callbacks online while independently blocking new topups',async()=>{
    const app=Fastify({logger:false});installErrorHandling(app);const service=fake();
    await registerQixiangTopupRoutes(app,accounts,service,async()=>false);const authorization={authorization:'Bearer paired',
      'x-kai-id-token':'paired-id'};
    const created=await app.inject({method:'POST',url:'/mobile/v1/credits/topups/qixiang',headers:{...authorization,
      'idempotency-key':'disabled-create-key-01'},payload:{amountCents:1002,rail:'qixiang_alipay'}});
    expect(created.statusCode).toBe(503);expect(service.create).not.toHaveBeenCalled();
    expect((await app.inject({method:'GET',url:'/mobile/v1/credits/topups/qixiang',headers:authorization})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`/mobile/v1/credits/topups/qixiang/${id}/recheck`,headers:{...authorization,
      'idempotency-key':'disabled-recheck-key-01'},payload:{expectedVersion:2}})).statusCode).toBe(202);
    expect((await app.inject('/mobile/v1/credits/topups/qixiang/notify?opaque=1')).body).toBe('success');await app.close();
  });

  it('publishes the active-query worker blocker in dynamic readiness',async()=>{
    const service=({...fake(),readiness:vi.fn().mockResolvedValue({ready:true,maxAmountCents:4_999_999,blockers:[]})}) as unknown as QixiangTopupService;
    const app=await buildApp({config:config('on'),database:null,accountService:accounts,qixiangTopupService:service,
      creditLotExpiryHealth:()=>({ready:true,consecutiveFailures:0,lastAttemptAt:null,lastSuccessAt:null}),
      qixiangQueryWorkerHealth:async()=>({ready:false,consecutiveFailures:3,lastAttemptAt:null,lastSuccessAt:null,
        healthyInstances:0,observedInstances:1}),logger:false});
    const response=await app.inject('/mobile/v1/readiness');
    expect(response.json().release.blockers).toContain('QIXIANG_QUERY_WORKER_UNHEALTHY');await app.close();
  });

  it('allows only the canary topup mutation while blocking every other commerce and refund mutation',async()=>{
    const qixiang=fake();const otherCreate=vi.fn();const refundRequest=vi.fn();
    const app=await buildApp({config:config('on'),database:null,accountService:accounts,qixiangTopupService:qixiang,
      qixiangRefundService:{request:refundRequest}as never,creditTopupService:{create:otherCreate}as never,
      qixiangBootstrapCanary:true,qixiangBootstrapCanaryTopupId:id,logger:false});
    const headers={authorization:'Bearer paired','x-kai-id-token':'paired-id','idempotency-key':'bootstrap-canary-key-1'};
    const canary=await app.inject({method:'POST',url:'/mobile/v1/credits/topups/qixiang',headers,
      payload:{amountCents:501,rail:'qixiang_alipay'}});expect(canary.statusCode).toBe(201);
    const ordinary=await app.inject({method:'POST',url:'/mobile/v1/credits/topups',headers,payload:{amountCents:501}});
    expect(ordinary.statusCode).toBe(503);expect(ordinary.json().error.code).toBe('QIXIANG_BOOTSTRAP_ROUTE_BLOCKED');
    const refund=await app.inject({method:'POST',url:`/mobile/v1/operator/credits/topups/${id}/qixiang-refunds`,headers,
      payload:{reasonCode:'customer_request',evidenceDigest:'a'.repeat(64)}});
    expect(refund.statusCode).toBe(503);expect(refundRequest).not.toHaveBeenCalled();expect(otherCreate).not.toHaveBeenCalled();
    const otherRecheck=await app.inject({method:'POST',url:'/mobile/v1/credits/topups/qixiang/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/recheck',
      headers,payload:{expectedVersion:1}});
    expect(otherRecheck.statusCode).toBe(503);expect(qixiang.recheck).not.toHaveBeenCalled();
    await app.close();
  });

  it('projects the signed bootstrap as one visible ¥5.01 canary while release commerce stays closed',async()=>{
    const service={...fake(),startupReadiness:vi.fn().mockResolvedValue({ready:true,maxAmountCents:501,blockers:[],
      phase:'bootstrap_canary'})}as unknown as QixiangTopupService;
    const database={health:async()=>true,schemaReadiness:async()=>({ready:true,expected:null,applied:null,missing:[],
      mismatched:[]})}as never;
    const app=await buildApp({config:config('on'),database,accountService:accounts,qixiangTopupService:service,
      qixiangBootstrapCanary:true,qixiangBootstrapCanaryTopupId:id,logger:false});
    const response=await app.inject('/mobile/v1/readiness');const body=response.json();
    expect(body.release.ready).toBe(false);expect(body.release.blockers).toContain('QIXIANG_BOOTSTRAP_CANARY_ONLY');
    expect(body.capabilities.qixiangTopups).toMatchObject({available:true,canaryOnly:true,
      minAmountCents:501,maxAmountCents:501,blockers:[]});
    await app.close();
  });

  it('logs only the callback path and never the raw query or signed payment fields',async()=>{const chunks:string[]=[];
    const stream=new Writable({write(chunk,_encoding,callback){chunks.push(chunk.toString());callback();}});
    const app=Fastify({loggerInstance:pino(applicationLoggerOptions(),stream)});await registerQixiangTopupRoutes(
      app as unknown as FastifyInstance,accounts,fake());
    const raw='pid=4611&trade_no=SECRETTRADE123&out_trade_no=SECRETOUT1234567890123456&param=SECRETPARAM&sign=SECRETMD5';
    const response=await app.inject(`/mobile/v1/credits/topups/qixiang/notify?${raw}`);expect(response.statusCode).toBe(200);
    await app.close();const logs=chunks.join('');expect(logs).toContain('/mobile/v1/credits/topups/qixiang/notify');
    for(const forbidden of ['?pid=','sign','trade_no','out_trade_no','param','SECRETTRADE123','SECRETOUT','SECRETPARAM','SECRETMD5']){
      expect(logs).not.toContain(forbidden);}
  });

  it('ACKs duplicate concurrent verified callbacks with the exact durable response',async()=>{const app=Fastify({logger:false});
    const service=fake();await registerQixiangTopupRoutes(app,accounts,service);const url='/mobile/v1/credits/topups/qixiang/notify?opaque=1';
    const responses=await Promise.all([app.inject(url),app.inject(url)]);expect(responses.map((item)=>[item.statusCode,item.body]))
      .toEqual([[200,'success'],[200,'success']]);expect((service.notification as unknown as ReturnType<typeof vi.fn>))
      .toHaveBeenCalledTimes(2);await app.close();});

  it.each([
    ['inquiry_only','on'],['full_commerce','off'],['full_commerce','shadow'],
  ]as const)('physically omits all Qixiang routes in profile=%s mode=%s',async(profile,mode)=>{
    const app=await buildApp({config:config(mode,profile),database:null,accountService:accounts,qixiangTopupService:fake(),logger:false});
    for(const url of ['/mobile/v1/credits/topups/qixiang','/payments/qixiang/return']){
      const response=await app.inject({method:'GET',url});expect(response.statusCode).toBe(404);}
    await app.close();
  });
});
