import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { AccountPrincipal } from '../account/types.js';
import { lookupHash, secretHash } from '../account/crypto.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import { decryptQixiangCheckout, encryptQixiangCheckout } from '../payment/qixiang-checkout-crypto.js';
import type { QixiangProvider } from '../payment/qixiang-provider.js';
import type { SubjectAccess } from '../subjects/types.js';
import type { QixiangEvidenceService } from './qixiang-evidence.js';
import type { QixiangProductionGate } from './qixiang-production-gate.js';
import type { PostgresQixiangTopupStore } from './qixiang-store.js';
import type { QixiangCursor, QixiangTopupRecord } from './qixiang-types.js';

type Context=Readonly<{requestId:string;ip:string}>;
const IDEMPOTENCY=/^[A-Za-z0-9:_-]{16,120}$/u;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function canonicalIp(value:string){const normalized=value.startsWith('::ffff:')?value.slice(7):value;
  if(!isIP(normalized))throw new AppError('TOPUP_CLIENT_IP_INVALID',400,'当前网络信息无效，请切换网络后重试。');return normalized;}
function amount(value:number){return`${Math.floor(value/100)}.${String(value%100).padStart(2,'0')}`;}
function encodeCursor(value:QixiangCursor){return Buffer.from(JSON.stringify({createdAt:value.createdAt.toISOString(),id:value.id})).toString('base64url');}
function decodeCursor(value:string|undefined):QixiangCursor|null{
  if(value===undefined)return null;
  try{const decoded=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as Record<string,unknown>;
    if(Object.keys(decoded).sort().join(',')!=='createdAt,id'||typeof decoded.createdAt!=='string'||typeof decoded.id!=='string'
      ||!UUID.test(decoded.id)||new Date(decoded.createdAt).toISOString()!==decoded.createdAt)throw new Error();
    return{createdAt:new Date(decoded.createdAt),id:decoded.id};
  }catch{throw new AppError('CURSOR_INVALID',400,'分页位置无效，请重新加载。');}}

export class QixiangTopupService{
  constructor(private readonly store:PostgresQixiangTopupStore,private readonly subjects:SubjectAccess,
  private readonly provider:QixiangProvider,private readonly evidence:QixiangEvidenceService,
  private readonly checkoutKey:Buffer,private readonly config:RuntimeConfig,private readonly now:()=>Date=()=>new Date(),
  private readonly productionGate?:QixiangProductionGate){
    if(!config.AUDIT_PEPPER)throw new Error('AUDIT_PEPPER is required.');
    if(!config.QIXIANG_CHECKOUT_KEY_ID)throw new Error('QIXIANG_CHECKOUT_KEY_ID is required.');
    if(checkoutKey.length!==32)throw new Error('QIXIANG_CHECKOUT_KEY_INVALID');
  }

