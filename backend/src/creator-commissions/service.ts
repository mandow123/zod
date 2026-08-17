import { createHash,randomUUID } from 'node:crypto';
import type { AccountPrincipal } from '../account/types.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import { AppError } from '../errors.js';
import type { SubjectAccess } from '../subjects/types.js';
import { FirstPartyAttributionProvider,referralCode } from './provider.js';
import type { CreatorCommissionStore,ReferralLinkRecord,RewardEventRecord } from './store.js';
import type { CreatorCommissionPolicy } from './types.js';

export class CreatorCommissionService {
  constructor(private readonly store:CreatorCommissionStore,private readonly subjects:SubjectAccess,
    private readonly provider:FirstPartyAttributionProvider,private readonly policy:CreatorCommissionPolicy|null,
    private readonly publicOrigin:string,private readonly now:()=>Date=()=>new Date()) {}

  async createReferralLink(principal:AccountPrincipal,clientRequestId:string) {
    this.requireAvailable(); this.idempotency(clientRequestId);
    await this.subjects.current(principal.userId,'credits.read');
    const expiresAt=new Date(this.now().getTime()+this.policy!.attributionTtlDays*86_400_000);
    const payloadDigest=digest({policyVersion:this.policy!.version});
    const result=await this.store.createLink({id:randomUUID(),creatorUserId:principal.userId,code:referralCode(),
      clientRequestId,payloadDigest,policy:this.policy!,expiresAt,now:this.now()});
    if(result.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'请勿复用这次提交标识。');
    return {replayed:result.status==='replayed',referralLink:this.link(result.link)};
  }

  async attribute(principal:AccountPrincipal,token:string) {
    const subject=await this.subjects.current(principal.userId,'orders.buy');
    let verified;
    try { verified=await this.provider.verify(token,this.now()); }
    catch(error) {
      const code=error instanceof Error?error.message:'REFERRAL_TOKEN_INVALID';
      if(code==='REFERRAL_TOKEN_EXPIRED')throw new AppError(code,410,'邀请链接已过期。');
      throw new AppError('REFERRAL_TOKEN_INVALID',400,'邀请链接无效。');
    }
    const link=await this.store.linkByCode(verified.code);
    if(!link||link.id!==verified.linkId||link.status!=='active'||link.expiresAt<=this.now())
      throw new AppError('REFERRAL_LINK_UNAVAILABLE',410,'邀请链接已失效。');
    const providerEventId=`first-party:${link.id}:${subject.subjectId}`;
    const payloadDigest=digest({linkId:link.id,buyerSubjectId:subject.subjectId});
    const expiresAt=new Date(Math.min(link.expiresAt.getTime(),verified.expiresAt.getTime()));
    const result=await this.store.attribute({id:randomUUID(),buyerUserId:principal.userId,buyerSubjectId:subject.subjectId,
      link,providerSource:'first_party',providerEventId,payloadDigest,expiresAt,now:this.now()});
    if(result.status==='self_referral')throw new AppError('CREATOR_SELF_REFERRAL_FORBIDDEN',409,'不能绑定自己的邀请链接。');
    if(result.status==='conflict')throw new AppError('REFERRAL_ATTRIBUTION_CONFLICT',409,'邀请归属信息不一致。');
    if(!('attribution' in result))throw new AppError('REFERRAL_ATTRIBUTION_CONFLICT',409,'邀请归属信息不一致。');
    return {replayed:result.status!=='created',attribution:{id:result.attribution.id,
      providerSource:result.attribution.providerSource,expiresAt:result.attribution.expiresAt.toISOString()}};
  }

  async summary(principal:AccountPrincipal) {
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
    this.requireAvailable();this.idempotency(clientRequestId);
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
    await this.subjects.current(principal.userId,'credits.read');
    return {events:(await this.store.rewardEvents(principal.userId,Math.min(Math.max(limit,1),50))).map((event)=>this.reward(event))};
  }

  async consumeReward(principal:AccountPrincipal,eventId:string) {
    await this.subjects.current(principal.userId,'credits.read');
    const event=await this.store.consumeReward(principal.userId,eventId,this.now());
    if(!event)throw new AppError('CREATOR_REWARD_EVENT_NOT_FOUND',404,'这条奖励已经领取或不存在。');
    return {event:this.reward(event)};
  }

  private link(link:ReferralLinkRecord) {
    const token=this.provider.issue({code:link.code,linkId:link.id,expiresAt:link.expiresAt});
    const url=new URL('/referral',this.publicOrigin);url.searchParams.set('token',token);
    return {id:link.id,code:link.code,providerSource:'first_party' as const,token,url:url.toString(),expiresAt:link.expiresAt.toISOString()};
  }
  private reward(event:RewardEventRecord) { return {eventId:event.id,transferId:event.transferId,
    cardHours:formatCreditDisplayMicros(event.creditMicros),status:event.status,createdAt:event.createdAt.toISOString(),
    consumedAt:event.consumedAt?.toISOString()??null}; }
  private requireAvailable(){if(!this.policy)throw new AppError('CREATOR_COMMISSION_UNAVAILABLE',503,'达人合作服务暂不可用。');}
  private idempotency(value:string){if(!/^[A-Za-z0-9:_-]{16,120}$/u.test(value))
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED',400,'请重新提交。');}
}

function digest(value:unknown){return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;}
