import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite,type Results,type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { buildApp } from '../src/app.js';
import type { AccountService } from '../src/account/service.js';
import { LEGAL_VERSIONS } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { ResourceInquiryService,SupplierCatalogImportService } from '../src/resource-inquiries/service.js';
import { PostgresResourceInquiryStore,PostgresSupplierImportStore } from '../src/resource-inquiries/store.js';
import type { SubjectAccess } from '../src/subjects/types.js';
import { buildLocalE2EDemoCatalog,buildLocalE2EDeviceProducts,localE2EDemoCatalogDigest } from './local-e2e-demo-catalog.js';

function input(values:string[]){const index=values.indexOf('--file'),file=index>=0?values[index+1]:undefined;if(!file)
  throw new Error('Usage: npm run inquiry:acceptance -- --file <private.xlsx>');return file;}
function pgResult<T>(result:Results<T>){return{...result,rowCount:result.rows.length||result.affectedRows||0,command:'',oid:0,rowAsArray:false};}
function adapter(pglite:PGlite):Database{return{health:async()=>true,schemaReadiness:async()=>({ready:true,expected:null,applied:null,missing:[],mismatched:[]}),
  query:async<Row extends Record<string,unknown>>(text:string,values?:unknown[])=>pgResult(await pglite.query<Row>(text,values)),
  transaction:async<T>(work:(client:PoolClient)=>Promise<T>)=>pglite.transaction(async(transaction:Transaction)=>work({
    query:async(text:string,values?:unknown[])=>pgResult(await transaction.query(text,values))}as unknown as PoolClient)),
  close:()=>pglite.close()}as unknown as Database;}

const file=input(process.argv.slice(2)),port=Number(process.env.INQUIRY_ACCEPTANCE_PORT??4156),origin=`http://127.0.0.1:${port}`;
const config=loadConfig({NODE_ENV:'test',LOCAL_E2E:'true',PUBLIC_ORIGIN:origin,ACCESS_TOKEN_SECRET:'a'.repeat(64),REFRESH_TOKEN_PEPPER:'b'.repeat(32),
  OTP_PEPPER:'c'.repeat(32),AUDIT_PEPPER:'d'.repeat(32),CURSOR_SECRET:'e'.repeat(32),PII_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),
  DATABASE_URL:'postgresql://acceptance/local',SMS_PROVIDER:'aliyun',SMS_ACCESS_KEY_ID:'local',SMS_ACCESS_KEY_SECRET:'local',
  SMS_SIGN_NAME:'KAI',SMS_TEMPLATE_CODE:'SMS_LOCAL',PUSH_PROVIDER:'expo',PUSH_CREDENTIALS_JSON:`{"accessToken":"${'p'.repeat(40)}"}`,
  OBJECT_STORAGE_PROVIDER:'s3',OBJECT_STORAGE_ENDPOINT:'http://127.0.0.1:9000',OBJECT_STORAGE_REGION:'local',
  OBJECT_STORAGE_BUCKET:'acceptance',OBJECT_STORAGE_ACCESS_KEY:'local',OBJECT_STORAGE_SECRET_KEY:'local',CLAMAV_HOST:'127.0.0.1',
  CLAMAV_PORT:'3310',METRICS_BEARER_TOKEN:'m'.repeat(48),BACKUP_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),
  BACKUP_KEY_ID:'acceptance-backup',BACKUP_LOCAL_DIRECTORY:'/tmp/zod-acceptance-backup',BACKUP_S3_ENDPOINT:'http://127.0.0.1:9001',
  BACKUP_S3_REGION:'local',BACKUP_S3_BUCKET:'acceptance-backup',BACKUP_S3_ACCESS_KEY:'local',BACKUP_S3_SECRET_KEY:'local',
  LEGAL_ENTITY_NAME:'KAI Local Acceptance',UNIFIED_SOCIAL_CREDIT_CODE:'913000000000000000',SUPPORT_EMAIL:'support@example.test',
  SUPPORT_PHONE:'4000000000',ICP_FILING:'LOCAL-TEST',ICP_FILING_STATUS:'issued',ICP_FILING_EVIDENCE_REF:'evidence://local/icp',
  APP_FILING:'LOCAL-TEST',APP_FILING_STATUS:'issued',APP_FILING_EVIDENCE_REF:'evidence://local/app',
  INTERNET_SERVICE_CLASSIFICATION_STATUS:'approved_with_legal_evidence',
  INTERNET_SERVICE_CLASSIFICATION_EVIDENCE_REF:'evidence://local/classification',
  TERMS_URL:`${origin}/terms`,PRIVACY_POLICY_URL:`${origin}/privacy`,INQUIRY_TERMS_URL:`${origin}/inquiry-terms`});
