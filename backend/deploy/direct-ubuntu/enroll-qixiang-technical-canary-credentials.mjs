import { constants } from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const ITEMS = [
  ['merchant','qixiang-merchant-key','/etc/credstore.encrypted/kai-cloudpay-qixiang-merchant-key'],
  ['checkout','qixiang-checkout-key','/etc/credstore.encrypted/kai-cloudpay-qixiang-checkout-key'],
  ['signing','qixiang-gate-signing-private','/etc/credstore.encrypted/kai-cloudpay-qixiang-gate-signing-private'],
  ['public','qixiang-gate-verification-public','/etc/credstore.encrypted/kai-cloudpay-qixiang-gate-verification-public'],
].map(([name,credentialName,target])=>({name,credentialName,target,candidate:`${target}.next`}));
const JOURNAL='/var/lib/kai-cloudpay-deploy/qixiang-technical-canary-credential-transaction.json';
const JOURNAL_TEMPORARY=`${JOURNAL}.tmp`;
const LOCK='/run/kai-cloudpay-qixiang-technical-canary-enrollment';
const MAX_INPUT_BYTES=8_192;
if(process.platform!=='linux'||process.getuid?.()!==0)throw new Error('QIXIANG_CREDENTIAL_ROOT_LINUX_REQUIRED');

