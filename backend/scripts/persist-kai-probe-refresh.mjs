import { chmod, chown, readFile, rename, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { atomicWriteHandoff, parseKaiProbeCredentialState } from './kai-probe-credential-core.mjs';

const handoffPath='/run/kai-cloudpay-probe/rotated-refresh-handoff.json';
const recoveredPath='/run/kai-cloudpay-probe/recovered-refresh-state.json';
const target='/etc/credstore.encrypted/kai-cloudpay-inquiry-refresh-state';
const phase=process.argv[2];
if(!['--recover','--commit'].includes(phase)||process.argv.length!==3)throw new Error('KAI_PROBE_PERSIST_PHASE_REQUIRED');
let handoff;
try { handoff=JSON.parse(await readFile(handoffPath,'utf8')); }
catch(error){if(error?.code==='ENOENT')process.exit(0);throw error;}
if(!handoff||handoff.schemaVersion!==1||Object.keys(handoff).sort().join(',')!=='nextState,schemaVersion')throw new Error('KAI_PROBE_HANDOFF_INVALID');
const nextState=parseKaiProbeCredentialState(handoff.nextState);
const temporary=`${target}.${process.pid}.tmp`;
const child=spawn('/usr/bin/systemd-creds',['encrypt','--with-key=host','--name=kai-refresh-state','-',temporary],{stdio:['pipe','ignore','pipe']});
let errorText='';child.stderr.on('data',(chunk)=>{errorText+=chunk.toString('utf8').slice(0,1024);});
child.stdin.end(`${JSON.stringify(nextState)}\n`);
const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
if(status!==0){await rm(temporary,{force:true});throw new Error(`KAI_PROBE_CREDENTIAL_ENCRYPT_FAILED:${errorText.replace(/[^A-Za-z0-9 _:.\/-]/gu,'').slice(0,160)}`);}
if(phase==='--recover'){
  await rm(recoveredPath,{force:true});
  await atomicWriteHandoff(recoveredPath,nextState);
  const runtime=await stat('/run/kai-cloudpay-probe');
  await chown(recoveredPath,runtime.uid,runtime.gid);
}
await chmod(temporary,0o600);await rename(temporary,target);await rm(handoffPath,{force:true});
