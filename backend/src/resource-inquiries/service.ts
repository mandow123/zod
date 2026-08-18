import { randomBytes, randomUUID } from 'node:crypto';
import { encryptPii, secretHash } from '../account/crypto.js';
import { LEGAL_VERSIONS, type AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import { parseCreditCentMicros } from '../credits/precision.js';
import { AppError } from '../errors.js';
import { CursorService } from '../market/cursor.js';
import type { SubjectAccess } from '../subjects/types.js';
import { assertExpectedSupplierImport, readSupplierWorkbook } from './importer.js';
import type { PostgresResourceInquiryStore, PostgresSupplierImportStore } from './store.js';
import type {
  CatalogCandidate, InquiryBillingMode, InquiryEnvironment, InquiryNetwork, InquiryRecord, InquiryStatus, InquiryUseCase,
} from './types.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export class SupplierCatalogImportService {
  private readonly piiKey: string | undefined;
  private readonly pepper: string | undefined;
  constructor(private readonly store: PostgresSupplierImportStore | null, config: RuntimeConfig) {
    this.piiKey = config.PII_ENCRYPTION_KEY;
    this.pepper = config.AUDIT_PEPPER;
  }

  async preflight(filePath: string) {
    const parsed = await readSupplierWorkbook(filePath);
    const errors = parsed.issues.filter((issue) => issue.severity === 'error');
    const expectationsMet = errors.length === 0 && parsed.counts.leads === 100 && parsed.counts.candidates === 120
      && parsed.counts.candidatesByModel.H100 === 100 && parsed.counts.candidatesByModel.H200 === 16
      && parsed.counts.candidatesByModel.B300 === 4 && parsed.counts.h200UnconfirmedLeads === 84
      && parsed.counts.sourceWarnings === 168;
    return { report: { schemaVersion: parsed.schemaVersion, sourceDigest: parsed.sourceDigest,
      sourceSizeBytes: parsed.sourceSizeBytes, sourceObservedAt: parsed.sourceObservedAt,
      counts: parsed.counts, issues: parsed.issues, expectationsMet }, parsed };
  }

  async commit(filePath: string) {
    if (!this.store) throw new Error('DATABASE_URL is required for supplier import commit.');
    const piiKey=required(this.piiKey,'PII_ENCRYPTION_KEY'),pepper=required(this.pepper,'AUDIT_PEPPER');
    const { parsed } = await this.preflight(filePath);
    assertExpectedSupplierImport(parsed);
    const batchId = randomUUID(); const leadIds = new Map<number,string>();
    const leads = parsed.leads.map((lead) => {
      const id = randomUUID(); leadIds.set(lead.sourceRow,id);
      const supplierReferenceDigest = secretHash(lead.supplierName.normalize('NFKC').trim(),pepper);
      return { id,sourceRow:lead.sourceRow,supplierReferenceDigest,
        privatePayloadCiphertext:encryptPii(JSON.stringify(lead.privatePayload),piiKey),
        candidates:lead.candidates.map((item)=>({ id:randomUUID(),
          fingerprint:secretHash(`${supplierReferenceDigest}:${item.model}:${item.cardType}:${item.wideRegion}`,pepper),
          ...item })),
        h200Unconfirmed:lead.h200Unconfirmed ? { id:randomUUID(),...lead.h200Unconfirmed } : null };
    });
    const warnings = parsed.issues.filter((issue)=>issue.severity==='warning').map((warning)=>({ id:randomUUID(),
      leadId:leadIds.get(warning.sourceRow)!,sourceRow:warning.sourceRow,sourceColumn:warning.sourceColumn }));
    const result = await this.store.commit({ id:batchId,preflight:parsed,leads,warnings });
    return { replayed:result.replayed,batch:{ id:result.id,sourceDigest:parsed.sourceDigest,
      counts:parsed.counts,committedAt:result.committedAt.toISOString() } };
  }
}

