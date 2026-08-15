import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerRuntime } from '../src/docker.mjs';

const leaseId = '10000000-0000-4000-8000-000000000001';

test('workspace cleanup retries quota reset after a crash between rm and xfs_quota', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kai-cleanup-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, leaseId); await mkdir(join(workspace, 'data'), { recursive: true });
  let quotaCalls = 0; let containerExists = true;
  const run = async (command, args) => {
    if (command === 'docker' && args[0] === 'rm') { containerExists = false; return { code: 0, stdout: '', stderr: '' }; }
    if (command === 'docker' && args[0] === 'inspect') return containerExists
      ? { code: 0, stdout: JSON.stringify([{ Id: 'a'.repeat(64) }]), stderr: '' }
      : { code: 1, stdout: '', stderr: 'No such container' };
    if (command === 'xfs_quota') {
      quotaCalls += 1; if (quotaCalls === 1) throw new Error('injected quota failure');
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  const docker = new DockerRuntime({ workspaceDirectory: root, workspaceQuotaMount: root }, run);
  const lease = { leaseId, quotaProjectId: docker.projectId(leaseId) };
  await assert.rejects(() => docker.cleanupWorkspace(lease), /injected quota failure/u);
  await assert.rejects(() => readFile(workspace), { code: 'ENOENT' });
  await docker.cleanupWorkspace(lease);
  assert.equal(quotaCalls, 2);
});

test('systemd stop budget exceeds the complete business-operation drain budget', async () => {
  const unit = await readFile(new URL('../deploy/kai-h100-sidecar.service', import.meta.url), 'utf8');
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(unit, /^TimeoutStopSec=240$/mu);
  assert.match(server, /SERVER_CLOSE_TIMEOUT'\)\), 190_000/u);
  assert.match(server, /finally \{ await service\.close\(\); \}/u);
});
