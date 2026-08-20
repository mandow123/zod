import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { StagingSandboxStore, type SandboxPrincipal } from './store.js';

const enabled = (process.env.ZOD_ENV === 'staging' && process.env.STAGING_SANDBOX_ENABLED === 'true')
  || (process.env.NODE_ENV === 'test' && process.env.LOCAL_E2E === 'true');
if (!enabled) throw new Error('STAGING_SANDBOX_DISABLED');
if (process.env.NODE_ENV === 'production' && process.env.ZOD_ENV !== 'staging') throw new Error('STAGING_SANDBOX_PRODUCTION_FORBIDDEN');
if (process.env.DATABASE_URL) throw new Error('STAGING_SANDBOX_DATABASE_URL_FORBIDDEN');
if (process.env.PUBLIC_ORIGIN) throw new Error('STAGING_SANDBOX_PUBLIC_ORIGIN_FORBIDDEN');

function required(name:string,min=43){const value=process.env[name]?.trim();if(!value||value.length<min)throw new Error(`${name}_REQUIRED`);return value;}
const tokens={buyer:required('STAGING_BUYER_TOKEN'),creator:required('STAGING_CREATOR_TOKEN'),operator:required('STAGING_OPERATOR_ACCESS_TOKEN'),supplier:required('STAGING_SUPPLIER_TOKEN')};
const operatorToken=required('STAGING_OPERATOR_CONTROL_TOKEN',32);
if(new Set([...Object.values(tokens),operatorToken]).size!==5)throw new Error('STAGING_SECRETS_MUST_BE_DISTINCT');
const productionFingerprints=['ACCESS_TOKEN_SECRET','REFRESH_TOKEN_PEPPER','OTP_PEPPER','KAI_OIDC_CLIENT_SECRET','COMPUTE_PROVIDER_TOKEN']
  .map(name=>process.env[name]?.trim()).filter((value):value is string=>Boolean(value));
if (productionFingerprints.includes(operatorToken)||Object.values(tokens).some(value=>productionFingerprints.includes(value))) throw new Error('STAGING_SECRET_FINGERPRINT_COLLISION');
const databasePath=process.env.STAGING_DATABASE_PATH?.trim()??'memory://';
if (databasePath!=='memory://'&&!databasePath.includes('zod-staging-sandbox')) throw new Error('STAGING_DATABASE_PATH_UNSAFE');
if(process.env.NODE_ENV==='production'&&databasePath==='memory://')throw new Error('STAGING_PERSISTENT_DATABASE_REQUIRED');
const db=new PGlite(databasePath);
const store=new StagingSandboxStore(db);await store.initialize(tokens);

type RequestWithPrincipal=FastifyRequest&{sandboxPrincipal?:SandboxPrincipal};
function error(code:string,statusCode:number):never{throw Object.assign(new Error(code),{code,statusCode});}
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)error('VALIDATION_ERROR',400);return result.data as T;}
function draftValidation(field:string,reason:string):never{throw Object.assign(new Error('VALIDATION_ERROR'),{code:'VALIDATION_ERROR',statusCode:422,details:{field,reason}});}
function parseDraft<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(result.success)return result.data;
  const issue=result.error.issues[0];const field=issue?.path.join('.')||((issue&&'keys'in issue&&Array.isArray(issue.keys))?String(issue.keys[0]??'body'):'body');
  draftValidation(field,issue?.code==='unrecognized_keys'?'unknown_field':'invalid_value');}
function safeEqual(left:string,right:string){const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}
function bearer(request:FastifyRequest):string{const session=request.headers['x-kai-e2e-session'];if(typeof session!=='string'||session.length>200)error('AUTH_REQUIRED',401);return session;}
function key(request:FastifyRequest):string{const value=request.headers['idempotency-key'];if(typeof value!=='string')error('IDEMPOTENCY_KEY_REQUIRED',400);return value;}
function version(){return z.number().int().min(1);}
function offset(value:string|undefined){if(!value)return 0;try{const decoded=Buffer.from(value,'base64url').toString('utf8');if(!/^\d{1,9}$/u.test(decoded))throw new Error();return Number(decoded);}catch{error('VALIDATION_ERROR',400);}}
function page<T>(items:T[],limit:number,start:number){const more=items.length>limit;return{items:items.slice(0,limit),nextCursor:more?Buffer.from(String(start+limit)).toString('base64url'):null};}