  async create(principal:AccountPrincipal,input:Readonly<{amountCents:number;rail:'qixiang_alipay';idempotencyKey:string}>,context:Context){
    this.assertIdempotency(input.idempotencyKey);
    const subject=await this.subjects.current(principal.userId,'credits.redeem');
    const gateContext={userId:principal.userId,subjectId:subject.subjectId,amountCents:input.amountCents};
    let canaryTopupId:string|null=null;
    if(this.config.NODE_ENV==='production'){
      if(!this.productionGate)throw new AppError('QIXIANG_TOPUP_PRODUCTION_GATE_CLOSED',503,'真实支付生产验收凭证未加载。');
      canaryTopupId=(await this.productionGate.require('create',gateContext)).canaryTopupId;
    }
    const runtime=await this.readiness(gateContext);
    if(!runtime.ready||runtime.maxAmountCents===null)throw new AppError('QIXIANG_TOPUP_UNAVAILABLE',503,
      '快线支付尚未完成上线核验。');
    if(!Number.isSafeInteger(input.amountCents)||input.amountCents<100||input.amountCents>runtime.maxAmountCents){
      throw new AppError('TOPUP_AMOUNT_INVALID',400,'充值金额不在当前允许范围内。');}
    const now=this.now();
    const cardHourCents=Math.floor(input.amountCents*1000/1002);const providerReference=this.reference(now);
    const payloadDigest=secretHash(JSON.stringify({subjectId:subject.subjectId,amountCents:input.amountCents,
      rail:input.rail}),this.config.AUDIT_PEPPER!);
    const ip=canonicalIp(context.ip);const prepared=await this.store.prepare({id:canaryTopupId??randomUUID(),subjectId:subject.subjectId,
      userId:principal.userId,idempotencyKey:input.idempotencyKey,payloadDigest,providerReference,
      amountCents:input.amountCents,cardHourCents,creditMicros:BigInt(cardHourCents)*10_000n,
      checkoutExpiresAt:new Date(now.getTime()+30*60_000),context:{requestId:context.requestId,
        ipHash:lookupHash(ip,this.config.AUDIT_PEPPER!),now}});
    if(prepared.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,
      '同一请求标识对应了不同的充值内容。');
    if(prepared.status==='replayed'&&prepared.topup.status!=='created')return{replayed:true,...this.detail(prepared.topup)};
    const started=await this.store.startCreate(prepared.topup.id,prepared.topup.version,
      new Date(now.getTime()+10_500),this.mutation(principal.userId,context,payloadDigest,now));
    if(!started)throw new AppError('TOPUP_STATE_CHANGED',409,'充值状态已变化，请刷新后查看。');
    const expectedVersion=started.version;const name=this.productName(started);const attempt=this.attempt(started);
    if(this.config.NODE_ENV==='production')try{await this.productionGate!.require('create',gateContext);}catch(error){
      const blockers=error instanceof AppError&&Array.isArray(error.details?.blockers)
        ?error.details.blockers.filter((value):value is string=>typeof value==='string'):['GATE_CLOSED'];
      await this.store.recordGateClosed(started.id,expectedVersion,blockers,
        this.mutation(principal.userId,context,payloadDigest,this.now()));throw error;}
    try{
      const checkout=await this.provider.createCheckout({providerReference:started.providerReference,paymentType:'alipay',
        amountCents:started.amountCents,name,clientIp:ip,attemptToken:attempt});
      if(checkout.state==='pending'){
        const encrypted=encryptQixiangCheckout(checkout.checkoutUrl,{topupId:started.id,
          providerReference:started.providerReference,keyId:this.config.QIXIANG_CHECKOUT_KEY_ID!},this.checkoutKey);
        const saved=await this.store.saveCheckout(started.id,expectedVersion,checkout.providerPaymentId,encrypted,
          this.mutation(principal.userId,context,payloadDigest,this.now()));
        return{replayed:false,...this.detail(saved??started)};
      }
      const unknown=await this.store.recordCreateUnknown(started.id,expectedVersion,
        new Date(this.now().getTime()+30_000),this.mutation(principal.userId,context,payloadDigest,this.now()));
      return{replayed:false,...this.detail(unknown??started)};
    }catch(error){
      if(error instanceof AppError&&error.code==='QIXIANG_CREATE_REJECTED'){
        const failed=await this.store.recordCreateRejected(started.id,expectedVersion,
          this.mutation(principal.userId,context,payloadDigest,this.now()));
        return{replayed:false,...this.detail(failed??started)};
      }
      const unknown=await this.store.recordCreateUnknown(started.id,expectedVersion,
        new Date(this.now().getTime()+30_000),this.mutation(principal.userId,context,payloadDigest,this.now()));
      return{replayed:false,...this.detail(unknown??started)};
    }
  }

  async list(principal:AccountPrincipal,input:Readonly<{limit:number;cursor?:string}>){
    const subject=await this.subjects.current(principal.userId,'credits.read');const limit=Math.min(Math.max(input.limit,1),100);
    const [rows,unresolved,runtime]=await Promise.all([this.store.list(subject.subjectId,{cursor:decodeCursor(input.cursor),limit}),
      this.store.hasUnresolved(subject.subjectId),this.readiness({userId:principal.userId,subjectId:subject.subjectId,amountCents:501})]);
    const page=rows.slice(0,limit);
    const reason=unresolved?'unresolved_topup' as const:!runtime.ready?'capability_unavailable' as const:
      runtime.maxAmountCents===null?'amount_policy_unavailable' as const:null;
    return{items:page.map((item)=>this.serialize(item)),nextCursor:rows.length>limit?
      encodeCursor({createdAt:page.at(-1)!.createdAt,id:page.at(-1)!.id}):null,
    creation:{allowed:reason===null,reason,canaryOnly:runtime.phase==='bootstrap_canary',
      requiredAmountCents:runtime.phase==='bootstrap_canary'?501:null}};
  }

