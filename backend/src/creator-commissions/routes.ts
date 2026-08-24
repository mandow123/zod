import type { FastifyInstance,FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { CreatorCommissionService } from './service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

function parse<T>(schema:z.ZodType<T>,value:unknown):T { const result=schema.safeParse(value);
  if(!result.success)throw new AppError('VALIDATION_ERROR',400,'提交的信息不完整或格式不正确。');return result.data; }
function key(request:FastifyRequest){return String(request.headers['idempotency-key']??'');}

export async function registerCreatorCommissionRoutes(app:FastifyInstance,accounts:AccountService,
  service:CreatorCommissionService) {
  app.get('/referral',async(request,reply)=>{
    const query=parse(z.object({token:z.string().trim().min(24).max(2_048)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)}).strict(),request.query);
    const deepLink=`kaicloudpay://referral?token=${encodeURIComponent(query.token)}`;
    const htmlLink=deepLink.replace(/[&<>"']/gu,(character)=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[character]!);
    const scriptLink=JSON.stringify(deepLink).replace(/</gu,'\\u003c');
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="zh-CN"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="refresh" content="0;url=${htmlLink}"><title>打开 Zod</title></head>
      <body><main><p>正在打开 Zod…</p><p><a href="${htmlLink}">点击继续</a></p></main>
      <script>window.location.replace(${scriptLink});</script></body></html>`);
  });
  app.post('/mobile/v1/creator/referral-links',async(request,reply)=>{
    const {principal}=await authenticateMobileRequest(accounts, request);
    parse(z.object({}).strict(),request.body??{});
    const result=await service.createReferralLink(principal,key(request));
    return reply.status(result.replayed?200:201).send({ok:true,...result});
  });
  app.post('/mobile/v1/referrals/attribute',async(request,reply)=>{
    const {principal}=await authenticateMobileRequest(accounts, request);
    const body=parse(z.object({token:z.string().trim().min(24).max(2_048)}).strict(),request.body);
    const result=await service.attribute(principal,body.token);
    return reply.status(result.replayed?200:201).send({ok:true,...result});
  });
  app.get('/mobile/v1/creator/commissions',async(request)=>{
    const {principal}=await authenticateMobileRequest(accounts, request);
    return {ok:true,...await service.summary(principal)};
  });
  app.post('/mobile/v1/creator/commissions/transfer',async(request,reply)=>{
    const {principal}=await authenticateMobileRequest(accounts, request);
    parse(z.object({}).strict(),request.body??{});
    const result=await service.transferAvailable(principal,key(request));
    return reply.status(result.replayed?200:201).send({ok:true,...result});
  });
  app.get('/mobile/v1/creator/reward-events',async(request)=>{
    const {principal}=await authenticateMobileRequest(accounts, request);
    const query=parse(z.object({limit:z.coerce.number().int().min(1).max(50).optional()}).strict(),request.query);
    return {ok:true,...await service.rewardEvents(principal,query.limit)};
  });
  app.post('/mobile/v1/creator/reward-events/:eventId/consume',async(request)=>{
    const {principal}=await authenticateMobileRequest(accounts, request);
    const params=parse(z.object({eventId:z.string().uuid()}).strict(),request.params);
    parse(z.object({}).strict(),request.body??{});
    return {ok:true,...await service.consumeReward(principal,params.eventId)};
  });
}
