import { readFile, rm } from 'node:fs/promises';
const marker='/run/kai-cloudpay-probe/remote-revocation-confirmed';
const value=(await readFile(marker,'utf8')).trim();
if(!Number.isFinite(Date.parse(value)))throw new Error('KAI_PROBE_REVOCATION_MARKER_INVALID');
await rm('/etc/credstore.encrypted/kai-cloudpay-inquiry-refresh-state',{force:true});
await Promise.all([
  '/run/kai-cloudpay-probe/ephemeral-token-pair.json',
  '/run/kai-cloudpay-probe/recovered-refresh-state.json',
  '/run/kai-cloudpay-probe/rotated-refresh-handoff.json',
  '/run/kai-cloudpay-probe/revocation-attempt.json',
  '/run/kai-cloudpay-probe/manual-admin-required.json',
].map((path)=>rm(path,{force:true})));