const app=Fastify({logger:{redact:{paths:['req.headers.authorization','req.headers.x-kai-e2e-session','req.headers.x-zod-staging-operator-token'],censor:'[REDACTED]'}},requestIdHeader:'x-request-id'});
app.addHook('onRequest',async request=>{
  if(request.headers['x-zod-client-environment']!=='staging')error('STAGING_ENVIRONMENT_MISMATCH',409);
  if(request.headers.authorization!==undefined||request.headers['x-kai-id-token']!==undefined)error('AUTH_SCHEME_CONFLICT',400);
  const principal=await store.principal(bearer(request));if(!principal)error('AUTH_REQUIRED',401);(request as RequestWithPrincipal).sandboxPrincipal=principal;
});
app.addHook('onSend',async(request,reply,payload)=>{reply.header('X-Zod-Environment','staging').header('Cache-Control','no-store');if(reply.getHeader('content-type')?.toString().includes('application/json')&&typeof payload==='string'){
    const body=JSON.parse(payload) as Record<string,unknown>;return JSON.stringify({ok:reply.statusCode<400,environment:'staging',simulation:true,requestId:request.id,...body});}return payload;});
app.setErrorHandler((cause,request,reply)=>{const item=cause as Error&{code?:string;statusCode?:number;details?:{field:string;reason:string};currentVersion?:number};const code=item.code&&/^[A-Z0-9_]+$/u.test(item.code)?item.code:'INTERNAL_ERROR';const message=code==='INTERNAL_ERROR'?'测试环境暂时不可用。':code==='SSH_KEY_IN_USE'?'该公钥正在用于人工履约，请先取消订单或等待履约请求被拒绝。':code;reply.status(item.statusCode??500).send({error:{code,message,...(item.details?{details:item.details}:{}),...(item.currentVersion!==undefined?{currentVersion:item.currentVersion}:{})}});});
function principal(request:FastifyRequest){return (request as RequestWithPrincipal).sandboxPrincipal!;}
function operator(request:FastifyRequest){const actor=principal(request);if(!['operator','admin'].includes(actor.role))error('FORBIDDEN',403);const value=request.headers['x-zod-staging-operator-token'];if(typeof value!=='string'||!safeEqual(value,operatorToken))error('FORBIDDEN',403);return actor;}
function supplier(request:FastifyRequest){const actor=principal(request);if(actor.role!=='supplier')error('FORBIDDEN',403);return actor;}
function buyer(request:FastifyRequest){const actor=principal(request);if(actor.role!=='member')error('FORBIDDEN',403);return actor;}

const safeText=(max:number)=>z.string().trim().min(1).max(max).nullable();
const nullableInt=(max:number)=>z.number().int().min(1).max(max).nullable();
const fixedPositive=(maxMajor:string)=>z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u).refine(value=>{
  const [major='0',minor='0']=value.split('.');const units=BigInt(major)*100n+BigInt(minor);return units>0n&&units<=BigInt(maxMajor)*100n;
});
const resourceSchema=z.object({
  name:safeText(80),gpuModel:safeText(80),gpuCardType:z.enum(['SXM','PCIe','other']).nullable(),gpuCount:nullableInt(1024),
  gpuMemoryGb:nullableInt(2048),regionCode:z.enum(['CN-SH','CN-BJ','CN-GD','CN-ZJ','CN-JS','CN-SC','CN-OTHER']).nullable(),
  city:safeText(40),machineType:z.enum(['bare_metal','virtualized']).nullable(),cpuModel:safeText(120),cpuCores:nullableInt(1024),
  memoryGb:nullableInt(65536),storageGb:nullableInt(1_000_000),networkMbps:nullableInt(1_000_000),
  operatingSystem:z.enum(['ubuntu_22_04','ubuntu_24_04','other']).nullable(),capacityGpuHours:fixedPositive('1000000000').nullable(),
  fulfillmentNotes:safeText(500),
}).strict();
const timezone=z.string().min(1).max(80).refine(value=>{try{new Intl.DateTimeFormat('en-US',{timeZone:value});return true;}catch{return false;}});
const scheduledPlan=z.object({mode:z.literal('scheduled_window'),startsAt:z.string().datetime({offset:true}),endsAt:z.string().datetime({offset:true}),timezone,leadTimeHours:z.null()}).strict()
  .refine(value=>Date.parse(value.endsAt)>Date.parse(value.startsAt),{path:['endsAt']});
