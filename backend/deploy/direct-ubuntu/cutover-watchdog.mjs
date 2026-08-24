import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { ACCEPTANCE_MODE, acceptanceWatchdogDecision } from './acceptance-watchdog-policy.mjs';

const ACTIVE_CONFIG = '/home/ubuntu/kai-transaction-v1/nginx-kai.conf';
const CONTAINER = 'kai-transaction-edge';
const CONTAINER_CONFIG = '/etc/nginx/nginx.conf';
const savedConfigValue = process.env.CUTOVER_SAVED_NGINX_CONFIG?.trim();
const baselinePath = process.env.CUTOVER_BASELINE_PATH?.trim();
const successReport = process.env.CUTOVER_SUCCESS_REPORT?.trim();
const deadlineValue = process.env.CUTOVER_DEADLINE_PATH?.trim();
const auditDirectory = resolve(process.env.CUTOVER_AUDIT_DIRECTORY?.trim() || '/var/lib/kai-cloudpay-deploy');
if (!savedConfigValue || !resolve(savedConfigValue).startsWith(`${auditDirectory}/`)) throw new Error('CUTOVER_SAVED_CONFIG_PATH_REQUIRED');
const savedConfig = resolve(savedConfigValue);
if (!baselinePath || !resolve(baselinePath).startsWith(`${auditDirectory}/`)
  || !successReport || !resolve(successReport).startsWith(`${auditDirectory}/`)
  || !deadlineValue || !resolve(deadlineValue).startsWith(`${auditDirectory}/`)) throw new Error('CUTOVER_AUDIT_PATHS_REQUIRED');
const deadlinePath = resolve(deadlineValue);
await mkdir(auditDirectory, { recursive: true, mode: 0o700 });
let window;
try { window = JSON.parse(await readFile(deadlinePath, 'utf8')); }
catch {
  const startedAt = new Date();
  window = { schemaVersion: 1, startedAt: startedAt.toISOString(), deadline: new Date(startedAt.getTime() + 10 * 60_000).toISOString() };
  await writeFile(deadlinePath, `${JSON.stringify(window, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
const startedAt = new Date(window.startedAt);
const deadline = new Date(window.deadline);
if (window.schemaVersion !== 1 || !Number.isFinite(startedAt.getTime()) || !Number.isFinite(deadline.getTime())
  || deadline.getTime() - startedAt.getTime() !== 10 * 60_000) throw new Error('CUTOVER_DEADLINE_INVALID');
const savedInfo = await stat(savedConfig);
if (!savedInfo.isFile() || (savedInfo.mode & 0o022) !== 0) throw new Error('CUTOVER_SAVED_CONFIG_INVALID');

async function technicalReportResult() {
  try {
    const info = await stat(resolve(successReport));
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) return null;
    const report = JSON.parse(await readFile(resolve(successReport), 'utf8'));
    const checkedAt = Date.parse(report.checkedAt);
    if (report.schemaVersion !== 1 || !Array.isArray(report.failures)
      || checkedAt < startedAt.getTime() || checkedAt > deadline.getTime()) return null;
    if (report.decision === 'technical_acceptance_passed' && report.failures.length === 0) return 'passed';
    if (report.decision === 'technical_acceptance_failed' && report.failures.length > 0) return 'failed';
    return null;
  } catch { return null; }
}

async function rollback(reason, technicalAcceptanceResult) {
  const savedBytes = await readFile(savedConfig);
  await writeFile(ACTIVE_CONFIG, savedBytes, { mode: 0o644 });
  const hostDigest = createHash('sha256').update(savedBytes).digest('hex');
  const containerBytes = execFileSync('/usr/bin/docker', ['exec', CONTAINER, 'cat', CONTAINER_CONFIG]);
  const containerDigest = createHash('sha256').update(containerBytes).digest('hex');
  if (containerDigest !== hostDigest) throw new Error('ROLLBACK_BIND_MOUNT_NOT_VISIBLE');
  execFileSync('/usr/bin/docker', ['exec', CONTAINER, 'nginx', '-t'], { stdio: 'ignore' });
  execFileSync('/usr/bin/docker', ['exec', CONTAINER, 'nginx', '-s', 'reload'], { stdio: 'ignore' });
  const reportPath = resolve(auditDirectory, `cutover-auto-rollback-${Date.now()}.json`);
  await writeFile(reportPath, `${JSON.stringify({ schemaVersion: 1, rolledBackAt: new Date().toISOString(), reason,
    acceptanceMode: ACCEPTANCE_MODE, technicalAcceptanceResult,
    restoredConfig: ACTIVE_CONFIG, savedConfig, container: CONTAINER, containerConfig: CONTAINER_CONFIG,
    restoredSha256: hostDigest, containerSha256: containerDigest, baselinePath: resolve(baselinePath), deadlinePath,
    preserved: ['legacy service', '43 database', '43 migrations', '43 local backups'],
    unchanged: ['DNS', 'cloud.kai.com'],
    cleanup: {
      probeTestFamily: { required: true, status: 'pending_remote_confirmation', mustNotClaimRevoked: true },
      appSession: { required: true, status: 'pending_device_and_auth_cleanup', mustNotClaimCleared: true },
    },
    probeCredentialRevocationRequiredOn43: true }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stderr.write(`CloudPay cutover automatically rolled back. Report: ${reportPath}\n`);
}

for (;;) {
  const decision = acceptanceWatchdogDecision({
    reportResult: await technicalReportResult(), nowMs: Date.now(), deadlineMs: deadline.getTime(),
  });
  if (decision.action === 'rollback') {
    await rollback(decision.reason, decision.technicalAcceptanceResult);
    process.exit(0);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
}