async function fsyncPath(path){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
async function safeFile(path){const link=await lstat(path);if(link.isSymbolicLink()||!link.isFile()||link.uid!==0
  ||(link.mode&0o077)!==0)throw new Error('QIXIANG_CREDENTIAL_FILE_UNSAFE');return link;}
async function digest(path){try{await safeFile(path);const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{return createHash('sha256').update(await handle.readFile()).digest('hex');}finally{await handle.close();}}
  catch(error){if(error?.code==='ENOENT')return null;throw error;}}
async function acquireLock(){try{await mkdir(LOCK,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;
  const info=await lstat(LOCK);if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==0||(info.mode&0o077)!==0)
    throw new Error('QIXIANG_CREDENTIAL_LOCK_UNSAFE');let owner;try{owner=JSON.parse(await readFile(`${LOCK}/owner.json`,'utf8'));}catch{}
  let running=false;if(Number.isInteger(owner?.pid)&&owner.pid>1){try{process.kill(owner.pid,0);running=true;}catch(reason){
    if(reason?.code!=='ESRCH')throw reason;}}if(running)throw new Error('QIXIANG_CREDENTIAL_ENROLLMENT_LOCKED');
  await rm(LOCK,{recursive:true});await mkdir(LOCK,{mode:0o700});}
  const handle=await open(`${LOCK}/owner.json`,'wx',0o600);try{await handle.writeFile(`${JSON.stringify({pid:process.pid,
    at:new Date().toISOString()})}\n`);await handle.sync();}finally{await handle.close();}await fsyncPath(LOCK);}
async function run(binary,args,stdin=Buffer.alloc(0),capture=false){const child=spawn(binary,args,{stdio:['pipe',capture?'pipe':'ignore','ignore'],
  env:{PATH:'/usr/bin:/usr/sbin:/bin:/sbin'}});const output=[];let bytes=0;let stdinError;if(capture)child.stdout.on('data',(chunk)=>{
  bytes+=chunk.length;if(bytes<=MAX_INPUT_BYTES)output.push(chunk);});child.stdin.on('error',(error)=>{stdinError=error;});child.stdin.end(stdin);
  const status=await new Promise((resolveStatus,reject)=>{child.once('error',reject);child.once('close',resolveStatus);});
  if(status!==0||bytes>MAX_INPUT_BYTES||(stdinError&&stdinError.code!=='EPIPE'))throw new Error('QIXIANG_CREDENTIAL_COMMAND_FAILED');
  return Buffer.concat(output);}
async function encrypt(item,value){await rm(item.candidate,{force:true});await run('/usr/bin/systemd-creds',
  ['encrypt','--with-key=host',`--name=${item.credentialName}`,'-',item.candidate],value);await chmod(item.candidate,0o600);
  const info=await safeFile(item.candidate);if(info.size<32)throw new Error('QIXIANG_ENCRYPTED_CREDENTIAL_INVALID');
  await fsyncPath(item.candidate);await fsyncPath(dirname(item.candidate));}
async function decrypt(item,path){return run('/usr/bin/systemd-creds',['decrypt',`--name=${item.credentialName}`,path,'-'],
  Buffer.alloc(0),true);}
function parseJournal(value){if(!value||value.schemaVersion!==1||!Number.isFinite(Date.parse(value.preparedAt))
  ||!/^[a-z0-9][a-z0-9._-]{7,63}$/u.test(value.checkoutKeyId??'')||!/^[0-9a-f]{64}$/u.test(value.merchantKeySha256??'')
  ||!value.credentials||Object.keys(value.credentials).sort().join(',')!==ITEMS.map((item)=>item.name).sort().join(','))
  throw new Error('QIXIANG_CREDENTIAL_JOURNAL_INVALID');for(const item of ITEMS){const entry=value.credentials[item.name];
  if(entry?.target!==item.target||entry?.candidate!==item.candidate||!/^[0-9a-f]{64}$/u.test(entry?.sha256??''))
    throw new Error('QIXIANG_CREDENTIAL_JOURNAL_INVALID');}return value;}
async function writeJournal(value){await mkdir(dirname(JOURNAL),{recursive:true,mode:0o700});await rm(JOURNAL_TEMPORARY,{force:true});
  const handle=await open(JOURNAL_TEMPORARY,'wx',0o600);try{await handle.writeFile(`${JSON.stringify(value,null,2)}\n`);await handle.sync();}
  finally{await handle.close();}await rename(JOURNAL_TEMPORARY,JOURNAL);await fsyncPath(dirname(JOURNAL));}
async function finalize(journal){for(const item of ITEMS){const entry=journal.credentials[item.name];if(await digest(item.target)===entry.sha256)continue;
  if(await digest(item.candidate)!==entry.sha256)throw new Error('QIXIANG_CREDENTIAL_RECOVERY_ARTIFACT_MISSING');await rename(item.candidate,item.target);}
  await fsyncPath(dirname(ITEMS[0].target));await rm(JOURNAL);await fsyncPath(dirname(JOURNAL));}

await acquireLock();
try{let pending;try{pending=parseJournal(JSON.parse(await readFile(JOURNAL,'utf8')));}catch(error){if(error?.code!=='ENOENT')throw error;}
  if(pending){await finalize(pending);process.stdout.write(`${JSON.stringify({ok:true,recovered:true,encryptedWithHostKey:true,
    merchantKeySha256:pending.merchantKeySha256,checkoutKeyId:pending.checkoutKeyId,retiredKeyClaimed:false})}\n`);}
  else{if((await Promise.all(ITEMS.map((item)=>digest(item.target)))).some(Boolean))
    throw new Error('QIXIANG_COMMERCE_CREDENTIAL_ALREADY_EXISTS');const chunks=[];let inputBytes=0;for await(const chunk of process.stdin){
    inputBytes+=chunk.length;if(inputBytes>MAX_INPUT_BYTES)throw new Error('QIXIANG_CREDENTIAL_INPUT_TOO_LARGE');chunks.push(chunk);}
    const input=Buffer.concat(chunks);let request;try{request=JSON.parse(input.toString('utf8'));}finally{input.fill(0);for(const chunk of chunks)chunk.fill(0);}
    const validKey=(value)=>typeof value==='string'&&value.length>=8&&value.length<=4095&&value.trim()===value
      &&!/[\u0000-\u001f\u007f]/u.test(value);if(!request||Object.keys(request).sort().join(',')!=='checkoutKeyId,currentMerchantKey,schemaVersion'
      ||request.schemaVersion!==1||!validKey(request.currentMerchantKey)||!/^[a-z0-9][a-z0-9._-]{7,63}$/u.test(request.checkoutKeyId??''))
      throw new Error('QIXIANG_CREDENTIAL_INPUT_INVALID');const checkout=randomBytes(32).toString('base64');const pair=generateKeyPairSync('ed25519');
    const values={merchant:Buffer.from(`${request.currentMerchantKey}\n`),checkout:Buffer.from(`${checkout}\n`),
      signing:Buffer.from(`${pair.privateKey.export({type:'pkcs8',format:'pem'})}`),
      public:Buffer.from(`${pair.publicKey.export({type:'spki',format:'pem'})}`)};
    try{await mkdir(dirname(ITEMS[0].target),{recursive:true,mode:0o700});for(const item of ITEMS)await encrypt(item,values[item.name]);
      for(const item of ITEMS){const roundTrip=await decrypt(item,item.candidate);try{if(!roundTrip.equals(values[item.name]))
        throw new Error('QIXIANG_CREDENTIAL_ROUND_TRIP_INVALID');}finally{roundTrip.fill(0);}}
      const journal=parseJournal({schemaVersion:1,preparedAt:new Date().toISOString(),checkoutKeyId:request.checkoutKeyId,
        merchantKeySha256:createHash('sha256').update(request.currentMerchantKey).digest('hex'),credentials:Object.fromEntries(
          await Promise.all(ITEMS.map(async(item)=>[item.name,{target:item.target,candidate:item.candidate,sha256:await digest(item.candidate)}])))});
      await writeJournal(journal);await finalize(journal);process.stdout.write(`${JSON.stringify({ok:true,recovered:false,
        encryptedWithHostKey:true,merchantKeySha256:journal.merchantKeySha256,checkoutKeyId:journal.checkoutKeyId,
        retiredKeyClaimed:false})}\n`);
    }finally{for(const value of Object.values(values))value.fill(0);request.currentMerchantKey='';request=null;}}
}finally{await rm(LOCK,{recursive:true,force:true});}