export class ResourceInquiryService {
  private readonly cursor: CursorService;
  private readonly pepper: string;
  constructor(private readonly store: PostgresResourceInquiryStore, private readonly subjects: SubjectAccess,
    config: RuntimeConfig, private readonly now:()=>Date=()=>new Date()) {
    this.cursor=new CursorService(required(config.CURSOR_SECRET,'CURSOR_SECRET'));
    this.pepper=required(config.AUDIT_PEPPER,'AUDIT_PEPPER');
  }

  async catalog(input: Readonly<{ model?: CatalogCandidate['model']; region?: string; query?: string;
    cursor?: string; limit?: number }>) {
    const limit=Math.min(Math.max(input.limit??20,1),50);
    const rows=await this.store.listCandidates({ ...(input.model?{model:input.model}:{}),
      ...(input.region?.trim()?{region:input.region.trim()}:{}),...(input.query?.trim()?{query:input.query.trim()}:{}),
      cursor:this.cursor.decode(input.cursor),limit });
    const last=rows.at(-1);
    return { items:rows.map((row)=>this.publicCandidate(row)),nextCursor:rows.length===limit&&last
      ? this.cursor.encode({createdAt:last.createdAt.toISOString(),id:last.id}):null };
  }

  async candidate(id:string) {
    const item=await this.store.getCandidate(id);
    if(!item)throw new AppError('CATALOG_CANDIDATE_NOT_FOUND',404,'没有找到这项询期候选资源。');
    return this.publicCandidate(item);
  }

  async create(principal:AccountPrincipal,input:Readonly<{ candidateId:string;startsAt:string;endsAt:string;timeZone:string;
    confirmBy:string;gpuCount:number;billingMode:InquiryBillingMode;allowSubstitutes:boolean;maxCreditAmount:string;
    useCase:InquiryUseCase;description:string;environment:InquiryEnvironment;network:InquiryNetwork;storageGiB:number;
    dataRegion:string;terms:Readonly<{termsVersion:string;privacyVersion:string;inquiryVersion:string}>;
    idempotencyKey:string }>,context:RequestContext) {
    this.idempotency(input.idempotencyKey);
    const subject=await this.subjects.current(principal.userId,'orders.buy');
    const startsAt=new Date(input.startsAt),endsAt=new Date(input.endsAt),confirmBy=new Date(input.confirmBy),now=this.now();
    if(Number.isNaN(startsAt.getTime())||Number.isNaN(endsAt.getTime())||startsAt<=now||endsAt<=startsAt)
      throw new AppError('INQUIRY_PERIOD_INVALID',400,'询期开始时间需晚于当前时间，结束时间需晚于开始时间。');
    if(!this.validTimeZone(input.timeZone))throw new AppError('INQUIRY_TIME_ZONE_INVALID',400,'请选择有效的 IANA 时区。');
    if(Number.isNaN(confirmBy.getTime())||confirmBy<now||confirmBy>=startsAt)
      throw new AppError('INQUIRY_CONFIRM_BY_INVALID',400,'最晚确认时间需在当前时间之后且早于用卡开始时间。');
    const maxCreditMicros=/^(?:0|[1-9]\d{0,11})\.\d{2}$/u.test(input.maxCreditAmount.trim())
      ? parseCreditCentMicros(input.maxCreditAmount) : null;
    if(!maxCreditMicros)throw new AppError('INQUIRY_MAX_CREDIT_INVALID',400,'最大可接受卡时需为大于 0 的两位小数。');
    if(input.terms.termsVersion!==LEGAL_VERSIONS.terms||input.terms.privacyVersion!==LEGAL_VERSIONS.privacy
      ||input.terms.inquiryVersion!==LEGAL_VERSIONS.inquiry)
      throw new AppError('LEGAL_VERSION_STALE',409,'协议版本已经更新，请重新阅读并确认。');
    const normalized={ candidateId:input.candidateId,startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString(),
      timeZone:input.timeZone,confirmBy:confirmBy.toISOString(),gpuCount:input.gpuCount,billingMode:input.billingMode,
      allowSubstitutes:input.allowSubstitutes,maxCreditMicros:maxCreditMicros.toString(),useCase:input.useCase,
      description:input.description.trim(),environment:input.environment,network:input.network,storageGiB:input.storageGiB,
      dataRegion:input.dataRegion.trim(),terms:input.terms };
    const result=await this.store.create({ id:randomUUID(),inquiryNumber:this.number(),subjectId:subject.subjectId,
      userId:principal.userId,candidateId:input.candidateId,startsAt,endsAt,timeZone:input.timeZone,confirmBy,
      gpuCount:input.gpuCount,billingMode:input.billingMode,allowSubstitutes:input.allowSubstitutes,
      maxCreditMicros,useCase:input.useCase,description:normalized.description,environment:input.environment,
      network:input.network,storageGiB:input.storageGiB,dataRegion:normalized.dataRegion,
      termsVersion:input.terms.termsVersion,
      privacyVersion:input.terms.privacyVersion,inquiryVersion:input.terms.inquiryVersion,
      idempotencyKey:input.idempotencyKey,payloadDigest:this.digest(normalized),ipHash:this.ip(context.ip),
      requestId:context.requestId,now });
    if(result.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'同一请求标识对应了不同的询期内容。');
    if(result.status==='candidate_not_found')throw new AppError('CATALOG_CANDIDATE_NOT_FOUND',404,'没有找到这项询期候选资源。');
    if(result.status==='mode_unavailable')throw new AppError('INQUIRY_BILLING_MODE_UNAVAILABLE',409,'候选资源未登记该计费方式，请重新选择。');
    if(!('inquiry' in result))throw new Error('unhandled resource inquiry creation result');
    return { replayed:result.status==='replayed',inquiry:await this.detail(result.inquiry) };
  }

