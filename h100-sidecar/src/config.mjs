import { isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';

function required(env, key, minimum = 1) {
  const value = env[key]?.trim();
  if (!value || value.length < minimum) throw new Error(`${key} is required${minimum > 1 ? ` (>=${minimum} chars)` : ''}`);
  return value;
}
function secret(env, key) {
  const value = required(env, key, 32);
  const forbidden = /(?:replace[-_ ]?with|change[-_ ]?me|changeme|placeholder|example|invalid[_-]|your[-_ ]?secret)/iu;
  const periodic = Array.from({ length: Math.min(8, Math.floor(value.length / 2)) }, (_, index) => index + 1)
    .some((size) => value === value.slice(0, size).repeat(value.length / size));
  if (!/^[A-Za-z0-9._~+\/-]+$/u.test(value) || forbidden.test(value) || new Set(value).size < 12 || periodic) {
    throw new Error(`${key} must be a non-placeholder high-entropy secret`);
  }
  return value;
}
function integer(env, key, fallback, minimum, maximum) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${key} must be ${minimum}-${maximum}`);
  return value;
}
function absolute(env, key) {
  const value = required(env, key);
  if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  return resolve(value);
}
function optionalAbsolute(env, key, fallback = null) {
  const value = env[key]?.trim() || fallback;
  if (value === null) return null;
  if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  return resolve(value);
}
function httpsBaseUrl(env, key) {
  const raw = required(env, key); let value;
  try { value = new URL(raw); }
  catch { throw new Error(`${key} must be a valid HTTPS origin`); }
  if (value.protocol !== 'https:' || value.username || value.password || value.search || value.hash || value.pathname !== '/') {
    throw new Error(`${key} must be an HTTPS origin without path, credentials, query, or fragment`);
  }
  return value.toString();
}

export function loadSidecarConfig(env = process.env) {
  const publicOrigin = new URL(required(env, 'SIDECAR_PUBLIC_ORIGIN'));
  if (publicOrigin.protocol !== 'https:') throw new Error('SIDECAR_PUBLIC_ORIGIN must use HTTPS');
  const image = required(env, 'SIDECAR_WORKLOAD_IMAGE');
  if (!/@sha256:[a-f0-9]{64}$/u.test(image)) throw new Error('SIDECAR_WORKLOAD_IMAGE must be pinned by sha256 digest');
  const sshStart = integer(env, 'SIDECAR_SSH_PORT_START', 22000, 1024, 65535);
  const sshEnd = integer(env, 'SIDECAR_SSH_PORT_END', 22099, sshStart, 65535);
  const expectedGpuCount = integer(env, 'SIDECAR_EXPECTED_GPU_COUNT', 8, 1, 1024);
  const defaultGpuCount = integer(env, 'SIDECAR_DEFAULT_GPU_COUNT', 1, 1, expectedGpuCount);
  const sshBindHost = required(env, 'SIDECAR_SSH_BIND_HOST');
  if (isIP(sshBindHost) !== 4 || !isPrivateIpv4(sshBindHost)) {
    throw new Error('SIDECAR_SSH_BIND_HOST must be an RFC1918 IPv4 address');
  }
  const host = required(env, 'SIDECAR_HOST');
  if (isIP(host) !== 4 || !isPrivateIpv4(host)) throw new Error('SIDECAR_HOST must be an RFC1918 IPv4 address');
  const allowedBackendIps = required(env, 'SIDECAR_ALLOWED_BACKEND_IPS').split(',').map((value) => value.trim());
  if (!allowedBackendIps.length || allowedBackendIps.some((value) => isIP(value) !== 4 || !isPrivateIpv4(value))) {
    throw new Error('SIDECAR_ALLOWED_BACKEND_IPS must contain RFC1918 IPv4 addresses');
  }
  const workspaceDirectory = absolute(env, 'SIDECAR_WORKSPACE_DIRECTORY');
  const workspaceQuotaMount = absolute(env, 'SIDECAR_WORKSPACE_QUOTA_MOUNT');
  if (!workspaceDirectory.startsWith(`${workspaceQuotaMount}/`)) {
    throw new Error('SIDECAR_WORKSPACE_DIRECTORY must be inside SIDECAR_WORKSPACE_QUOTA_MOUNT');
  }
  const workspaceQuotaSize = required(env, 'SIDECAR_WORKSPACE_QUOTA_SIZE');
  if (!/^[1-9]\d{0,5}[gG]$/u.test(workspaceQuotaSize)) throw new Error('SIDECAR_WORKSPACE_QUOTA_SIZE must use whole gigabytes');
  const hostDiskReserveSize = required(env, 'SIDECAR_HOST_DISK_RESERVE_SIZE');
  if (!/^[1-9]\d{0,5}[gG]$/u.test(hostDiskReserveSize)) throw new Error('SIDECAR_HOST_DISK_RESERVE_SIZE must use whole gigabytes');
  if (Number.parseInt(hostDiskReserveSize, 10) < 500) throw new Error('SIDECAR_HOST_DISK_RESERVE_SIZE must be at least 500g');
  const providerToken = secret(env, 'SIDECAR_PROVIDER_TOKEN');
  const ticketSecret = secret(env, 'SIDECAR_TICKET_SECRET');
  const previousProviderToken = env.SIDECAR_PROVIDER_TOKEN_PREVIOUS?.trim()
    ? secret(env, 'SIDECAR_PROVIDER_TOKEN_PREVIOUS') : null;
  if (providerToken === ticketSecret || previousProviderToken === providerToken || previousProviderToken === ticketSecret) {
    throw new Error('SIDECAR secrets must be distinct');
  }
  const nodeAgentVersion = env.SIDECAR_NODE_AGENT_VERSION?.trim() || '1.0.0';
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(nodeAgentVersion)) {
    throw new Error('SIDECAR_NODE_AGENT_VERSION is invalid');
  }
  const nodeRetryMinMs = integer(env, 'SIDECAR_NODE_RETRY_MIN_MS', 1_000, 250, 10_000);
  const nodeRetryMaxMs = integer(env, 'SIDECAR_NODE_RETRY_MAX_MS', 30_000, 1_000, 300_000);
  if (nodeRetryMaxMs < nodeRetryMinMs) throw new Error('SIDECAR_NODE_RETRY_MAX_MS must be >= SIDECAR_NODE_RETRY_MIN_MS');
  return Object.freeze({
    host, allowedBackendIps: Object.freeze([...new Set(allowedBackendIps)]),
    port: integer(env, 'SIDECAR_PORT', 9443, 1, 65535),
    publicOrigin: publicOrigin.toString(), tlsCertFile: absolute(env, 'SIDECAR_TLS_CERT_FILE'),
    tlsKeyFile: absolute(env, 'SIDECAR_TLS_KEY_FILE'), stateDirectory: absolute(env, 'SIDECAR_STATE_DIRECTORY'),
    workspaceDirectory, workspaceQuotaMount, workspaceQuotaSize: workspaceQuotaSize.toLowerCase(),
    hostDiskReserveSize: hostDiskReserveSize.toLowerCase(),
    resourcePoliciesFile: absolute(env, 'SIDECAR_RESOURCE_POLICIES_FILE'),
    providerToken, ticketSecret,
    workloadImage: image, expectedGpuCount, defaultGpuCount, sshPublicHost: required(env, 'SIDECAR_SSH_PUBLIC_HOST'),
    sshBindHost,
    previousProviderToken,
    sshPortStart: sshStart, sshPortEnd: sshEnd,
    accessTtlSeconds: integer(env, 'SIDECAR_ACCESS_TTL_SECONDS', 300, 60, 600),
    maxActiveSessionsGlobal: integer(env, 'SIDECAR_MAX_ACTIVE_SESSIONS_GLOBAL', 64, 3, 1_024),
    stateMaxBytes: integer(env, 'SIDECAR_STATE_MAX_BYTES', 1_048_576, 65_536, 16_777_216),
    containerMemory: env.SIDECAR_CONTAINER_MEMORY?.trim() || '240g',
    containerCpus: env.SIDECAR_CONTAINER_CPUS?.trim() || '24',
    containerStorageSize: env.SIDECAR_CONTAINER_STORAGE_SIZE?.trim() || '100g',
    logLevel: env.SIDECAR_LOG_LEVEL?.trim() || 'info',
    backendBaseUrl: httpsBaseUrl(env, 'SIDECAR_BACKEND_BASE_URL'),
    nodeClaimFile: '/var/lib/kai-h100-sidecar/node-claim.json',
    backendCaFile: optionalAbsolute(env, 'SIDECAR_BACKEND_CA_FILE'),
    nodeAgentVersion,
    nodeHeartbeatIntervalMs: integer(env, 'SIDECAR_NODE_HEARTBEAT_INTERVAL_SECONDS', 30, 10, 300) * 1_000,
    backendRequestTimeoutMs: integer(env, 'SIDECAR_BACKEND_REQUEST_TIMEOUT_MS', 10_000, 1_000, 30_000),
    nodeRetryMinMs, nodeRetryMaxMs,
  });
}

function isPrivateIpv4(value) {
  const octets = value.split('.').map(Number);
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}
