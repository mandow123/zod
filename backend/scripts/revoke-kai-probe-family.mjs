import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteHandoff, createManualAdminState, createRevokeOnlyCandidate,
  parseKaiProbeCredentialState, revokeKaiProbeFamily, withExclusiveRotationLock } from './kai-probe-credential-core.mjs';

const runtimeDirectory=resolve(process.env.RUNTIME_DIRECTORY??'');
if(runtimeDirectory!=='/run/kai-cloudpay-probe')throw new Error('KAI_PROBE_REVOKE_DIRECTORIES_REQUIRED');
const confirmedPath=resolve(runtimeDirectory,'remote-revocation-confirmed');
try{
  const confirmed=(await readFile(confirmedPath,'utf8')).trim();
  if(!Number.isFinite(Date.parse(confirmed)))throw new Error('KAI_PROBE_REVOCATION_MARKER_INVALID');
  process.stdout.write(`${JSON.stringify({ok:true,revocationAlreadyConfirmed:true,noNetwork:true})}\n`);process.exit(0);
}catch(error){if(error?.code!=='ENOENT')throw error;}
const manualPath=resolve(runtimeDirectory,'manual-admin-required.json');
try{
  const manual=JSON.parse(await readFile(manualPath,'utf8'));
  if(!manual||manual.schemaVersion!==1||manual.mode!=='manual_admin_required'
    ||typeof manual.attemptId!=='string'||typeof manual.reason!=='string'||!Number.isFinite(Date.parse(manual.ambiguousSince))){
    throw new Error('KAI_PROBE_MANUAL_MARKER_INVALID');
  }
  process.stderr.write('KAI_PROBE_REVOCATION_MANUAL_ADMIN_REQUIRED\n');process.exit(78);
}catch(error){if(error?.code!=='ENOENT')throw error;}
const attemptPath=resolve(runtimeDirectory,'revocation-attempt.json');
const attempt=parseKaiProbeCredentialState(JSON.parse(await readFile(attemptPath,'utf8')));
if(attempt.schemaVersion!==2||attempt.mode!=='attempt_pending')throw new Error('KAI_PROBE_REVOCATION_ATTEMPT_REQUIRED');
await withExclusiveRotationLock(resolve(runtimeDirectory,'rotation.lock'),async()=>{
  let result;
  try{result=await revokeKaiProbeFamily({schemaVersion:1,refreshToken:attempt.refreshToken,subject:attempt.subject});}
  catch{
    const manual=createManualAdminState(attempt,'revocation_confirmation_unconfirmed',new Date().toISOString());
    await atomicWriteHandoff(resolve(runtimeDirectory,'rotated-refresh-handoff.json'),{schemaVersion:1,nextState:manual});
    await rm(attemptPath,{force:true});
    throw new Error('KAI_PROBE_REVOCATION_MANUAL_ADMIN_REQUIRED');
  }
  if(!result.revoked){
    const candidate=createRevokeOnlyCandidate(attempt,result.candidateRefreshToken,new Date().toISOString());
    await atomicWriteHandoff(resolve(runtimeDirectory,'rotated-refresh-handoff.json'),{schemaVersion:1,nextState:candidate});
    await rm(attemptPath,{force:true});
    throw new Error('KAI_PROBE_REVOCATION_STILL_ACTIVE');
  }
  await rm(attemptPath,{force:true});
  await writeFile(confirmedPath,`${new Date().toISOString()}\n`,{flag:'wx',mode:0o600});
});
process.stdout.write(`${JSON.stringify({ok:true,remoteRevocationConfirmed:true})}\n`);