  async list(principal:AccountPrincipal,input:Readonly<{status?:InquiryStatus;cursor?:string;limit?:number}>) {
    const subject=await this.subjects.current(principal.userId,'orders.read');const limit=Math.min(Math.max(input.limit??20,1),50);
    const rows=await this.store.list(subject.subjectId,{...(input.status?{status:input.status}:{}),cursor:this.cursor.decode(input.cursor),limit});
    const last=rows.at(-1);return { inquiries:rows.map((row)=>this.summary(row)),nextCursor:rows.length===limit&&last
      ?this.cursor.encode({createdAt:last.createdAt.toISOString(),id:last.id}):null };
  }

  async get(principal:AccountPrincipal,id:string) {
    const subject=await this.subjects.current(principal.userId,'orders.read');const record=await this.store.get(subject.subjectId,id);
    if(!record)throw new AppError('RESOURCE_INQUIRY_NOT_FOUND',404,'询期记录不存在。');return this.detail(record);
  }

  async clarifications(principal:AccountPrincipal,id:string) {
    const subject=await this.subjects.current(principal.userId,'orders.read');const rows=await this.store.clarifications(subject.subjectId,id);
    if(!rows)throw new AppError('RESOURCE_INQUIRY_NOT_FOUND',404,'询期记录不存在。');
    return rows.map((row)=>({id:row.id,message:row.message,createdAt:row.createdAt.toISOString()}));
  }

  async cancel(principal:AccountPrincipal,id:string,expectedVersion:number,key:string,context:RequestContext) {
    this.idempotency(key);const subject=await this.subjects.current(principal.userId,'orders.buy');
    const payloadDigest=this.digest({action:'cancel',subjectId:subject.subjectId,inquiryId:id,expectedVersion});
    const result=await this.store.cancel({subjectId:subject.subjectId,userId:principal.userId,inquiryId:id,
      expectedVersion,idempotencyKey:key,payloadDigest,ipHash:this.ip(context.ip),requestId:context.requestId,now:this.now()});
    if(result.status==='not_found')throw new AppError('RESOURCE_INQUIRY_NOT_FOUND',404,'询期记录不存在。');
    if(result.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'同一请求标识对应了不同的取消操作。');
    if(result.status==='version_conflict')throw new AppError('RESOURCE_INQUIRY_VERSION_CONFLICT',409,'询期已更新，请刷新后重试。');
    if(result.status==='invalid_state')throw new AppError('RESOURCE_INQUIRY_STATE_INVALID',409,'询期状态已经变化，当前不能取消。');
    return {replayed:result.status==='replayed',inquiry:await this.detail(result.inquiry)};
  }

