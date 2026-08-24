import { createHash,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite,type Results,type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe,expect,it } from 'vitest';
import type { AccountService } from '../src/account/service.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { ResourceInquiryService } from '../src/resource-inquiries/service.js';
import { PostgresResourceInquiryStore } from '../src/resource-inquiries/store.js';
import type { SubjectAccess } from '../src/subjects/types.js';
import { SupplierInquiryCatalogService } from '../src/supplier-inquiry-catalog/service.js';
import { PostgresSupplierInquiryCatalogStore } from '../src/supplier-inquiry-catalog/store.js';

function result<T>(value:Results<T>){return{...value,rowCount:value.rows.length||value.affectedRows||0,command:'',oid:0,rowAsArray:false};}
function adapter(pglite:PGlite):Database{return{health:async()=>true,
  schemaReadiness:async()=>({ready:true,expected:null,applied:null,missing:[],mismatched:[]}),
  query:async<Row extends Record<string,unknown>>(text:string,values?:unknown[])=>result(await pglite.query<Row>(text,values)),
  transaction:async<T>(work:(client:PoolClient)=>Promise<T>)=>pglite.transaction(async(transaction:Transaction)=>work({
    query:async(text:string,values?:unknown[])=>result(await transaction.query(text,values))}as unknown as PoolClient)),
  close:()=>pglite.close()}as unknown as Database;}
const migrationNames=['0001_cloudpay_ledger.sql','0016_trading_subjects.sql','0022_kai_credit_double_entry_ledger.sql',
  '0058_resource_inquiries.sql','0059_resource_inquiry_operations.sql','0062_honghuan_supplier_inquiry_catalog.sql'];
async function migrate(pglite:PGlite){for(const name of migrationNames)await pglite.exec(await readFile(
  fileURLToPath(new URL(`../migrations/${name}`,import.meta.url)),'utf8'));}
const baseEnvironment={NODE_ENV:'test',PUBLIC_ORIGIN:'https://cloudpay.kai.com',ACCESS_TOKEN_SECRET:'a'.repeat(64),
  REFRESH_TOKEN_PEPPER:'b'.repeat(32),OTP_PEPPER:'c'.repeat(32),AUDIT_PEPPER:'d'.repeat(32),CURSOR_SECRET:'e'.repeat(32),
  PII_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),TERMS_URL:'https://cloudpay.kai.com/terms',
  PRIVACY_POLICY_URL:'https://cloudpay.kai.com/privacy',INQUIRY_TERMS_URL:'https://cloudpay.kai.com/inquiry-terms'};
const now=new Date('2026-08-20T00:00:00.000Z');

const canonicalIds=['gpu-honghuan-a100-sxm4-80gb-1','gpu-honghuan-a100-sxm4-80gb-2',
  'gpu-honghuan-h100-sxm-80gb-1','gpu-honghuan-h100-sxm-80gb-2','gpu-honghuan-h200-nvl-1',
  'gpu-honghuan-h200-nvl-2','gpu-honghuan-b200-179gb-1','gpu-honghuan-b200-179gb-2',
  'gpu-honghuan-b200-179gb-4','gpu-honghuan-b300-269gb-1','server-honghuan-b300-monthly-32plus'] as const;
const exactPrices:Record<string,[string|null,string|null,string|null]>={
  'gpu-honghuan-a100-sxm4-80gb-1':['28.44','682.63',null],
  'gpu-honghuan-a100-sxm4-80gb-2':['53.89','1293.41',null],
  'gpu-honghuan-h100-sxm-80gb-1':['89.82','2155.69',null],
  'gpu-honghuan-h100-sxm-80gb-2':['163.17','3916.17',null],
  'gpu-honghuan-h200-nvl-1':['88.32','2119.76',null],
  'gpu-honghuan-h200-nvl-2':['137.72','3305.39',null],
  'gpu-honghuan-b200-179gb-1':['143.71','3449.10',null],
  'gpu-honghuan-b200-179gb-2':['278.44','6682.63',null],
  'gpu-honghuan-b200-179gb-4':['547.90','13149.70',null],
  'gpu-honghuan-b300-269gb-1':['305.39','7329.34',null],
  'server-honghuan-b300-monthly-32plus':[null,null,'411676.65'],
};

