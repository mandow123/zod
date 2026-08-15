import assert from 'node:assert/strict';
import test from 'node:test';
import { knownHostsInstallCommand, privateKeyPath, sshCommand, validateSshConnection } from '../src/ssh-connection.ts';

const now = Date.parse('2026-08-14T10:00:00.000Z');
const expiresAt = '2026-08-14T10:05:00.000Z';
const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'A'.repeat(70)}\n${'B'.repeat(70)}\n-----END OPENSSH PRIVATE KEY-----\n`;
const hostKeyFingerprint = `SHA256:${'C'.repeat(43)}`;
const knownHostsEntry = `[10.24.0.8]:22 ssh-ed25519 ${'A'.repeat(44)}`;
const connection = { protocol: 'ssh', host: '10.24.0.8', port: 22, username: 'kai', privateKey,
  hostKeyFingerprint, knownHostsEntry, expiresAt };
const attestedConnection = { protocol: 'ssh', host: '10.24.0.8', port: 22, hostKeyFingerprint,
  knownHostsEntry, displayName: 'H100 训练节点' };

test('strictly validates the backend-issued SSH response', () => {
  assert.deepEqual(validateSshConnection(connection, attestedConnection, '2026-08-14T11:00:00.000Z', now), connection);
  assert.throws(() => validateSshConnection({ ...connection, protocol: 'https' }, attestedConnection, null, now));
  assert.throws(() => validateSshConnection({ ...connection, username: 'root' }, attestedConnection, null, now));
  assert.throws(() => validateSshConnection({ ...connection, host: 'https://evil.example/x' }, attestedConnection, null, now));
  assert.throws(() => validateSshConnection({ ...connection, host: '10.24.0.9' }, attestedConnection, null, now));
  assert.throws(() => validateSshConnection({ ...connection, port: 2222 }, attestedConnection, null, now));
  assert.throws(() => validateSshConnection({ ...connection, hostKeyFingerprint: `SHA256:${'D'.repeat(43)}` }, attestedConnection, null, now));
  assert.throws(() => validateSshConnection({ ...connection, knownHostsEntry: `[10.24.0.8]:22 ssh-ed25519 ${'B'.repeat(44)}` }, attestedConnection, null, now));
  assert.throws(() => validateSshConnection({ ...connection, privateKey: 'not a key' }, attestedConnection, null, now));
  assert.throws(() => validateSshConnection({ ...connection, extra: 'secret' }, attestedConnection, null, now));
  assert.throws(() => validateSshConnection(connection, null, null, now));
});

test('connection expiry is future, at most five minutes, and within the lease', () => {
  assert.throws(() => validateSshConnection({ ...connection, expiresAt: '2026-08-14T10:05:01.000Z' }, attestedConnection, null, now));
  assert.throws(() => validateSshConnection(connection, attestedConnection, '2026-08-14T10:04:59.000Z', now));
  assert.throws(() => validateSshConnection({ ...connection, expiresAt: '2026-08-14T09:59:59.000Z' }, attestedConnection, null, now));
});

test('connection command uses only validated fields', () => {
  const stem = `kai-cloud-22-${'C'.repeat(43)}`;
  assert.equal(privateKeyPath(connection), `~/.ssh/${stem}`);
  assert.equal(sshCommand(connection), `ssh -i ~/.ssh/${stem} -o UserKnownHostsFile=~/.ssh/${stem}-known_hosts -o StrictHostKeyChecking=yes -p 22 kai@10.24.0.8`);
  assert.equal(knownHostsInstallCommand(connection), `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' '${knownHostsEntry}' > ~/.ssh/${stem}-known_hosts && chmod 600 ~/.ssh/${stem}-known_hosts`);
});

test('simultaneous compute connections receive independent identity and private-key files', () => {
  const second = { ...connection, hostKeyFingerprint: `SHA256:${'D'.repeat(43)}` };
  assert.notEqual(privateKeyPath(connection), privateKeyPath(second));
  assert.notEqual(knownHostsInstallCommand(connection), knownHostsInstallCommand(second));
  assert.notEqual(sshCommand(connection), sshCommand(second));
});