  async clarify(principal:AccountPrincipal,id:string,message:string,expectedVersion:number,key:string,context:RequestContext) {
    this.idempotency(key);const subject=await this.subjects.current(principal.userId,'orders.buy'),normalized=message.trim();
    const payloadDigest=this.digest({action:'clarify',subjectId:subject.subjectId,inquiryId:id,message:normalized,expectedVersion});
    const result=await this.store.clarify({id:randomUUID(),subjectId:subject.subjectId,userId:principal.userId,inquiryId:id,
      message:normalized,expectedVersion,idempotencyKey:key,payloadDigest,ipHash:this.ip(context.ip),requestId:context.requestId,now:this.now()});
    if(result.status==='not_found')throw new AppError('RESOURCE_INQUIRY_NOT_FOUND',404,'询期记录不存在。');
    if(result.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'同一请求标识对应了不同的补充说明。');
    if(result.status==='version_conflict')throw new AppError('RESOURCE_INQUIRY_VERSION_CONFLICT',409,'询期已更新，请刷新后重试。');
    if(result.status==='invalid_state')throw new AppError('RESOURCE_INQUIRY_STATE_INVALID',409,'当前询期未要求补充说明。');
    return {replayed:result.status==='replayed',inquiry:await this.detail(result.inquiry),clarification:{
      id:result.clarification.id,message:result.clarification.message,createdAt:result.clarification.createdAt.toISOString()} };
  }

  async operatorList(principal:AccountPrincipal,input:Readonly<{status?:InquiryStatus;assignment?:'assigned'|'unassigned';cursor?:string;limit?:number}>){
    this.operator(principal);const limit=Math.min(Math.max(input.limit??20,1),50),rows=await this.store.listOperator({
      ...(input.status?{status:input.status}:{}),...(input.assignment?{assignment:input.assignment}:{}),
      cursor:this.cursor.decode(input.cursor),limit});return this.page(rows,limit,(item)=>this.operatorSummary(item));}
  async operatorGet(principal:AccountPrincipal,id:string){this.operator(principal);const item=await this.store.getOperator(id);
    if(!item)throw new AppError('RESOURCE_INQUIRY_NOT_FOUND',404,'询期记录不存在。');return this.operatorDetail(item);}
  async supplierList(principal:AccountPrincipal,input:Readonly<{status?:InquiryStatus;cursor?:string;limit?:number}>){
    const subject=await this.subjects.current(principal.userId,'provider.read'),limit=Math.min(Math.max(input.limit??20,1),50);
    const rows=await this.store.listSupplier(subject.subjectId,{...(input.status?{status:input.status}:{}),
      cursor:this.cursor.decode(input.cursor),limit});return this.page(rows,limit,(item)=>this.supplierSummary(item));}
  async supplierGet(principal:AccountPrincipal,id:string){const subject=await this.subjects.current(principal.userId,'provider.read');
    const item=await this.store.getSupplier(subject.subjectId,id);if(!item)throw new AppError('RESOURCE_INQUIRY_NOT_FOUND',404,'询期记录不存在。');
    return this.supplierDetail(item);}
  async assign(principal:AccountPrincipal,id:string,input:Readonly<{supplierSubjectId:string;expectedVersion:number}>,key:string,context:RequestContext){
    this.operator(principal);this.idempotency(key);const payloadDigest=this.digest({action:'assign',id,...input});
    return this.handleTransition(await this.store.assign({inquiryId:id,supplierSubjectId:input.supplierSubjectId,
      expectedVersion:input.expectedVersion,actorId:principal.userId,idempotencyKey:key,payloadDigest,requestId:context.requestId,
      ipHash:this.ip(context.ip),now:this.now()}),'operator');}
  async operatorAction(principal:AccountPrincipal,id:string,action:'request_clarification'|'expire'|'submit_audit',
    input:Readonly<{expectedVersion:number;message?:string}>,key:string,context:RequestContext){this.operator(principal);
    return this.action(principal,id,null,'operator',action,input,key,context);}
  async supplierAction(principal:AccountPrincipal,id:string,action:'request_clarification'|'decline'|'confirm_capacity',
    input:Readonly<{expectedVersion:number;message?:string}>,key:string,context:RequestContext){
    const subject=await this.subjects.current(principal.userId,'provider.order.manage');
    return this.action(principal,id,subject.subjectId,'provider',action,input,key,context);}
  async expireDue(now=this.now(),limit=100){return{expired:await this.store.expireDue(now,limit)};}