const leadTimePlan=z.object({mode:z.literal('preparation_lead_time'),startsAt:z.null(),endsAt:z.null(),timezone:z.null(),leadTimeHours:z.number().int().min(1).max(2160)}).strict();
const deliveryPlanSchema=z.discriminatedUnion('mode',[scheduledPlan,leadTimePlan]).nullable();
const pricingSchema=z.object({unit:z.literal('KAI_CARD_HOUR_PER_GPU_HOUR'),amount:fixedPositive('1000000').nullable()}).strict();
const acknowledgementsSchema=z.object({ownershipConfirmed:z.boolean(),remoteAccessSafetyAcknowledged:z.boolean()}).strict();
const supplierDraftCreateSchema=z.object({clientDraftId:z.string().uuid(),resource:resourceSchema,deliveryPlan:deliveryPlanSchema,pricing:pricingSchema,acknowledgements:acknowledgementsSchema}).strict();
const supplierDraftPatchSchema=z.object({expectedVersion:version(),patch:z.object({
  resource:resourceSchema.partial().optional(),deliveryPlan:deliveryPlanSchema.optional(),
  pricing:z.object({unit:z.literal('KAI_CARD_HOUR_PER_GPU_HOUR').optional(),amount:fixedPositive('1000000').nullable().optional()}).strict().refine(value=>Object.keys(value).length>0).optional(),
  acknowledgements:acknowledgementsSchema.partial().refine(value=>Object.keys(value).length>0).optional(),
}).strict().refine(value=>Object.keys(value).length>0)}).strict();
const sensitivePattern=/(?:演示|展示|期货|交易|password|passwd|private\s*key|begin\s+[a-z ]*private\s+key|token|secret|ssh|用户名|密码|私钥|令牌|密钥|(?:host(?:name)?|端口|port)\s*[:=]?\s*[^\s,，;；]+|(?:https?:\/\/|www\.)\S+|(?:\b(?:\d{1,3}\.){3}\d{1,3}\b)|(?:\b1[3-9]\d{9}\b)|(?:\b\d{16,19}\b)|(?:\b\d{17}[\dXx]\b)|(?:机房|园区|\d+号楼|\d+室))/iu;
function assertDraftContent(value:unknown,path='body'):void{
  if(typeof value==='string'){if(sensitivePattern.test(value))draftValidation(path,'sensitive_or_disallowed_content');return;}
  if(Array.isArray(value)){value.forEach((item,index)=>assertDraftContent(item,`${path}.${index}`));return;}
  if(value&&typeof value==='object')for(const [key,item] of Object.entries(value))assertDraftContent(item,`${path}.${key}`);
}
const sshLabelForbidden=/(?:演示|展示|期货|交易|(?:\b1[3-9]\d{9}\b)|(?:\b\d{16,19}\b)|(?:\b\d{17}[\dXx]\b)|(?:机房|园区|\d+号楼|\d+室))/u;
function assertSshLabel(value:string){if(sshLabelForbidden.test(value))draftValidation('label','sensitive_or_disallowed_content');}

app.get('/mobile/v1/staging/health',async()=>({status:'ready'}));
app.get('/mobile/v1/staging/balance',async request=>({balance:await store.balance(principal(request).subjectId)}));
app.post('/mobile/v1/staging/topups',async(request,reply)=>{const body=parse(z.object({amount:z.string()}).strict(),request.body);const result=await store.createTopup(principal(request).subjectId,body.amount,key(request));return reply.status(result.replayed?200:201).send(result.body);});
app.get('/mobile/v1/staging/topups',async request=>{const query=parse(z.object({cursor:z.string().optional(),limit:z.coerce.number().int().min(1).max(100).default(20)}).strict(),request.query),start=offset(query.cursor);return page(await store.topups(principal(request).subjectId,query.limit+1,start),query.limit,start);});
app.get('/mobile/v1/staging/topups/:id',async request=>{const params=parse(z.object({id:z.string().uuid()}),request.params);return{topup:await store.topup(params.id,principal(request).subjectId)};});
app.post('/staging/v1/operator/topups/:id/outcome',async(request,reply)=>{const actor=operator(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({outcome:z.enum(['succeeded','failed','canceled']),expectedVersion:version(),reasonCode:z.string().trim().min(1).max(80)}).strict(),request.body);const result=await store.topupOutcome(actor.subjectId,params.id,body,key(request));return reply.status(result.replayed?200:result.status).send(result.body);});

