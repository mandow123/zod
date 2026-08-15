#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import readline from 'node:readline';
import { canReplaceExpiredNodeClaim, validateNodeClaim } from '../src/node-client.mjs';

const target = '/var/lib/kai-h100-sidecar/node-claim.json';
if (process.getuid?.() !== 0) stop('请用 sudo 运行。');

let echoDisabled = false;
function terminalEcho(enabled) {
  if (!process.stdin.isTTY) return;
  const result = spawnSync('/bin/stty', [enabled ? 'echo' : '-echo'], { stdio: ['inherit', 'ignore', 'inherit'] });
  if (result.status !== 0) stop('无法关闭终端回显，未读取认领凭证。');
  echoDisabled = !enabled;
}
function restoreEcho() { if (echoDisabled) { spawnSync('/bin/stty', ['echo'], { stdio: ['inherit', 'ignore', 'inherit'] }); echoDisabled = false; } }
function stop(message) { restoreEcho(); process.stderr.write(`${message}\n`); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { restoreEcho(); process.exit(130); });

if (process.stdin.isTTY) process.stderr.write('请粘贴 KAI 节点认领 JSON，然后按回车（内容不会显示）：');
terminalEcho(false);
const input = await new Promise((resolve) => {
  const reader = readline.createInterface({ input: process.stdin, terminal: false });
  reader.once('line', (line) => { reader.close(); resolve(line); });
  reader.once('close', () => resolve(''));
});
restoreEcho();
if (process.stdin.isTTY) process.stderr.write('\n');

let claim;
try { claim = validateNodeClaim(JSON.parse(input)); }
catch { stop('认领文件格式无效，未写入任何内容。'); }

async function requireSecureExisting(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid()
    || (metadata.mode & 0o777) !== 0o600) throw new Error('INSECURE_EXISTING_FILE');
}

let replaceExpired = false;
try {
  await requireSecureExisting(target);
  const existing = validateNodeClaim(JSON.parse(await readFile(target, 'utf8')));
  if (!canReplaceExpiredNodeClaim(existing, claim)) stop('已有待处理认领文件；不会覆盖，请先检查服务状态。');
  replaceExpired = true;
} catch (error) {
  if (error?.code !== 'ENOENT') stop('已有认领文件不安全、未过期或不属于同一次接入；不会覆盖。');
}

let handle; const temporary = join(dirname(target), `.node-claim-${randomUUID()}.tmp`);
try {
  handle = await open(temporary, 'wx', 0o600);
  await handle.writeFile(`${JSON.stringify(claim)}\n`, 'utf8'); await handle.sync(); await handle.close(); handle = null;
  if (replaceExpired) {
    const pending = join(dirname(target), 'node-claim-request.json');
    try { await requireSecureExisting(pending); await unlink(pending); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rename(temporary, target);
  } else { await link(temporary, target); await unlink(temporary); }
  const directory = await open(dirname(target), 'r'); try { await directory.sync(); } finally { await directory.close(); }
} catch (error) {
  try { await handle?.close(); } catch { /* best effort */ }
  try { await unlink(temporary); } catch { /* best effort */ }
  stop(error?.code === 'EEXIST' ? '已有待处理认领文件；不会覆盖，请先检查服务状态。' : '认领文件写入失败。');
}
const restarted = spawnSync('/bin/systemctl', ['restart', 'kai-h100-sidecar.service'], { stdio: 'inherit' });
if (restarted.status !== 0) stop('认领文件已安全保存，但服务启动失败；请检查服务状态。');
process.stdout.write('认领资料已导入，KAI H100 Sidecar 正在完成节点验证。\n');