  private publicCandidate(item:CatalogCandidate){return{candidateId:item.id,model:item.model,cardType:item.cardType,
    region:item.region,modes:item.modes,status:'inquiry_required' as const,sourceObservedAt:item.sourceObservedAt.toISOString(),
    lastVerifiedAt:item.verifiedAt?.toISOString()??null,
    verification:{status:'awaiting_supplier_confirmation' as const,message:'资料待供应方确认' as const},
    supplier:{displayName:'待认领供应方' as const,claimed:false as const},terms:'inquiry-required' as const};}
  private summary(item:InquiryRecord){return{id:item.id,inquiryNumber:item.inquiryNumber,candidate:{candidateId:item.candidate.id,
    model:item.candidate.model,cardType:item.candidate.cardType,region:item.candidate.region},status:item.status,
    startsAt:item.startsAt.toISOString(),endsAt:item.endsAt.toISOString(),timeZone:item.timeZone,confirmBy:item.confirmBy.toISOString(),
    gpuCount:item.gpuCount,billingMode:item.billingMode,version:item.version,
    assignment:{status:item.supplierSubjectId?'assigned' as const:'unassigned' as const},
    allowedActions:this.buyerActions(item),createdAt:item.createdAt.toISOString(),updatedAt:item.updatedAt.toISOString()};}
  private async detail(item:InquiryRecord){return{...this.summary(item),allowSubstitutes:item.allowSubstitutes,
    maxCreditAmount:formatCreditDisplayMicros(item.maxCreditMicros),useCase:item.useCase,description:item.description,
    requirements:{environment:item.environment,network:item.network,storageGiB:item.storageGiB,dataRegion:item.dataRegion},
    terms:{termsVersion:item.termsVersion,privacyVersion:item.privacyVersion,inquiryVersion:item.inquiryVersion,
      acceptedAt:item.acceptedAt.toISOString()},clarifications:await this.clarificationsFor(item),
    cancelledAt:item.cancelledAt?.toISOString()??null,capacityConfirmedAt:item.capacityConfirmedAt?.toISOString()??null,
    expiredAt:item.expiredAt?.toISOString()??null,statusMessage:item.statusMessage};}
  private async clarificationsFor(item:InquiryRecord){const rows=await this.store.clarifications(item.subjectId,item.id)??[];
    return rows.map((row)=>({id:row.id,message:row.message,kind:row.kind==='operator_request'?'supplier_request':row.kind,
      createdAt:row.createdAt.toISOString()}));}
  private buyerActions(item:InquiryRecord){const actions:('cancel'|'provide_clarification')[]=[];
    if(['submitted','awaiting_supplier','clarification_required'].includes(item.status))actions.push('cancel');
    if(item.status==='clarification_required')actions.push('provide_clarification');return actions;}
  private supplierActions(item:InquiryRecord){const actions:string[]=[];if(item.status==='awaiting_supplier')
    actions.push('request_clarification','decline','confirm_capacity');if(item.status==='clarification_required')actions.push('decline');return actions;}
  private operatorActions(item:InquiryRecord){const actions:string[]=[];if(item.status==='submitted')actions.push('assign');
    if(item.status==='awaiting_supplier')actions.push('request_clarification');if(item.status==='capacity_confirmed')actions.push('submit_audit');
    if(['submitted','awaiting_supplier','clarification_required'].includes(item.status)&&item.confirmBy<=this.now())actions.push('expire');return actions;}
  private supplierSummary(item:InquiryRecord){return{...this.summary(item),supplierSubjectId:item.supplierSubjectId,
    allowedActions:this.supplierActions(item)};}
  private operatorSummary(item:InquiryRecord){return{...this.summary(item),buyerSubjectId:item.subjectId,
    supplierSubjectId:item.supplierSubjectId,allowedActions:this.operatorActions(item)};}
  private async supplierDetail(item:InquiryRecord){return{...await this.detail(item),supplierSubjectId:item.supplierSubjectId,
    allowedActions:this.supplierActions(item)};}
  private async operatorDetail(item:InquiryRecord){return{...await this.detail(item),buyerSubjectId:item.subjectId,
    supplierSubjectId:item.supplierSubjectId,allowedActions:this.operatorActions(item)};}
  private page<T>(rows:InquiryRecord[],limit:number,serialize:(item:InquiryRecord)=>T){const last=rows.at(-1);return{
    inquiries:rows.map(serialize),nextCursor:rows.length===limit&&last?this.cursor.encode({createdAt:last.createdAt.toISOString(),id:last.id}):null};}
  private async action(principal:AccountPrincipal,id:string,subjectId:string|null,actorKind:'operator'|'provider',
    action:'request_clarification'|'decline'|'confirm_capacity'|'expire'|'submit_audit',input:Readonly<{expectedVersion:number;message?:string}>,
    key:string,context:RequestContext){this.idempotency(key);const message=input.message?.trim();
    if(action==='request_clarification'&&(!message||message.length<20||message.length>1000))
      throw new AppError('VALIDATION_ERROR',400,'补件说明需为 20 至 1000 个字。');
    if(action==='decline'&&(!message||message.length<2||message.length>500))
      throw new AppError('VALIDATION_ERROR',400,'拒绝原因需为 2 至 500 个字。');
    const payloadDigest=this.digest({action,id,expectedVersion:input.expectedVersion,message:message??null});
    return this.handleTransition(await this.store.transition({inquiryId:id,actorId:principal.userId,actorKind,
      actorSubjectId:subjectId,action,expectedVersion:input.expectedVersion,idempotencyKey:key,payloadDigest,
      ...(message?{message}:{}),requestId:context.requestId,ipHash:this.ip(context.ip),now:this.now()}),actorKind==='operator'?'operator':'supplier');}
  private async handleTransition(result:Awaited<ReturnType<PostgresResourceInquiryStore['transition']>>|Awaited<ReturnType<PostgresResourceInquiryStore['assign']>>,
    view:'operator'|'supplier'){
    if(result.status==='not_found')throw new AppError('RESOURCE_INQUIRY_NOT_FOUND',404,'询期记录不存在。');
    if(result.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'同一请求标识对应了不同操作。');
    if(result.status==='version_conflict')throw new AppError('RESOURCE_INQUIRY_VERSION_CONFLICT',409,'询期已更新，请刷新后重试。');
    if(result.status==='invalid_state')throw new AppError('RESOURCE_INQUIRY_STATE_INVALID',409,'询期状态已经变化，当前不能执行该操作。');
    if(result.status==='invalid_supplier')throw new AppError('SUPPLIER_SUBJECT_INVALID',409,'只能分派给已通过审核且有效的供应主体。');
    if(result.status==='assignment_conflict')throw new AppError('SUPPLIER_ASSIGNMENT_CONFLICT',409,'候选资源已经绑定其他供应主体。');
    if(!('inquiry'in result))throw new Error('unhandled inquiry transition');return{replayed:result.status==='replayed',
      inquiry:view==='operator'?await this.operatorDetail(result.inquiry):await this.supplierDetail(result.inquiry)};}
  private operator(principal:AccountPrincipal){if(principal.role!=='operator'&&principal.role!=='admin')
    throw new AppError('OPERATOR_REQUIRED',403,'该操作需要运营权限。');}
  private validTimeZone(value:string){try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(this.now());return true;}catch{return false;}}
  private idempotency(value:string){if(!/^[A-Za-z0-9:_-]{16,120}$/u.test(value))throw new AppError('IDEMPOTENCY_KEY_INVALID',400,'请求缺少有效的幂等标识。');}
  private number(){return`KIQ${this.now().getTime().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;}
  private digest(value:unknown){return secretHash(JSON.stringify(value),this.pepper);}
  private ip(value:string){return secretHash(value||'unknown',this.pepper);}
}
