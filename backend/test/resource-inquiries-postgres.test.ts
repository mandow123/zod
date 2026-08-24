import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe,expect,it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { preflightSupplierRows,type SupplierWorkbookRow } from '../src/resource-inquiries/importer.js';
import { ResourceInquiryService } from '../src/resource-inquiries/service.js';
import { PostgresResourceInquiryStore,PostgresSupplierImportStore } from '../src/resource-inquiries/store.js';
import type { SubjectAccess } from '../src/subjects/types.js';

function pgResult<T>(result:Results<T>){return{...result,rowCount:result.rows.length||result.affectedRows||0,command:'',oid:0,rowAsArray:false};}
function adapter(pglite:PGlite):Database{return{health:async()=>true,schemaReadiness:async()=>({ready:true,expected:null,applied:null,missing:[],mismatched:[]}),
  query:async<Row extends Record<string,unknown>>(text:string,values?:unknown[])=>pgResult(await pglite.query<Row>(text,values)),
  transaction:async<T>(work:(client:PoolClient)=>Promise<T>)=>pglite.transaction(async(transaction:Transaction)=>work({
    query:async(text:string,values?:unknown[])=>pgResult(await transaction.query(text,values))}as unknown as PoolClient)),
  close:()=>pglite.close()}as unknown as Database;}
