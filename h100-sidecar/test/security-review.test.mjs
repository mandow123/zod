import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { loadSidecarConfig } from '../src/config.mjs';
import { generateSshKeyPair } from '../src/security.mjs';
import { StateStore } from '../src/state.mjs';

const execute = promisify(execFile);

test('a failed durable write never changes memory and does not poison later updates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kai-state-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(root);
  await store.load();

  const save = store.saveValue.bind(store);
  let failOnce = true;
  store.saveValue = async (value) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated fsync failure');
    }
    return save(value);
  };

  await assert.rejects(() => store.update(async (state) => { state.uncommitted = true; }), /fsync failure/u);
  assert.equal(store.snapshot().uncommitted, undefined);
  assert.equal(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).uncommitted, undefined);

  await store.update(async (state) => { state.committed = true; });
  assert.equal(store.snapshot().committed, true);
  assert.equal(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).committed, true);
});

test('generated user credential is a real OpenSSH Ed25519 key whose public half matches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kai-key-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = await generateSshKeyPair('kai:security-review');
  const privatePath = join(root, 'id_ed25519');
  await writeFile(privatePath, keys.privateKey, { mode: 0o600 });
  const derived = await execute('ssh-keygen', ['-y', '-f', privatePath]);
  assert.equal(derived.stdout.trim().split(/\s+/u).slice(0, 2).join(' '),
    keys.publicKey.split(/\s+/u).slice(0, 2).join(' '));
});

test('sidecar API and SSH listeners reject wildcard and public bind addresses', () => {
  const base = {
    SIDECAR_HOST: '10.0.0.10',
    SIDECAR_PORT: '9443',
    SIDECAR_PUBLIC_ORIGIN: 'https://h100-sidecar.internal:9443',
    SIDECAR_BACKEND_BASE_URL: 'https://api.kai.example',
    SIDECAR_ALLOWED_BACKEND_IPS: '10.0.1.20',
    SIDECAR_TLS_CERT_FILE: '/etc/kai/tls/cert.pem',
    SIDECAR_TLS_KEY_FILE: '/etc/kai/tls/key.pem',
    SIDECAR_STATE_DIRECTORY: '/var/lib/kai',
    SIDECAR_WORKSPACE_DIRECTORY: '/srv/kai/workspaces',
    SIDECAR_WORKSPACE_QUOTA_MOUNT: '/srv/kai',
    SIDECAR_WORKSPACE_QUOTA_SIZE: '250g',
    SIDECAR_HOST_DISK_RESERVE_SIZE: '500g',
    SIDECAR_RESOURCE_POLICIES_FILE: '/etc/kai/policies.json',
    SIDECAR_PROVIDER_TOKEN: 'Pr0v1der-6rQ9_Zx2.Km8-Ld5_Wc7-Ns4',
    SIDECAR_TICKET_SECRET: 'T1cket-9vB4_Hm7-Qp2_Xr8-Kd6_Ls3-Zf5',
    SIDECAR_WORKLOAD_IMAGE: `registry.invalid/kai@sha256:${'a'.repeat(64)}`,
    SIDECAR_EXPECTED_GPU_COUNT: '8',
    SIDECAR_DEFAULT_GPU_COUNT: '1',
    SIDECAR_SSH_PUBLIC_HOST: 'gpu.example.com',
    SIDECAR_SSH_BIND_HOST: '10.0.0.10',
  };
  assert.throws(() => loadSidecarConfig({ ...base, SIDECAR_HOST: '0.0.0.0' }), /RFC1918/u);
  assert.throws(() => loadSidecarConfig({ ...base, SIDECAR_SSH_BIND_HOST: '203.0.113.10' }), /RFC1918/u);
  assert.throws(() => loadSidecarConfig({ ...base, SIDECAR_BACKEND_BASE_URL: '' }), /SIDECAR_BACKEND_BASE_URL is required/u);
  assert.throws(() => loadSidecarConfig({ ...base, SIDECAR_BACKEND_BASE_URL: 'http://api.kai.example' }), /HTTPS origin/u);
  assert.doesNotThrow(() => loadSidecarConfig(base));
});

