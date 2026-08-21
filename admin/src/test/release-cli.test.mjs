import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('administrator release verifier CLI', () => {
  it('runs when its path is a symlink or filesystem alias', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kai-admin-release-cli-'));
    const linkedVerifier = join(directory, 'verify-release.mjs');
    try {
      await symlink(new URL('../../scripts/verify-release.mjs', import.meta.url), linkedVerifier);
      const result = spawnSync(process.execPath, [linkedVerifier, '--help'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('Usage: ADMIN_API_ORIGIN=');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
