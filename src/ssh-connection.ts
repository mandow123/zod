import type { CloudPayFulfillment, CloudPaySshConnection } from './api';

const RESPONSE_FIELDS = [
  'expiresAt', 'host', 'hostKeyFingerprint', 'knownHostsEntry', 'port', 'privateKey', 'protocol', 'username',
];

export function validateSshConnection(
  value: unknown,
  expectedConnection: CloudPayFulfillment['connection'],
  leaseExpiresAt: string | null,
  now = Date.now(),
): CloudPaySshConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== RESPONSE_FIELDS.join(',')) {
    throw new Error('平台返回了无法识别的连接信息，请重新获取。');
  }
  const record = value as Record<string, unknown>;
  const expiresAt = typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) : Number.NaN;
  const leaseExpiry = leaseExpiresAt ? Date.parse(leaseExpiresAt) : Number.POSITIVE_INFINITY;
  if (!expectedConnection || expectedConnection.protocol !== 'ssh'
    || record.protocol !== expectedConnection.protocol || record.host !== expectedConnection.host
    || record.port !== expectedConnection.port
    || record.hostKeyFingerprint !== expectedConnection.hostKeyFingerprint
    || record.knownHostsEntry !== expectedConnection.knownHostsEntry
    || record.username !== 'kai' || !validHost(record.host)
    || !Number.isInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65_535
    || !validHostKeyFingerprint(record.hostKeyFingerprint)
    || !validKnownHostsEntry(record.knownHostsEntry, record.host as string, record.port as number)
    || !validOpenSshPrivateKey(record.privateKey) || !Number.isFinite(expiresAt) || expiresAt <= now
    || expiresAt > now + 5 * 60_000
    || (leaseExpiresAt !== null && (!Number.isFinite(leaseExpiry) || expiresAt > leaseExpiry))) {
    throw new Error('平台返回的连接信息没有通过安全检查，请重新获取。');
  }
  return {
    protocol: 'ssh', host: record.host as string, port: record.port as number, username: 'kai',
    privateKey: record.privateKey as string, hostKeyFingerprint: record.hostKeyFingerprint as string,
    knownHostsEntry: record.knownHostsEntry as string, expiresAt: record.expiresAt as string,
  };
}

export function sshCommand(connection: CloudPaySshConnection) {
  return `ssh -i ${privateKeyPath(connection)} -o UserKnownHostsFile=${knownHostsPath(connection)} -o StrictHostKeyChecking=yes -p ${connection.port} ${connection.username}@${connection.host}`;
}

export function knownHostsInstallCommand(connection: CloudPaySshConnection) {
  const path = knownHostsPath(connection);
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' '${connection.knownHostsEntry}' > ${path} && chmod 600 ${path}`;
}

export function privateKeyPath(connection: CloudPaySshConnection) {
  return `~/.ssh/${connectionFileStem(connection)}`;
}

function knownHostsPath(connection: CloudPaySshConnection) {
  return `~/.ssh/${connectionFileStem(connection)}-known_hosts`;
}

function connectionFileStem(connection: CloudPaySshConnection) {
  const serverKey = connection.hostKeyFingerprint.slice('SHA256:'.length).replace(/\+/gu, '-').replace(/\//gu, '_');
  return `kai-cloud-${connection.port}-${serverKey}`;
}

function validHost(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253 || /[\s/@?#:]/u.test(value)) return false;
  if (/^[0-9.]+$/u.test(value)) {
    const parts = value.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) return false;
    return value !== '0.0.0.0' && value !== '255.255.255.255';
  }
  return value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}

function validOpenSshPrivateKey(value: unknown) {
  if (typeof value !== 'string' || value.length < 100 || value.length > 16_384) return false;
  const lines = value.trimEnd().split('\n');
  if (lines[0] !== '-----BEGIN OPENSSH PRIVATE KEY-----'
    || lines.at(-1) !== '-----END OPENSSH PRIVATE KEY-----' || lines.length < 4) return false;
  return lines.slice(1, -1).every((line) => /^[A-Za-z0-9+/=]{1,80}$/u.test(line));
}

function validHostKeyFingerprint(value: unknown) {
  return typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/u.test(value);
}

function validKnownHostsEntry(value: unknown, host: string, port: number) {
  if (typeof value !== 'string' || value.length > 1_024 || value.includes('\n') || value.includes('\r')) return false;
  const prefix = `[${host}]:${port} ssh-ed25519 `;
  return value.startsWith(prefix) && /^[A-Za-z0-9+/]{40,}={0,2}$/u.test(value.slice(prefix.length));
}
