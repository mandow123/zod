import { randomUUID } from 'node:crypto';
import type { AccountPrincipal } from '../account/types.js';
import { secretHash } from '../account/crypto.js';
import type { RuntimeConfig } from '../config.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import { AppError } from '../errors.js';
import type { QixiangProvider } from '../payment/qixiang-provider.js';
import type { PostgresQixiangRefundStore,QixiangRefundRecord } from './qixiang-refund-store.js';
import type { QixiangProductionGate } from './qixiang-production-gate.js';

const keyPattern=/^[A-Za-z0-9:_-]{16,120}$/u;const evidence=/^[0-9a-f]{64}$/u;
export class QixiangRefundService{
  constructor(private readonly store:PostgresQixiangRefundStore,private readonly provider:QixiangProvider,
    private readonly config:RuntimeConfig,private readonly now:()=>Date=()=>new Date(),
    private readonly productionGate?:QixiangProductionGate){
    if(!config.AUDIT_PEPPER)throw new Error('AUDIT_PEPPER is required.');}
  async get(principal:AccountPrincipal,id:string){this.operator(principal);const refund=await this.store.get(id);
    if(!refund)throw new AppError('QIXIANG_REFUND_NOT_FOUND',404,'七相退款记录不存在。');return{refund:this.serialize(refund)}}
  async request(principal:AccountPrincipal,topupId:string,input:{reasonCode:QixiangRefundRecord['reasonCode'];
    evidenceDigest:string;idempotencyKey:string}){this.operator(principal);this.input(input);
    const payload=this.digest({topupId,reasonCode:input.reasonCode,evidenceDigest:input.evidenceDigest});
    return this.result(await this.store.request({id:randomUUID(),topupId,operatorId:principal.userId,
      reasonCode:input.reasonCode,evidenceDigest:input.evidenceDigest,idempotencyKey:input.idempotencyKey,
      payloadDigest:payload,now:this.now()}));}
  async approve(principal:AccountPrincipal,refundId:string,input:{evidenceDigest:string;idempotencyKey:string}){
    this.operator(principal);this.input(input);const payload=this.digest({refundId,evidenceDigest:input.evidenceDigest,action:'approve'});
    return this.result(await this.store.approve({refundId,operatorId:principal.userId,evidenceDigest:input.evidenceDigest,
      idempotencyKey:input.idempotencyKey,payloadDigest:payload,now:this.now()}));}
  async submit(principal:AccountPrincipal,refundId:string,input:{evidenceDigest:string;idempotencyKey:string}){
    this.operator(principal);this.input(input);
    if(this.config.NODE_ENV==='production'){
      if(!this.productionGate)throw new AppError('QIXIANG_REFUND_PRODUCTION_GATE_CLOSED',503,'真实支付生产验收凭证未加载。');
      await this.productionGate.require('refund');
    }
    const payload=this.digest({refundId,evidenceDigest:input.evidenceDigest,action:'submit'});
    const callId=randomUUID();const begun=await this.store.beginSubmit({refundId,operatorId:principal.userId,
      providerCallId:callId,idempotencyKey:input.idempotencyKey,payloadDigest:payload,now:this.now()});
    const normalized=this.result(begun);if(begun.status==='replayed')return normalized;
    if(!('refund'in begun))throw new Error('QIXIANG_REFUND_SUBMIT_RESULT_INVALID');
    if(this.config.NODE_ENV==='production')try{await this.productionGate!.require('refund');}catch(error){
      await this.store.markManualReview(refundId,callId,principal.userId,payload,this.now());throw error;}
    try{const response=await this.provider.requestRefund({providerReference:begun.refund.providerReference,
      amountCents:begun.refund.amountCents});const updated=await this.store.recordProviderResponse(refundId,callId,
      response.responseCode,response.responseDigest,this.now());if(!updated)throw new Error('QIXIANG_REFUND_PROVIDER_RESPONSE_STALE');
      return{replayed:false,refund:this.serialize(updated)};
    }catch{const updated=await this.store.markManualReview(refundId,callId,principal.userId,payload,this.now());
      return{replayed:false,refund:this.serialize(updated)};}}
  async confirm(principal:AccountPrincipal,refundId:string,input:{evidenceDigest:string;idempotencyKey:string}){
    this.operator(principal);this.input(input);const payload=this.digest({refundId,evidenceDigest:input.evidenceDigest,action:'confirm'});
    return this.result(await this.store.confirm({refundId,operatorId:principal.userId,evidenceDigest:input.evidenceDigest,
      idempotencyKey:input.idempotencyKey,payloadDigest:payload,now:this.now()}));}
  async takeover(principal:AccountPrincipal,refundId:string,input:{evidenceDigest:string;idempotencyKey:string}){
    this.operator(principal);this.input(input);const now=this.now();
    const payload=this.digest({refundId,evidenceDigest:input.evidenceDigest,action:'manual_takeover'});
    return this.result(await this.store.manualTakeover({refundId,operatorId:principal.userId,
      evidenceDigest:input.evidenceDigest,idempotencyKey:input.idempotencyKey,payloadDigest:payload,
      staleBefore:new Date(now.getTime()-120_000),now}));}
  async reject(principal:AccountPrincipal,refundId:string,input:{evidenceDigest:string;idempotencyKey:string}){
    this.operator(principal);this.input(input);const payload=this.digest({refundId,evidenceDigest:input.evidenceDigest,action:'reject'});
    return this.result(await this.store.reject({refundId,operatorId:principal.userId,evidenceDigest:input.evidenceDigest,
      idempotencyKey:input.idempotencyKey,payloadDigest:payload,now:this.now()}));}
  private result(value:Awaited<ReturnType<PostgresQixiangRefundStore['request']>>){
    if(value.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'同一请求标识对应了不同的退款操作。');
    if(value.status==='not_found')throw new AppError('QIXIANG_REFUND_NOT_FOUND',404,'七相退款记录或充值记录不存在。');
    if(value.status==='invalid_state')throw new AppError('QIXIANG_REFUND_STATE_INVALID',409,'七相退款当前状态不允许该操作。');
    if(value.status==='same_operator')throw new AppError('QIXIANG_REFUND_DUAL_CONTROL_REQUIRED',409,'申请人与复核人必须是不同运营人员。');
    if(value.status==='credits_in_use')throw new AppError('QIXIANG_REFUND_CREDITS_IN_USE',409,'该充值卡时已使用、冻结或到期，不能发起全额退款。');
    if(!('refund'in value))throw new Error('QIXIANG_REFUND_RESULT_INVALID');
    return{replayed:value.status==='replayed',refund:this.serialize(value.refund)};}
  private serialize(value:QixiangRefundRecord){return{id:value.id,topupId:value.topupId,status:value.status,version:value.version,
    reasonCode:value.reasonCode,payment:{currency:'CNY' as const,amountCents:value.amountCents,
      amount:(value.amountCents/100).toFixed(2)},credit:{unit:'KAI_CARD_HOUR' as const,
      amount:formatCreditDisplayMicros(value.creditMicros)},requestedByOperatorId:value.requestedByOperatorId,
    approvedByOperatorId:value.approvedByOperatorId,confirmedByOperatorId:value.confirmedByOperatorId,
    provider:{submitted:value.providerCallId!==null,responseCode:value.providerResponseCode},
    requestedAt:value.requestedAt.toISOString(),approvedAt:value.approvedAt?.toISOString()??null,
    providerSubmittedAt:value.providerSubmittedAt?.toISOString()??null,confirmedAt:value.confirmedAt?.toISOString()??null,
    updatedAt:value.updatedAt.toISOString()};}
  private input(input:{evidenceDigest:string;idempotencyKey:string}){if(!keyPattern.test(input.idempotencyKey))
    throw new AppError('IDEMPOTENCY_KEY_INVALID',400,'请求缺少有效的幂等标识。');if(!evidence.test(input.evidenceDigest))
    throw new AppError('QIXIANG_REFUND_EVIDENCE_INVALID',400,'退款证据摘要无效。');}
  private digest(value:unknown){return secretHash(JSON.stringify(value),this.config.AUDIT_PEPPER!)}
  private operator(principal:AccountPrincipal){if(principal.role!=='operator'&&principal.role!=='admin')
    throw new AppError('OPERATOR_REQUIRED',403,'该操作需要运营权限。');}
}
