import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { canonicalJson, qixiangCredentialFingerprint, qixiangGateConfigurationDigest,
  qixiangDatabaseGateSnapshot, QixiangProductionGate } from '../src/topups/qixiang-production-gate.js';
import { QixiangRefundService } from '../src/topups/qixiang-refund-service.js';

const environment = {
  NODE_ENV:'production',MOBILE_API_PROFILE:'full_commerce',HOST:'127.0.0.1',PORT:'4100',TRUST_PROXY_HOPS:'1',
  DATABASE_URL:'postgresql://app:secret@127.0.0.1:5432/cloudpay',DATABASE_SSL:'false',PUBLIC_ORIGIN:'https://cloudpay.kai.com',
  QIXIANG_TOPUP_MODE:'on',QIXIANG_RECOVERY_MODE:'on',QIXIANG_PID:'4611',QIXIANG_APPROVED_MAX_CENTS:'4999999',
  QIXIANG_CHECKOUT_KEY_ID:'qixiang-checkout-2026a',QIXIANG_CHECKOUT_CIPHER_VERSION:'1',
  QIXIANG_NOTIFY_URL:'https://cloudpay.kai.com/mobile/v1/credits/topups/qixiang/notify',
  QIXIANG_RETURN_URL:'https://cloudpay.kai.com/payments/qixiang/return',LEGAL_ENTITY_NAME:'上海申比芯人工智能科技有限公司',
  UNIFIED_SOCIAL_CREDIT_CODE:'91310112MAKJAYAJ7U',ICP_FILING:'沪ICP备TEST号',ICP_FILING_STATUS:'issued',
  ICP_FILING_EVIDENCE_REF:'evidence://icp',ICP_FILING_DOMAIN:'cloudpay.kai.com',APP_FILING:'沪ICP备TEST号-A',
  APP_FILING_STATUS:'issued',APP_FILING_EVIDENCE_REF:'evidence://app',APP_FILING_PACKAGE:'com.kaicloud.marketplace',
  FILING_OPERATOR_CREDIT_CODE:'91310112MAKJAYAJ7U',INTERNET_SERVICE_CLASSIFICATION_STATUS:'approved_with_legal_evidence',
  INTERNET_SERVICE_CLASSIFICATION_EVIDENCE_REF:'evidence://legal',QIXIANG_KEY_ROTATION_EVIDENCE_REF:'evidence://rotation',
  QIXIANG_OLD_KEY_REVOCATION_EVIDENCE_REF:'evidence://revocation',QIXIANG_MERCHANT_ENTITY_EVIDENCE_REF:'evidence://entity',
  QIXIANG_DOMAIN_APP_SCENE_EVIDENCE_REF:'evidence://scene',QIXIANG_SERVICE_CATEGORY_EVIDENCE_REF:'evidence://category',
  QIXIANG_REFUND_API_EVIDENCE_REF:'evidence://refund',QIXIANG_REAL_FULFILLMENT_EVIDENCE_REF:'evidence://fulfillment',
  QIXIANG_RECONCILIATION_EVIDENCE_REF:'evidence://reconciliation',QIXIANG_APPROVED_MAX_EVIDENCE_REF:'evidence://max',
  QIXIANG_LOT_ACCOUNTING_EVIDENCE_REF:'evidence://lots',
} as const;
const merchant='rotated-merchant-key';const checkout=Buffer.alloc(32,7);const release='a'.repeat(64);

function fixture(now='2026-08-24T04:00:00.000Z',pair=generateKeyPairSync('ed25519')){
  const issued=new Date(now);const expires=new Date(issued.getTime()+10*60_000);
  const payload={schemaVersion:2,kind:'qixiang_full_commerce_runtime_gate',phase:'full_commerce',
    issuedAt:issued.toISOString(),expiresAt:expires.toISOString(),
    configurationSha256:qixiangGateConfigurationDigest(environment),releaseManifestSha256:release,
    database:{identitySha256:'b'.repeat(64),migrationSha256:'c'.repeat(64)},
    credentials:{merchantSha256:qixiangCredentialFingerprint(merchant),checkoutSha256:qixiangCredentialFingerprint(checkout)},
    provider:{pid:'4611',currentKeyActive:true,accountActive:true,retiredKeyRejected:true,proofSha256:'d'.repeat(64)},
    approvals:{complianceManifestSha256:'e'.repeat(64),domainAppScene:true,serviceCategory:true,refundApi:true},
    acceptance:{dedicatedProbeSubjectSha256:'f'.repeat(64),appSessionReportSha256:'1'.repeat(64),
      fulfillmentReportSha256:'2'.repeat(64),reconciliationReportSha256:'3'.repeat(64),lotAccountingReportSha256:'4'.repeat(64)},
    canary:{topupId:'00000000-0000-4000-8000-000000000010',userId:'00000000-0000-4000-8000-000000000011',
      subjectId:'00000000-0000-4000-8000-000000000012',amountCents:501}} as const;
  const signature=sign(null,Buffer.from(canonicalJson(payload)),pair.privateKey).toString('base64');
  return{receipt:JSON.stringify({...payload,signature:{algorithm:'Ed25519',value:signature}}),
    publicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString(),now,pair};
}
function withPhase(input:ReturnType<typeof fixture>,phase:'bootstrap_canary'|'full_commerce'){
  const parsed=JSON.parse(input.receipt);parsed.phase=phase;const{signature:_signature,...payload}=parsed;
  parsed.signature={algorithm:'Ed25519',value:sign(null,Buffer.from(canonicalJson(payload)),input.pair.privateKey).toString('base64')};
  return JSON.stringify(parsed);
}

