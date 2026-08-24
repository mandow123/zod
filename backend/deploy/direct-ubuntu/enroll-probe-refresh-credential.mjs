import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseRefreshState } from '../../scripts/kai-probe-credential-core.mjs';

const TARGET = '/etc/credstore.encrypted/kai-cloudpay-inquiry-refresh-state';
const CREDENTIAL_NAME = 'kai-refresh-state';
const LOCK = '/run/kai-cloudpay-probe-refresh-enrollment';
const EXPECTED_SUBJECT = '/etc/kai-cloudpay/probe-expected-subject.sha256';
const MAX_INPUT_BYTES = 8_192;

if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('KAI_PROBE_ENROLLMENT_ROOT_LINUX_REQUIRED');
async function acquireLock(){try{await mkdir(LOCK,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;
  const info=await lstat(LOCK);if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==0||(info.mode&0o077)!==0)
    throw new Error('KAI_PROBE_ENROLLMENT_LOCK_UNSAFE');let owner;try{owner=JSON.parse(await readFile(`${LOCK}/owner.json`,'utf8'));}catch{}
  let running=false;if(Number.isInteger(owner?.pid)&&owner.pid>1){try{process.kill(owner.pid,0);running=true;}catch(reason){if(reason?.code!=='ESRCH')throw reason;}}
  if(running)throw new Error('KAI_PROBE_ENROLLMENT_LOCKED');await rm(LOCK,{recursive:true});await mkdir(LOCK,{mode:0o700});}
  const handle=await open(`${LOCK}/owner.json`,'wx',0o600);try{await handle.writeFile(`${JSON.stringify({pid:process.pid})}\n`);await handle.sync();}
  finally{await handle.close();}}

async function runCapture(binary, args, stdin = Buffer.alloc(0)) {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/usr/sbin:/bin:/sbin' } });
  const output = []; let bytes = 0; let stdinError;
  child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes <= MAX_INPUT_BYTES) output.push(chunk); });
  child.stdin.on('error', (error) => { stdinError = error; });
  child.stdin.end(stdin);
  const status = await new Promise((resolveStatus, reject) => { child.once('error', reject); child.once('close', resolveStatus); });
  if (status !== 0 || bytes > MAX_INPUT_BYTES || (stdinError && stdinError.code !== 'EPIPE')) {
    throw new Error('KAI_PROBE_ENROLLMENT_CREDENTIAL_COMMAND_FAILED');
  }
  return Buffer.concat(output);
}

async function targetPresent() {
  try { const info=await lstat(TARGET);if(info.isSymbolicLink()||!info.isFile()||info.uid!==0||(info.mode&0o077)!==0)
    throw new Error('KAI_PROBE_ENROLLMENT_TARGET_UNSAFE');return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function expectedSubjectSha256(){const info=await lstat(EXPECTED_SUBJECT);if(info.isSymbolicLink()||!info.isFile()||info.uid!==0
  ||(info.mode&0o077)!==0||info.size!==65)throw new Error('KAI_PROBE_EXPECTED_SUBJECT_FILE_INVALID');
  const handle=await open(EXPECTED_SUBJECT,constants.O_RDONLY|constants.O_NOFOLLOW);try{const value=(await handle.readFile('utf8')).trim();
    if(!/^[0-9a-f]{64}$/u.test(value))throw new Error('KAI_PROBE_EXPECTED_SUBJECT_FILE_INVALID');return value;}finally{await handle.close();}}

async function decryptAndValidate(path) {
  const plaintext = await runCapture('/usr/bin/systemd-creds', ['decrypt', `--name=${CREDENTIAL_NAME}`, path, '-']);
  try { return parseRefreshState(JSON.parse(plaintext.toString('utf8'))); }
  finally { plaintext.fill(0); }
}

async function syncDirectory(path) {
  const handle = await open(dirname(path), 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

await acquireLock();
try{
if (process.argv.includes('--status')) {
  if (!await targetPresent()) {
    process.stdout.write(`${JSON.stringify({ ok: true, present: false })}\n`);
    await rm(LOCK,{recursive:true,force:true});
    process.exit(0);
  }
  const state = await decryptAndValidate(TARGET);
  const subjectSha256=createHash('sha256').update(state.subject).digest('hex');
  const expectedSubjectMatch=subjectSha256===await expectedSubjectSha256();
  process.stdout.write(`${JSON.stringify({ ok: true, present: true, valid: expectedSubjectMatch, encryptedWithHostKey: true,
    subjectSha256,expectedSubjectMatch })}\n`);
  await rm(LOCK,{recursive:true,force:true});
  process.exit(0);
}

if (!process.argv.includes('--enroll')) throw new Error('KAI_PROBE_ENROLLMENT_MODE_REQUIRED');
if (await targetPresent()) throw new Error('KAI_PROBE_REFRESH_CREDENTIAL_ALREADY_EXISTS');

const chunks = []; let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > MAX_INPUT_BYTES) throw new Error('KAI_PROBE_ENROLLMENT_INPUT_TOO_LARGE');
  chunks.push(chunk);
}
const input = Buffer.concat(chunks);
let state;
try { state = parseRefreshState(JSON.parse(input.toString('utf8'))); }
finally { input.fill(0); for (const chunk of chunks) chunk.fill(0); }
if(createHash('sha256').update(state.subject).digest('hex')!==await expectedSubjectSha256())
  throw new Error('KAI_PROBE_SUBJECT_NOT_PREAPPROVED');

await mkdir(dirname(TARGET), { recursive: true, mode: 0o700 });
const temporary = `${TARGET}.enroll-${process.pid}`;
await rm(temporary, { force: true });
try {
  const serialized = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
  try {
    await runCapture('/usr/bin/systemd-creds', ['encrypt', '--with-key=host', `--name=${CREDENTIAL_NAME}`, '-', temporary], serialized);
  } finally { serialized.fill(0); }
  await chmod(temporary, 0o600);
  const info = await lstat(temporary);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600 || info.size < 32) {
    throw new Error('KAI_PROBE_ENROLLMENT_ENCRYPTED_FILE_INVALID');
  }
  const verified = await decryptAndValidate(temporary);
  if (verified.subject !== state.subject || verified.refreshToken !== state.refreshToken) {
    throw new Error('KAI_PROBE_ENROLLMENT_ROUND_TRIP_INVALID');
  }
  if (await targetPresent()) throw new Error('KAI_PROBE_REFRESH_CREDENTIAL_ALREADY_EXISTS');
  await rename(temporary, TARGET);
  await syncDirectory(TARGET);
} catch (error) {
  await rm(temporary, { force: true });
  throw error;
}

process.stdout.write(`${JSON.stringify({ ok: true, present: true, valid: true, encryptedWithHostKey: true,
  subjectSha256: createHash('sha256').update(state.subject).digest('hex') })}\n`);
}finally{await rm(LOCK,{recursive:true,force:true});}