const pglite=new PGlite(),database=adapter(pglite);for(const name of ['0001_cloudpay_ledger.sql','0016_trading_subjects.sql','0058_resource_inquiries.sql','0059_resource_inquiry_operations.sql'])
  await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`,import.meta.url)),'utf8'));
const userId='10000000-0000-4000-8000-000000000001',subjectId='10000000-0000-4000-8000-000000000002';
await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'acceptance','询期验收账号')`,[userId]);
await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES($1,'personal','询期验收主体',$2)`,[subjectId,userId]);
const imported=await new SupplierCatalogImportService(new PostgresSupplierImportStore(database),config).commit(file);
const demoCatalog=buildLocalE2EDemoCatalog('local_e2e'),demoDigest=localE2EDemoCatalogDigest(demoCatalog),
  deviceProducts=buildLocalE2EDeviceProducts();
const subjects={current:async()=>({subjectId,kind:'personal' as const,displayName:'询期验收主体',subjectStatus:'active' as const,
  role:'owner' as const,userId,permissions:['orders.read','orders.buy'] as const})}as SubjectAccess;
let latestOtp={phone:'13800000000',code:'246810'},challengeId=randomUUID();
const acceptanceUser={id:userId,displayName:'询期验收账号',phone:'+8613800000000',role:'member' as const,status:'active' as const,
  createdAt:'2026-08-18T00:00:00.000Z'};
const accounts={authenticate:async()=>({principal:{userId,sessionId:'acceptance-session',role:'member' as const},identity:{}}),
  requestOtp:async(input:{phone:string})=>{challengeId=randomUUID();latestOtp={phone:input.phone,code:'246810'};
    return{challengeId,expiresInSeconds:300,resendAfterSeconds:1};},
  verifyOtp:async(input:{phone:string;challengeId:string;code:string})=>{if(input.challengeId!==challengeId||input.code!==latestOtp.code)
    throw new Error('OTP_INVALID');return{kind:'session' as const,accessToken:'acceptance-access-token-'.padEnd(64,'a'),
      refreshToken:'acceptance-refresh-token-'.padEnd(64,'r'),accessExpiresInSeconds:3600,
      refreshExpiresAt:'2026-09-18T00:00:00.000Z',user:acceptanceUser};},
  profile:async()=>acceptanceUser,
  refresh:async()=>({accessToken:'acceptance-access-token-'.padEnd(64,'a'),refreshToken:'acceptance-refresh-token-'.padEnd(64,'r'),
    accessExpiresInSeconds:3600,refreshExpiresAt:'2026-09-18T00:00:00.000Z'}),
  legalDocuments:()=>({terms:{version:LEGAL_VERSIONS.terms,url:`${origin}/terms`},privacy:{version:LEGAL_VERSIONS.privacy,url:`${origin}/privacy`},
    inquiry:{version:LEGAL_VERSIONS.inquiry,url:`${origin}/inquiry-terms`}})}as unknown as AccountService;
const app=await buildApp({config,database,accountService:accounts,
  resourceInquiryService:new ResourceInquiryService(new PostgresResourceInquiryStore(database),subjects,config),logger:false});
app.get('/__e2e/otp',async(request,reply)=>{if(!/^[A-Za-z0-9_-]{43,120}$/u.test(String(request.headers['x-kai-e2e-session']??'')))
  return reply.code(403).send({error:'LOCAL_E2E_SESSION_REQUIRED'});return latestOtp;});
app.get('/__e2e/demo-catalog',async(request,reply)=>{if(!/^[A-Za-z0-9_-]{43,120}$/u.test(String(request.headers['x-kai-e2e-session']??'')))
  return reply.code(403).send({error:'LOCAL_E2E_SESSION_REQUIRED'});return{ok:true,mode:'local_e2e',count:demoCatalog.length,
    digest:demoDigest,generatedAt:new Date().toISOString(),listings:demoCatalog};});
app.get('/mobile/v1/market/resources',async()=>({ok:true,resources:[],nextCursor:null}));
app.get('/mobile/v1/market/listings',async()=>({ok:true,listings:[]}));
app.get('/mobile/v1/device-products',async()=>({ok:true,products:deviceProducts}));
app.get('/mobile/v1/device-products/:productId',async(request,reply)=>{const id=(request.params as{productId:string}).productId,
  product=deviceProducts.find((item)=>item.id===id);return product?{ok:true,product}:reply.code(404).send({ok:false});});
app.get('/mobile/v1/notifications',async()=>({ok:true,notifications:[],unreadCount:0,nextCursor:null}));
app.get('/mobile/v1/subjects',async()=>({ok:true,currentSubjectId:subjectId,subjects:[{id:subjectId,kind:'personal',
  displayName:'询期验收主体',role:'owner',status:'active',selected:true,permissions:['credits.read','orders.read','orders.buy']}]}));
app.get('/mobile/v1/credits/balance',async()=>({ok:true,balance:{subjectId,unit:'KAI_CREDIT',precision:2,available:'0.00',
  reserved:'0.00',supplierReceivable:'0.00',redeemableSupplierEarnings:'0.00',payoutFrozen:'0.00',total:'0.00'}}));
app.get('/mobile/v1/orders',async()=>({ok:true,orders:[],nextCursor:null}));
app.get('/mobile/v1/device-orders',async()=>({ok:true,orders:[]}));
app.get('/mobile/v1/device-assets',async()=>({ok:true,assets:[]}));
app.get('/mobile/v1/credits/payout-profile',async()=>({ok:true,profile:{status:'pending_activation',activatedAt:null}}));
app.get('/mobile/v1/credits/payouts',async()=>({ok:true,payouts:[]}));
app.get('/mobile/v1/provider/bootstrap',async()=>({ok:true,workspace:{mode:'provider',sameAccount:true,requiresRelogin:false,
  subject:{id:subjectId,kind:'personal',displayName:'询期验收主体',role:'owner',status:'active',selected:true,
    permissions:['credits.read','orders.read','orders.buy']},canManage:false,supplier:null,
  resources:{draft:0,awaitingMaterials:0,underReview:0,verified:0,rejected:0,suspended:0,retired:0},
  offers:{draft:0,underReview:0,changesRequested:0,approved:0,rejected:0,suspended:0,expired:0},
  listings:{selling:0,scheduled:0,scheduledPaused:0,paused:0,soldOut:0},resourceActions:[],resume:null,
  nextAction:{key:'complete_supplier_profile',label:'完善供应资料',route:'provider_profile',entityId:null}}}));
await app.listen({host:'0.0.0.0',port});
process.stdout.write(`${JSON.stringify({ready:true,origin,catalog:`${origin}/mobile/v1/inquiry-catalog`,authorization:'Bearer acceptance',
  imported:imported.batch.counts})}\n`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void(async()=>{await app.close();await database.close();process.exit(0);})());