async function migrate(pglite:PGlite){for(const name of ['0001_cloudpay_ledger.sql','0016_trading_subjects.sql','0022_kai_credit_double_entry_ledger.sql','0058_resource_inquiries.sql','0059_resource_inquiry_operations.sql','0062_honghuan_supplier_inquiry_catalog.sql'])
  await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`,import.meta.url)),'utf8'));}
const headers=['序号','公司名称','企业性质','机房所在地','可提供GPU型号','H100单卡时租(元)','H100单卡包月(元)',
  'H200单卡时租(元)','H200单卡包月(元)','B300单卡时租(元)','B300单卡包月(元)','合约要求','网络配置','现货状态','SLA','备注'];
function sourceRows():SupplierWorkbookRow[]{const rows:SupplierWorkbookRow[]=[{sourceRow:2,values:['统计日期：2026-08-17']},{sourceRow:3,values:headers}];
  for(let index=0;index<100;index+=1){const explicitH200=index<16,explicitB300=index<4;
    rows.push({sourceRow:index+4,values:[index+1,`test-lead-${String(index+1).padStart(3,'0')}`,'test-kind','上海',
      `H100${explicitH200?'/H200':''}${explicitB300?'/B300':''}`,'private','private','private','private',
      explicitB300?'private':'',explicitB300?'private':'','','','source-claim','','']});}return rows;}
const source={digest:`sha256:${'a'.repeat(64)}`,sizeBytes:12345};
function prepared(){return preflightSupplierRows(sourceRows(),source);}
function importInput(preflight=prepared()){const leadIds=new Map<number,string>();const leads=preflight.leads.map((lead)=>{const id=randomUUID();leadIds.set(lead.sourceRow,id);
  return{id,sourceRow:lead.sourceRow,supplierReferenceDigest:`${lead.sourceRow}`.padStart(128,'0'),privatePayloadCiphertext:`v1.private.${lead.sourceRow}`,
    candidates:lead.candidates.map((candidate)=>({id:randomUUID(),fingerprint:randomUUID().replaceAll('-','').padEnd(128,'0'),...candidate})),
    h200Unconfirmed:lead.h200Unconfirmed?{id:randomUUID(),...lead.h200Unconfirmed}:null};});
  return{id:randomUUID(),preflight,leads,warnings:preflight.issues.filter((issue)=>issue.severity==='warning').map((warning)=>({
    id:randomUUID(),leadId:leadIds.get(warning.sourceRow)!,sourceRow:warning.sourceRow,sourceColumn:warning.sourceColumn}))};}
const config=loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:'https://cloudpay.kai.com',ACCESS_TOKEN_SECRET:'a'.repeat(64),
  REFRESH_TOKEN_PEPPER:'b'.repeat(32),OTP_PEPPER:'c'.repeat(32),AUDIT_PEPPER:'d'.repeat(32),CURSOR_SECRET:'e'.repeat(32),
  PII_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),TERMS_URL:'https://cloudpay.kai.com/terms',
  PRIVACY_POLICY_URL:'https://cloudpay.kai.com/privacy',INQUIRY_TERMS_URL:'https://cloudpay.kai.com/inquiry-terms'});

describe('supplier inquiry catalog and inquiry lifecycle',()=>{
  it('isolates malformed rows while proving the private workbook count contract',()=>{const report=prepared();
    expect(report.counts).toEqual({leads:100,candidates:120,candidatesByModel:{H100:100,H200:16,B300:4},h200UnconfirmedLeads:84,sourceWarnings:168});
    expect(report.issues.filter((issue)=>issue.severity==='error')).toHaveLength(0);
    const malformed=sourceRows();malformed[10]={sourceRow:malformed[10]!.sourceRow,values:[7,'','','','','']};
    const isolated=preflightSupplierRows(malformed,source);expect(isolated.counts.leads).toBe(99);
    expect(isolated.issues).toContainEqual(expect.objectContaining({severity:'error',code:'ROW_REQUIRED_FIELD_MISSING'}));
    const explicit=sourceRows();explicit[2]={sourceRow:4,values:[1,'test-lead','test-kind','上海','H100 PCIe/H200 SXM',
      'private','private','private','private','','','','','','','']};
    const cardTypes=preflightSupplierRows(explicit,source).leads[0]!.candidates.map((item)=>[item.model,item.cardType]);
    expect(cardTypes).toEqual([['H100','PCIe'],['H200','SXM']]);
    expect(report.leads.flatMap((lead)=>lead.candidates).every((item)=>['PCIe','SXM','卡型待确认'].includes(item.cardType))).toBe(true);});

  it('commits once, persists 84 private H200 leads and 168 warnings, and publishes only 120 explicit candidates',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite),store=new PostgresSupplierImportStore(database),input=importInput();
    const first=await store.commit(input),replay=await store.commit({...input,id:randomUUID()});expect(first.replayed).toBe(false);expect(replay).toMatchObject({replayed:true,id:first.id});
    const counts=await database.query<{leads:string;candidates:string;h200:string;warnings:string}>(`SELECT
      (SELECT count(*) FROM supplier_leads)::text leads,(SELECT count(*) FROM candidate_resources WHERE active)::text candidates,
      (SELECT count(*) FROM h200_unconfirmed_leads)::text h200,(SELECT count(*) FROM supplier_import_source_warnings)::text warnings`);
    expect(counts.rows[0]).toEqual({leads:'100',candidates:'120',h200:'84',warnings:'168'});
    const catalog=new PostgresResourceInquiryStore(database),h200=await catalog.listCandidates({model:'H200',cursor:null,limit:50});
    expect(h200).toHaveLength(16);expect(h200.every((item)=>item.model==='H200')).toBe(true);
    const privateRows=await database.query<{private_payload_ciphertext:string}>(`SELECT private_payload_ciphertext FROM supplier_leads LIMIT 1`);
    expect(privateRows.rows[0]?.private_payload_ciphertext).not.toContain('test-lead');await database.close();});

  it('keeps public responses anonymous and free of prices, currency, stock, and purchase claims',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite);await new PostgresSupplierImportStore(database).commit(importInput());
    const subjects={current:async()=>({subjectId:randomUUID(),kind:'personal',displayName:'test',subjectStatus:'active',role:'owner',userId:randomUUID(),permissions:['orders.read','orders.buy']})}as SubjectAccess;
    const service=new ResourceInquiryService(new PostgresResourceInquiryStore(database),subjects,config,()=>new Date('2026-08-18T00:00:00.000Z'));
    const response=await service.catalog({limit:50});expect(response.items).toHaveLength(50);
    const serialized=JSON.stringify(response).toLowerCase();for(const forbidden of ['price','cny','rmb','人民币','现货','可购买','company','contact'])expect(serialized).not.toContain(forbidden);
    expect(response.items[0]).toMatchObject({status:'inquiry_required',lastVerifiedAt:null,
      verification:{status:'awaiting_supplier_confirmation',message:'资料待供应方确认'},
      supplier:{displayName:'待认领供应方',claimed:false},terms:'inquiry-required'});
    expect(response.items[0]!.sourceObservedAt).toBe('2026-08-16T16:00:00.000Z');
    await database.close();});

  it('creates only a submitted inquiry, records three acceptances, changes no order or ledger, and isolates subjects',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite);await new PostgresSupplierImportStore(database).commit(importInput());
    const userA=randomUUID(),userB=randomUUID(),subjectA=randomUUID(),subjectB=randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'a','A'),($2,'b','B')`,[userA,userB]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES($1,'personal','A',$2),($3,'personal','B',$4)`,[subjectA,userA,subjectB,userB]);
    const access={current:async(userId:string)=>({subjectId:userId===userA?subjectA:subjectB,kind:'personal' as const,displayName:'test',subjectStatus:'active' as const,
      role:'owner' as const,userId,permissions:['orders.read','orders.buy'] as const})}as SubjectAccess;
    const store=new PostgresResourceInquiryStore(database),now=new Date('2026-08-18T00:00:00.000Z'),service=new ResourceInquiryService(store,access,config,()=>now);
    const candidate=(await store.listCandidates({cursor:null,limit:1}))[0]!;
    const body={candidateId:candidate.id,startsAt:'2026-08-20T01:00:00.000Z',endsAt:'2026-08-20T09:00:00.000Z',timeZone:'Asia/Shanghai',
      confirmBy:'2026-08-19T01:00:00.000Z',gpuCount:8,billingMode:'hourly' as const,allowSubstitutes:true,maxCreditAmount:'100.00',
      useCase:'training' as const,description:'用于训练已完成数据合规审核的内部模型任务。',environment:'container' as const,
      network:'private_network' as const,storageGiB:2048,dataRegion:'中国大陆·华东',terms:{termsVersion:'2026-08-11',privacyVersion:'2026-08-11',inquiryVersion:'2026-08-18'},
      idempotencyKey:'resource-inquiry-create-0001'};
    const before=await database.query<{orders:string;transactions:string}>(`SELECT (SELECT count(*) FROM orders)::text orders,
      (SELECT count(*) FROM kai_credit_transactions)::text transactions`);
    const principalA={userId:userA,sessionId:'a',role:'member' as const},created=await service.create(principalA,body,{requestId:'r1',ip:'127.0.0.1'});
    const replay=await service.create(principalA,body,{requestId:'r2',ip:'127.0.0.1'});expect(created).toMatchObject({replayed:false,inquiry:{status:'submitted',maxCreditAmount:'100.00'}});
    expect(replay).toMatchObject({replayed:true,inquiry:{id:created.inquiry.id}});
    const after=await database.query<{orders:string;transactions:string}>(`SELECT (SELECT count(*) FROM orders)::text orders,
      (SELECT count(*) FROM kai_credit_transactions)::text transactions`);expect(after.rows[0]).toEqual(before.rows[0]);
    expect((await database.query<{count:string}>(`SELECT count(*)::text count FROM resource_inquiry_terms_acceptances WHERE inquiry_id=$1`,[created.inquiry.id])).rows[0]?.count).toBe('3');
    expect((await database.query<{count:string}>(`SELECT count(*)::text count FROM outbox_events WHERE aggregate_id=$1`,[created.inquiry.id])).rows[0]?.count).toBe('1');
    await expect(service.get({userId:userB,sessionId:'b',role:'member'},created.inquiry.id)).rejects.toMatchObject({code:'RESOURCE_INQUIRY_NOT_FOUND'});
    const conflictKey='resource-inquiry-create-conflict',conflicting=await Promise.allSettled([
      service.create(principalA,{...body,maxCreditAmount:'101.00',idempotencyKey:conflictKey},{requestId:'conflict-a',ip:'127.0.0.1'}),
      service.create(principalA,{...body,maxCreditAmount:'102.00',idempotencyKey:conflictKey},{requestId:'conflict-b',ip:'127.0.0.1'})]);
    expect(conflicting.filter((item)=>item.status==='fulfilled')).toHaveLength(1);const rejected=conflicting.find((item)=>item.status==='rejected');
    expect(rejected&&rejected.status==='rejected'?rejected.reason:null).toMatchObject({code:'IDEMPOTENCY_KEY_CONFLICT'});
    expect((await database.query<{count:string}>(`SELECT count(*)::text count FROM resource_inquiries WHERE subject_id=$1 AND client_request_id=$2`,[subjectA,conflictKey])).rows[0]?.count).toBe('1');
    await database.close();});

  it('advances through real operator and supplier services with optimistic concurrency and isolated assignment',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite);await new PostgresSupplierImportStore(database).commit(importInput());
    const buyerUser=randomUUID(),buyerSubject=randomUUID(),supplierUser=randomUUID(),supplierSubject=randomUUID(),otherSupplierUser=randomUUID(),otherSupplierSubject=randomUUID(),operatorUser=randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES($1,'a','Buyer','member'),($2,'b','Supplier','supplier'),($3,'c','Other','supplier'),($4,'d','Operator','operator')`,
    [buyerUser,supplierUser,otherSupplierUser,operatorUser]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES($1,'personal','Buyer',$2),($3,'organization','Supplier',$4),($5,'organization','Other',$6)`,
    [buyerSubject,buyerUser,supplierSubject,supplierUser,otherSupplierSubject,otherSupplierUser]);
    await database.query(`INSERT INTO supplier_profiles(id,created_by_user_id,subject_id,legal_name,credit_code,contact_name,status)
      VALUES(gen_random_uuid(),$1,$2,'Supplier','CREDIT-1','Contact','approved'),(gen_random_uuid(),$3,$4,'Other','CREDIT-2','Contact','approved')`,
    [supplierUser,supplierSubject,otherSupplierUser,otherSupplierSubject]);
    const access={current:async(userId:string,permission:string)=>{const supplier=userId===supplierUser||userId===otherSupplierUser,
      permissions=supplier?['orders.read','provider.read','provider.order.manage']:['orders.read','orders.buy'];
      if(!permissions.includes(permission))throw Object.assign(new Error('denied'),{code:'SUBJECT_PERMISSION_DENIED',statusCode:403});
      return{subjectId:userId===supplierUser?supplierSubject:userId===otherSupplierUser?otherSupplierSubject:buyerSubject,
        kind:supplier?'organization' as const:'personal' as const,displayName:'test',subjectStatus:'active' as const,
        role:'owner' as const,userId,permissions};}}as SubjectAccess;
    const store=new PostgresResourceInquiryStore(database),now=new Date('2026-08-18T00:00:00.000Z'),service=new ResourceInquiryService(store,access,config,()=>now);
    const candidate=(await store.listCandidates({cursor:null,limit:1}))[0]!,buyer={userId:buyerUser,sessionId:'buyer',role:'member' as const},
      supplier={userId:supplierUser,sessionId:'supplier',role:'supplier' as const},otherSupplier={userId:otherSupplierUser,sessionId:'other',role:'supplier' as const},
      operator={userId:operatorUser,sessionId:'operator',role:'operator' as const};
    const commerceBefore=await database.query<{orders:string;transactions:string}>(`SELECT (SELECT count(*) FROM orders)::text orders,
      (SELECT count(*) FROM kai_credit_transactions)::text transactions`);
    const base={candidateId:candidate.id,startsAt:'2026-08-20T01:00:00.000Z',endsAt:'2026-08-20T09:00:00.000Z',timeZone:'Asia/Shanghai',
      confirmBy:'2026-08-19T01:00:00.000Z',gpuCount:1,billingMode:'hourly',allowSubstitutes:false,maxCreditAmount:'20.00',useCase:'research',
      description:'用于已通过审核的科研计算与模型验证任务。',environment:'bare_metal',network:'flexible',storageGiB:500,
      dataRegion:'中国大陆·华东',terms:{termsVersion:'2026-08-11',privacyVersion:'2026-08-11',inquiryVersion:'2026-08-18'}} as const;
    const createPair=await Promise.all([
      service.create(buyer,{...base,idempotencyKey:'resource-inquiry-lifecycle-create'},{requestId:'create-a',ip:'127.0.0.1'}),
      service.create(buyer,{...base,idempotencyKey:'resource-inquiry-lifecycle-create'},{requestId:'create-b',ip:'127.0.0.1'})]);
    expect(createPair.map((item)=>item.replayed).sort()).toEqual([false,true]);expect(new Set(createPair.map((item)=>item.inquiry.id)).size).toBe(1);
    const created=createPair[0]!,id=created.inquiry.id,assignPair=await Promise.all([
      service.assign(operator,id,{supplierSubjectId:supplierSubject,expectedVersion:1},'resource-inquiry-assign-0001',{requestId:'assign-a',ip:'127.0.0.1'}),
      service.assign(operator,id,{supplierSubjectId:supplierSubject,expectedVersion:1},'resource-inquiry-assign-0001',{requestId:'assign-b',ip:'127.0.0.1'})]);
    expect(assignPair.map((item)=>item.replayed).sort()).toEqual([false,true]);const assigned=assignPair[0]!;
    expect(assigned).toMatchObject({inquiry:{status:'awaiting_supplier',version:2,supplierSubjectId:supplierSubject}});
    await expect(service.supplierGet(otherSupplier,id)).rejects.toMatchObject({code:'RESOURCE_INQUIRY_NOT_FOUND'});
    await expect(service.supplierAction(otherSupplier,id,'confirm_capacity',{expectedVersion:2},'resource-inquiry-other-0001',{requestId:'other',ip:'127.0.0.1'}))
      .rejects.toMatchObject({code:'RESOURCE_INQUIRY_NOT_FOUND'});
    const requestPair=await Promise.all([
      service.supplierAction(supplier,id,'request_clarification',{expectedVersion:2,message:'请补充说明训练数据的合规来源与跨区域传输安排。'},'resource-inquiry-request-0001',{requestId:'request-a',ip:'127.0.0.1'}),
      service.supplierAction(supplier,id,'request_clarification',{expectedVersion:2,message:'请补充说明训练数据的合规来源与跨区域传输安排。'},'resource-inquiry-request-0001',{requestId:'request-b',ip:'127.0.0.1'})]);
    expect(requestPair.map((item)=>item.replayed).sort()).toEqual([false,true]);const requested=requestPair[0]!;
    expect(requested).toMatchObject({inquiry:{status:'clarification_required',version:3}});
    const clarifyPair=await Promise.all([
      service.clarify(buyer,id,'补充说明：训练数据已加密，仅通过私网传输。',3,'resource-inquiry-clarify-0001',{requestId:'clarify-a',ip:'127.0.0.1'}),
      service.clarify(buyer,id,'补充说明：训练数据已加密，仅通过私网传输。',3,'resource-inquiry-clarify-0001',{requestId:'clarify-b',ip:'127.0.0.1'})]);
    expect(clarifyPair.map((item)=>item.replayed).sort()).toEqual([false,true]);const clarified=clarifyPair[0]!;
    expect(clarified).toMatchObject({inquiry:{status:'awaiting_supplier',version:4}});
    await expect(service.supplierAction(supplier,id,'confirm_capacity',{expectedVersion:3},'resource-inquiry-confirm-stale',{requestId:'stale',ip:'127.0.0.1'}))
      .rejects.toMatchObject({code:'RESOURCE_INQUIRY_VERSION_CONFLICT'});
    const confirmed=await service.supplierAction(supplier,id,'confirm_capacity',{expectedVersion:4},'resource-inquiry-confirm-0001',{requestId:'confirm',ip:'127.0.0.1'});
    expect(confirmed).toMatchObject({inquiry:{status:'capacity_confirmed',version:5}});
    const audit=await service.operatorAction(operator,id,'submit_audit',{expectedVersion:5},'resource-inquiry-audit-0001',{requestId:'audit',ip:'127.0.0.1'});
    expect(audit).toMatchObject({inquiry:{status:'audit_pending',version:6}});
    const declinedTarget=await service.create(buyer,{...base,idempotencyKey:'resource-inquiry-decline-create'},{requestId:'decline-create',ip:'127.0.0.1'});
    await service.assign(operator,declinedTarget.inquiry.id,{supplierSubjectId:supplierSubject,expectedVersion:1},'resource-inquiry-assign-0002',{requestId:'assign2',ip:'127.0.0.1'});
    const operatorRequest=await service.operatorAction(operator,declinedTarget.inquiry.id,'request_clarification',{expectedVersion:2,message:'请补充该业务用途所需的数据区域合规证明与授权材料。'},'resource-inquiry-operator-request',{requestId:'operator-request',ip:'127.0.0.1'});
    expect(operatorRequest).toMatchObject({inquiry:{status:'clarification_required',version:3}});
    const declined=await service.supplierAction(supplier,declinedTarget.inquiry.id,'decline',{expectedVersion:3,message:'当前资源档期无法满足该时间窗口。'},'resource-inquiry-decline-0001',{requestId:'decline',ip:'127.0.0.1'});
    expect(declined).toMatchObject({inquiry:{status:'supplier_declined',version:4,statusMessage:'当前资源档期无法满足该时间窗口。'}});
    expect((await service.supplierList(supplier,{})).inquiries).toHaveLength(2);expect((await service.supplierList(otherSupplier,{})).inquiries).toHaveLength(0);
    const events=await database.query<{count:string}>(`SELECT count(*)::text count FROM audit_events WHERE entity_id=$1`,[id]);
    const outbox=await database.query<{count:string}>(`SELECT count(*)::text count FROM outbox_events WHERE aggregate_id=$1`,[id]);
    const clarificationCount=await database.query<{count:string}>(`SELECT count(*)::text count FROM resource_inquiry_clarifications WHERE inquiry_id=$1`,[id]);
    const actionCount=await database.query<{count:string}>(`SELECT count(*)::text count FROM resource_inquiry_actions WHERE inquiry_id=$1`,[id]);
    expect(events.rows[0]?.count).toBe('6');expect(outbox.rows[0]?.count).toBe('6');expect(clarificationCount.rows[0]?.count).toBe('2');
    expect(actionCount.rows[0]?.count).toBe('4');
    const commerceAfter=await database.query<{orders:string;transactions:string}>(`SELECT (SELECT count(*) FROM orders)::text orders,
      (SELECT count(*) FROM kai_credit_transactions)::text transactions`);expect(commerceAfter.rows[0]).toEqual(commerceBefore.rows[0]);await database.close();});

  it('requires buyer manage permission, keeps cancellation idempotent, and expires through the worker service',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite);await new PostgresSupplierImportStore(database).commit(importInput());
    const owner=randomUUID(),viewer=randomUUID(),subject=randomUUID();await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'a','Owner'),($2,'b','Viewer')`,[owner,viewer]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES($1,'personal','A',$2)`,[subject,owner]);
    const access={current:async(userId:string,permission:string)=>{const permissions=userId===viewer?['orders.read']:['orders.read','orders.buy'];
      if(!permissions.includes(permission))throw Object.assign(new Error('denied'),{code:'SUBJECT_PERMISSION_DENIED',statusCode:403});
      return{subjectId:subject,kind:'personal' as const,displayName:'A',subjectStatus:'active' as const,role:userId===viewer?'viewer' as const:'owner' as const,userId,permissions};}}as SubjectAccess;
    const store=new PostgresResourceInquiryStore(database),now=new Date('2026-08-18T00:00:00.000Z'),service=new ResourceInquiryService(store,access,config,()=>now),candidate=(await store.listCandidates({cursor:null,limit:1}))[0]!;
    const ownerPrincipal={userId:owner,sessionId:'owner',role:'member' as const},viewerPrincipal={userId:viewer,sessionId:'viewer',role:'member' as const};
    const make=(key:string)=>service.create(ownerPrincipal,{candidateId:candidate.id,startsAt:'2026-08-20T01:00:00.000Z',endsAt:'2026-08-20T09:00:00.000Z',timeZone:'Asia/Shanghai',confirmBy:'2026-08-19T01:00:00.000Z',gpuCount:1,billingMode:'hourly',allowSubstitutes:false,maxCreditAmount:'20.00',useCase:'research',description:'用于已通过审核的科研计算与模型验证任务。',environment:'bare_metal',network:'flexible',storageGiB:500,dataRegion:'中国大陆·华东',terms:{termsVersion:'2026-08-11',privacyVersion:'2026-08-11',inquiryVersion:'2026-08-18'},idempotencyKey:key},{requestId:key,ip:'127.0.0.1'});
    const target=await make('resource-inquiry-cancel-create1');await expect(service.cancel(viewerPrincipal,target.inquiry.id,1,'resource-inquiry-viewer-cancel',{requestId:'viewer',ip:'127.0.0.1'})).rejects.toMatchObject({code:'SUBJECT_PERMISSION_DENIED',statusCode:403});
    await expect(service.clarify(viewerPrincipal,target.inquiry.id,'补充说明：查看者不应能够写入询期。',1,'resource-inquiry-viewer-clarify',{requestId:'viewer-clarify',ip:'127.0.0.1'})).rejects.toMatchObject({code:'SUBJECT_PERMISSION_DENIED',statusCode:403});
    const cancelled=await service.cancel(ownerPrincipal,target.inquiry.id,1,'resource-inquiry-cancel-0001',{requestId:'cancel',ip:'127.0.0.1'});
    const replay=await service.cancel(ownerPrincipal,target.inquiry.id,1,'resource-inquiry-cancel-0001',{requestId:'replay',ip:'127.0.0.1'});
    expect(cancelled).toMatchObject({replayed:false,inquiry:{status:'user_cancelled',version:2}});expect(replay.replayed).toBe(true);
    const expiring=await make('resource-inquiry-expire-create');expect(await service.expireDue(new Date('2026-08-19T01:00:00.000Z'))).toEqual({expired:1});
    expect(await service.get(ownerPrincipal,expiring.inquiry.id)).toMatchObject({status:'inquiry_expired',version:2});await database.close();});
});
