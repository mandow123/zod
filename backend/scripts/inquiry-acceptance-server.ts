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

function input(values:string[]){const index=values.indexOf('--file'),file=index>=0?values[index+1]:undefined;if(!file)
  throw new Error('Usage: npm run inquiry:acceptance -- --file <private.xlsx>');return file;}
function pgResult<T>(result:Results<T>){return{...result,rowCount:result.rows.length||result.affectedRows||0,command:'',oid:0,rowAsArray:false};}
function adapter(pglite:PGlite):Database{return{health:async()=>true,schemaReadiness:async()=>({ready:true,expected:null,applied:null,missing:[],mismatched:[]}),
  query:async<Row extends Record<string,unknown>>(text:string,values?:unknown[])=>pgResult(await pglite.query<Row>(text,values)),
  transaction:async<T>(work:(client:PoolClient)=>Promise<T>)=>pglite.transaction(async(transaction:Transaction)=>work({
    query:async(text:string,values?:unknown[])=>pgResult(await transaction.query(text,values))}as unknown as PoolClient)),
  close:()=>pglite.close()}as unknown as Database;}

const file=input(process.argv.slice(2)),port=Number(process.env.INQUIRY_ACCEPTANCE_PORT??4156),origin=`http://127.0.0.1:${port}`;
const config=loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:origin,ACCESS_TOKEN_SECRET:'a'.repeat(64),REFRESH_TOKEN_PEPPER:'b'.repeat(32),
  OTP_PEPPER:'c'.repeat(32),AUDIT_PEPPER:'d'.repeat(32),CURSOR_SECRET:'e'.repeat(32),PII_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),
  TERMS_URL:`${origin}/terms`,PRIVACY_POLICY_URL:`${origin}/privacy`,INQUIRY_TERMS_URL:`${origin}/inquiry-terms`});
const pglite=new PGlite(),database=adapter(pglite);for(const name of ['0001_cloudpay_ledger.sql','0016_trading_subjects.sql','0058_resource_inquiries.sql','0059_resource_inquiry_operations.sql'])
  await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`,import.meta.url)),'utf8'));
const userId='10000000-0000-4000-8000-000000000001',subjectId='10000000-0000-4000-8000-000000000002';
await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'acceptance','询期验收账号')`,[userId]);
await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES($1,'personal','询期验收主体',$2)`,[subjectId,userId]);
const imported=await new SupplierCatalogImportService(new PostgresSupplierImportStore(database),config).commit(file);
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
await app.listen({host:'0.0.0.0',port});
process.stdout.write(`${JSON.stringify({ready:true,origin,catalog:`${origin}/mobile/v1/inquiry-catalog`,authorization:'Bearer acceptance',
  imported:imported.batch.counts})}\n`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void(async()=>{await app.close();await database.close();process.exit(0);})());