  async get(principal:AccountPrincipal,id:string){const subject=await this.subjects.current(principal.userId,'credits.read');
    const topup=await this.store.get(subject.subjectId,id);if(!topup)throw new AppError('TOPUP_NOT_FOUND',404,'充值记录不存在。');
    return this.detail(topup);}

  async recheck(principal:AccountPrincipal,input:Readonly<{topupId:string;expectedVersion:number;idempotencyKey:string}>,
  context:Context){this.assertIdempotency(input.idempotencyKey);const subject=await this.subjects.current(principal.userId,'credits.read');
    const now=this.now();const digest=secretHash(JSON.stringify({subjectId:subject.subjectId,topupId:input.topupId,
      expectedVersion:input.expectedVersion}),this.config.AUDIT_PEPPER!);
    const result=await this.store.recheck({topupId:input.topupId,subjectId:subject.subjectId,userId:principal.userId,
      expectedVersion:input.expectedVersion,idempotencyKey:input.idempotencyKey,payloadDigest:digest,
      requestId:context.requestId,ipHash:lookupHash(context.ip||'unknown',this.config.AUDIT_PEPPER!),now});
    if(result.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'同一请求标识对应了不同的复核内容。');
    if(result.status==='not_found')throw new AppError('TOPUP_NOT_FOUND',404,'充值记录不存在。');
    if(result.status==='version_conflict')throw new AppError('TOPUP_VERSION_CONFLICT',409,'充值状态已变化，请刷新后重试。');
    if(result.status!=='updated'&&result.status!=='replayed')throw new Error('QIXIANG_RECHECK_RESULT_INVALID');
    return{topup:this.serialize(result.topup)};}

  async notification(rawQuery:string,context:Context){const notification=this.provider.verifyNotification(rawQuery);
    const topup=await this.store.findByReference(notification.providerReference);const canonical=Object.keys(
      notification.normalizedPayloadWithoutSign).sort().map((name)=>`${name}=${notification.normalizedPayloadWithoutSign[name]}`).join('&');
    if(this.config.NODE_ENV==='production'){
      if(!this.productionGate||!topup)throw new AppError('QIXIANG_CALLBACK_PRODUCTION_GATE_CLOSED',503,
        '支付回调不属于当前验收单。');
      const gate=await this.productionGate.require('create',{userId:topup.createdByUserId,subjectId:topup.subjectId,
        amountCents:topup.amountCents});
      if(gate.phase==='bootstrap_canary'&&gate.canaryTopupId!==topup.id)throw new AppError(
        'QIXIANG_CALLBACK_BOOTSTRAP_CANARY_ONLY',503,'当前只处理指定的验收单。');
    }
    const digest=lookupHash(canonical,this.config.AUDIT_PEPPER!);const snapshotMatched=Boolean(topup
      && notification.paymentType==='alipay'&&notification.amountCents===topup.amountCents
      &&(notification.name===null||notification.name===this.productName(topup))
      &&(notification.passthrough===null||notification.passthrough===this.attempt(topup))
      &&(topup.providerPaymentId===null||topup.providerPaymentId===notification.providerTransactionId));
    return this.store.recordCallback({receiptKey:`callback:${digest}`,providerReference:notification.providerReference,
      providerTransactionId:notification.providerTransactionId,paymentType:notification.paymentType,
      amountCents:notification.amountCents,payloadDigest:digest,snapshotMatched,
      processingResult:topup?.providerPaymentId!==null&&topup?.providerPaymentId!==notification.providerTransactionId
        ?'trade_conflict':snapshotMatched?'accepted':'snapshot_mismatch',requestId:context.requestId,
      ipHash:lookupHash(context.ip||'unknown',this.config.AUDIT_PEPPER!),now:this.now()});}

