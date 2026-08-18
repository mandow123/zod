import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';
import { AppError } from '../errors.js';
import type { ResourceInquiryService } from './service.js';

const status=z.enum(['submitted','awaiting_supplier','clarification_required','supplier_declined','inquiry_expired','user_cancelled','capacity_confirmed','audit_pending']);
const model=z.enum(['H100','H200','B300']);
const uuid=z.string().uuid();
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)
  throw new AppError('VALIDATION_ERROR',400,'提交的信息不完整或格式不正确。',{fields:result.error.issues.map((issue)=>({path:issue.path.join('.'),code:issue.code}))});return result.data;}
function key(request:FastifyRequest){return String(request.headers['idempotency-key']??'');}
function context(request:FastifyRequest){return{requestId:request.id,ip:request.ip};}
function auth(accounts:AccountService,request:FastifyRequest){return authenticateMobileRequest(accounts,request);}

export async function registerResourceInquiryRoutes(app:FastifyInstance,accounts:AccountService,service:ResourceInquiryService){
  app.get('/mobile/v1/inquiry-catalog',async(request)=>{const query=parse(z.object({model:model.optional(),region:z.string().trim().min(2).max(40).optional(),
    query:z.string().trim().min(1).max(80).optional(),cursor:z.string().max(2000).optional(),limit:z.coerce.number().int().min(1).max(50).optional()}).strict(),request.query);
    const input={...(query.model===undefined?{}:{model:query.model}),...(query.region===undefined?{}:{region:query.region}),
      ...(query.query===undefined?{}:{query:query.query}),...(query.cursor===undefined?{}:{cursor:query.cursor}),
      ...(query.limit===undefined?{}:{limit:query.limit})};return{ok:true,...await service.catalog(input)};});
  app.get('/mobile/v1/inquiry-catalog/:candidateId',async(request)=>{const params=parse(z.object({candidateId:uuid}),request.params);
    return{ok:true,candidate:await service.candidate(params.candidateId)};});
  app.post('/mobile/v1/resource-inquiries',async(request,reply)=>{const{principal}=await auth(accounts,request);
    const body=parse(z.object({candidateId:uuid,startsAt:z.string().datetime({offset:true}),endsAt:z.string().datetime({offset:true}),
      timeZone:z.string().trim().min(1).max(100),confirmBy:z.string().datetime({offset:true}),gpuCount:z.number().int().positive().max(100000),
      billingMode:z.enum(['hourly','monthly']),allowSubstitutes:z.boolean(),maxCreditAmount:z.string().trim().min(1).max(40),
      useCase:z.enum(['training','inference','rendering','research','other']),description:z.string().trim().min(20).max(500),
      environment:z.enum(['bare_metal','virtual_machine','container','flexible']),
      network:z.enum(['public_internet','private_network','dedicated_line','flexible']),storageGiB:z.number().int().positive().max(10000000),
      dataRegion:z.string().trim().min(2).max(80),terms:z.object({termsVersion:z.string().trim().min(1).max(40),
        privacyVersion:z.string().trim().min(1).max(40),inquiryVersion:z.string().trim().min(1).max(40)}).strict()}).strict(),request.body);
    const result=await service.create(principal,{...body,idempotencyKey:key(request)},context(request));
    return reply.status(result.replayed?200:201).send({ok:true,...result});});
  app.get('/mobile/v1/resource-inquiries',async(request)=>{const{principal}=await auth(accounts,request);
    const query=parse(z.object({status:status.optional(),cursor:z.string().max(2000).optional(),limit:z.coerce.number().int().min(1).max(50).optional()}).strict(),request.query);
    const input={...(query.status===undefined?{}:{status:query.status}),...(query.cursor===undefined?{}:{cursor:query.cursor}),
      ...(query.limit===undefined?{}:{limit:query.limit})};return{ok:true,...await service.list(principal,input)};});
  app.get('/mobile/v1/resource-inquiries/:inquiryId',async(request)=>{const{principal}=await auth(accounts,request);
    const params=parse(z.object({inquiryId:uuid}),request.params);return{ok:true,inquiry:await service.get(principal,params.inquiryId)};});
  app.get('/mobile/v1/resource-inquiries/:inquiryId/clarifications',async(request)=>{const{principal}=await auth(accounts,request);
    const params=parse(z.object({inquiryId:uuid}),request.params);return{ok:true,clarifications:await service.clarifications(principal,params.inquiryId)};});
  app.post('/mobile/v1/resource-inquiries/:inquiryId/clarifications',async(request,reply)=>{const{principal}=await auth(accounts,request);
    const params=parse(z.object({inquiryId:uuid}),request.params),body=parse(z.object({message:z.string().trim().min(20).max(1000),expectedVersion:z.number().int().positive()}).strict(),request.body);
    const result=await service.clarify(principal,params.inquiryId,body.message,body.expectedVersion,key(request),context(request));
    return reply.status(result.replayed?200:201).send({ok:true,...result});});
  app.post('/mobile/v1/resource-inquiries/:inquiryId/cancel',async(request)=>{const{principal}=await auth(accounts,request);
    const params=parse(z.object({inquiryId:uuid}),request.params),body=parse(z.object({expectedVersion:z.number().int().positive()}).strict(),request.body??{});
    return{ok:true,...await service.cancel(principal,params.inquiryId,body.expectedVersion,key(request),context(request))};});

  const scopedQuery=z.object({status:status.optional(),cursor:z.string().max(2000).optional(),limit:z.coerce.number().int().min(1).max(50).optional()}).strict();
  const scopedInput=(query:z.infer<typeof scopedQuery>)=>({...(query.status?{status:query.status}:{}),
    ...(query.cursor?{cursor:query.cursor}:{}),...(query.limit?{limit:query.limit}:{})});
  app.get('/mobile/v1/provider/resource-inquiries',async(request)=>{const{principal}=await auth(accounts,request);
    return{ok:true,...await service.supplierList(principal,scopedInput(parse(scopedQuery,request.query)))};});
  app.get('/mobile/v1/provider/resource-inquiries/:inquiryId',async(request)=>{const{principal}=await auth(accounts,request);
    const params=parse(z.object({inquiryId:uuid}),request.params);return{ok:true,inquiry:await service.supplierGet(principal,params.inquiryId)};});
  for(const action of ['request-clarification','decline','confirm-capacity'] as const)app.post(`/mobile/v1/provider/resource-inquiries/:inquiryId/${action}`,async(request)=>{
    const{principal}=await auth(accounts,request),params=parse(z.object({inquiryId:uuid}),request.params);
    const body=parse(z.object({expectedVersion:z.number().int().positive(),message:z.string().trim().min(action==='decline'?2:20).max(action==='decline'?500:1000).optional()}).strict(),request.body);
    const internal=action==='request-clarification'?'request_clarification':action==='confirm-capacity'?'confirm_capacity':'decline';
    return{ok:true,...await service.supplierAction(principal,params.inquiryId,internal,{expectedVersion:body.expectedVersion,
      ...(body.message?{message:body.message}:{})},key(request),context(request))};});

  app.get('/mobile/v1/operator/resource-inquiries',async(request)=>{const{principal}=await auth(accounts,request);
    const query=parse(scopedQuery.extend({assignment:z.enum(['assigned','unassigned']).optional()}),request.query);
    return{ok:true,...await service.operatorList(principal,{...scopedInput(query),...(query.assignment?{assignment:query.assignment}:{})})};});
  app.get('/mobile/v1/operator/resource-inquiries/:inquiryId',async(request)=>{const{principal}=await auth(accounts,request);
    const params=parse(z.object({inquiryId:uuid}),request.params);return{ok:true,inquiry:await service.operatorGet(principal,params.inquiryId)};});
  app.post('/mobile/v1/operator/resource-inquiries/:inquiryId/assign',async(request)=>{const{principal}=await auth(accounts,request);
    const params=parse(z.object({inquiryId:uuid}),request.params),body=parse(z.object({supplierSubjectId:uuid,expectedVersion:z.number().int().positive()}).strict(),request.body);
    return{ok:true,...await service.assign(principal,params.inquiryId,body,key(request),context(request))};});
  for(const action of ['request-clarification','expire','submit-audit'] as const)app.post(`/mobile/v1/operator/resource-inquiries/:inquiryId/${action}`,async(request)=>{
    const{principal}=await auth(accounts,request),params=parse(z.object({inquiryId:uuid}),request.params);
    const body=parse(z.object({expectedVersion:z.number().int().positive(),message:z.string().trim().min(20).max(1000).optional()}).strict(),request.body);
    const internal=action==='request-clarification'?'request_clarification':action==='submit-audit'?'submit_audit':'expire';
    return{ok:true,...await service.operatorAction(principal,params.inquiryId,internal,{expectedVersion:body.expectedVersion,
      ...(body.message?{message:body.message}:{})},key(request),context(request))};});
}
