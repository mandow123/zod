import { randomBytes } from 'node:crypto';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptedBackupStream, encryptBackupStream, readBackupHeader, sha256File, verifyEncryptedBackup,
} from '../src/backups/format.js';

const directories: string[] = [];
afterEach(async () => { while (directories.length) await rm(directories.pop()!, { recursive: true, force: true }); });

async function bytes(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('authenticated database backup format', () => {
  it('streams an encrypted archive, verifies it before restore, and rejects any tampering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cloudpay-backup-test-'));
    directories.push(directory);
    const path = join(directory, 'backup.kcpb');
    const key = randomBytes(32).toString('base64');
    const plaintext = Buffer.concat([Buffer.from('PGDMP'), randomBytes(256 * 1024), Buffer.from('archive-end')]);
    await encryptBackupStream(Readable.from([plaintext.subarray(0, 33), plaintext.subarray(33)]), path, key, {
      createdAt: '2026-08-12T01:30:00.000Z', databaseFingerprint: '0123456789abcdef01234567',
      keyId: 'cloudpay-backup-2026-01', schemaVersion: '0011_backup_audit.sql', postgresMajor: 15,
    });

    const header = await readBackupHeader(path);
    expect(header.header).toMatchObject({
      version: 1, cipher: 'AES-256-GCM', archiveFormat: 'postgres-custom',
      databaseFingerprint: '0123456789abcdef01234567', schemaVersion: '0011_backup_audit.sql',
      keyId: 'cloudpay-backup-2026-01',
      postgresMajor: 15,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(verifyEncryptedBackup(path, key)).resolves.toMatchObject({ plaintextSizeBytes: plaintext.length });
    const decrypted = await decryptedBackupStream(path, key);
    expect(await bytes(decrypted.stream)).toEqual(plaintext);
    expect(await sha256File(path)).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const wrongKey = randomBytes(32).toString('base64');
    await expect(verifyEncryptedBackup(path, wrongKey)).rejects.toThrow('BACKUP_AUTHENTICATION_FAILED');
    const handle = await open(path, 'r+');
    const changed = Buffer.from([0xff]);
    await handle.write(changed, 0, 1, header.ciphertextStart + 10);
    await handle.close();
    await expect(verifyEncryptedBackup(path, key)).rejects.toThrow('BACKUP_AUTHENTICATION_FAILED');
  });
});