  private detail(topup:QixiangTopupRecord){let checkout:null|{kind:'external_browser';url:string;expiresAt:string}=null;
    if(topup.status==='pending'&&topup.checkout&&topup.checkoutExpiresAt>this.now()){
      try{checkout={kind:'external_browser',url:decryptQixiangCheckout(topup.checkout,
        {topupId:topup.id,providerReference:topup.providerReference},this.checkoutKey),
      expiresAt:topup.checkoutExpiresAt.toISOString()};}catch{checkout=null;}}
    const serialized=this.serialize(topup,checkout!==null);return{topup:serialized,checkout};}
  private serialize(topup:QixiangTopupRecord,openCheckout=false){const actions=[] as Array<'open_checkout'|'recheck'|'contact_support'>;
    if(openCheckout)actions.push('open_checkout');
    if(!['succeeded','failed'].includes(topup.status))actions.push('recheck');
    if(['created','verifying','expired','manual_review','failed'].includes(topup.status))actions.push('contact_support');
    return{id:topup.id,topupNumber:topup.providerReference,provider:'qixiang' as const,rail:'qixiang_alipay' as const,
      status:topup.status,version:topup.version,payment:{currency:'CNY' as const,amountCents:topup.amountCents,
        amount:amount(topup.amountCents)},credit:{unit:'KAI_CARD_HOUR' as const,amount:amount(topup.cardHourCents),precision:2 as const},
      conversion:{numerator:1000 as const,denominator:1002 as const,rounding:'floor' as const},
      entitlement:{validityDays:364 as const,expiresAt:topup.entitlementExpiresAt?.toISOString()??null},
      checkoutExpiresAt:topup.checkoutExpiresAt.toISOString(),createdAt:topup.createdAt.toISOString(),
      succeededAt:topup.succeededAt?.toISOString()??null,lastCheckedAt:topup.lastCheckedAt?.toISOString()??null,
      allowedActions:actions};}
  async readiness(canaryContext?:Readonly<{userId:string;subjectId:string;amountCents:number}>){
    const configBlockers=this.config.readiness.capabilities.qixiangTopups.blockers;
    const gate=this.config.NODE_ENV==='production'?await this.productionGate?.readinessWithDatabase('create',canaryContext)
      ??{ready:false,blockers:['GATE_NOT_LOADED'],phase:null,canaryTopupId:null}
      :{ready:true,blockers:[] as string[],phase:null,canaryTopupId:null};
    const evidence=await this.evidence.readiness(gate.phase==='bootstrap_canary'?'bootstrap_canary':'full');
    return{ready:evidence.ready&&configBlockers.length===0&&gate.ready,maxAmountCents:evidence.maxAmountCents,
      blockers:[...new Set([...configBlockers,...evidence.blockers,...gate.blockers])],phase:gate.phase??null};}
  async startupReadiness(){
    if(this.config.NODE_ENV!=='production')return this.readiness();
    if(!this.productionGate)return{ready:false,maxAmountCents:null,blockers:['GATE_NOT_LOADED'],phase:null};
    try{const gate=await this.productionGate.requireStartup();const phase=gate.phase??null;
      const evidence=await this.evidence.readiness(phase==='bootstrap_canary'?'bootstrap_canary':'full');
      const configBlockers=this.config.readiness.capabilities.qixiangTopups.blockers;
      return{ready:evidence.ready&&configBlockers.length===0,maxAmountCents:phase==='bootstrap_canary'?501:evidence.maxAmountCents,
        blockers:[...new Set([...configBlockers,...evidence.blockers])],phase};
    }catch(error){const blockers=error instanceof AppError&&Array.isArray(error.details?.blockers)
      ?error.details.blockers.filter((value):value is string=>typeof value==='string'):['GATE_STARTUP_INVALID'];
      return{ready:false,maxAmountCents:null,blockers,phase:null};}
  }
  private mutation(actorId:string,context:Context,payloadDigest:string,now:Date){return{actorId,requestId:context.requestId,
    ipHash:lookupHash(context.ip||'unknown',this.config.AUDIT_PEPPER!),payloadDigest,now};}
  private reference(now:Date){return`QX${now.getTime().toString(36).toUpperCase()}${randomBytes(10).toString('hex').toUpperCase()}`;}
  private productName(topup:QixiangTopupRecord){return`算力服务卡时权益（364天） ${topup.providerReference.slice(-12)}`;}
  private attempt(topup:QixiangTopupRecord){return lookupHash(`qixiang-attempt:${topup.id}`,this.config.AUDIT_PEPPER!);}
  private assertIdempotency(value:string){if(!IDEMPOTENCY.test(value))throw new AppError('IDEMPOTENCY_KEY_INVALID',400,
    '充值请求缺少有效的幂等标识。');}
}