describe('Shanghai Honghuan formal supplier inquiry catalog',()=>{
  it('rejects a canonical seed whose approved specification snapshot was changed',{timeout:30000},async()=>{
    const pglite=new PGlite();for(const name of migrationNames.slice(0,-1))await pglite.exec(await readFile(
      fileURLToPath(new URL(`../migrations/${name}`,import.meta.url)),'utf8'));
    const approved=await readFile(fileURLToPath(new URL('../migrations/0062_honghuan_supplier_inquiry_catalog.sql',import.meta.url)),'utf8'),
      tampered=approved.replace('"storage":{"description":"256GB"}','"storage":{"description":"512GB"}');
    expect(tampered).not.toBe(approved);await expect(pglite.exec(tampered)).rejects.toThrow(
      'Honghuan catalog conflicts with the approved 11-item seed snapshot');await pglite.close();
  });

  it('publishes exactly 11 unverified inquiry-only resources with exact reference prices',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite),store=new PostgresSupplierInquiryCatalogStore(database);
    const service=new SupplierInquiryCatalogService(store,'inquiry','e'.repeat(32),()=>now);
    expect(await service.readiness()).toEqual({mode:'inquiry',ready:true,blockers:[]});
    const response=await service.list({limit:50});expect(response.items).toHaveLength(11);
    expect(response.items.map((item)=>item.resourceId).sort()).toEqual([...canonicalIds].sort());
    const modelCounts=response.items.reduce<Record<string,number>>((counts,item)=>{
      const key=`${item.specifications.gpu.model}:${item.catalogKind}`;counts[key]=(counts[key]??0)+1;return counts;},{});
    expect(modelCounts).toEqual({'A100:hourly_gpu':2,'H100:hourly_gpu':2,'H200:hourly_gpu':2,
      'B200:hourly_gpu':3,'B300:hourly_gpu':1,'B300:contract_monthly':1});
    for(const item of response.items){const price=item.billing.referencePrice;
      expect([price.hourlyAmount,price.dailyAmount,price.monthlyAmount]).toEqual(exactPrices[item.resourceId]);
      expect(item).toMatchObject({version:1,supplier:{id:'supplier-shanghai-honghuan',legalName:'上海鸿欢网络科技有限公司',
        displayName:'上海鸿欢',disclosureStatus:'platform_imported_unverified',logo:{authorizationStatus:'unverified',provenance:'user_provided'}},
      region:{scope:'national',exact:null,confirmationRequired:true},availability:{status:'inquiry_required',quantity:null,inventoryCommitment:false},
      delivery:{mode:'manual'},purchase:{purchasable:false,orderCreation:false,inquiryAvailable:true,cta:'submit_inquiry'},
      source:{observedAt:'2026-08-19',kind:'USER_PROVIDED_SUPPLIER_QUOTE',label:'资料来源：用户提供的供应商报价',
        verificationStatus:'unverified'},terms:'inquiry-required'});
      expect(price).toMatchObject({currency:'KAI_CARD_HOUR',precision:2,status:'reference_only',validUntil:'2026-09-19T03:59:59.000Z'});
    }
    const contract=response.items.find((item)=>item.resourceId==='server-honghuan-b300-monthly-32plus')!;
    expect(contract).toMatchObject({catalogKind:'contract_monthly',legalReviewRequired:true,
      specifications:{gpu:{model:'B300',formFactor:null,advertisedMemoryGb:null,environmentObservedMemoryGb:null,countPerInstance:null}},
      quantity:{unit:'server',min:32,max:128,allowedValues:[32,64,128]},billing:{modes:['monthly'],unit:'SERVER_MONTH'},
      delivery:{leadTime:{status:'supplier_declared',value:4,unit:'month'}}});
    expect(response.items.filter((item)=>item.catalogKind==='hourly_gpu').every((item)=>!item.legalReviewRequired
      &&item.quantity.unit==='instance'&&item.quantity.min===1&&item.quantity.max===100000&&item.quantity.allowedValues===null
      &&item.delivery.leadTime.status==='inquiry_confirmation_required'&&item.delivery.leadTime.value===null)).toBe(true);
    const publicJson=JSON.stringify(response).toLowerCase();for(const forbidden of ['cny','人民币','listing_multiplier','source_hourly',
      'evidence://','publication_directive','supplier_authorization_evidence','contact','275000'])expect(publicJson).not.toContain(forbidden);
    const logo=await readFile(fileURLToPath(new URL('../../assets/suppliers/shanghai-honghuan.jpg',import.meta.url)));
    expect(`sha256:${createHash('sha256').update(logo).digest('hex')}`).toBe(
      'sha256:db1ed9e4cddc31f4b6e641bbc9179443e5a5d251a31abe28109c3fa55f32a70f');
    await database.close();
  });

  it('fails closed when off or expired, while read_only permits only GET',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite),store=new PostgresSupplierInquiryCatalogStore(database);
    const off=new SupplierInquiryCatalogService(store,'off','e'.repeat(32),()=>now);
    await expect(off.list({})).rejects.toMatchObject({code:'NOT_FOUND',statusCode:404});
    const readOnly=new SupplierInquiryCatalogService(store,'read_only','e'.repeat(32),()=>now);
    expect((await readOnly.list({limit:50})).items).toHaveLength(11);
    const expired=new SupplierInquiryCatalogService(store,'inquiry','e'.repeat(32),()=>new Date('2026-09-19T04:00:00.000Z'));
    expect(await expired.readiness()).toEqual({mode:'inquiry',ready:false,blockers:['HONGHUAN_REFERENCE_PRICE_EXPIRED']});
    await expect(expired.list({})).rejects.toMatchObject({code:'SUPPLIER_INQUIRY_CATALOG_NOT_READY',statusCode:503,
      details:{blockers:['HONGHUAN_REFERENCE_PRICE_EXPIRED']}});
    await expect(expired.get(canonicalIds[0])).rejects.toMatchObject({code:'SUPPLIER_INQUIRY_CATALOG_NOT_READY',statusCode:503});
    const expiredConfig=loadConfig({...baseEnvironment,HONGHUAN_SUPPLIER_CATALOG_MODE:'inquiry'}),
      app=await buildApp({config:expiredConfig,database,supplierInquiryCatalogService:expired,logger:false}),
      readiness=await app.inject({method:'GET',url:'/mobile/v1/readiness'});
    expect(readiness.statusCode).toBe(503);expect(readiness.json()).toMatchObject({capabilities:{honghuanSupplierCatalog:{
      mode:'inquiry',ready:false,blockers:['HONGHUAN_REFERENCE_PRICE_EXPIRED']}},release:{ready:false}});
    expect(readiness.json().release.blockers).toContain('HONGHUAN_REFERENCE_PRICE_EXPIRED');await app.close();
    expect(loadConfig(baseEnvironment).honghuanSupplierCatalogMode).toBe('off');
    expect(loadConfig({...baseEnvironment,HONGHUAN_SUPPLIER_CATALOG_MODE:'invalid'}).honghuanSupplierCatalogMode).toBe('off');
    await database.close();
  });

  it('rejects formal POST in the same transaction when a twelfth catalog row pollutes readiness',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite),user=randomUUID(),subject=randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'a','A')`,[user]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES($1,'personal','A',$2)`,[subject,user]);
    await database.query(`INSERT INTO supplier_inquiry_catalog_items SELECT
      (jsonb_populate_record(NULL::supplier_inquiry_catalog_items,to_jsonb(i)||jsonb_build_object(
        'id',gen_random_uuid(),'canonical_id','gpu-honghuan-a100-sxm4-80gb-extra'))).*
      FROM supplier_inquiry_catalog_items i WHERE i.canonical_id='gpu-honghuan-a100-sxm4-80gb-1'`);
    const catalog=new SupplierInquiryCatalogService(new PostgresSupplierInquiryCatalogStore(database),'inquiry','e'.repeat(32),()=>now);
    expect(await catalog.readiness()).toMatchObject({ready:false,blockers:['HONGHUAN_SUPPLIER_CATALOG_SEED_11_ITEMS']});
    const access={current:async()=>({subjectId:subject,kind:'personal' as const,displayName:'A',subjectStatus:'active' as const,
      role:'owner' as const,userId:user,permissions:['orders.read','orders.buy'] as const})}as SubjectAccess,
      service=new ResourceInquiryService(new PostgresResourceInquiryStore(database),access,
        loadConfig({...baseEnvironment,HONGHUAN_SUPPLIER_CATALOG_MODE:'inquiry'}),()=>now),
      before=(await database.query<Record<'inquiries'|'terms'|'audits'|'outbox'|'orders'|'accounts'|'transactions'|'entries',string>>(`SELECT
        (SELECT count(*) FROM resource_inquiries)::text inquiries,
        (SELECT count(*) FROM resource_inquiry_terms_acceptances)::text terms,
        (SELECT count(*) FROM audit_events WHERE entity_type='resource_inquiry')::text audits,
        (SELECT count(*) FROM outbox_events WHERE aggregate_type='resource_inquiry')::text outbox,
        (SELECT count(*) FROM orders)::text orders,(SELECT count(*) FROM kai_credit_accounts)::text accounts,
        (SELECT count(*) FROM kai_credit_transactions)::text transactions,(SELECT count(*) FROM kai_credit_entries)::text entries`)).rows[0];
    await expect(service.create({userId:user,sessionId:'a',role:'member'},{supplierResourceId:canonicalIds[0],
      supplierResourceVersion:1,quantity:1,startsAt:'2026-08-25T01:00:00.000Z',endsAt:'2026-08-25T09:00:00.000Z',
      timeZone:'Asia/Shanghai',confirmBy:'2026-08-24T01:00:00.000Z',billingMode:'hourly',allowSubstitutes:false,
      maxCreditAmount:'100.00',useCase:'research',description:'用于已通过数据合规审核的内部科研计算与模型验证任务。',
      environment:'container',network:'private_network',storageGiB:2048,dataRegion:'中国大陆·华东',
      terms:{termsVersion:'2026-08-11',privacyVersion:'2026-08-11',inquiryVersion:'2026-08-18'},
      idempotencyKey:'honghuan-polluted-catalog-0001'},{requestId:'polluted',ip:'127.0.0.1'}))
      .rejects.toMatchObject({code:'SUPPLIER_INQUIRY_CATALOG_NOT_READY',statusCode:503});
    const after=(await database.query<Record<'inquiries'|'terms'|'audits'|'outbox'|'orders'|'accounts'|'transactions'|'entries',string>>(`SELECT
      (SELECT count(*) FROM resource_inquiries)::text inquiries,
      (SELECT count(*) FROM resource_inquiry_terms_acceptances)::text terms,
      (SELECT count(*) FROM audit_events WHERE entity_type='resource_inquiry')::text audits,
      (SELECT count(*) FROM outbox_events WHERE aggregate_type='resource_inquiry')::text outbox,
      (SELECT count(*) FROM orders)::text orders,(SELECT count(*) FROM kai_credit_accounts)::text accounts,
      (SELECT count(*) FROM kai_credit_transactions)::text transactions,(SELECT count(*) FROM kai_credit_entries)::text entries`)).rows[0];
    expect(after).toEqual(before);await database.close();
  });

  it('creates a snapshot-only formal inquiry idempotently without commerce or ledger writes',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite);
    const userA=randomUUID(),userB=randomUUID(),subjectA=randomUUID(),subjectB=randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'a','A'),($2,'b','B')`,[userA,userB]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES
      ($1,'personal','A',$2),($3,'personal','B',$4)`,[subjectA,userA,subjectB,userB]);
    const access={current:async(userId:string)=>({subjectId:userId===userA?subjectA:subjectB,kind:'personal' as const,
      displayName:'test',subjectStatus:'active' as const,role:'owner' as const,userId,
      permissions:['orders.read','orders.buy'] as const})}as SubjectAccess;
    const config=loadConfig({...baseEnvironment,HONGHUAN_SUPPLIER_CATALOG_MODE:'inquiry'}),
      service=new ResourceInquiryService(new PostgresResourceInquiryStore(database),access,config,()=>now);
    const principalA={userId:userA,sessionId:'a',role:'member' as const},principalB={userId:userB,sessionId:'b',role:'member' as const};
    const body={supplierResourceId:'gpu-honghuan-h200-nvl-2',supplierResourceVersion:1,quantity:3,
      startsAt:'2026-08-25T01:00:00.000Z',endsAt:'2026-08-25T09:00:00.000Z',timeZone:'Asia/Shanghai',
      confirmBy:'2026-08-24T01:00:00.000Z',billingMode:'hourly' as const,allowSubstitutes:false,maxCreditAmount:'100.00',
      useCase:'research' as const,description:'用于已通过数据合规审核的内部科研计算与模型验证任务。',environment:'container' as const,
      network:'private_network' as const,storageGiB:2048,dataRegion:'中国大陆·华东',
      terms:{termsVersion:'2026-08-11',privacyVersion:'2026-08-11',inquiryVersion:'2026-08-18'},
      idempotencyKey:'honghuan-formal-create-0001'};
    const counts=()=>database.query<Record<'orders'|'accounts'|'transactions'|'entries',string>>(`SELECT
      (SELECT count(*) FROM orders)::text orders,(SELECT count(*) FROM kai_credit_accounts)::text accounts,
      (SELECT count(*) FROM kai_credit_transactions)::text transactions,(SELECT count(*) FROM kai_credit_entries)::text entries`);
    const before=(await counts()).rows[0];
    const pair=await Promise.all([service.create(principalA,body,{requestId:'a1',ip:'127.0.0.1'}),
      service.create(principalA,body,{requestId:'a2',ip:'127.0.0.1'})]);
    expect(pair.map((item)=>item.replayed).sort()).toEqual([false,true]);expect(new Set(pair.map((item)=>item.inquiry.id)).size).toBe(1);
    const created=pair[0]!.inquiry;expect(created).toMatchObject({candidate:null,status:'submitted',gpuCount:6,requestedQuantity:3,
      billingMode:'hourly',version:1,supplierResource:{resourceId:body.supplierResourceId,version:1,catalogKind:'hourly_gpu',
        legalReviewRequired:false,requestedQuantity:3,supplier:{disclosureStatus:'platform_imported_unverified'},
        referencePrice:{hourlyAmount:'137.72',dailyAmount:'3305.39',monthlyAmount:null},
        source:{verificationStatus:'unverified'}}});
    expect((await counts()).rows[0]).toEqual(before);
    expect((await database.query<{count:string}>(`SELECT count(*)::text count FROM resource_inquiry_terms_acceptances WHERE inquiry_id=$1`,[created.id])).rows[0]?.count).toBe('3');
    expect((await database.query<{count:string}>(`SELECT count(*)::text count FROM audit_events WHERE entity_id=$1`,[created.id])).rows[0]?.count).toBe('1');
    expect((await database.query<{count:string}>(`SELECT count(*)::text count FROM outbox_events WHERE aggregate_id=$1`,[created.id])).rows[0]?.count).toBe('1');
    const snapshots=await database.query<{supplier_snapshot:Record<string,unknown>;resource_snapshot:Record<string,unknown>;
      reference_price_snapshot:Record<string,unknown>;source_snapshot:Record<string,unknown>}>(`SELECT supplier_snapshot,resource_snapshot,
      reference_price_snapshot,source_snapshot FROM resource_inquiries WHERE id=$1`,[created.id]);
    expect(JSON.stringify(snapshots.rows[0])).not.toMatch(/CNY|人民币|evidence:\/\/|multiplier/u);
    await expect(service.get(principalB,created.id)).rejects.toMatchObject({code:'RESOURCE_INQUIRY_NOT_FOUND'});
    const crossSubject=await service.create(principalB,body,{requestId:'b1',ip:'127.0.0.2'});
    expect(crossSubject).toMatchObject({replayed:false,inquiry:{candidate:null,requestedQuantity:3}});
    expect(crossSubject.inquiry.id).not.toBe(created.id);
    const conflictKey='honghuan-formal-conflict-0001';
    await service.create(principalA,{...body,idempotencyKey:conflictKey},{requestId:'c1',ip:'127.0.0.1'});
    await expect(service.create(principalA,{...body,quantity:4,idempotencyKey:conflictKey},{requestId:'c2',ip:'127.0.0.1'}))
      .rejects.toMatchObject({code:'IDEMPOTENCY_KEY_CONFLICT',statusCode:409});
    expect((await counts()).rows[0]).toEqual(before);
    await database.close();
  });

  it('rejects stale versions, billing mismatches and invalid contract quantities without side effects',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite),user=randomUUID(),subject=randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'a','A')`,[user]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES($1,'personal','A',$2)`,[subject,user]);
    const access={current:async()=>({subjectId:subject,kind:'personal' as const,displayName:'A',subjectStatus:'active' as const,
      role:'owner' as const,userId:user,permissions:['orders.read','orders.buy'] as const})}as SubjectAccess;
    const config=loadConfig({...baseEnvironment,HONGHUAN_SUPPLIER_CATALOG_MODE:'inquiry'}),
      service=new ResourceInquiryService(new PostgresResourceInquiryStore(database),access,config,()=>now),
      principal={userId:user,sessionId:'a',role:'member' as const};
    const common={startsAt:'2026-08-25T01:00:00.000Z',endsAt:'2026-08-25T09:00:00.000Z',timeZone:'Asia/Shanghai',
      confirmBy:'2026-08-24T01:00:00.000Z',allowSubstitutes:false,maxCreditAmount:'100.00',useCase:'research' as const,
      description:'用于已通过数据合规审核的内部科研计算与模型验证任务。',environment:'container' as const,
      network:'private_network' as const,storageGiB:2048,dataRegion:'中国大陆·华东',
      terms:{termsVersion:'2026-08-11',privacyVersion:'2026-08-11',inquiryVersion:'2026-08-18'}};
    const before=(await database.query<{inquiries:string;audits:string;outbox:string}>(`SELECT
      (SELECT count(*) FROM resource_inquiries)::text inquiries,
      (SELECT count(*) FROM audit_events WHERE entity_type='resource_inquiry')::text audits,
      (SELECT count(*) FROM outbox_events WHERE aggregate_type='resource_inquiry')::text outbox`)).rows[0];
    await expect(service.create(principal,{...common,supplierResourceId:canonicalIds[0],supplierResourceVersion:2,quantity:1,
      billingMode:'hourly',idempotencyKey:'honghuan-stale-version-0001'},{requestId:'v',ip:'127.0.0.1'}))
      .rejects.toMatchObject({code:'CATALOG_VERSION_CONFLICT',statusCode:409});
    await expect(service.create(principal,{...common,supplierResourceId:canonicalIds[0],supplierResourceVersion:1,quantity:1,
      billingMode:'monthly',idempotencyKey:'honghuan-mode-mismatch-0001'},{requestId:'m',ip:'127.0.0.1'}))
      .rejects.toMatchObject({code:'INQUIRY_BILLING_MODE_UNAVAILABLE',statusCode:409});
    await expect(service.create(principal,{...common,supplierResourceId:'server-honghuan-b300-monthly-32plus',supplierResourceVersion:1,
      quantity:33,billingMode:'monthly',idempotencyKey:'honghuan-contract-quantity-0001'},{requestId:'q',ip:'127.0.0.1'}))
      .rejects.toMatchObject({code:'INQUIRY_QUANTITY_INVALID',statusCode:400});
    const after=(await database.query<{inquiries:string;audits:string;outbox:string}>(`SELECT
      (SELECT count(*) FROM resource_inquiries)::text inquiries,
      (SELECT count(*) FROM audit_events WHERE entity_type='resource_inquiry')::text audits,
      (SELECT count(*) FROM outbox_events WHERE aggregate_type='resource_inquiry')::text outbox`)).rows[0];
    expect(after).toEqual(before);await database.close();
  });

  it('keeps an unverified formal inquiry operator-only and rejects arbitrary approved supplier assignment',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite),buyerUser=randomUUID(),buyerSubject=randomUUID(),
      supplierUser=randomUUID(),supplierSubject=randomUUID(),operatorUser=randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES
      ($1,'a','Buyer','member'),($2,'b','Unrelated supplier','supplier'),($3,'c','Operator','operator')`,
    [buyerUser,supplierUser,operatorUser]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES
      ($1,'personal','Buyer',$2),($3,'organization','Unrelated supplier',$4)`,
    [buyerSubject,buyerUser,supplierSubject,supplierUser]);
    await database.query(`INSERT INTO supplier_profiles(id,created_by_user_id,subject_id,legal_name,credit_code,contact_name,status)
      VALUES(gen_random_uuid(),$1,$2,'Unrelated supplier','CREDIT-UNRELATED','Contact','approved')`,[supplierUser,supplierSubject]);
    const access={current:async(userId:string,permission:string)=>{const supplier=userId===supplierUser,
      permissions=supplier?['orders.read','provider.read','provider.order.manage']:['orders.read','orders.buy'];
      if(!permissions.includes(permission))throw Object.assign(new Error('denied'),{code:'SUBJECT_PERMISSION_DENIED',statusCode:403});
      return{subjectId:supplier?supplierSubject:buyerSubject,kind:supplier?'organization' as const:'personal' as const,
        displayName:'test',subjectStatus:'active' as const,role:'owner' as const,userId,permissions};}}as SubjectAccess,
      service=new ResourceInquiryService(new PostgresResourceInquiryStore(database),access,
        loadConfig({...baseEnvironment,HONGHUAN_SUPPLIER_CATALOG_MODE:'inquiry'}),()=>now),
      buyer={userId:buyerUser,sessionId:'buyer',role:'member' as const},
      supplier={userId:supplierUser,sessionId:'supplier',role:'supplier' as const},
      operator={userId:operatorUser,sessionId:'operator',role:'operator' as const};
    const created=await service.create(buyer,{supplierResourceId:canonicalIds[0],supplierResourceVersion:1,quantity:1,
      startsAt:'2026-08-25T01:00:00.000Z',endsAt:'2026-08-25T09:00:00.000Z',timeZone:'Asia/Shanghai',
      confirmBy:'2026-08-24T01:00:00.000Z',billingMode:'hourly',allowSubstitutes:false,maxCreditAmount:'100.00',
      useCase:'research',description:'用于已通过数据合规审核的内部科研计算与模型验证任务。',environment:'container',
      network:'private_network',storageGiB:2048,dataRegion:'中国大陆·华东',
      terms:{termsVersion:'2026-08-11',privacyVersion:'2026-08-11',inquiryVersion:'2026-08-18'},
      idempotencyKey:'honghuan-operator-only-create-0001'},{requestId:'create',ip:'127.0.0.1'});
    const operatorView=await service.operatorGet(operator,created.inquiry.id);
    expect(operatorView).toMatchObject({status:'submitted',version:1,supplierSubjectId:null,allowedActions:[]});
    await expect(service.assign(operator,created.inquiry.id,{supplierSubjectId:supplierSubject,expectedVersion:1},
      'honghuan-unrelated-assign-0001',{requestId:'assign',ip:'127.0.0.1'}))
      .rejects.toMatchObject({code:'FORMAL_SUPPLIER_ASSIGNMENT_UNAVAILABLE',statusCode:409});
    expect((await service.supplierList(supplier,{})).inquiries).toHaveLength(0);
    await expect(service.supplierGet(supplier,created.inquiry.id)).rejects.toMatchObject({code:'RESOURCE_INQUIRY_NOT_FOUND'});
    await expect(service.supplierAction(supplier,created.inquiry.id,'confirm_capacity',{expectedVersion:1},
      'honghuan-unrelated-progress-0001',{requestId:'progress',ip:'127.0.0.1'}))
      .rejects.toMatchObject({code:'RESOURCE_INQUIRY_NOT_FOUND'});
    expect(await service.get(buyer,created.inquiry.id)).toMatchObject({status:'submitted',version:1,assignment:{status:'unassigned'}});
    expect((await database.query<{count:string}>(`SELECT count(*)::text count FROM resource_inquiry_actions WHERE inquiry_id=$1`,
      [created.inquiry.id])).rows[0]?.count).toBe('0');
    expect((await database.query<{count:string}>(`SELECT count(*)::text count FROM audit_events WHERE entity_id=$1`,
      [created.inquiry.id])).rows[0]?.count).toBe('1');
    expect((await database.query<{count:string}>(`SELECT count(*)::text count FROM outbox_events WHERE aggregate_id=$1`,
      [created.inquiry.id])).rows[0]?.count).toBe('1');await database.close();
  });

  it('registers the exact public routes and rejects mixed legacy/formal POST bodies',{timeout:30000},async()=>{
    const pglite=new PGlite();await migrate(pglite);const database=adapter(pglite),user=randomUUID(),subject=randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'a','A')`,[user]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES($1,'personal','A',$2)`,[subject,user]);
    const config=loadConfig({...baseEnvironment,HONGHUAN_SUPPLIER_CATALOG_MODE:'inquiry'}),
      catalog=new SupplierInquiryCatalogService(new PostgresSupplierInquiryCatalogStore(database),'inquiry','e'.repeat(32),()=>now),
      access={current:async()=>({subjectId:subject,kind:'personal' as const,displayName:'A',subjectStatus:'active' as const,
        role:'owner' as const,userId:user,permissions:['orders.read','orders.buy'] as const})}as SubjectAccess,
      inquiry=new ResourceInquiryService(new PostgresResourceInquiryStore(database),access,config,()=>now),
      accounts={authenticate:async()=>({principal:{userId:user,sessionId:'a',role:'member'},identity:{}})}as unknown as AccountService;
    const app=await buildApp({config,database,accountService:accounts,resourceInquiryService:inquiry,
      supplierInquiryCatalogService:catalog,logger:false});
    const list=await app.inject({method:'GET',url:'/mobile/v1/supplier-inquiry-catalog?kind=contract_monthly&limit=50'});
    expect(list.statusCode).toBe(200);expect(list.json()).toMatchObject({ok:true,items:[{
      resourceId:'server-honghuan-b300-monthly-32plus',version:1,legalReviewRequired:true}]});
    const body={supplierResourceId:canonicalIds[0],supplierResourceVersion:1,quantity:1,
      startsAt:'2026-08-25T01:00:00.000Z',endsAt:'2026-08-25T09:00:00.000Z',timeZone:'Asia/Shanghai',
      confirmBy:'2026-08-24T01:00:00.000Z',billingMode:'hourly',allowSubstitutes:false,maxCreditAmount:'100.00',
      useCase:'research',description:'用于已通过数据合规审核的内部科研计算与模型验证任务。',environment:'container',
      network:'private_network',storageGiB:2048,dataRegion:'中国大陆·华东',
      terms:{termsVersion:'2026-08-11',privacyVersion:'2026-08-11',inquiryVersion:'2026-08-18'}};
    const missingKey=await app.inject({method:'POST',url:'/mobile/v1/resource-inquiries',payload:body});
    expect(missingKey.statusCode).toBe(400);expect(missingKey.json()).toMatchObject({error:{code:'IDEMPOTENCY_KEY_INVALID'}});
    const mixed=await app.inject({method:'POST',url:'/mobile/v1/resource-inquiries',headers:{'idempotency-key':'mixed-formal-legacy-0001'},
      payload:{...body,candidateId:randomUUID(),gpuCount:1}});
    expect(mixed.statusCode).toBe(400);expect(mixed.json()).toMatchObject({error:{code:'VALIDATION_ERROR'}});
    const created=await app.inject({method:'POST',url:'/mobile/v1/resource-inquiries',headers:{'idempotency-key':'formal-route-create-0001'},payload:body});
    expect(created.statusCode).toBe(201);expect(created.json()).toMatchObject({ok:true,replayed:false,
      inquiry:{candidate:null,requestedQuantity:1,supplierResource:{resourceId:canonicalIds[0]}}});
    await app.close();await database.close();
  });
});
