import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args=process.argv.slice(2),reportIndex=args.indexOf('--report'),reportValue=reportIndex>=0?args[reportIndex+1]:undefined;
if(args.length!==2||!reportValue||process.platform!=='linux'||process.getuid?.()!==0){
  process.stderr.write('Usage (root on target Ubuntu): node verify-paired-probe-systemd.mjs --report /absolute/report.json\n');process.exit(2);
}
const deployRoot=resolve(import.meta.dirname),backendRoot=resolve(deployRoot,'../..');
const unit=await readFile(resolve(deployRoot,'cloudpay-mobile-paired-probe-revoke.service'),'utf8');
const revoker=await readFile(resolve(backendRoot,'scripts/revoke-kai-probe-family.mjs'),'utf8');
execFileSync('/usr/bin/systemd-analyze',['verify',resolve(deployRoot,'cloudpay-mobile-paired-probe-revoke.service')],{stdio:'pipe'});
if(!unit.includes('RestartPreventExitStatus=78')
  ||revoker.indexOf("manual-admin-required.json")>revoker.indexOf('await revokeKaiProbeFamily(')){
  throw new Error('PRODUCTION_MANUAL_EXIT_ORDER_INVALID');
}
const name=`kai-cloudpay-restartprevent-acceptance-${process.pid}`;
const directory=`/run/${name}`,wrapper=resolve(directory,'main.mjs'),mainCount=resolve(directory,'main-count'),networkCount=resolve(directory,'network-count');
await mkdir(directory,{mode:0o700});
await writeFile(wrapper,`import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.MAIN_COUNT,'1\\n');\nif(process.env.MANUAL_MODE==='1')process.exit(78);\nappendFileSync(process.env.NETWORK_COUNT,'1\\n');\nawait fetch('https://auth.kai.com/');\n`,{mode:0o600});
let properties={};
try{
  try{
    execFileSync('/usr/bin/systemd-run',['--unit',name,'--property=Type=oneshot','--property=Restart=on-failure',
      '--property=RestartPreventExitStatus=78','--property=IPAddressDeny=any',`--setenv=MAIN_COUNT=${mainCount}`,
      `--setenv=NETWORK_COUNT=${networkCount}`,'--setenv=MANUAL_MODE=1','/usr/bin/node',wrapper],{stdio:'pipe'});
  }catch(error){if(error?.status!==1)throw error;}
  for(let attempt=0;attempt<25;attempt+=1){
    const text=execFileSync('/usr/bin/systemctl',['show',name,'--property=ActiveState,SubState,Result,NRestarts,ExecMainStatus'],{encoding:'utf8'});
    properties=Object.fromEntries(text.trim().split(/\r?\n/u).map((line)=>{const index=line.indexOf('=');return[line.slice(0,index),line.slice(index+1)];}));
    if(properties.ExecMainStatus==='78')break;
    await new Promise((resolveWait)=>setTimeout(resolveWait,200));
  }
  const mainRuns=(await readFile(mainCount,'utf8')).trim().split(/\r?\n/u).filter(Boolean).length;
  let networkRuns=0;try{networkRuns=(await readFile(networkCount,'utf8')).trim().split(/\r?\n/u).filter(Boolean).length;}catch(error){if(error?.code!=='ENOENT')throw error;}
  const pass=properties.ExecMainStatus==='78'&&properties.NRestarts==='0'&&mainRuns===1&&networkRuns===0
    &&['failed','inactive'].includes(properties.ActiveState);
  const report={schemaVersion:1,checkedAt:new Date().toISOString(),target:'ubuntu-systemd',pass,
    productionMainManualCheckPrecedesNetwork:true,properties,mainRuns,networkRuns,networkSandbox:'IPAddressDeny=any'};
  const reportPath=resolve(reportValue);await mkdir(dirname(reportPath),{recursive:true,mode:0o700});
  await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`,{flag:'wx',mode:0o600});
  const info=await stat(reportPath);if((info.mode&0o777)!==0o600)throw new Error('SYSTEMD_ACCEPTANCE_REPORT_PERMISSIONS_INVALID');
  process.stdout.write(`${pass?'PASS':'FAIL'} paired_probe_systemd_manual_exit\nReport: ${reportPath}\n`);
  if(!pass)process.exitCode=1;
}finally{
  try{execFileSync('/usr/bin/systemctl',['reset-failed',name],{stdio:'ignore'});}catch{}
  try{execFileSync('/usr/bin/systemctl',['stop',name],{stdio:'ignore'});}catch{}
  await rm(directory,{recursive:true,force:true});
}
