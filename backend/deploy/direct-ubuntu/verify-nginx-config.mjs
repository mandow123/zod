import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function blocks(source, headerPattern) {
  const found = [];
  for (const match of source.matchAll(headerPattern)) {
    const start = match.index;
    const open = source.indexOf('{', start);
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = open; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (quote) { if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '{') depth += 1;
      if (char === '}' && --depth === 0) { found.push({ header: match[1]?.trim() ?? '', raw: source.slice(start, index + 1) }); break; }
    }
  }
  return found;
}
function protectedLocations(source) {
  return blocks(source, /^\s*location\s+([^\n{]+)\{/gmu)
    .filter(({ header }) => /^(?:(?:=|\^~)\s+)?\/$/u.test(header) || /^(?:(?:=|\^~)\s+)?\/api(?:\/|\*|$)/u.test(header));
}
function cloudKaiServers(source) {
  return blocks(source, /^\s*(server)\s*\{/gmu).filter(({ raw }) => /\bserver_name\s+[^;]*\bcloud\.kai\.com\b/u.test(raw));
}
const values = process.argv.slice(2);
const value = (flag) => { const index = values.indexOf(flag); return index >= 0 ? values[index + 1] : undefined; };
const beforePath = value('--before');
const candidatePath = value('--candidate');
const reportValue = value('--report');
if (values.length !== 6 || !beforePath || !candidatePath || !reportValue) {
  process.stderr.write('Usage: verify-nginx-config.mjs --before /absolute/nginx-before.txt --candidate /absolute/nginx-candidate.txt --report /absolute/report.json\n');
  process.exit(2);
}
const [before, candidate] = await Promise.all([readFile(resolve(beforePath), 'utf8'), readFile(resolve(candidatePath), 'utf8')]);
const beforeProtected = protectedLocations(before).map(({ raw }) => raw);
const candidateProtected = protectedLocations(candidate).map(({ raw }) => raw);
const beforeCloudKai = cloudKaiServers(before).map(({ raw }) => raw);
const candidateCloudKai = cloudKaiServers(candidate).map(({ raw }) => raw);
const routeBlocks = Object.fromEntries(blocks(candidate, /^\s*location\s+([^\n{]+)\{/gmu).map((item) => [item.header, item.raw]));
const required = ['= /mobile/v1', '= /mobile/v1/credits/topups/qixiang/notify', '^~ /mobile/v1/',
  '= /privacy', '= /terms', '= /inquiry-terms', '= /account/delete'];
const failures = [];
if (JSON.stringify(beforeProtected) !== JSON.stringify(candidateProtected)) failures.push('existing / or /api location bytes changed');
if (JSON.stringify(beforeCloudKai) !== JSON.stringify(candidateCloudKai)) failures.push('cloud.kai.com server bytes changed');
for (const selector of required) {
  const block = routeBlocks[selector];
  if (!block || !block.includes('proxy_pass http://172.31.31.78:4154;')
    || !block.includes('set_real_ip_from 172.31.0.0/16;')
    || !block.includes('real_ip_header X-Forwarded-For;') || !block.includes('real_ip_recursive on;')
    || !block.includes('proxy_set_header Host cloudpay.kai.com;')
    || !block.includes('proxy_set_header X-Forwarded-Host cloudpay.kai.com;')
    || !block.includes('proxy_set_header X-Forwarded-Proto https;')
    || !block.includes('proxy_set_header X-Forwarded-For $remote_addr;')
    || !block.includes('add_header Cache-Control "no-store" always;') || /\brewrite\b/u.test(block)) {
    failures.push(`${selector}: exact proxy contract missing`);
  }
}
const qixiangNotify = routeBlocks['= /mobile/v1/credits/topups/qixiang/notify'];
if (!qixiangNotify || !qixiangNotify.includes('access_log off;') || /\$(?:request_uri|args)\b/u.test(qixiangNotify)) {
  failures.push('qixiang notify: signed callback query logging is not disabled');
}
if (Object.keys(routeBlocks).some((selector) => selector.includes('/internal/metrics'))) failures.push('internal metrics exposed');
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(),
  oldProtectedSha256: sha256(beforeProtected.join('\n')), candidateProtectedSha256: sha256(candidateProtected.join('\n')),
  oldCloudKaiSha256: sha256(beforeCloudKai.join('\n')), candidateCloudKaiSha256: sha256(candidateCloudKai.join('\n')),
  readyForNginxReload: failures.length === 0, requiredLocations: required, failures };
const reportPath = resolve(reportValue);
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${failures.length === 0 ? 'PASS' : 'FAIL'} nginx_exact_route_contract\nReport: ${reportPath}\n`);
if (failures.length > 0) process.exit(1);
