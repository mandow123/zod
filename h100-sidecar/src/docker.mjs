import { mkdir, realpath, chown, chmod, open, lstat, rename, unlink, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand } from './command.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GPU_UUID = /^GPU-[A-Fa-f0-9-]+$/u;

export class DockerRuntime {
  constructor(config, run = runCommand) { this.config = config; this.run = run; this.quotaProjects = new Map();
    this.quotaInitialized = new Set(); }
  projectId(leaseId) { return projectIdFor(leaseId); }
  async ensureNetwork() {
    const inspected = await this.run('docker', ['network', 'inspect', 'kai-h100-leases'], { allowFailure: true });
    if (inspected.code !== 0) {
      if (!missing(inspected)) throw new Error('DOCKER_NETWORK_INSPECT_FAILED');
      await this.run('docker', ['network', 'create', '--driver', 'bridge', '--internal', '--ipv6=false',
        '--opt', 'com.docker.network.bridge.enable_icc=false', 'kai-h100-leases']);
    }
    const verified = await this.run('docker', ['network', 'inspect', 'kai-h100-leases']);
    const network = JSON.parse(verified.stdout)?.[0];
    if (network?.Driver !== 'bridge' || network?.Internal !== true || network?.EnableIPv6 !== false
      || network?.Options?.['com.docker.network.bridge.enable_icc'] !== 'false') {
      throw new Error('DOCKER_NETWORK_POLICY_MISMATCH');
    }
  }
  async workspace(leaseId) {
    if (!UUID.test(leaseId)) throw new Error('LEASE_ID_INVALID');
    const base = resolve(this.config.workspaceDirectory); await mkdir(base, { recursive: true, mode: 0o711 });
    const baseReal = await realpath(base); const path = join(baseReal, leaseId);
    await mkdir(join(path, '.access'), { recursive: true, mode: 0o700 });
    await mkdir(join(path, 'data'), { recursive: true, mode: 0o700 });
    const resolved = await realpath(path);
    if (!resolved.startsWith(`${baseReal}${sep}`)) throw new Error('WORKSPACE_PATH_ESCAPE');
    const access = await realpath(join(resolved, '.access')); const data = await realpath(join(resolved, 'data'));
    if (access !== join(resolved, '.access') || data !== join(resolved, 'data')) throw new Error('WORKSPACE_SYMLINK_INVALID');
    await chown(resolved, 0, 0); await chmod(resolved, 0o711);
    await chown(access, 0, 0); await chmod(access, 0o700);
    await chown(data, 1000, 1000); await chmod(data, 0o700);
    const authorizedKeys = join(access, 'authorized_keys');
    try {
      const metadata = await lstat(authorizedKeys);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || await realpath(authorizedKeys) !== authorizedKeys) {
        throw new Error('AUTHORIZED_KEYS_FILE_POLICY_INVALID');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const authorized = await open(authorizedKeys, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await authorized.close();
    }
    await chown(authorizedKeys, 0, 0); await chmod(authorizedKeys, 0o600);
    await this.ensureWorkspaceQuota(leaseId, resolved);
    return resolved;
  }
  async ensureWorkspaceQuota(leaseId, workspace) {
    if (this.quotaInitialized.has(leaseId)) return;
    const projectId = projectIdFor(leaseId);
    const owner = this.quotaProjects.get(projectId);
    if (owner && owner !== leaseId) throw new Error('WORKSPACE_QUOTA_PROJECT_COLLISION');
    this.quotaProjects.set(projectId, leaseId);
    const mount = this.config.workspaceQuotaMount;
    if (!/^\/[A-Za-z0-9/_-]+$/u.test(workspace) || !/^\/[A-Za-z0-9/_-]+$/u.test(mount)) {
      throw new Error('WORKSPACE_QUOTA_PATH_INVALID');
    }
    const fs = await this.run('findmnt', ['-n', '-o', 'FSTYPE,OPTIONS', '--target', workspace]);
    if (!/^xfs\s/u.test(fs.stdout.trim()) || !/(?:^|,)(?:pquota|prjquota)(?:,|$)/u.test(fs.stdout.trim().replace(/^xfs\s+/u, ''))) {
      throw new Error('WORKSPACE_XFS_PROJECT_QUOTA_REQUIRED');
    }
    await this.run('xfs_quota', ['-x', '-c', `project -s -p ${workspace} ${projectId}`, mount]);
    await this.run('xfs_quota', ['-x', '-c', `limit -p bsoft=${this.config.workspaceQuotaSize} bhard=${this.config.workspaceQuotaSize} ${projectId}`, mount]);
    this.quotaInitialized.add(leaseId);
  }
  async ensureCapacity(reservations) {
    if (!Number.isInteger(reservations) || reservations < 1 || reservations > this.config.expectedGpuCount) {
      throw new Error('WORKSPACE_RESERVATION_COUNT_INVALID');
    }
    const result = await this.run('df', ['-B1', '--output=size,avail', this.config.workspaceQuotaMount]);
    const values = result.stdout.trim().split(/\s+/u); const available = Number(values.at(-1)); const total = Number(values.at(-2));
    const reserve = Math.max(parseBytes(this.config.hostDiskReserveSize), Math.ceil(total * 0.15));
    const required = reservations * parseBytes(this.config.workspaceQuotaSize) + reserve;
    if (!Number.isSafeInteger(available) || !Number.isSafeInteger(total) || available < required) {
      throw new Error('WORKSPACE_GLOBAL_CAPACITY_UNAVAILABLE');
    }
  }
  async start({ leaseId, orderId, resourceId, gpuUuids, sshPort }) {
    if (!UUID.test(orderId) || !UUID.test(resourceId) || !gpuUuids.length || gpuUuids.some((uuid) => !GPU_UUID.test(uuid))) {
      throw new Error('CONTAINER_INPUT_INVALID');
    }
    if (!Number.isInteger(sshPort) || sshPort < this.config.sshPortStart || sshPort > this.config.sshPortEnd) {
      throw new Error('SSH_PORT_INVALID');
    }
    await this.ensureNetwork(); const workspace = await this.workspace(leaseId); const hostKey = await this.ensureHostKey(workspace);
    const name = `kai-lease-${leaseId}`;
    const prior = await this.inspect(name, true);
    if (prior) {
      this.validateContainer(prior, { leaseId, orderId, resourceId, gpuUuids, sshPort, workspace });
      return { id: prior.Id, name, workspace, quotaProjectId: projectIdFor(leaseId), ...hostKey };
    }
    const args = ['run', '--detach', '--name', name, '--restart', 'on-failure:3',
      '--init', '--ipc', 'none',
      '--label', 'com.kai.managed=h100-sidecar-v1', '--label', `com.kai.lease-id=${leaseId}`,
      '--label', `com.kai.order-id=${orderId}`, '--label', `com.kai.resource-id=${resourceId}`,
      '--gpus', `device=${gpuUuids.join(',')}`, '--network', 'kai-h100-leases', '--read-only',
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'SETGID',
      '--cap-add', 'SETUID', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '4096', '--memory', this.config.containerMemory, '--cpus', this.config.containerCpus,
      '--storage-opt', `size=${this.config.containerStorageSize}`,
      '--ulimit', 'nofile=65536:65536', '--ulimit', 'nproc=8192:8192',
      '--log-driver', 'json-file', '--log-opt', 'max-size=20m', '--log-opt', 'max-file=3',
      '--tmpfs', '/run:rw,noexec,nosuid,nodev,size=64m', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=4g',
      '--mount', `type=bind,src=${join(workspace, 'data')},dst=/workspace/data,rw`,
      '--mount', `type=bind,src=${join(workspace, '.access')},dst=/workspace/.access,ro`,
      '--publish', `${this.config.sshBindHost}:${sshPort}:22`,
      this.config.workloadImage];
    const result = await this.run('docker', args, { timeoutMs: 120_000 });
    const created = await this.inspect(name);
    this.validateContainer(created, { leaseId, orderId, resourceId, gpuUuids, sshPort, workspace });
    return { id: result.stdout.trim(), name, workspace, quotaProjectId: projectIdFor(leaseId), ...hostKey };
  }
  async ensureHostKey(workspace) {
    const access = join(resolve(workspace), '.access');
    if (await realpath(access) !== access) throw new Error('HOST_KEY_DIRECTORY_ESCAPE');
    const privateKey = join(access, 'ssh_host_ed25519_key'); const publicKey = `${privateKey}.pub`;
    try { await lstat(privateKey); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const temporary = join(access, `.host-key-${process.pid}.tmp`);
      await unlink(temporary).catch((failure) => { if (failure?.code !== 'ENOENT') throw failure; });
      await unlink(`${temporary}.pub`).catch((failure) => { if (failure?.code !== 'ENOENT') throw failure; });
      await this.run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'kai-h100-lease-host', '-f', temporary]);
      await rename(temporary, privateKey); await rename(`${temporary}.pub`, publicKey);
    }
    for (const path of [privateKey, publicKey]) {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || await realpath(path) !== path) {
        throw new Error('HOST_KEY_FILE_POLICY_INVALID');
      }
    }
    await chown(privateKey, 0, 0); await chmod(privateKey, 0o600); await chown(publicKey, 0, 0); await chmod(publicKey, 0o644);
    for (const [path, mode] of [[privateKey, 0o600], [publicKey, 0o644]]) {
      const metadata = await lstat(path);
      if (metadata.uid !== 0 || (metadata.mode & 0o777) !== mode) throw new Error('HOST_KEY_FILE_POLICY_INVALID');
    }
    const handle = await open(publicKey, constants.O_RDONLY | constants.O_NOFOLLOW);
    const publicLine = (await handle.readFile('utf8')).trim(); await handle.close();
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/u.test(publicLine)) throw new Error('HOST_KEY_INVALID');
    const fingerprintResult = await this.run('ssh-keygen', ['-l', '-E', 'sha256', '-f', publicKey]);
    const fingerprint = fingerprintResult.stdout.match(/SHA256:[A-Za-z0-9+/]+/u)?.[0];
    if (!fingerprint) throw new Error('HOST_KEY_FINGERPRINT_INVALID');
    return { hostPublicKey: publicLine.split(/\s+/u).slice(0, 2).join(' '), hostKeyFingerprint: fingerprint };
  }
  async verifyGpus(container, expected) {
    const result = await this.run('docker', ['exec', container, 'nvidia-smi', '--query-gpu=uuid,name,driver_version',
      '--format=csv,noheader,nounits'], { timeoutMs: 20_000 });
    const actual = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => line.split(',')[0].trim()).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('CONTAINER_GPU_ATTESTATION_MISMATCH');
    return result.stdout;
  }
  async waitHealthy(container, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const inspected = await this.inspect(container);
      if (!inspected?.State?.Running) throw new Error('CONTAINER_EXITED_BEFORE_HEALTHY');
      if (inspected.State?.Health?.Status === 'healthy') return inspected;
      if (inspected.State?.Health?.Status === 'unhealthy') throw new Error('CONTAINER_UNHEALTHY');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('CONTAINER_HEALTH_TIMEOUT');
  }
  async inspect(container, allowMissing = false) {
    const result = await this.run('docker', ['inspect', container], { allowFailure: allowMissing });
    if (result.code !== 0) return null;
    const value = JSON.parse(result.stdout); return value[0] ?? null;
  }
  async listManaged() {
    const result = await this.run('docker', ['ps', '--all', '--filter', 'label=com.kai.managed=h100-sidecar-v1', '--format', '{{.ID}}']);
    return result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  }
  async stop(container) {
    const result = await this.run('docker', ['stop', '--time', '20', container], { timeoutMs: 45_000, allowFailure: true });
    if (result.code !== 0 && !missing(result)) throw new Error('CONTAINER_STOP_COMMAND_FAILED');
    const inspected = await this.inspect(container, true);
    if (inspected?.State?.Running) throw new Error('CONTAINER_STOP_FAILED');
  }
  async remove(container) {
    const result = await this.run('docker', ['rm', '--force', container], { timeoutMs: 45_000, allowFailure: true });
    if (result.code !== 0 && !missing(result)) throw new Error('CONTAINER_REMOVE_COMMAND_FAILED');
    if (await this.inspect(container, true)) throw new Error('CONTAINER_REMOVE_FAILED');
  }
  async cleanupWorkspace(lease) {
    if (!UUID.test(lease.leaseId) || lease.quotaProjectId !== projectIdFor(lease.leaseId)) throw new Error('WORKSPACE_CLEANUP_IDENTITY_INVALID');
    await this.remove(`kai-lease-${lease.leaseId}`);
    const base = await realpath(resolve(this.config.workspaceDirectory)); const candidate = join(base, lease.leaseId);
    let resolved = null;
    try { resolved = await realpath(candidate); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (resolved) {
      const metadata = await lstat(candidate);
      if (!resolved.startsWith(`${base}${sep}`) || metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('WORKSPACE_CLEANUP_PATH_INVALID');
      }
      await rm(resolved, { recursive: true, force: false, maxRetries: 2 });
    }
    await this.run('xfs_quota', ['-x', '-c', `limit -p bsoft=0 bhard=0 ${lease.quotaProjectId}`,
      this.config.workspaceQuotaMount]);
  }

  validateContainer(container, expected) {
    const labels = container?.Config?.Labels ?? {}; const host = container?.HostConfig ?? {};
    const deviceRequests = host.DeviceRequests ?? [];
    const requested = deviceRequests.filter((request) => request.Driver === 'nvidia')
      .flatMap((request) => request.DeviceIDs ?? []).sort();
    const mounts = container?.Mounts ?? [];
    const workspaceData = mounts.find((mount) => mount.Destination === '/workspace/data');
    const workspaceAccess = mounts.find((mount) => mount.Destination === '/workspace/.access');
    const binding = host.PortBindings?.['22/tcp']?.[0];
    const security = [...(host.SecurityOpt ?? [])].sort(); const dropped = [...(host.CapDrop ?? [])].sort();
    const added = [...(host.CapAdd ?? [])].sort(); const expectedCaps = ['CHOWN', 'DAC_OVERRIDE', 'NET_BIND_SERVICE', 'SETGID', 'SETUID'];
    const tmpfs = host.Tmpfs ?? {};
    const attachedNetworks = Object.keys(container?.NetworkSettings?.Networks ?? {}).sort();
    if (labels['com.kai.managed'] !== 'h100-sidecar-v1' || labels['com.kai.lease-id'] !== expected.leaseId
      || labels['com.kai.order-id'] !== expected.orderId || labels['com.kai.resource-id'] !== expected.resourceId
      || container?.Config?.Image !== this.config.workloadImage
      || deviceRequests.length !== 1 || JSON.stringify(requested) !== JSON.stringify([...expected.gpuUuids].sort())
      || host.NetworkMode !== 'kai-h100-leases' || host.Privileged !== false || host.PidMode !== ''
      || JSON.stringify(attachedNetworks) !== JSON.stringify(['kai-h100-leases'])
      || host.IpcMode !== 'none' || host.ReadonlyRootfs !== true || !dropped.includes('ALL')
      || JSON.stringify(added) !== JSON.stringify(expectedCaps)
      || JSON.stringify(security) !== JSON.stringify(['no-new-privileges:true']) || host.Init !== true
      || (host.Devices ?? []).length !== 0 || (host.Binds ?? []).length !== 0 || host.UsernsMode !== ''
      || mounts.length !== 2
      || workspaceData?.Type !== 'bind' || resolve(workspaceData.Source) !== join(resolve(expected.workspace), 'data')
      || workspaceData.RW !== true || workspaceData.Propagation !== 'rprivate' || workspaceAccess?.Type !== 'bind'
      || resolve(workspaceAccess.Source) !== join(resolve(expected.workspace), '.access') || workspaceAccess.RW !== false
      || workspaceAccess.Propagation !== 'rprivate'
      || binding?.HostIp !== this.config.sshBindHost || Number(binding?.HostPort) !== expected.sshPort
      || Object.keys(host.PortBindings ?? {}).length !== 1 || (host.PortBindings?.['22/tcp'] ?? []).length !== 1
      || host.PidsLimit !== 4096 || host.Memory !== parseBytes(this.config.containerMemory)
      || host.NanoCpus !== Math.round(Number(this.config.containerCpus) * 1_000_000_000)
      || host.RestartPolicy?.Name !== 'on-failure' || host.RestartPolicy?.MaximumRetryCount !== 3
      || Object.keys(tmpfs).sort().join(',') !== '/run,/tmp'
      || !String(tmpfs['/run']).includes('noexec') || !String(tmpfs['/run']).includes('nosuid')
      || !String(tmpfs['/tmp']).includes('noexec') || !String(tmpfs['/tmp']).includes('nosuid')
      || host.StorageOpt?.size !== this.config.containerStorageSize
      || host.LogConfig?.Type !== 'json-file' || host.LogConfig?.Config?.['max-size'] !== '20m'
      || host.LogConfig?.Config?.['max-file'] !== '3') throw new Error('CONTAINER_POLICY_MISMATCH');
  }
}

function missing(result) { return /No such (?:object|container|network)/iu.test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`); }
function projectIdFor(leaseId) {
  return 10_000 + Number.parseInt(createHash('sha256').update(leaseId).digest('hex').slice(0, 7), 16);
}
function parseBytes(value) {
  const match = String(value).match(/^([1-9]\d*)([kKmMgGtT])$/u); if (!match) throw new Error('CONTAINER_MEMORY_INVALID');
  return Number(match[1]) * 1024 ** ({ k: 1, m: 2, g: 3, t: 4 }[match[2].toLowerCase()]);
}
