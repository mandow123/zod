import { randomUUID } from 'node:crypto';
import { lookupHash } from '../account/crypto.js';
import { AppError } from '../errors.js';
import { encryptQixiangCheckout } from '../payment/qixiang-checkout-crypto.js';
import type { QixiangProvider, QixiangQueryResult } from '../payment/qixiang-provider.js';
import type { PostgresQixiangTopupStore } from './qixiang-store.js';
import type { QixiangQueryAttempt, QixiangQueryProcessingResult, QixiangTopupRecord } from './qixiang-types.js';

type Logger=Readonly<{
  info(fields:Record<string,unknown>,message:string):void;
  error(fields:Record<string,unknown>,message:string):void;
}>;

function canonical(value:Record<string,unknown>){return JSON.stringify(Object.fromEntries(
  Object.entries(value).sort(([left],[right])=>left.localeCompare(right)),
));}

export class QixiangQueryWorker{
  private timer:NodeJS.Timeout|null=null;private running:Promise<void>|null=null;private stopping=false;
  private readonly instanceId=randomUUID();private readonly startedAt:Date;
  private lastAttemptAt:Date|null=null;private lastSuccessAt:Date|null=null;private consecutiveFailures=0;
  private schedulerFailures=0;
  constructor(private readonly store:PostgresQixiangTopupStore,private readonly provider:QixiangProvider,
  private readonly auditPepper:string,private readonly logger:Logger,private readonly intervalMs=15_000,
  private readonly now:()=>Date=()=>new Date(),private readonly scopedTopupId:string|null=null,
  private readonly checkoutRecovery?:Readonly<{key:Buffer;keyId:string}>){
    if(!auditPepper)throw new Error('AUDIT_PEPPER_REQUIRED');this.startedAt=this.now();
  }
  start(){if(this.timer||this.stopping)return;void this.run();this.timer=setInterval(()=>void this.run(),this.intervalMs);
    this.timer.unref();}
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=null;await this.running;}
  async tick(){await this.run();}
  async runOnce(){await this.run();}
  async health(at=this.now()){
    const graceMs=Math.max(this.intervalMs*4,100),starting=this.lastSuccessAt===null
      &&at.getTime()-this.startedAt.getTime()<=graceMs;
    try{const shared=await this.store.queryWorkerHealth({staleAfterMs:graceMs});
      const schedulerReady=shared.healthyInstances>0||(shared.observedInstances===0&&starting&&this.schedulerFailures<3);
      const ready=!this.stopping&&schedulerReady&&shared.providerConsecutiveFailures<3;
      return{ready,consecutiveFailures:shared.providerConsecutiveFailures,schedulerFailures:this.schedulerFailures,
        lastAttemptAt:this.lastAttemptAt?.toISOString()??null,lastSuccessAt:shared.lastSuccessAt?.toISOString()
          ??this.lastSuccessAt?.toISOString()??null,healthyInstances:shared.healthyInstances,
        observedInstances:shared.observedInstances}as const;
    }catch{return{ready:false,consecutiveFailures:this.consecutiveFailures,schedulerFailures:this.schedulerFailures,
      lastAttemptAt:this.lastAttemptAt?.toISOString()??null,lastSuccessAt:this.lastSuccessAt?.toISOString()??null,
      healthyInstances:0,observedInstances:0}as const;}}
  async runBatch(limit=50){let processed=0,successful=0;const attemptedAt=this.now();this.lastAttemptAt=attemptedAt;
    try{while(processed<limit){const claimedAt=this.now();const attempts=await this.store.claimQueries({now:claimedAt,
      staleBefore:new Date(claimedAt.getTime()-120_000),limit:1,topupId:this.scopedTopupId});const attempt=attempts[0];if(!attempt)break;
      if(await this.process(attempt))successful+=1;processed+=1;}
      if(processed>0&&successful===0)await this.heartbeat('failure','QIXIANG_QUERY_BATCH_NO_SUCCESS');
      else if(successful>0)await this.heartbeat('success',null);
      else await this.heartbeat('none',null);
      if(processed)this.logger.info({processed,successful},'qixiang query batch completed');return processed;
    }catch(error){await this.schedulerFailed(this.code(error));throw error;}}
  private async run(){if(this.running||this.stopping)return this.running??Promise.resolve();
    this.running=this.runBatch().then(()=>undefined).catch((error:unknown)=>this.logger.error({error:this.code(error)},
      'qixiang query batch failed')).finally(()=>{this.running=null;});return this.running;}
  private async process(attempt:QixiangQueryAttempt){const topup=attempt.topup;
    try{const result=await this.provider.queryOrder({providerReference:topup.providerReference,paymentType:'alipay',
      amountCents:topup.amountCents,name:this.productName(topup),attemptToken:this.attemptToken(topup)});
      await this.apply(attempt,result);return true;
    }catch(error){const code=this.code(error),manual=this.manual(code),providerRejected=code==='QIXIANG_QUERY_REJECTED';
      const now=this.now();await this.store.recordQueryFailure({attemptId:attempt.attemptId,claimedAt:attempt.claimedAt,
        topupId:topup.id,payloadDigest:lookupHash(canonical({attemptId:attempt.attemptId,errorCode:code}),this.auditPepper),
        errorCode:code,providerRejected,manualReview:manual,now,nextAttemptAt:this.next(now,topup.reconciliationAttempts)});
      return false;}}
  private async apply(attempt:QixiangQueryAttempt,result:QixiangQueryResult):Promise<QixiangQueryProcessingResult>{
    const now=this.now();const digest=lookupHash(canonical(result.normalizedPayload),this.auditPepper);
    if(result.state==='pending'){let recovery:{}|Readonly<{providerPaymentId:string;checkout:ReturnType<typeof encryptQixiangCheckout>}>= {};
      if(result.providerPaymentId&&result.checkoutUrl&&this.checkoutRecovery){const checkout=encryptQixiangCheckout(
        result.checkoutUrl,{topupId:attempt.topup.id,providerReference:attempt.topup.providerReference,
          keyId:this.checkoutRecovery.keyId},this.checkoutRecovery.key);recovery={providerPaymentId:result.providerPaymentId,checkout};}
      return this.store.recordUnpaidQuery({attemptId:attempt.attemptId,
      claimedAt:attempt.claimedAt,topupId:attempt.topup.id,payloadDigest:digest,now,
      nextAttemptAt:this.next(now,attempt.topup.reconciliationAttempts),...recovery});}
    const apiTradeNo=result.normalizedPayload.apiTradeNo;
    if(typeof apiTradeNo!=='string'||apiTradeNo.length===0)throw new Error('QIXIANG_QUERY_API_TRADE_NO_MISSING');
    const grantPayloadDigest=lookupHash(canonical({topupId:attempt.topup.id,subjectId:attempt.topup.subjectId,
      queryAttemptId:attempt.attemptId,providerTransactionDigest:lookupHash(result.providerTransactionId,this.auditPepper),
      amountCents:attempt.topup.amountCents,cardHourCents:attempt.topup.cardHourCents,succeededAt:now.toISOString()}),
    this.auditPepper);return this.store.recordPaidQuery({attemptId:attempt.attemptId,claimedAt:attempt.claimedAt,
      topupId:attempt.topup.id,providerTransactionId:result.providerTransactionId,apiTradeNo,
      queryPayloadDigest:digest,grantPayloadDigest,now});
  }
  private productName(topup:QixiangTopupRecord){return`算力服务卡时权益（364天） ${topup.providerReference.slice(-12)}`;}
  private attemptToken(topup:QixiangTopupRecord){return lookupHash(`qixiang-attempt:${topup.id}`,this.auditPepper);}
  private next(now:Date,attempts:number){return new Date(now.getTime()+Math.min(1_800_000,30_000*2**Math.min(attempts,6)));}
  private manual(code:string){return['QIXIANG_QUERY_SNAPSHOT_MISMATCH','QIXIANG_QUERY_RESPONSE_INVALID',
    'QIXIANG_QUERY_API_TRADE_NO_MISSING'].includes(code);}
  private async heartbeat(providerOutcome:'success'|'failure'|'none',errorCode:string|null){this.schedulerFailures=0;
    this.lastSuccessAt=this.now();if(providerOutcome==='success')this.consecutiveFailures=0;
    else if(providerOutcome==='failure')this.consecutiveFailures+=1;
    await this.store.recordQueryWorkerHealth({instanceId:this.instanceId,schedulerSucceeded:true,providerOutcome,
      consecutiveFailures:this.consecutiveFailures,errorCode:errorCode?.slice(0,80)??null});}
  private async schedulerFailed(errorCode:string){this.schedulerFailures+=1;
    try{await this.store.recordQueryWorkerHealth({instanceId:this.instanceId,schedulerSucceeded:false,
      providerOutcome:'none',consecutiveFailures:this.consecutiveFailures,errorCode:errorCode.slice(0,80)});}catch{return;}}
  private code(error:unknown){return error instanceof AppError?error.code:error instanceof Error?
    error.message.slice(0,80):'QIXIANG_QUERY_UNKNOWN';}
}