describe('Qixiang signed production runtime gate',()=>{
  it('binds stable database identity and migrations from one PostgreSQL statement snapshot',async()=>{const query=vi.fn().mockResolvedValue({rows:[{
    database_name:'cloudpay',database_user:'app',server_address:'127.0.0.1',server_port:5432,database_oid:'16384',
    system_identifier:'7612345678901234567',migrations:[{version:'0065.sql',checksum:'a'.repeat(64)}]}]});
    const snapshot=await qixiangDatabaseGateSnapshot(query);expect(query).toHaveBeenCalledTimes(1);
    expect(snapshot.identity).toEqual({databaseOid:'16384',systemIdentifier:'7612345678901234567'});
    expect(snapshot.state.identitySha256).toMatch(/^[0-9a-f]{64}$/u);expect(snapshot.state.migrationSha256).toMatch(/^[0-9a-f]{64}$/u);
  });
  it('opens create and refund only for the exact signed release, config, credentials and live database',async()=>{const input=fixture();
    const gate=new QixiangProductionGate({receipt:input.receipt,verificationPublicKeyPem:input.publicKey,environment,
      merchantKey:merchant,checkoutKey:checkout,releaseManifestSha256:release,now:()=>new Date(input.now),
      databaseStateLoader:async()=>({identitySha256:'b'.repeat(64),migrationSha256:'c'.repeat(64)})});
    expect(gate.readiness('create')).toMatchObject({ready:true});expect(gate.readiness('refund')).toMatchObject({ready:true});
    await expect(gate.require('create')).resolves.toMatchObject({ready:true});});
  it.each(['signature','configuration','release','merchant','expired'] as const)('fails closed for %s drift',async(kind)=>{const input=fixture();
    const parsed=JSON.parse(input.receipt);if(kind==='signature')parsed.acceptance.appSessionReportSha256='9'.repeat(64);
    const gate=new QixiangProductionGate({receipt:JSON.stringify(parsed),verificationPublicKeyPem:input.publicKey,
      environment:kind==='configuration'?{...environment,PUBLIC_ORIGIN:'https://wrong.example'}:environment,
      merchantKey:kind==='merchant'?'wrong-merchant':merchant,checkoutKey:checkout,
      releaseManifestSha256:kind==='release'?'9'.repeat(64):release,
      now:()=>new Date(kind==='expired'?'2026-08-24T04:11:00.000Z':input.now)});
    expect(gate.readiness('create').ready).toBe(false);await expect(gate.require('create')).rejects.toThrow();});
  it('fails closed when the live PostgreSQL instance or migration set differs from the signed receipt',async()=>{const input=fixture();
    const gate=new QixiangProductionGate({receipt:input.receipt,verificationPublicKeyPem:input.publicKey,environment,
      merchantKey:merchant,checkoutKey:checkout,releaseManifestSha256:release,now:()=>new Date(input.now),
      databaseStateLoader:async()=>({identitySha256:'9'.repeat(64),migrationSha256:'c'.repeat(64)})});
    expect(gate.readiness('create').ready).toBe(true);
    await expect(gate.require('create')).rejects.toMatchObject({code:'QIXIANG_TOPUP_PRODUCTION_GATE_CLOSED'});
  });
  it('permits a bootstrap receipt only for the one pinned user, subject and ¥5.01 canary',async()=>{const input=fixture();
    const parsed=JSON.parse(input.receipt);parsed.phase='bootstrap_canary';
    const {signature:_signature,...payload}=parsed;parsed.signature={algorithm:'Ed25519',
      value:sign(null,Buffer.from(canonicalJson(payload)),input.pair.privateKey).toString('base64')};
    const gate=new QixiangProductionGate({receipt:JSON.stringify(parsed),verificationPublicKeyPem:input.publicKey,environment,
      merchantKey:merchant,checkoutKey:checkout,releaseManifestSha256:release,now:()=>new Date(input.now),
      databaseStateLoader:async()=>({identitySha256:'b'.repeat(64),migrationSha256:'c'.repeat(64)})});
    await expect(gate.require('create',{userId:parsed.canary.userId,subjectId:parsed.canary.subjectId,amountCents:501}))
      .resolves.toMatchObject({ready:true,canaryTopupId:parsed.canary.topupId});
    await expect(gate.requireStartup()).resolves.toMatchObject({ready:true,canaryTopupId:parsed.canary.topupId});
    await expect(gate.require('create',{userId:parsed.canary.userId,subjectId:parsed.canary.subjectId,amountCents:502}))
      .rejects.toThrow();
    await expect(gate.require('refund')).rejects.toThrow();
  });
  it('permits an honest current-key-only bootstrap receipt while keeping refunds and full commerce closed',async()=>{
    const input=fixture();const parsed=JSON.parse(input.receipt);parsed.phase='bootstrap_canary';
    parsed.provider.retiredKeyRejected=false;parsed.approvals.domainAppScene=false;
    parsed.approvals.serviceCategory=false;parsed.approvals.refundApi=false;
    const{signature:_signature,...payload}=parsed;parsed.signature={algorithm:'Ed25519',
      value:sign(null,Buffer.from(canonicalJson(payload)),input.pair.privateKey).toString('base64')};
    const gate=new QixiangProductionGate({receipt:JSON.stringify(parsed),verificationPublicKeyPem:input.publicKey,environment,
      merchantKey:merchant,checkoutKey:checkout,releaseManifestSha256:release,now:()=>new Date(input.now),
      databaseStateLoader:async()=>({identitySha256:'b'.repeat(64),migrationSha256:'c'.repeat(64)})});
    await expect(gate.require('create',{userId:parsed.canary.userId,subjectId:parsed.canary.subjectId,amountCents:501}))
      .resolves.toMatchObject({ready:true,canaryTopupId:parsed.canary.topupId});
    expect(gate.readiness('refund')).toMatchObject({ready:false,
      blockers:expect.arrayContaining(['REFUND_API_NOT_APPROVED','GATE_BOOTSTRAP_CANARY_ONLY'])});
    parsed.phase='full_commerce';const{signature:oldSignature,...fullPayload}=parsed;void oldSignature;
    parsed.signature={algorithm:'Ed25519',value:sign(null,Buffer.from(canonicalJson(fullPayload)),input.pair.privateKey).toString('base64')};
    const fullGate=new QixiangProductionGate({receipt:JSON.stringify(parsed),verificationPublicKeyPem:input.publicKey,
      environment,merchantKey:merchant,checkoutKey:checkout,releaseManifestSha256:release,now:()=>new Date(input.now)});
    expect(fullGate.readiness('create')).toMatchObject({ready:false,
      blockers:expect.arrayContaining(['GATE_FULL_COMMERCE_APPROVALS_REQUIRED'])});
  });
  it('re-reads a renewed root-owned receipt for every action without restarting the process',()=>{
    const first=fixture('2026-08-24T04:00:00.000Z');const renewed=fixture('2026-08-24T04:09:00.000Z',first.pair);let receipt=first.receipt;
    const gate=new QixiangProductionGate({receipt,receiptLoader:()=>receipt,verificationPublicKeyPem:first.publicKey,
      environment,merchantKey:merchant,checkoutKey:checkout,releaseManifestSha256:release,
      now:()=>new Date('2026-08-24T04:10:30.000Z')});
    expect(gate.readiness('create').ready).toBe(false);
    receipt=renewed.receipt;expect(gate.readiness('create').ready).toBe(true);
  });
  it('evaluates each database gate from exactly one immutable receipt snapshot',async()=>{
    const input=fixture();const bootstrap=withPhase(input,'bootstrap_canary');let reads=0;let databaseReads=0;
    const gate=new QixiangProductionGate({receipt:input.receipt,receiptLoader:()=>{reads+=1;
      return reads===1?input.receipt:bootstrap;},verificationPublicKeyPem:input.publicKey,environment,
      merchantKey:merchant,checkoutKey:checkout,releaseManifestSha256:release,now:()=>new Date(input.now),
      databaseStateLoader:async()=>{databaseReads+=1;return{identitySha256:'b'.repeat(64),migrationSha256:'c'.repeat(64)};}});
    await expect(gate.readinessWithDatabase('refund')).resolves.toMatchObject({ready:true,phase:'full_commerce'});
    expect(reads).toBe(1);expect(databaseReads).toBe(1);
  });
  it('locks bootstrap at process start and rejects an in-place upgrade to full commerce',async()=>{
    const input=fixture();let receipt=withPhase(input,'bootstrap_canary');const parsed=JSON.parse(receipt);
    const gate=new QixiangProductionGate({receipt,receiptLoader:()=>receipt,verificationPublicKeyPem:input.publicKey,
      environment,merchantKey:merchant,checkoutKey:checkout,releaseManifestSha256:release,now:()=>new Date(input.now),
      databaseStateLoader:async()=>({identitySha256:'b'.repeat(64),migrationSha256:'c'.repeat(64)})});
    await expect(gate.requireStartup()).resolves.toMatchObject({phase:'bootstrap_canary',canaryTopupId:parsed.canary.topupId});
    receipt=withPhase(input,'full_commerce');
    await expect(gate.require('create',{userId:randomUUID(),subjectId:randomUUID(),amountCents:10_000}))
      .rejects.toMatchObject({details:{blockers:expect.arrayContaining(['GATE_PHASE_RESTART_REQUIRED'])}});
    expect((await gate.readinessWithDatabase('create',{userId:parsed.canary.userId,
      subjectId:parsed.canary.subjectId,amountCents:501}))).toMatchObject({ready:false,
      blockers:expect.arrayContaining(['GATE_PHASE_RESTART_REQUIRED'])});
  });
  it('locks full commerce at process start and rejects an in-place downgrade to bootstrap',async()=>{
    const input=fixture();let receipt=input.receipt;const gate=new QixiangProductionGate({receipt,receiptLoader:()=>receipt,
      verificationPublicKeyPem:input.publicKey,environment,merchantKey:merchant,checkoutKey:checkout,
      releaseManifestSha256:release,now:()=>new Date(input.now),databaseStateLoader:async()=>({
        identitySha256:'b'.repeat(64),migrationSha256:'c'.repeat(64)})});
    await expect(gate.requireStartup()).resolves.toMatchObject({phase:'full_commerce'});
    receipt=withPhase(input,'bootstrap_canary');
    await expect(gate.require('refund')).rejects.toMatchObject({details:{
      blockers:expect.arrayContaining(['GATE_PHASE_RESTART_REQUIRED'])}});
  });
  it('blocks a production refund before any store or provider mutation when no gate is loaded',async()=>{
    const beginSubmit=vi.fn();const requestRefund=vi.fn();const service=new QixiangRefundService({beginSubmit} as never,
      {requestRefund} as never,{NODE_ENV:'production',AUDIT_PEPPER:'a'.repeat(64)} as RuntimeConfig);
    await expect(service.submit({userId:'00000000-0000-4000-8000-000000000001',sessionId:'s',role:'operator'},
      '00000000-0000-4000-8000-000000000002',{evidenceDigest:'b'.repeat(64),idempotencyKey:'refund-gate-test-1234'}))
      .rejects.toMatchObject({code:'QIXIANG_REFUND_PRODUCTION_GATE_CLOSED'});
    expect(beginSubmit).not.toHaveBeenCalled();expect(requestRefund).not.toHaveBeenCalled();});
  it('moves a prepared refund to manual review without provider I/O when the adjacent database recheck drifts',async()=>{
    let calls=0;const gate={require:vi.fn(async()=>{calls+=1;if(calls===1)return{ready:true,canaryTopupId:null};
      throw new Error('database drift');})};const requestRefund=vi.fn();const markManualReview=vi.fn().mockResolvedValue({});
    const now=new Date('2026-08-24T04:00:00.000Z');const refund={id:'00000000-0000-4000-8000-000000000020',
      topupId:'00000000-0000-4000-8000-000000000021',subjectId:'00000000-0000-4000-8000-000000000022',
      providerReference:'QX12345678901234567890',providerPaymentId:'TRADE1',providerTransactionId:'TRADE1',
      amountCents:501,creditMicros:5_000_000n,status:'provider_pending',version:3,reasonCode:'customer_request',
      requestedByOperatorId:'00000000-0000-4000-8000-000000000001',approvedByOperatorId:null,confirmedByOperatorId:null,
      providerCallId:'call',providerResponseCode:null,requestedAt:now,approvedAt:null,providerSubmittedAt:now,
      confirmedAt:null,updatedAt:now};
    const beginSubmit=vi.fn().mockResolvedValue({status:'updated',refund});
    const service=new QixiangRefundService({beginSubmit,markManualReview}as never,{requestRefund}as never,
      {NODE_ENV:'production',AUDIT_PEPPER:'a'.repeat(64)}as RuntimeConfig,()=>now,gate as never);
    await expect(service.submit({userId:'00000000-0000-4000-8000-000000000001',sessionId:'s',role:'operator'},refund.id,
      {evidenceDigest:'b'.repeat(64),idempotencyKey:'refund-drift-test-1234'})).rejects.toThrow('database drift');
    expect(gate.require).toHaveBeenCalledTimes(2);expect(markManualReview).toHaveBeenCalledTimes(1);
    expect(requestRefund).not.toHaveBeenCalled();
  });
});
