import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMigrationManifest } from '../src/schema.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(entries: Record<string, string | Uint8Array>) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudpay-migration-manifest-'));
  temporaryDirectories.push(directory);
  await Promise.all(Object.entries(entries).map(([name, bytes]) => writeFile(join(directory, name), bytes)));
  return directory;
}

describe('migration manifest input boundary', () => {
  it('accepts only canonical four-digit migration names', async () => {
    const directory = await fixture({
      '0001_initial.sql': 'SELECT 1;\n',
      '0002_add_index.sql': 'SELECT 2;\n',
      'README.md': 'operator notes',
    });
    await expect(readMigrationManifest(directory)).resolves.toMatchObject([
      { version: '0001_initial.sql' }, { version: '0002_add_index.sql' },
    ]);
  });

  it('fails explicitly on a real AppleDouble migration fixture', async () => {
    const appleDouble = Buffer.from('00051607000200004d6163204f53205800020000000900000032000000', 'hex');
    const directory = await fixture({
      '0001_initial.sql': 'SELECT 1;\n',
      '._0001_initial.sql': appleDouble,
    });
    await expect(readMigrationManifest(directory)).rejects.toThrow(
      'MIGRATION_DIRECTORY_FORBIDDEN_ENTRY:._0001_initial.sql',
    );
  });

  it('fails explicitly on a non-canonical SQL file instead of silently ignoring it', async () => {
    const directory = await fixture({ '0001_initial.sql': 'SELECT 1;\n', 'bootstrap.sql': 'SELECT 2;\n' });
    await expect(readMigrationManifest(directory)).rejects.toThrow(
      'MIGRATION_DIRECTORY_FORBIDDEN_ENTRY:bootstrap.sql',
    );
  });
});
