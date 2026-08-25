import { constants } from 'node:fs';
import { createHash, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import pg from 'pg';
import { canonicalJson, qixiangCredentialFingerprint, qixiangDatabaseGateSnapshot,
  qixiangGateConfigurationDigest } from '../../dist/topups/qixiang-production-gate.js';
import { parseEnvironment } from './full-commerce-gate-core.mjs';
import { isExactActiveQixiangMerchant } from './qixiang-production-evidence-core.mjs';

const ENV_PATH='/etc/kai-cloudpay/backend.env';
const REPORT_PATH='/var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json';
const CREDENTIALS={
  merchant:['/etc/credstore.encrypted/kai-cloudpay-qixiang-merchant-key','qixiang-merchant-key'],
  checkout:['/etc/credstore.encrypted/kai-cloudpay-qixiang-checkout-key','qixiang-checkout-key'],
  signing:['/etc/credstore.encrypted/kai-cloudpay-qixiang-gate-signing-private','qixiang-gate-signing-private'],
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
if(process.platform!=='linux'||process.getuid?.()!==0)throw new Error('QIXIANG_TECHNICAL_CANARY_ROOT_LINUX_REQUIRED');

async function secureRead(path,maximum=4*1024*1024,privateFile=true){const link=await lstat(path);
  if(link.isSymbolicLink()||!link.isFile()||link.uid!==0||(privateFile?(link.mode&0o077)!==0:(link.mode&0o022)!==0)
    ||link.size<1||link.size>maximum)throw new Error('QIXIANG_TECHNICAL_CANARY_FILE_UNSAFE');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const metadata=await handle.stat();
    if(metadata.dev!==link.dev||metadata.ino!==link.ino||metadata.size!==link.size)throw new Error('QIXIANG_TECHNICAL_CANARY_FILE_CHANGED');
    return await handle.readFile();}finally{await handle.close();}}
const decrypt=async([path,name])=>{await secureRead(path,64*1024);return execFileSync('/usr/bin/systemd-creds',
  ['decrypt',`--name=${name}`,path,'-'],{encoding:'buffer',maxBuffer:64*1024,env:{PATH:'/usr/bin:/usr/sbin:/bin:/sbin'},
    stdio:['ignore','pipe','ignore']});};
const sha256=(value)=>createHash('sha256').update(value).digest('hex');
async function currentMerchant(key){const response=await fetch(`https://api.payqixiang.cn/api.php?act=query&pid=4611&key=${encodeURIComponent(key)}`,
  {redirect:'manual',signal:AbortSignal.timeout(10_000),headers:{Accept:'application/json','User-Agent':'KAI-CloudPay/1.0'}});
  if(!response.ok||response.status>=300&&response.status<400)throw new Error('QIXIANG_TECHNICAL_CANARY_PROVIDER_HTTP');
  const contentType=(response.headers.get('content-type')??'').toLowerCase();if(!contentType.startsWith('application/json'))
    throw new Error('QIXIANG_TECHNICAL_CANARY_PROVIDER_CONTENT_TYPE');const raw=await response.text();
  if(Buffer.byteLength(raw,'utf8')>32_768)throw new Error('QIXIANG_TECHNICAL_CANARY_PROVIDER_RESPONSE_SIZE');
  let payload;try{payload=JSON.parse(raw);}catch{throw new Error('QIXIANG_TECHNICAL_CANARY_PROVIDER_JSON');}
  if(!isExactActiveQixiangMerchant(payload,key))throw new Error('QIXIANG_TECHNICAL_CANARY_MERCHANT_INACTIVE');
  return{code:1,pid:'4611',active:1};}

const encrypted={};let merchantKey='';let checkoutText='';let signingKey='';
try{
  const env=parseEnvironment((await secureRead(ENV_PATH,256*1024)).toString('utf8'));
  if(env.NODE_ENV!=='production'||env.MOBILE_API_PROFILE!=='full_commerce'||env.QIXIANG_TECHNICAL_CANARY_MODE!=='on'
    ||env.HOST!=='127.0.0.1'||env.PORT!=='4100'||env.TRUST_PROXY_HOPS!=='1'
    ||env.PUBLIC_ORIGIN!=='https://cloudpay.kai.com'||env.QIXIANG_TOPUP_MODE!=='on'||env.QIXIANG_RECOVERY_MODE!=='on'
    ||env.QIXIANG_PID!=='4611'||env.QIXIANG_APPROVED_MAX_CENTS!=='501'
    ||env.QIXIANG_NOTIFY_URL!=='https://cloudpay.kai.com/mobile/v1/credits/topups/qixiang/notify'
    ||env.QIXIANG_RETURN_URL!=='https://cloudpay.kai.com/payments/qixiang/return'
    ||!UUID.test(env.QIXIANG_TECHNICAL_CANARY_USER_ID??'')||!UUID.test(env.QIXIANG_TECHNICAL_CANARY_SUBJECT_ID??'')
    ||!UUID_V4.test(env.QIXIANG_TECHNICAL_CANARY_TOPUP_ID??''))throw new Error('QIXIANG_TECHNICAL_CANARY_ENV_INVALID');
  for(const[name,entry]of Object.entries(CREDENTIALS))encrypted[name]=await decrypt(entry);
  merchantKey=encrypted.merchant.toString('utf8').replace(/\n$/u,'');
  checkoutText=encrypted.checkout.toString('utf8').replace(/\n$/u,'');
  signingKey=encrypted.signing.toString('utf8');const checkoutKey=Buffer.from(checkoutText,'base64');
  if(checkoutKey.length!==32||checkoutKey.toString('base64')!==checkoutText)throw new Error('QIXIANG_TECHNICAL_CANARY_CHECKOUT_KEY_INVALID');
  const provider=await currentMerchant(merchantKey);const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:1,
    connectionTimeoutMillis:5_000,ssl:env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:false});let snapshot;let principal;let topups;
  try{[snapshot,principal,topups]=await Promise.all([
    qixiangDatabaseGateSnapshot((text,values)=>pool.query(text,values)),
    pool.query(`SELECT u.id user_id,u.status user_status,s.id subject_id,s.status subject_status,s.kind,s.owner_user_id,
      m.role,m.status membership_status,x.subject_id selected_subject_id FROM users u
      JOIN trading_subjects s ON s.id=$2::uuid JOIN subject_memberships m ON m.subject_id=s.id AND m.user_id=u.id
      LEFT JOIN subject_selections x ON x.user_id=u.id WHERE u.id=$1::uuid`,
      [env.QIXIANG_TECHNICAL_CANARY_USER_ID,env.QIXIANG_TECHNICAL_CANARY_SUBJECT_ID]),
    pool.query(`SELECT id,subject_id,created_by_user_id,amount_cents::text,status FROM kai_credit_topups
      WHERE provider='qixiang' ORDER BY created_at,id`),
  ]);}finally{await pool.end();}
  const authorized=principal.rows[0];if(principal.rows.length!==1||authorized?.user_status!=='active'
    ||authorized.subject_status!=='active'||authorized.kind!=='personal'||authorized.owner_user_id!==env.QIXIANG_TECHNICAL_CANARY_USER_ID
    ||authorized.role!=='owner'||authorized.membership_status!=='active'
    ||authorized.selected_subject_id!==env.QIXIANG_TECHNICAL_CANARY_SUBJECT_ID)
    throw new Error('QIXIANG_TECHNICAL_CANARY_PRINCIPAL_INVALID');
  if(topups.rows.some((row)=>row.id!==env.QIXIANG_TECHNICAL_CANARY_TOPUP_ID)
    ||topups.rows.some((row)=>row.subject_id!==env.QIXIANG_TECHNICAL_CANARY_SUBJECT_ID
      ||row.created_by_user_id!==env.QIXIANG_TECHNICAL_CANARY_USER_ID||row.amount_cents!=='501'
      ||!['created','pending','verifying','expired','manual_review'].includes(row.status)))
    throw new Error('QIXIANG_TECHNICAL_CANARY_TOPUP_STATE_INVALID');
  const releaseManifest=await secureRead(join(process.cwd(),'RELEASE-MANIFEST.json'),4*1024*1024,false);
  const issuedAt=new Date();const expiresAt=new Date(issuedAt.getTime()+10*60_000);
  const payload={schemaVersion:2,kind:'qixiang_full_commerce_runtime_gate',phase:'bootstrap_canary',
    issuedAt:issuedAt.toISOString(),expiresAt:expiresAt.toISOString(),configurationSha256:qixiangGateConfigurationDigest(env),
    releaseManifestSha256:sha256(releaseManifest),database:snapshot.state,
    credentials:{merchantSha256:qixiangCredentialFingerprint(merchantKey),checkoutSha256:qixiangCredentialFingerprint(checkoutKey)},
    provider:{pid:'4611',currentKeyActive:true,accountActive:true,retiredKeyRejected:false,
      proofSha256:sha256(canonicalJson({...provider,checkedAt:issuedAt.toISOString()}))},
    approvals:{complianceManifestSha256:'0'.repeat(64),domainAppScene:false,serviceCategory:false,refundApi:false},
    acceptance:{dedicatedProbeSubjectSha256:'0'.repeat(64),appSessionReportSha256:'0'.repeat(64),
      fulfillmentReportSha256:'0'.repeat(64),reconciliationReportSha256:'0'.repeat(64),lotAccountingReportSha256:'0'.repeat(64)},
    canary:{topupId:env.QIXIANG_TECHNICAL_CANARY_TOPUP_ID,userId:env.QIXIANG_TECHNICAL_CANARY_USER_ID,
      subjectId:env.QIXIANG_TECHNICAL_CANARY_SUBJECT_ID,amountCents:501}};
  const signature=sign(null,Buffer.from(canonicalJson(payload)),signingKey).toString('base64');
  const report={...payload,signature:{algorithm:'Ed25519',value:signature}};await mkdir(dirname(REPORT_PATH),{recursive:true,mode:0o755});
  const temporary=`${REPORT_PATH}.${process.pid}.tmp`;await rm(temporary,{force:true});const handle=await open(temporary,'wx',0o644);
  try{await handle.writeFile(`${JSON.stringify(report)}\n`);await handle.sync();}finally{await handle.close();}
  await rename(temporary,REPORT_PATH);const directory=await open(dirname(REPORT_PATH),'r');try{await directory.sync();}finally{await directory.close();}
  checkoutKey.fill(0);process.stdout.write(`PASS qixiang_technical_canary_gate\nExpires: ${expiresAt.toISOString()}\n`);
}finally{for(const bytes of Object.values(encrypted))bytes.fill(0);merchantKey='';checkoutText='';signingKey='';}
