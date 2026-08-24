import { randomUUID } from 'node:crypto';
import { chmod, chown, readFile, rename, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { atomicWriteHandoff, createManualAdminState, createRevocationAttempt,
  parseKaiProbeCredentialState } from './kai-probe-credential-core.mjs';

const credentialDirectory=resolve(process.env.CREDENTIALS_DIRECTORY??'');
const runtimeDirectory=resolve(process.env.RUNTIME_DIRECTORY??'');
if(!credentialDirectory.startsWith('/run/credentials/')||runtimeDirectory!=='/run/kai-cloudpay-probe'){
  throw new Error('KAI_PROBE_REVOCATION_PREPARE_DIRECTORIES_REQUIRED');
}
const target='/etc/credstore.encrypted/kai-cloudpay-inquiry-refresh-state';
const recoveredPath=resolve(runtimeDirectory,'recovered-refresh-state.json');
const attemptPath=resolve(runtimeDirectory,'revocation-attempt.json');
const manualPath=resolve(runtimeDirectory,'manual-admin-required.json');
const confirmedPath=resolve(runtimeDirectory,'remote-revocation-confirmed');
try{
  const confirmed=(await readFile(confirmedPath,'utf8')).trim();
  if(!Number.isFinite(Date.parse(confirmed)))throw new Error('KAI_PROBE_REVOCATION_MARKER_INVALID');
  await Promise.all([attemptPath,manualPath,recoveredPath,resolve(runtimeDirectory,'ephemeral-token-pair.json'),
    resolve(runtimeDirectory,'rotated-refresh-handoff.json')].map((path)=>rm(path,{force:true})));
  process.stdout.write(`${JSON.stringify({ok:true,revocationAlreadyConfirmed:true,cleanupIdempotent:true})}\n`);
  process.exit(0);
}catch(error){if(error?.code!=='ENOENT')throw error;}
await Promise.all([attemptPath,manualPath,resolve(runtimeDirectory,'ephemeral-token-pair.json')].map((path)=>rm(path,{force:true})));
let current;
try{current=parseKaiProbeCredentialState(JSON.parse(await readFile(recoveredPath,'utf8')));}
catch(error){
  if(error?.code!=='ENOENT')throw error;
  current=parseKaiProbeCredentialState(JSON.parse(await readFile(resolve(credentialDirectory,'kai-refresh-state'),'utf8')));
}

async function persistMachineState(state){
  const temporary=`${target}.${process.pid}.tmp`;
  const child=spawn('/usr/bin/systemd-creds',['encrypt','--with-key=host','--name=kai-refresh-state','-',temporary],{stdio:['pipe','ignore','pipe']});
  let errorText='';child.stderr.on('data',(chunk)=>{errorText+=chunk.toString('utf8').slice(0,1024);});
  child.stdin.end(`${JSON.stringify(state)}\n`);
  const status=await new Promise((resolveStatus,reject)=>{child.once('error',reject);child.once('close',resolveStatus);});
  if(status!==0){await rm(temporary,{force:true});throw new Error(`KAI_PROBE_REVOCATION_STATE_ENCRYPT_FAILED:${errorText.replace(/[^A-Za-z0-9 _:.\/-]/gu,'').slice(0,160)}`);}
  await chmod(temporary,0o600);await rename(temporary,target);
}

async function writeManualMarker(state){
  await rm(manualPath,{force:true});
  await atomicWriteHandoff(manualPath,{schemaVersion:1,mode:'manual_admin_required',attemptId:state.attemptId,
    reason:state.reason,ambiguousSince:state.ambiguousSince});
  const runtime=await stat(runtimeDirectory);await chown(manualPath,runtime.uid,runtime.gid);
}

if(current.schemaVersion===2&&current.mode==='manual_admin_required'){
  await rm(recoveredPath,{force:true});await writeManualMarker(current);process.exit(0);
}
if(current.schemaVersion===2&&current.mode==='attempt_pending'){
  const manual=createManualAdminState(current,'revocation_attempt_interrupted',new Date().toISOString());
  await persistMachineState(manual);await rm(recoveredPath,{force:true});await writeManualMarker(manual);process.exit(0);
}
const attempt=createRevocationAttempt(current,randomUUID(),new Date().toISOString());
await persistMachineState(attempt);
await rm(recoveredPath,{force:true});
await atomicWriteHandoff(attemptPath,attempt);
const runtime=await stat(runtimeDirectory);await chown(attemptPath,runtime.uid,runtime.gid);
process.stdout.write(`${JSON.stringify({ok:true,revocationAttemptPrepared:true,attemptId:attempt.attemptId})}\n`);
