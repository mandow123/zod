import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { SupplierInquiryCatalogService } from './service.js';

function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)
  throw new AppError('VALIDATION_ERROR',400,'请求参数格式不正确。',{fields:result.error.issues.map((issue)=>({path:issue.path.join('.'),code:issue.code}))});return result.data;}

export async function registerSupplierInquiryCatalogRoutes(app:FastifyInstance,service:SupplierInquiryCatalogService){
  app.get('/mobile/v1/supplier-inquiry-catalog',async(request)=>{const query=parse(z.object({
    kind:z.enum(['hourly_gpu','contract_monthly']).optional(),model:z.enum(['A100','H100','H200','B200','B300']).optional(),
    query:z.string().trim().min(1).max(120).optional(),cursor:z.string().max(2000).optional(),
    limit:z.coerce.number().int().min(1).max(50).optional()}).strict(),request.query);
    const input={...(query.kind===undefined?{}:{kind:query.kind}),...(query.model===undefined?{}:{model:query.model}),
      ...(query.query===undefined?{}:{query:query.query}),...(query.cursor===undefined?{}:{cursor:query.cursor}),
      ...(query.limit===undefined?{}:{limit:query.limit})};return{ok:true,...await service.list(input)};});
  app.get('/mobile/v1/supplier-inquiry-catalog/:resourceId',async(request)=>{const params=parse(z.object({
    resourceId:z.string().regex(/^(?:gpu|server)-honghuan-[a-z0-9-]{6,100}$/u)}).strict(),request.params);
    return{ok:true,item:await service.get(params.resourceId)};});
}
