import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';
import { AppError } from '../errors.js';
import type { QixiangTopupService } from './qixiang-service.js';

function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);
  if(!result.success)throw new AppError('VALIDATION_ERROR',400,'提交的信息不完整或格式不正确。',{
    fields:result.error.issues.map((issue)=>({path:issue.path.join('.'),code:issue.code})),});return result.data;}
function key(value:unknown){const result=typeof value==='string'?value:'';
  if(!/^[A-Za-z0-9:_-]{16,120}$/u.test(result))throw new AppError('IDEMPOTENCY_KEY_INVALID',400,
    '请求缺少有效的幂等标识。');return result;}

export async function registerQixiangTopupRoutes(app:FastifyInstance,accounts:AccountService,service:QixiangTopupService,
  allowNewTopups:boolean|(()=>boolean|Promise<boolean>)=true){
  app.post('/mobile/v1/credits/topups/qixiang',{config:{rateLimit:{max:10,timeWindow:'1 hour'}}},async(request,reply)=>{
    const newTopupsEnabled=typeof allowNewTopups==='function'?await allowNewTopups():allowNewTopups;
    if(!newTopupsEnabled)throw new AppError('QIXIANG_NEW_TOPUPS_DISABLED',503,
      '新建充值暂时关闭；历史充值仍会继续核单和处理退款。');
    const{principal}=await authenticateMobileRequest(accounts,request);const body=parse(z.object({
      amountCents:z.number().int().min(100).max(4_999_999),rail:z.literal('qixiang_alipay'),
    }).strict(),request.body);const result=await service.create(principal,{...body,idempotencyKey:key(request.headers['idempotency-key'])},
    {requestId:request.id,ip:request.ip});return reply.status(result.replayed?200:201).send({topup:result.topup,checkout:result.checkout});
  });
  app.get('/mobile/v1/credits/topups/qixiang',async(request)=>{const{principal}=await authenticateMobileRequest(accounts,request);
    const query=parse(z.object({limit:z.coerce.number().int().min(1).max(100).default(30),cursor:z.string().max(256).optional()}).strict(),
      request.query);return service.list(principal,{limit:query.limit,...(query.cursor===undefined?{}:{cursor:query.cursor})});});
  app.get('/mobile/v1/credits/topups/qixiang/:topupId',async(request)=>{const{principal}=await authenticateMobileRequest(accounts,request);
    const parameters=parse(z.object({topupId:z.string().uuid()}).strict(),request.params);return service.get(principal,parameters.topupId);});
  app.post('/mobile/v1/credits/topups/qixiang/:topupId/recheck',{config:{rateLimit:{max:20,timeWindow:'1 hour'}}},
  async(request,reply)=>{const{principal}=await authenticateMobileRequest(accounts,request);
    const parameters=parse(z.object({topupId:z.string().uuid()}).strict(),request.params);
    const body=parse(z.object({expectedVersion:z.number().int().min(1)}).strict(),request.body);
    const result=await service.recheck(principal,{topupId:parameters.topupId,expectedVersion:body.expectedVersion,
      idempotencyKey:key(request.headers['idempotency-key'])},{requestId:request.id,ip:request.ip});
    return reply.status(202).send(result);});
  app.get('/mobile/v1/credits/topups/qixiang/notify',{config:{rateLimit:{max:300,timeWindow:'1 minute'}}},
  async(request,reply)=>{try{const url=request.raw.url??'';const separator=url.indexOf('?');
    if(separator<0)throw new AppError('QIXIANG_NOTIFICATION_INVALID',400,'七相支付通知参数为空。');
    await service.notification(url.slice(separator+1),{requestId:request.id,ip:request.ip});
    return reply.type('text/plain; charset=utf-8').send('success');
  }catch{return reply.status(400).type('text/plain; charset=utf-8').send('failure');}});
  app.get('/payments/qixiang/return',async(_request,reply)=>reply.header('Cache-Control','no-store, max-age=0')
    .type('text/html; charset=utf-8').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>支付结果核对中</title><body><main><h1>支付结果核对中</h1><p>请返回 KAI CloudPay 查看最新状态。卡时仅在支付渠道主动查单确认后到账。</p></main></body></html>'));
}
