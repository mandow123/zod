import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteHandoff, createManualAdminState, createRevocationAttempt, createRevokeOnlyCandidate,
  prepareProbeRefreshState, refreshKaiProbeTokens, revokeKaiProbeFamily,
  validateLoopbackProbeDatabaseUrl, withExclusiveRotationLock } from '../scripts/kai-probe-credential-core.mjs';
import { parseEnrollmentArguments } from '../scripts/authorize-and-enroll-kai-probe.mjs';

const directories:string[]=[];
afterEach(async()=>Promise.all(directories.splice(0).map((path)=>rm(path,{recursive:true,force:true}))));
const state={schemaVersion:1 as const,refreshToken:'old-refresh-token-1234567890',subject:'kai-user-1'};
const jsonResponse=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

describe('rotating KAI paired readiness credential',()=>{
  it('pins enrollment to the production probe host and accepts no credential argument',()=>{
    const parsed=parseEnrollmentArguments(['--identity-file','/tmp/probe-key']);
    expect(parsed.host).toBe('43.198.97.0');
    expect(parsed.identityFile).toBe('/tmp/probe-key');
    expect(Object.hasOwn(parsed,'remoteScript')).toBe(false);
    expect(()=>parseEnrollmentArguments(['--identity-file','/tmp/probe-key','--host','example.com']))
      .toThrow('KAI_PROBE_ENROLLMENT_TARGET_INVALID');
    expect(()=>parseEnrollmentArguments(['--identity-file','/tmp/probe-key','--refresh-token','secret']))
      .toThrow('KAI_PROBE_ENROLLMENT_ARGUMENT_INVALID');
  });
  it('requires a new refresh token and validates the access/ID pair before returning it',async()=>{
    const verifyPair=vi.fn(async()=>undefined);
    const result=await refreshKaiProbeTokens(state,{fetcher:async(_url,init)=>{
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      return jsonResponse({access_token:'access-token-1234567890',id_token:'id-token-'.padEnd(50,'x'),
        refresh_token:'new-refresh-token-1234567890',token_type:'Bearer',expires_in:300,scope:'openid profile email'});
    },verifyPair});
    expect(result.nextState).toEqual({...state,refreshToken:'new-refresh-token-1234567890'});
    expect(verifyPair).toHaveBeenCalledWith('id-token-'.padEnd(50,'x'),'access-token-1234567890','kai-user-1');
  });

  it('rejects non-rotating, malformed, and rejected refresh responses',async()=>{
    const base={access_token:'access-token-1234567890',id_token:'id-token-'.padEnd(50,'x'),
      refresh_token:state.refreshToken,token_type:'Bearer',expires_in:300,scope:'openid profile email'};
    await expect(refreshKaiProbeTokens(state,{fetcher:async()=>jsonResponse(base),verifyPair:async()=>undefined}))
      .rejects.toThrow('KAI_PROBE_REFRESH_RESPONSE_INVALID');
    await expect(refreshKaiProbeTokens(state,{fetcher:async()=>jsonResponse({error:'invalid_grant'},400)}))
      .rejects.toThrow('KAI_PROBE_REFRESH_INVALID_GRANT');
  });

  it('writes a 0600 handoff atomically and prevents concurrent family rotation',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'kai-probe-'));directories.push(directory);
    const handoff=resolve(directory,'handoff.json'),lock=resolve(directory,'rotation.lock');
    await atomicWriteHandoff(handoff,{schemaVersion:1,nextState:state,probeSucceeded:false});
    expect((await stat(handoff)).mode&0o777).toBe(0o600);
    expect(JSON.parse(await readFile(handoff,'utf8')).nextState).toEqual(state);
    let release!:()=>void;const gate=new Promise<void>((resolveGate)=>{release=resolveGate;});
    let entered!:()=>void;const started=new Promise<void>((resolveStarted)=>{entered=resolveStarted;});
    const first=withExclusiveRotationLock(lock,async()=>{entered();await gate;return 'done';});
    await started;
    await expect(withExclusiveRotationLock(lock,async()=>undefined)).rejects.toThrow('KAI_PROBE_ROTATION_ALREADY_RUNNING');
    release();await expect(first).resolves.toBe('done');
  });

  it('requires an explicit invalid_grant after RFC7009 success before confirming family revocation',async()=>{
    await expect(revokeKaiProbeFamily(state,{fetcher:async()=>{throw new Error('network');}}))
      .rejects.toThrow('KAI_PROBE_REVOCATION_UNCONFIRMED');
    await expect(revokeKaiProbeFamily(state,{fetcher:async()=>new Response('',{status:200})}))
      .rejects.toThrow('KAI_PROBE_REVOCATION_UNCONFIRMED');
    let calls=0;
    await expect(revokeKaiProbeFamily(state,{fetcher:async()=>++calls===1
      ?new Response('',{status:200}):jsonResponse({error:'invalid_grant'},400)})).resolves.toEqual({revoked:true});
    calls=0;
    await expect(revokeKaiProbeFamily(state,{fetcher:async()=>++calls===1?new Response('',{status:200})
      :new Response(JSON.stringify({error:'invalid_grant'}),{status:400,headers:{'content-type':'text/html'}})}))
      .rejects.toThrow('KAI_PROBE_REVOCATION_UNCONFIRMED');
  });

  it('retains the newest refresh state when the post-revocation refresh unexpectedly succeeds',async()=>{
    let calls=0;
    await expect(revokeKaiProbeFamily(state,{fetcher:async()=>++calls===1?new Response('',{status:200}):jsonResponse({
      access_token:'access-token-1234567890',id_token:'id-token-'.padEnd(50,'x'),
      refresh_token:'still-active-refresh-1234567890',token_type:'Bearer',expires_in:300,scope:'openid profile email',
    })})).resolves.toEqual({revoked:false,candidateRefreshToken:'still-active-refresh-1234567890'});
    calls=0;
    await expect(revokeKaiProbeFamily(state,{fetcher:async()=>{calls+=1;if(calls===1)return new Response('',{status:200});throw new Error('network');}}))
      .rejects.toThrow('KAI_PROBE_REVOCATION_UNCONFIRMED');
    calls=0;
    await expect(revokeKaiProbeFamily(state,{fetcher:async()=>++calls===1?new Response('',{status:200}):jsonResponse({
      access_token:'access-token-1234567890',id_token:'id-token-'.padEnd(50,'x'),
      token_type:'Bearer',expires_in:300,scope:'openid profile email',
    })})).rejects.toThrow('KAI_PROBE_REVOCATION_UNCONFIRMED');
    calls=0;
    await expect(revokeKaiProbeFamily(state,{fetcher:async()=>++calls===1?new Response('',{status:200}):jsonResponse({
      access_token:'bad',id_token:'bad',
      refresh_token:'new-refresh-token-1234567890',token_type:'Bearer',expires_in:300,scope:'openid profile email',
    })})).resolves.toEqual({revoked:false,candidateRefreshToken:'new-refresh-token-1234567890'});
  });

  it('persists ambiguity across restart so an old-token invalid_grant can never finalize the family',async()=>{
    const now='2026-08-21T04:00:00.000Z',attempt=createRevocationAttempt(state,'11111111-1111-4111-8111-111111111111',now);
    const manual=createManualAdminState(attempt,'revocation_confirmation_unconfirmed','2026-08-21T04:01:00.000Z');
    expect(manual).toMatchObject({schemaVersion:2,mode:'manual_admin_required',refreshToken:state.refreshToken,
      ambiguousSince:now});
    expect(()=>createRevocationAttempt(manual,'22222222-2222-4222-8222-222222222222','2026-08-21T04:02:00.000Z'))
      .toThrow('KAI_PROBE_REVOCATION_REQUIRES_ADMIN');
    let calls=0;
    await expect(revokeKaiProbeFamily(state,{fetcher:async()=>++calls===1?new Response('',{status:200})
      :jsonResponse({error:'invalid_grant'},400)})).resolves.toEqual({revoked:true});
    expect(manual.mode).toBe('manual_admin_required');
  });

  it('isolates a returned candidate from probe use and can revoke that exact candidate next',async()=>{
    const attempt=createRevocationAttempt(state,'11111111-1111-4111-8111-111111111111','2026-08-21T04:00:00.000Z');
    const candidate=createRevokeOnlyCandidate(attempt,'candidate-refresh-token-1234567890','2026-08-21T04:00:10.000Z');
    expect(candidate).toMatchObject({schemaVersion:2,mode:'revoke_only',refreshToken:'candidate-refresh-token-1234567890'});
    await expect(refreshKaiProbeTokens(candidate)).rejects.toThrow('KAI_PROBE_REFRESH_STATE_INVALID');
    const nextAttempt=createRevocationAttempt(candidate,'22222222-2222-4222-8222-222222222222','2026-08-21T04:01:00.000Z');
    let calls=0;
    await expect(revokeKaiProbeFamily({schemaVersion:1,refreshToken:nextAttempt.refreshToken,subject:nextAttempt.subject},{
      fetcher:async()=>++calls===1?new Response('',{status:200}):jsonResponse({error:'invalid_grant'},400),
    })).resolves.toEqual({revoked:true});
  });

  it('removes a crashed run token pair and consumes only the recovered persisted refresh once',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'kai-probe-recovery-'));directories.push(directory);
    const credential=resolve(directory,'credential.json'),pair=resolve(directory,'ephemeral-token-pair.json');
    const recovered=resolve(directory,'recovered-refresh-state.json');
    const next={...state,refreshToken:'persisted-next-refresh-1234567890'};
    await writeFile(credential,JSON.stringify(state),{mode:0o600});
    await writeFile(pair,JSON.stringify({accessToken:'orphan',idToken:'orphan'}),{mode:0o600});
    await writeFile(recovered,JSON.stringify(next),{mode:0o600});
    await expect(prepareProbeRefreshState(credential,directory)).resolves.toEqual(next);
    await expect(stat(pair)).rejects.toMatchObject({code:'ENOENT'});
    await expect(stat(recovered)).rejects.toMatchObject({code:'ENOENT'});
    await expect(prepareProbeRefreshState(credential,directory)).resolves.toEqual(state);
  });

  it('permits no-TLS probe database access only for the dedicated loopback PostgreSQL database',()=>{
    expect(validateLoopbackProbeDatabaseUrl('postgresql://probe:secret@127.0.0.1:5432/cloudpay')).toContain('127.0.0.1');
    expect(validateLoopbackProbeDatabaseUrl('postgresql://probe:secret@localhost:5432/cloudpay?sslmode=disable')).toContain('localhost');
    expect(()=>validateLoopbackProbeDatabaseUrl('postgresql://probe:secret@10.0.0.8:5432/cloudpay')).toThrow('KAI_PROBE_DATABASE_MUST_BE_LOOPBACK');
    expect(()=>validateLoopbackProbeDatabaseUrl('postgresql://probe:secret@db.example.com:5432/cloudpay?sslmode=require'))
      .toThrow('KAI_PROBE_DATABASE_MUST_BE_LOOPBACK');
  });

  it('keeps access and ID tokens out of env/argv and deletes refresh ciphertext only after remote confirmation',async()=>{
    const root=resolve(import.meta.dirname,'..');
    const [runner,rotator,persist,prepareRevoke,revoke,finalize,service,revokeUnit,enrollHost,authorizeEnroll]=await Promise.all([
      readFile(resolve(root,'scripts/run-inquiry-readiness-systemd.mjs'),'utf8'),
      readFile(resolve(root,'scripts/rotate-kai-probe-credential.mjs'),'utf8'),
      readFile(resolve(root,'scripts/persist-kai-probe-refresh.mjs'),'utf8'),
      readFile(resolve(root,'scripts/prepare-kai-probe-revocation.mjs'),'utf8'),
      readFile(resolve(root,'scripts/revoke-kai-probe-family.mjs'),'utf8'),
      readFile(resolve(root,'scripts/finalize-kai-probe-revocation.mjs'),'utf8'),
      readFile(resolve(root,'deploy/direct-ubuntu/cloudpay-mobile-paired-probe.service'),'utf8'),
      readFile(resolve(root,'deploy/direct-ubuntu/cloudpay-mobile-paired-probe-revoke.service'),'utf8'),
      readFile(resolve(root,'deploy/direct-ubuntu/enroll-probe-refresh-credential.mjs'),'utf8'),
      readFile(resolve(root,'scripts/authorize-and-enroll-kai-probe.mjs'),'utf8'),
    ]);
    expect(runner).not.toContain('process.env.INQUIRY_READINESS_ACCESS_TOKEN');
    expect(runner).toContain('accessToken:pair.accessToken');
    expect(rotator).toContain('refreshKaiProbeTokens(state)');
    expect(rotator).toContain("'ephemeral-token-pair.json'");
    expect(persist).toContain("spawn('/usr/bin/systemd-creds',['encrypt','--with-key=host','--name=kai-refresh-state','-',temporary]");
    expect(persist).toContain('await rename(temporary,target)');
    expect(persist).toContain("phase==='--recover'");
    expect(service).toContain('User=kai-cloudpay-probe');
    expect(service).not.toContain('EnvironmentFile=/etc/kai-cloudpay/backend.env');
    expect(service.indexOf('scripts/rotate-kai-probe-credential.mjs')).toBeLessThan(service.lastIndexOf('scripts/persist-kai-probe-refresh.mjs'));
    expect(service.lastIndexOf('scripts/persist-kai-probe-refresh.mjs')).toBeLessThan(service.indexOf('scripts/run-inquiry-readiness-systemd.mjs'));
    expect(revoke).toContain("withExclusiveRotationLock(resolve(runtimeDirectory,'rotation.lock')");
    expect(revoke).toContain('if(!result.revoked)');
    expect(revoke).toContain("'rotated-refresh-handoff.json'");
    expect(prepareRevoke.indexOf('await persistMachineState(attempt)')).toBeLessThan(prepareRevoke.indexOf('await atomicWriteHandoff(attemptPath,attempt)'));
    expect(prepareRevoke.indexOf("readFile(confirmedPath,'utf8')")).toBeLessThan(prepareRevoke.indexOf('let current;'));
    expect(service).not.toContain('prepare-kai-probe-revocation.mjs');
    expect(revoke.indexOf('await revokeKaiProbeFamily(')).toBeLessThan(revoke.indexOf('await writeFile(confirmedPath'));
    expect(revokeUnit).toContain('ExecStart=/usr/bin/node scripts/revoke-kai-probe-family.mjs');
    expect(revokeUnit).toContain('ExecStartPre=+/usr/bin/node scripts/prepare-kai-probe-revocation.mjs');
    expect(revokeUnit).toContain('ExecStartPost=+/usr/bin/node scripts/finalize-kai-probe-revocation.mjs');
    expect(revokeUnit).toContain('ExecStopPost=+/usr/bin/node scripts/persist-kai-probe-refresh.mjs --commit');
    expect(revokeUnit).toContain('Conflicts=cloudpay-mobile-paired-probe.timer');
    expect(revokeUnit).toContain('cloudpay-mobile-paired-probe.service');
    expect(revokeUnit).toContain('Before=cloudpay-mobile-paired-probe.timer cloudpay-mobile-paired-probe.service');
    expect(revokeUnit).toContain('RuntimeDirectory=kai-cloudpay-probe');
    expect(revokeUnit).toContain('Restart=on-failure');
    expect(revokeUnit).toContain('RestartPreventExitStatus=78');
    expect(prepareRevoke).toContain("writeManualMarker(current)");
    expect(revoke.indexOf("readFile(manualPath,'utf8')")).toBeLessThan(revoke.indexOf('await revokeKaiProbeFamily('));
    expect(revoke.indexOf("readFile(confirmedPath,'utf8')")).toBeLessThan(revoke.indexOf('await revokeKaiProbeFamily('));
    expect(finalize.indexOf("readFile(marker")).toBeLessThan(finalize.indexOf("rm('/etc/credstore.encrypted"));
    expect(finalize).toContain("rm('/etc/credstore.encrypted/kai-cloudpay-inquiry-refresh-state',{force:true})");
    expect(finalize).toContain("'/run/kai-cloudpay-probe/ephemeral-token-pair.json'");
    expect(enrollHost).toContain('for await (const chunk of process.stdin)');
    expect(enrollHost).toContain("'--with-key=host'");
    expect(enrollHost).toContain('KAI_PROBE_REFRESH_CREDENTIAL_ALREADY_EXISTS');
    expect(enrollHost).toContain('KAI_PROBE_SUBJECT_NOT_PREAPPROVED');
    expect(enrollHost).toContain('probe-expected-subject.sha256');
    expect(enrollHost).not.toContain('--locked');
    expect(enrollHost).not.toContain('process.env.');
    expect(authorizeEnroll).toContain("prompt: 'login'");
    expect(authorizeEnroll).toContain('refreshKaiProbeTokens(initial.state)');
    expect(authorizeEnroll).toContain('child.stdin.end(stdin)');
    expect(authorizeEnroll).not.toMatch(/--refresh-token|--access-token|--id-token/u);
    expect(authorizeEnroll).not.toContain('--remote-script');
    expect(authorizeEnroll).toContain('url.port');
  });
});
