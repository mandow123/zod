import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../src/command.mjs';

const required = (key) => {
  const value = process.env[key]?.trim(); if (!value) throw new Error(`${key} is required`); return value;
};
const backend = new URL(required('KAI_ACCEPTANCE_BACKEND_URL')); if (backend.protocol !== 'https:') throw new Error('backend must use HTTPS');
const orderId = required('KAI_ACCEPTANCE_ORDER_ID'); const userToken = required('KAI_ACCEPTANCE_USER_TOKEN');
const expectedGpuUuid = required('KAI_ACCEPTANCE_EXPECTED_GPU_UUID');
const accessRequestId = `h100-acceptance-${randomUUID()}`;
const response = await fetch(new URL(`/mobile/v1/orders/${encodeURIComponent(orderId)}/fulfillment/access-session`, backend), {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: {
    authorization: `Bearer ${userToken}`, 'content-type': 'application/json', 'idempotency-key': accessRequestId,
  }, body: '{}',
});
if (!response.ok || !String(response.headers.get('cache-control')).includes('no-store')) throw new Error(`access request failed: ${response.status}`);
const bodyText = await response.text(); if (Buffer.byteLength(bodyText) > 32_768) throw new Error('access response too large');
const payload = JSON.parse(bodyText); const session = payload?.session;
if (session?.protocol !== 'ssh' || session.username !== 'kai' || !Number.isInteger(session.port)
  || typeof session.host !== 'string' || typeof session.privateKey !== 'string'
  || !session.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')
  || !/^SHA256:[A-Za-z0-9+/]+$/u.test(session.hostKeyFingerprint)
  || !/^\[[^\]\r\n]+\]:\d+ ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(session.knownHostsEntry)) {
  throw new Error('backend returned invalid SSH credential');
}
if (['ticket', 'uri', 'sidecarUrl'].some((field) => Object.hasOwn(session, field))) {
  throw new Error('mobile response exposed a private sidecar field');
}
const replayResponse = await fetch(new URL(`/mobile/v1/orders/${encodeURIComponent(orderId)}/fulfillment/access-session`, backend), {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: {
    authorization: `Bearer ${userToken}`, 'content-type': 'application/json', 'idempotency-key': accessRequestId,
  }, body: '{}',
});
if (!replayResponse.ok || !String(replayResponse.headers.get('cache-control')).includes('no-store')) {
  throw new Error(`access replay failed: ${replayResponse.status}`);
}
const replayPayload = await replayResponse.json();
if (JSON.stringify(replayPayload?.session) !== JSON.stringify(session)
  || replayPayload?.fulfillment?.runningAt !== payload?.fulfillment?.runningAt) {
  throw new Error('access replay changed the credential or restarted metering');
}
const directory = await mkdtemp(join(tmpdir(), 'kai-h100-acceptance-')); const key = join(directory, 'id_ed25519');
const knownHosts = join(directory, 'known_hosts');
try {
  await writeFile(key, session.privateKey, { mode: 0o600 }); await chmod(key, 0o600);
  await writeFile(knownHosts, `${session.knownHostsEntry}\n`, { mode: 0o600 });
  const fingerprint = (await runCommand('ssh-keygen', ['-l', '-E', 'sha256', '-f', knownHosts])).stdout;
  if (!fingerprint.includes(session.hostKeyFingerprint)) throw new Error('known_hosts fingerprint mismatch');
  const marker = `acceptance-${randomUUID()}`;
  const command = `set -eu; test \"$(id -u)\" = 1000; printf '%s' '${marker}' > /workspace/data/${marker}; test \"$(cat /workspace/data/${marker})\" = '${marker}'; nvidia-smi --query-gpu=uuid --format=csv,noheader; ! printf x >> /workspace/.access/authorized_keys`;
  const result = await runCommand('ssh', ['-p', String(session.port), '-i', key, '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    `${session.username}@${session.host}`, command], { timeoutMs: 30_000 });
  const gpuUuids = result.stdout.trim().split(/\r?\n/u).filter((line) => /^GPU-[A-Fa-f0-9-]+$/u.test(line.trim()));
  if (gpuUuids.length !== 1 || gpuUuids[0].trim() !== expectedGpuUuid) throw new Error('SSH session GPU isolation mismatch');
  const stop = await fetch(new URL(`/mobile/v1/orders/${encodeURIComponent(orderId)}/fulfillment/stop`, backend), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000), headers: {
      authorization: `Bearer ${userToken}`, 'content-type': 'application/json',
      'idempotency-key': `h100-acceptance-stop-${randomUUID()}`,
    }, body: '{}',
  });
  if (!stop.ok) throw new Error(`stop failed: ${stop.status}`);
  const authoritative = await fetch(new URL(`/mobile/v1/orders/${encodeURIComponent(orderId)}/fulfillment`, backend), {
    redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${userToken}` },
  });
  const stopped = await authoritative.json();
  if (!authoritative.ok || stopped?.fulfillment?.status !== 'stopped' || stopped?.usage?.capacityUnit !== 'GPU时'
    || !/^sha256:[a-f0-9]{64}$/u.test(stopped?.usage?.evidenceDigest ?? '')) {
    throw new Error('authoritative signed metering was not recorded');
  }
  const rejected = await runCommand('ssh', ['-p', String(session.port), '-i', key, '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    `${session.username}@${session.host}`, 'true'], { timeoutMs: 10_000, allowFailure: true });
  if (rejected.code === 0) throw new Error('revoked SSH credential still works after stop');
  process.stdout.write(`${JSON.stringify({ ok: true, host: session.host, port: session.port,
    hostKeyFingerprint: session.hostKeyFingerprint, gpuVerified: true, workspaceWriteVerified: true,
    authorizedKeysProtected: true, stopVerified: true, credentialRevocationVerified: true,
    accessReplayVerified: true, privateSidecarFieldsHidden: true,
    meteringEvidenceDigest: stopped.usage.evidenceDigest })}\n`);
} finally { await rm(directory, { recursive: true, force: true }); }