app.get('/mobile/v1/staging/catalog',async request=>{const query=parse(z.object({query:z.string().trim().max(100).optional(),region:z.string().trim().max(40).optional(),cursor:z.string().optional(),limit:z.coerce.number().int().min(1).max(100).default(20)}).strict(),request.query),start=offset(query.cursor);return page(await store.catalog(query.query,query.region,query.limit+1,start),query.limit,start);});

const sshLabel=z.string().trim().min(1).max(40);
app.post('/mobile/v1/staging/access/ssh-public-keys',{bodyLimit:32*1024},async(request,reply)=>{const actor=buyer(request),body=parseDraft(z.object({clientKeyId:z.string().uuid(),label:sshLabel,publicKey:z.string().min(1).max(16_384),ownershipAttested:z.boolean()}).strict(),request.body);if(!body.ownershipAttested)error('OWNERSHIP_ATTESTATION_REQUIRED',422);assertSshLabel(body.label);const result=await store.createSshPublicKey(actor.subjectId,{...body,ownershipAttested:true},key(request),request.id);return reply.status(result.replayed?200:result.status).send(result.body);});
app.get('/mobile/v1/staging/access/ssh-public-keys',async request=>{const actor=buyer(request),query=parseDraft(z.object({cursor:z.string().optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict(),request.query),start=offset(query.cursor);return page(await store.sshPublicKeys(actor.subjectId,query.limit+1,start),query.limit,start);});
app.get('/mobile/v1/staging/access/ssh-public-keys/:id',async request=>{const actor=buyer(request),params=parseDraft(z.object({id:z.string().uuid()}).strict(),request.params);return{sshPublicKey:await store.sshPublicKey(actor.subjectId,params.id)};});
app.patch('/mobile/v1/staging/access/ssh-public-keys/:id',{bodyLimit:4096},async(request,reply)=>{const actor=buyer(request),params=parseDraft(z.object({id:z.string().uuid()}).strict(),request.params),body=parseDraft(z.object({expectedVersion:version(),label:sshLabel}).strict(),request.body);assertSshLabel(body.label);const result=await store.renameSshPublicKey(actor.subjectId,params.id,body.expectedVersion,body.label,key(request),request.id);return reply.status(200).send(result.body);});
app.post('/mobile/v1/staging/access/ssh-public-keys/:id/revoke',{bodyLimit:4096},async(request,reply)=>{const actor=buyer(request),params=parseDraft(z.object({id:z.string().uuid()}).strict(),request.params),body=parseDraft(z.object({expectedVersion:version()}).strict(),request.body);const result=await store.revokeSshPublicKey(actor.subjectId,params.id,body.expectedVersion,key(request),request.id);return reply.status(200).send(result.body);});

app.post('/mobile/v1/staging/supplier/resource-drafts',{bodyLimit:32*1024},async(request,reply)=>{const actor=supplier(request),body=parseDraft(supplierDraftCreateSchema,request.body);assertDraftContent(body);const result=await store.createSupplierResourceDraft(actor.subjectId,body,key(request),request.id);return reply.status(result.replayed?200:result.status).send(result.body);});
app.get('/mobile/v1/staging/supplier/resource-drafts',async request=>{const actor=supplier(request),query=parseDraft(z.object({cursor:z.string().optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict(),request.query),start=offset(query.cursor);return page(await store.supplierResourceDrafts(actor.subjectId,query.limit+1,start),query.limit,start);});
app.get('/mobile/v1/staging/supplier/resource-drafts/:id',async request=>{const actor=supplier(request),params=parseDraft(z.object({id:z.string().uuid()}).strict(),request.params);return{draft:await store.supplierResourceDraft(actor.subjectId,params.id)};});
app.patch('/mobile/v1/staging/supplier/resource-drafts/:id',{bodyLimit:32*1024},async(request,reply)=>{const actor=supplier(request),params=parseDraft(z.object({id:z.string().uuid()}).strict(),request.params),body=parseDraft(supplierDraftPatchSchema,request.body);assertDraftContent(body.patch);const result=await store.updateSupplierResourceDraft(actor.subjectId,params.id,body.expectedVersion,body.patch,key(request),request.id);return reply.status(200).send(result.body);});

app.post('/mobile/v1/staging/compute-orders',async(request,reply)=>{const actor=buyer(request),body=parse(z.object({listingId:z.string().uuid(),quantity:z.string()}).strict(),request.body);const result=await store.createOrder(actor.subjectId,body,key(request));return reply.status(result.replayed?200:201).send(result.body);});
app.get('/mobile/v1/staging/compute-orders',async request=>{const actor=buyer(request),query=parse(z.object({status:z.string().optional(),cursor:z.string().optional(),limit:z.coerce.number().int().min(1).max(100).default(20)}).strict(),request.query),start=offset(query.cursor);return page(await store.orders(actor.subjectId,query.status,query.limit+1,start),query.limit,start);});
app.get('/mobile/v1/staging/compute-orders/:id',async request=>{const actor=buyer(request),params=parse(z.object({id:z.string().uuid()}),request.params);return{order:await store.order(params.id,actor.subjectId)};});
app.post('/mobile/v1/staging/compute-orders/:id/cancel',async(request,reply)=>{const actor=buyer(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({expectedVersion:version()}).strict(),request.body);const result=await store.cancelOrder(actor.subjectId,params.id,body.expectedVersion,key(request),request.id);return reply.status(200).send(result.body);});
app.post('/mobile/v1/staging/compute-orders/:id/manual-delivery-requests',{bodyLimit:4096},async(request,reply)=>{const actor=buyer(request),params=parseDraft(z.object({id:z.string().uuid()}).strict(),request.params),body=parseDraft(z.object({expectedOrderVersion:version(),sshPublicKeyId:z.string().uuid(),termsVersion:z.literal('staging-manual-delivery-v1')}).strict(),request.body);const result=await store.submitManualDelivery(actor.subjectId,params.id,body,key(request),request.id);return reply.status(result.replayed?200:result.status).send(result.body);});
app.post('/mobile/v1/staging/compute-orders/:id/request-stop',async(request,reply)=>{const actor=buyer(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({expectedVersion:version()}).strict(),request.body);const result=await store.requestStop(actor.subjectId,params.id,body.expectedVersion,key(request));return reply.status(200).send(result.body);});
app.get('/mobile/v1/staging/compute-orders/:id/access-preview',async request=>{const actor=buyer(request),params=parse(z.object({id:z.string().uuid()}),request.params),order=await store.order(params.id,actor.subjectId);if(!order.allowedActions.includes('access_preview'))error('INVALID_STATE',409);return{accessPreview:{mode:'demo_terminal',headline:'测试终端已就绪',connectable:false,copyAllowed:false,terminalScript:['欢迎进入 Zod 测试终端','当前不会连接真实节点，也不会执行命令。']}};});
app.post('/mobile/v1/staging/compute-orders/:id/accept',async(request,reply)=>{const actor=buyer(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({expectedVersion:version()}).strict(),request.body);const result=await store.accept(actor.subjectId,params.id,body.expectedVersion,key(request));return reply.status(200).send(result.body);});
app.post('/mobile/v1/staging/compute-orders/:id/disputes',async(request,reply)=>{const actor=buyer(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({expectedVersion:version(),category:z.enum(['access','metering','disconnect','other']),description:z.string().trim().min(20).max(500)}).strict(),request.body);const result=await store.openDispute(actor.subjectId,params.id,body,key(request));return reply.status(result.replayed?200:201).send(result.body);});

app.post('/staging/v1/operator/compute-orders/:id/fulfillment-transition',async(request,reply)=>{const actor=operator(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({event:z.enum(['start_provisioning','mark_ready','start_running','request_stop','mark_stopped','fail_provisioning']),expectedVersion:version(),reasonCode:z.string().trim().min(1).max(80).optional()}).strict(),request.body);const result=await store.transition(actor.subjectId,params.id,body,key(request));return reply.status(200).send(result.body);});
app.post('/staging/v1/operator/compute-orders/:id/connection',async(request,reply)=>{const actor=operator(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({event:z.enum(['lost','restored']),expectedVersion:version(),reasonCode:z.string().trim().min(1).max(80)}).strict(),request.body);const result=await store.connection(actor.subjectId,params.id,body,key(request));return reply.status(200).send(result.body);});
app.post('/staging/v1/operator/compute-orders/:id/metering',async(request,reply)=>{const actor=operator(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({consumedQuantity:z.string(),expectedVersion:version(),evidenceRef:z.string().regex(/^demo:[0-9a-f-]{36}$/u)}).strict(),request.body);const result=await store.meter(actor.subjectId,params.id,body,key(request));return reply.status(200).send(result.body);});
app.post('/staging/v1/operator/disputes/:id/resolve',async(request,reply)=>{const actor=operator(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({outcome:z.enum(['full_refund','partial_refund','reject_refund']),refundCredits:z.string().optional(),expectedVersion:version(),reasonCode:z.string().trim().min(1).max(80)}).strict(),request.body);const result=await store.resolveDispute(actor.subjectId,params.id,body,key(request));return reply.status(200).send(result.body);});
app.get('/staging/v1/operator/manual-delivery-requests/:id',async request=>{operator(request);const params=parseDraft(z.object({id:z.string().uuid()}).strict(),request.params),detail=await store.operatorManualDelivery(params.id);return{manualDeliveryRequest:{...detail.safe,orderId:detail.orderId,buyerSubjectId:detail.buyerSubjectId,orderVersion:detail.orderVersion,normalizedPublicKey:detail.normalizedPublicKey}};});
app.post('/staging/v1/operator/manual-delivery-requests/:id/transition',{bodyLimit:4096},async(request,reply)=>{const actor=operator(request),params=parseDraft(z.object({id:z.string().uuid()}).strict(),request.params),body=parseDraft(z.object({event:z.enum(['verify_key','start_provisioning','mark_ready','reject']),expectedVersion:version(),evidenceRef:z.string().regex(/^staging-manual:[0-9a-f-]{36}$/u),reasonCode:z.enum(['key_invalid','capacity_unavailable','schedule_unavailable','safety_rejected','other']).optional()}).strict(),request.body);if(body.event==='reject'&&!body.reasonCode)draftValidation('reasonCode','required');const result=await store.transitionManualDelivery(actor.subjectId,params.id,body,key(request),request.id);return reply.status(200).send(result.body);});

app.post('/mobile/v1/staging/creator/referral-links',async(request,reply)=>{parse(z.object({}).strict(),request.body??{});const result=await store.referralLink(principal(request).subjectId,key(request));return reply.status(result.replayed?200:201).send(result.body);});
app.post('/mobile/v1/staging/referrals/attribute',async(request,reply)=>{const body=parse(z.object({token:z.string().min(24).max(200)}).strict(),request.body);const result=await store.attribute(principal(request).subjectId,body.token,key(request));return reply.status(result.replayed?200:201).send(result.body);});
app.get('/mobile/v1/staging/creator/commissions',async request=>store.commissions(principal(request).subjectId));
app.post('/mobile/v1/staging/creator/commissions/transfer',async(request,reply)=>{parse(z.object({}).strict(),request.body??{});const result=await store.transfer(principal(request).subjectId,key(request));return reply.status(result.replayed?200:201).send(result.body);});
app.get('/mobile/v1/staging/creator/reward-events',async request=>{const query=parse(z.object({limit:z.coerce.number().int().min(1).max(50).default(20)}).strict(),request.query);return{events:await store.rewards(principal(request).subjectId,query.limit)};});
app.post('/mobile/v1/staging/creator/reward-events/:id/consume',async(request,reply)=>{const params=parse(z.object({id:z.string().uuid()}),request.params);parse(z.object({}).strict(),request.body??{});const result=await store.consumeReward(principal(request).subjectId,params.id,key(request));return reply.status(200).send(result.body);});
app.post('/staging/v1/operator/creator/orders/:id/reconcile',async(request,reply)=>{const actor=operator(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({event:z.enum(['source_completed','source_refunded','mature_observation']),expectedVersion:version()}).strict(),request.body);const result=await store.reconcile(actor.subjectId,params.id,body,key(request));return reply.status(200).send(result.body);});
app.post('/staging/v1/operator/test-subjects/:id/reset',async(request,reply)=>{const actor=operator(request),params=parse(z.object({id:z.string().uuid()}),request.params),body=parse(z.object({confirmation:z.literal('RESET STAGING SUBJECT'),expectedVersion:version()}).strict(),request.body);const result=await store.reset(actor.subjectId,params.id,body,key(request));return reply.status(200).send(result.body);});

const port=Number(process.env.PORT??4187);
const localE2e=process.env.NODE_ENV==='test'&&process.env.LOCAL_E2E==='true';
if(!Number.isInteger(port)||port<1024||port>65535||(!localE2e&&port!==4187))throw new Error('STAGING_PORT_MUST_BE_4187');
await app.listen({host:'127.0.0.1',port});
const shutdown=async()=>{await app.close();await db.close();process.exit(0);};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
