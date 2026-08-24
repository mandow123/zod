import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteHandoff, prepareProbeRefreshState, refreshKaiProbeTokens, withExclusiveRotationLock } from './kai-probe-credential-core.mjs';

const credentialDirectory=resolve(process.env.CREDENTIALS_DIRECTORY??''),runtimeDirectory=resolve(process.env.RUNTIME_DIRECTORY??'');
if(!credentialDirectory.startsWith('/run/credentials/')||runtimeDirectory!=='/run/kai-cloudpay-probe')throw new Error('KAI_PROBE_SYSTEMD_DIRECTORIES_REQUIRED');
try{await stat(resolve(runtimeDirectory,'remote-revocation-confirmed'));throw new Error('KAI_PROBE_FAMILY_REVOKED');}
catch(error){if(error?.code!=='ENOENT')throw error;}
await withExclusiveRotationLock(resolve(runtimeDirectory,'rotation.lock'),async()=>{
  const state=await prepareProbeRefreshState(resolve(credentialDirectory,'kai-refresh-state'),runtimeDirectory);
  const rotated=await refreshKaiProbeTokens(state);
  await atomicWriteHandoff(resolve(runtimeDirectory,'rotated-refresh-handoff.json'),{schemaVersion:1,nextState:rotated.nextState});
  await atomicWriteHandoff(resolve(runtimeDirectory,'ephemeral-token-pair.json'),{schemaVersion:1,
    accessToken:rotated.accessToken,idToken:rotated.idToken,
    subjectSha256:createHash('sha256').update(state.subject).digest('hex')});
});
process.stdout.write(`${JSON.stringify({ok:true,rotated:true,persisted:false})}\n`);
