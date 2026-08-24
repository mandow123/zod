import { createHash } from 'node:crypto';
import type { AccountPrincipal } from '../account/types.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import { AppError } from '../errors.js';
import type { SubjectAccess } from '../subjects/types.js';
import { FirstPartyAttributionProvider } from './provider.js';
import type { CreatorCommissionStore,RewardEventRecord } from './store.js';
import type { CreatorCommissionPolicy } from './types.js';

export class CreatorCommissionService {
  constructor(private readonly store:CreatorCommissionStore,private readonly subjects:SubjectAccess,
    private readonly provider:FirstPartyAttributionProvider,private readonly policy:CreatorCommissionPolicy|null,
    private readonly publicOrigin:string,private readonly now:()=>Date=()=>new Date(),
    private readonly legacyMode:'off'|'drain'='drain') {}

  async createReferralLink(_principal:AccountPrincipal,_clientRequestId:string):Promise<{replayed:boolean;referralLink:never}> {
    this.rejectLegacyIntake();
  }

  async attribute(_principal:AccountPrincipal,_token:string):Promise<{replayed:boolean;attribution:never}> {
    this.rejectLegacyIntake();
  }

  async summary(principal:AccountPrincipal) {
    this.requireDrain();
    await this.subjects.current(principal.userId,'credits.read');
    const summary=await this.store.summary(principal.userId);
    return {unit:'KAI_CARD_HOUR' as const,precision:2 as const,balances:{
      pendingCardHours:formatCreditDisplayMicros(summary.pendingMicros),
      availableCardHours:formatCreditDisplayMicros(summary.availableMicros),
      transferredCardHours:formatCreditDisplayMicros(summary.transferredMicros),
    },commissions:summary.orders.map((order)=>({id:order.id,orderKind:order.orderKind,orderId:order.orderId,
      status:order.status,commissionCardHours:formatCreditDisplayMicros(order.commissionCreditMicros),
      completedAt:order.completedAt?.toISOString()??null,availableAt:order.availableAt?.toISOString()??null,
      createdAt:order.createdAt.toISOString(),updatedAt:order.updatedAt.toISOString()}))};
  }

  async transferAvailable(principal:AccountPrincipal,clientRequestId:string) {
    this.requireDrain();this.idempotency(clientRequestId);
    const subject=await this.subjects.current(principal.userId,'credits.redeem');
    const result=await this.store.transferAvailable({creatorUserId:principal.userId,targetSubjectId:subject.subjectId,
      clientRequestId,payloadDigest:digest({targetSubjectId:subject.subjectId}),now:this.now()});
    if(result.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'请勿复用这次提交标识。');
    if(result.status==='nothing_available')throw new AppError('CREATOR_COMMISSION_NOT_AVAILABLE',409,'当前没有可转入的返佣卡时。');
    if(!('creditMicros' in result))throw new AppError('CREATOR_COMMISSION_NOT_AVAILABLE',409,'当前没有可转入的返佣卡时。');
    return {replayed:result.status==='replayed',transfer:{cardHours:formatCreditDisplayMicros(result.creditMicros),
      rewardEvent:this.reward(result.reward)}};
  }

  async rewardEvents(principal:AccountPrincipal,limit=20) {
    this.requireDrain();
    await this.subjects.current(principal.userId,'credits.read');
    return {events:(await this.store.rewardEvents(principal.userId,Math.min(Math.max(limit,1),50))).map((event)=>this.reward(event))};
  }

  async consumeReward(principal:AccountPrincipal,eventId:string) {
    this.requireDrain();
    await this.subjects.current(principal.userId,'credits.read');
    const event=await this.store.consumeReward(principal.userId,eventId,this.now());
    if(!event)throw new AppError('CREATOR_REWARD_EVENT_NOT_FOUND',404,'这条奖励已经领取或不存在。');
    return {event:this.reward(event)};
  }

  private reward(event:RewardEventRecord) { return {eventId:event.id,transferId:event.transferId,
    cardHours:formatCreditDisplayMicros(event.creditMicros),status:event.status,createdAt:event.createdAt.toISOString(),
    consumedAt:event.consumedAt?.toISOString()??null}; }
  private rejectLegacyIntake():never { throw new AppError('LEGACY_CREATOR_INTAKE_CLOSED',410,'旧达人归因入口已关闭。'); }
  private requireDrain(){if(this.legacyMode!=='drain')throw new AppError('CREATOR_COMMISSION_UNAVAILABLE',503,'达人合作服务暂不可用。');}
  private idempotency(value:string){if(!/^[A-Za-z0-9:_-]{16,120}$/u.test(value))
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED',400,'请重新提交。');}
}

function digest(value:unknown){return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;}
