import type {FastifyInstance}from'fastify';import{z}from'zod';
import type{AccountService}from'../account/service.js';import{authenticateMobileRequest}from'../account/request-auth.js';
import{AppError}from'../errors.js';import type{QixiangRefundService}from'./qixiang-refund-service.js';
function parse<T>(schema:z.ZodType<T>,value:unknown){const result=schema.safeParse(value);if(!result.success)
  throw new AppError('VALIDATION_ERROR',400,'提交的信息不完整或格式不正确。');return result.data;}
function key(value:unknown){const result=typeof value==='string'?value:'';if(!/^[A-Za-z0-9:_-]{16,120}$/u.test(result))
  throw new AppError('IDEMPOTENCY_KEY_INVALID',400,'请求缺少有效的幂等标识。');return result;}
const evidence=z.string().regex(/^[0-9a-f]{64}$/u);const id=z.object({refundId:z.string().uuid()}).strict();
export async function registerQixiangRefundRoutes(app:FastifyInstance,accounts:AccountService,service:QixiangRefundService){
  app.get('/mobile/v1/operator/qixiang-refunds/:refundId',async(request)=>{const{principal}=await authenticateMobileRequest(accounts,request);
    return service.get(principal,parse(id,request.params).refundId);});
  app.post('/mobile/v1/operator/credits/topups/:topupId/qixiang-refunds',async(request,reply)=>{const{principal}=await authenticateMobileRequest(accounts,request);
    const params=parse(z.object({topupId:z.string().uuid()}).strict(),request.params);const body=parse(z.object({
      reasonCode:z.enum(['customer_request','service_unavailable','duplicate_payment','fraud_confirmed','other']),
      evidenceDigest:evidence}).strict(),request.body);const result=await service.request(principal,params.topupId,{...body,
      idempotencyKey:key(request.headers['idempotency-key'])});return reply.status(result.replayed?200:201).send(result);});
  for(const action of['approve','submit','takeover','confirm','reject']as const)app.post(`/mobile/v1/operator/qixiang-refunds/:refundId/${action}`,
    async(request,reply)=>{const{principal}=await authenticateMobileRequest(accounts,request);const params=parse(id,request.params);
      const body=parse(z.object({evidenceDigest:evidence}).strict(),request.body);const result=await service[action](principal,params.refundId,
        {...body,idempotencyKey:key(request.headers['idempotency-key'])});return reply.status(result.replayed?200:202).send(result);});
}
