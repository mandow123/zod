import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { qixiangDatabaseGateState, QixiangProductionGate } from '../../dist/topups/qixiang-production-gate.js';
import { fullCommerceStaticFailures, parseEnvironment } from './full-commerce-gate-core.mjs';

const ENV_PATH = '/etc/kai-cloudpay/backend.env';
const GATE_REPORT = '/var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json';
const DROP_IN = '/etc/systemd/system/cloudpay-mobile-backend.service.d/50-commerce-credentials.conf';
const CREDENTIALS = {
  merchant: ['/etc/credstore.encrypted/kai-cloudpay-qixiang-merchant-key','qixiang-merchant-key'],
  retired: ['/etc/credstore.encrypted/kai-cloudpay-qixiang-retired-key','qixiang-retired-key'],
  checkout: ['/etc/credstore.encrypted/kai-cloudpay-qixiang-checkout-key','qixiang-checkout-key'],
  signing: ['/etc/credstore.encrypted/kai-cloudpay-qixiang-gate-signing-private','qixiang-gate-signing-private'],
  public: ['/etc/credstore.encrypted/kai-cloudpay-qixiang-gate-verification-public','qixiang-gate-verification-public'],
};
const values = process.argv.slice(2); const reportIndex = values.indexOf('--report'); const reportValue = values[reportIndex + 1];
if (values.length !== 2 || !reportValue || process.platform !== 'linux' || process.getuid?.() !== 0) {
  process.stderr.write('Usage: sudo node preflight-full-commerce.mjs --report /absolute/create-only-report.json\n');
  process.exit(2);
}
async function secureRead(path, maximum = 4 * 1024 * 1024, rootOwned = true, privateFile = true) {
  const link = await lstat(path);
  if (link.isSymbolicLink() || !link.isFile() || (rootOwned && link.uid !== 0)
    || (privateFile ? (link.mode & 0o077) !== 0 : (link.mode & 0o022) !== 0)
    || link.size < 1 || link.size > maximum) throw new Error('FULL_COMMERCE_FILE_UNSAFE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await handle.stat();
    if (metadata.dev !== link.dev || metadata.ino !== link.ino || metadata.size !== link.size) throw new Error('FULL_COMMERCE_FILE_CHANGED');
    return await handle.readFile();
  } finally { await handle.close(); }
}
const decrypt = async ([path,name]) => {
  await secureRead(path, 64 * 1024);
  return execFileSync('/usr/bin/systemd-creds',['decrypt',`--name=${name}`,path,'-'],{encoding:'buffer',maxBuffer:64*1024,
    env:{PATH:'/usr/bin:/usr/sbin:/bin:/sbin'},stdio:['ignore','pipe','ignore']});
};
const checks=[]; const check=(name,pass,detail)=>checks.push({name,pass,detail});
check('linux_root_operator',true,'root on Linux');
let env={}; let dropIn=''; let releaseManifest; let gateReceipt; const decrypted={};
try {
  env=parseEnvironment((await secureRead(ENV_PATH,256*1024)).toString('utf8'));
  check('full_commerce_static_configuration',fullCommerceStaticFailures(env).length===0,
    fullCommerceStaticFailures(env).join(',')||'exact production settings');
} catch(error) { check('full_commerce_static_configuration',false,error instanceof Error?error.message:'unreadable'); }
try {
  dropIn=(await secureRead(DROP_IN,128*1024,true,false)).toString('utf8');
  const expected=['LoadCredentialEncrypted=qixiang-merchant-key:','LoadCredentialEncrypted=qixiang-checkout-key:',
    'LoadCredentialEncrypted=qixiang-gate-verification-public:','ReadOnlyPaths=/var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json',
    'ExecStartPre=+/usr/bin/node /opt/kai-cloudpay/current/deploy/direct-ubuntu/assert-full-commerce-runtime.mjs'];
  check('systemd_consumes_same_runtime_gate',expected.every((item)=>dropIn.includes(item))&&!dropIn.includes('Environment='),
    'startup assertion plus merchant, checkout, public-key and signed receipt credentials');
} catch(error) { check('systemd_consumes_same_runtime_gate',false,error instanceof Error?error.message:'unreadable'); }
try {
  for(const [name,entry] of Object.entries(CREDENTIALS)) decrypted[name]=await decrypt(entry);
  check('machine_encrypted_commerce_credentials',true,'five host-key encrypted credentials');
} catch(error) { check('machine_encrypted_commerce_credentials',false,error instanceof Error?error.message:'unreadable'); }
try { gateReceipt=(await secureRead(GATE_REPORT,128*1024,true,false)).toString('utf8');
  releaseManifest=await secureRead(join(process.cwd(),'RELEASE-MANIFEST.json'),4*1024*1024,false,false);
  const merchant=decrypted.merchant.toString('utf8').replace(/\n$/u,'');
  const checkoutText=decrypted.checkout.toString('utf8').replace(/\n$/u,''); const checkout=Buffer.from(checkoutText,'base64');
  const publicKey=decrypted.public.toString('utf8').replace(/\n$/u,'');
  const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:1,connectionTimeoutMillis:5_000,
    ssl:env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:false});
  const gate=new QixiangProductionGate({receipt:gateReceipt,verificationPublicKeyPem:publicKey,environment:env,merchantKey:merchant,
    checkoutKey:checkout,releaseManifestSha256:createHash('sha256').update(releaseManifest).digest('hex'),
    databaseStateLoader:()=>qixiangDatabaseGateState((text,values)=>pool.query(text,values))});
  const create=gate.readiness('create'); const refund=gate.readiness('refund');
  let runtimeReady=false;try{await gate.requireStartup();runtimeReady=true;}finally{await pool.end();}
  const receiptPhase=JSON.parse(gateReceipt).phase;
  check('short_lived_signed_runtime_gate',runtimeReady,
    runtimeReady?`${receiptPhase}; expires ${create.expiresAt??refund.expiresAt}`:[...create.blockers,...refund.blockers].join(','));
  checkout.fill(0);
} catch(error) { check('short_lived_signed_runtime_gate',false,error instanceof Error?error.message:'invalid'); }
for(const value of Object.values(decrypted)) value.fill(0);
const failures=checks.filter((item)=>!item.pass);let gatePhase='invalid';try{gatePhase=JSON.parse(gateReceipt??'{}').phase??'invalid';}catch{}
const report={schemaVersion:2,checkedAt:new Date().toISOString(),hostRole:'mobile_full_commerce',gatePhase,
  readyForCanaryStart:failures.length===0&&gatePhase==='bootstrap_canary',
  readyForFullCommerceStart:failures.length===0&&gatePhase==='full_commerce',checks,failures};
const reportPath=resolve(reportValue); await mkdir(dirname(reportPath),{recursive:true,mode:0o700});
await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`,{flag:'wx',mode:0o600});
process.stdout.write(`${failures.length===0?'PASS':'FAIL'} full_commerce_preflight\nReport: ${reportPath}\n`);
if(failures.length)process.exit(1);