test('workload health continuously covers SSH authorization, writable workspace, and GPU access', async () => {
  const healthcheck = await readFile(new URL('../workload/healthcheck.sh', import.meta.url), 'utf8');
  assert.match(healthcheck, /sshd -t/u);
  assert.match(healthcheck, /authorized_keys/u);
  assert.match(healthcheck, /stat -c %a[^\n]+600/u);
  assert.match(healthcheck, /test -w \/workspace\/data/u);
  assert.match(healthcheck, /nvidia-smi -L/u);
});

test('claim importer only replaces an expired claim in the same deployment and never places a secret in argv', async () => {
  const importer = await readFile(new URL('../scripts/import-claim.mjs', import.meta.url), 'utf8');
  const wrapper = await readFile(new URL('../deploy/kai-h100-sidecar-enroll', import.meta.url), 'utf8');
  assert.match(importer, /canReplaceExpiredNodeClaim/u);
  assert.match(importer, /node-claim-request\.json/u);
  assert.match(importer, /await rename\(temporary, target\)/u);
  assert.doesNotMatch(wrapper, /\$[@*]/u);
});

test('sidecar startup fails closed for missing, placeholder, repeated, or reused credential secrets', () => {
  const base = {
    SIDECAR_HOST: '10.0.0.10', SIDECAR_PORT: '9443', SIDECAR_PUBLIC_ORIGIN: 'https://h100-sidecar.internal:9443',
    SIDECAR_BACKEND_BASE_URL: 'https://api.kai.example',
    SIDECAR_ALLOWED_BACKEND_IPS: '10.0.1.20', SIDECAR_TLS_CERT_FILE: '/etc/kai/tls/cert.pem',
    SIDECAR_TLS_KEY_FILE: '/etc/kai/tls/key.pem', SIDECAR_STATE_DIRECTORY: '/var/lib/kai',
    SIDECAR_WORKSPACE_DIRECTORY: '/srv/kai/workspaces', SIDECAR_WORKSPACE_QUOTA_MOUNT: '/srv/kai',
    SIDECAR_WORKSPACE_QUOTA_SIZE: '250g', SIDECAR_HOST_DISK_RESERVE_SIZE: '500g',
    SIDECAR_RESOURCE_POLICIES_FILE: '/etc/kai/policies.json',
    SIDECAR_PROVIDER_TOKEN: 'Pr0v1der-6rQ9_Zx2.Km8-Ld5_Wc7-Ns4',
    SIDECAR_TICKET_SECRET: 'T1cket-9vB4_Hm7-Qp2_Xr8-Kd6_Ls3-Zf5',
    SIDECAR_WORKLOAD_IMAGE: `registry.invalid/kai@sha256:${'a'.repeat(64)}`, SIDECAR_EXPECTED_GPU_COUNT: '8',
    SIDECAR_DEFAULT_GPU_COUNT: '1', SIDECAR_SSH_PUBLIC_HOST: 'gpu.example.com', SIDECAR_SSH_BIND_HOST: '10.0.0.10',
  };
  assert.throws(() => loadSidecarConfig({ ...base, SIDECAR_TICKET_SECRET: '' }), /SIDECAR_TICKET_SECRET is required/u);
  assert.throws(() => loadSidecarConfig({ ...base,
    SIDECAR_TICKET_SECRET: 'replace-with-at-least-32-random-characters' }), /high-entropy/u);
  assert.throws(() => loadSidecarConfig({ ...base, SIDECAR_PROVIDER_TOKEN: 'abc12345'.repeat(5) }), /high-entropy/u);
  assert.throws(() => loadSidecarConfig({ ...base, SIDECAR_TICKET_SECRET: base.SIDECAR_PROVIDER_TOKEN }), /must be distinct/u);
});
