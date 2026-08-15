import { access, lstat, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { loadSidecarConfig } from '../src/config.mjs';
import { runCommand } from '../src/command.mjs';
import { inspectNvidia } from '../src/nvidia.mjs';
import { validateNodeClaim, validateNodeEnrollment } from '../src/node-client.mjs';

const config = loadSidecarConfig(); const checks = [];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Digest = /^sha256:[a-f0-9]{64}$/u;
async function check(name, action) {
  try { const detail = await action(); checks.push({ name, ok: true, ...(detail ? { detail } : {}) }); }
  catch (error) { checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) }); }
}
const bytes = (value) => Number.parseInt(value, 10) * 1024 ** 3;

await check('ubuntu-linux-root', async () => {
  if (os.platform() !== 'linux' || process.getuid?.() !== 0) throw new Error('must run as root on Linux');
  const release = await readFile('/etc/os-release', 'utf8'); if (!/Ubuntu 22\.04/u.test(release)) throw new Error('Ubuntu 22.04 required');
});
await check('required-tools', async () => {
  for (const command of ['docker', 'nvidia-smi', 'nvidia-ctk', 'ssh-keygen', 'xfs_quota', 'findmnt', 'df', 'openssl', 'ss']) {
    await runCommand('sh', ['-c', `command -v ${command}`]);
  }
});
await check('private-listener-address', async () => {
  const addresses = JSON.parse((await runCommand('ip', ['-j', 'address', 'show'])).stdout)
    .flatMap((entry) => entry.addr_info ?? []).map((entry) => entry.local);
  if (!addresses.includes(config.host) || !addresses.includes(config.sshBindHost)) throw new Error('configured private bind IP is not on this host');
});
await check('tls-material', async () => {
  await access(config.tlsCertFile); await access(config.tlsKeyFile);
  const mode = (await stat(config.tlsKeyFile)).mode & 0o777; if ((mode & 0o077) !== 0) throw new Error('TLS private key must not be group/world accessible');
  await runCommand('openssl', ['x509', '-in', config.tlsCertFile, '-noout', '-checkend', '604800']);
  await runCommand('openssl', ['x509', '-in', config.tlsCertFile, '-noout', '-checkhost', new URL(config.publicOrigin).hostname]);
  const certPublic = (await runCommand('openssl', ['x509', '-in', config.tlsCertFile, '-pubkey', '-noout'])).stdout;
  const keyPublic = (await runCommand('openssl', ['pkey', '-in', config.tlsKeyFile, '-pubout'])).stdout;
  if (createHash('sha256').update(certPublic).digest('hex') !== createHash('sha256').update(keyPublic).digest('hex')) {
    throw new Error('TLS certificate and private key do not match');
  }
});
await check('node-enrollment-input', async () => {
  const enrollmentPath = `${config.stateDirectory}/node-enrollment.json`;
  let path = enrollmentPath; let validator = validateNodeEnrollment; let detail = 'durable enrollment';
  try { await access(path); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    path = config.nodeClaimFile; validator = validateNodeClaim; detail = 'one-time claim';
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
    || metadata.uid !== process.getuid?.()) throw new Error('node enrollment input must be a root-owned 0600 regular file');
  const value = validator(JSON.parse(await readFile(path, 'utf8')));
  if (value.expiresAt && Date.now() >= new Date(value.expiresAt).getTime()) throw new Error('node claim expired');
  if (config.backendCaFile) await access(config.backendCaFile);
  return detail;
});
await check('clock-synchronized', async () => {
  const result = await runCommand('timedatectl', ['show', '--property=NTPSynchronized', '--value']);
  if (result.stdout.trim() !== 'yes') throw new Error('NTP is not synchronized');
});
await check('docker-nvidia-runtime', async () => {
  const info = JSON.parse((await runCommand('docker', ['info', '--format', '{{json .}}'])).stdout);
  if (!info.Runtimes?.nvidia) throw new Error('Docker NVIDIA runtime missing');
  await runCommand('nvidia-ctk', ['runtime', 'configure', '--dry-run']);
});
await check('pinned-workload-image', async () => {
  const image = JSON.parse((await runCommand('docker', ['image', 'inspect', config.workloadImage])).stdout)?.[0];
  if (!(image?.RepoDigests ?? []).includes(config.workloadImage)) throw new Error('reviewed immutable RepoDigest is not present locally');
});
await check('gpu-inventory-and-policy', async () => {
  const hardware = await inspectNvidia(); if (hardware.gpus.length !== config.expectedGpuCount) throw new Error('GPU count mismatch');
  const actual = new Set(hardware.gpus.map((gpu) => gpu.uuid));
  if (actual.size !== hardware.gpus.length) throw new Error('duplicate GPU UUID');
  const policies = JSON.parse(await readFile(config.resourcePoliciesFile, 'utf8'));
  for (const [resourceId, policy] of Object.entries(policies)) {
    if (!uuid.test(resourceId) || !uuid.test(policy.bindingId)
      || !Number.isSafeInteger(policy.bindingGeneration) || policy.bindingGeneration < 1
      || !sha256Digest.test(policy.policyDigest) || !uuid.test(policy.nodeId)) {
      throw new Error('resource binding contract is incomplete');
    }
    if (policy.modelPattern !== '^NVIDIA H100' || policy.minimumMemoryMiB < 90_000
      || policy.requiredMigMode !== 'Disabled' || policy.requiredComputeMode !== 'Default') {
      throw new Error('resource policy H100 identity requirements are incomplete');
    }
    for (const uuid of policy.allowedGpuUuids ?? []) {
      const device = hardware.gpus.find((gpu) => gpu.uuid === uuid);
      if (!actual.has(uuid) || !device || !/^NVIDIA H100/u.test(device.model)
        || device.memoryTotalMiB < policy.minimumMemoryMiB || device.migMode !== policy.requiredMigMode
        || device.computeMode !== policy.requiredComputeMode) throw new Error('resource policy GPU mismatch');
    }
  }
  return `${hardware.gpus.length} GPUs`;
});
await check('xfs-project-quota', async () => {
  const mounted = (await runCommand('findmnt', ['-n', '-o', 'FSTYPE,OPTIONS,TARGET', '--target', config.workspaceDirectory])).stdout.trim();
  if (!/^xfs\s/u.test(mounted) || !/(?:pquota|prjquota)/u.test(mounted)) throw new Error('workspace requires existing XFS pquota/prjquota mount');
});
await check('global-disk-budget', async () => {
  const values = (await runCommand('df', ['-B1', '--output=size,avail', config.workspaceQuotaMount])).stdout.trim().split(/\s+/u);
  const total = Number(values.at(-2)); const available = Number(values.at(-1));
  const reserve = Math.max(bytes(config.hostDiskReserveSize), Math.ceil(total * 0.15));
  const required = config.expectedGpuCount * bytes(config.workspaceQuotaSize) + reserve;
  if (!Number.isSafeInteger(available) || available < required) throw new Error(`need ${required} bytes free, found ${available}`);
  return `${available} bytes free`;
});
await check('ports-unused', async () => {
  const sockets = (await runCommand('ss', ['-H', '-lnt'])).stdout;
  if (new RegExp(`:${config.port}\\s`, 'u').test(sockets)) throw new Error(`API port already listening: ${config.port}`);
  let persisted = { leases: {} };
  try { persisted = JSON.parse(await readFile(`${config.stateDirectory}/state.json`, 'utf8')); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (let port = config.sshPortStart; port <= config.sshPortEnd; port += 1) {
    if (!new RegExp(`:${port}\\s`, 'u').test(sockets)) continue;
    const lease = Object.values(persisted.leases ?? {}).find((candidate) => candidate.sshPort === port
      && ['ready', 'running', 'stopping'].includes(candidate.status));
    if (!lease) throw new Error(`unmanaged SSH port already listening: ${port}`);
    const inspected = JSON.parse((await runCommand('docker', ['inspect', `kai-lease-${lease.leaseId}`])).stdout)?.[0];
    const binding = inspected?.HostConfig?.PortBindings?.['22/tcp']?.[0];
    if (inspected?.Config?.Labels?.['com.kai.lease-id'] !== lease.leaseId
      || binding?.HostIp !== config.sshBindHost || Number(binding?.HostPort) !== port) {
      throw new Error(`SSH port is not bound by its persisted managed lease: ${port}`);
    }
  }
});

for (const result of checks) process.stdout.write(`${JSON.stringify(result)}\n`);
if (checks.some((result) => !result.ok)) process.exitCode = 1;
