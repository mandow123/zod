import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadQixiangCheckoutKey, loadQixiangMerchantKey, qixiangCheckoutKeyPath, qixiangMerchantKeyPath,
} from '../src/payment/qixiang-credential.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qixiang-credential-'));
  directories.push(directory);
  const file = join(directory, 'qixiang-merchant-key');
  writeFileSync(file, 'TEST_ONLY_ROTATED_KEY\n', { mode: 0o600 });
  return { directory, file };
}

describe('Qixiang merchant key file credential', () => {
  it('loads only the dedicated 0600 file and tolerates one terminal newline', () => {
    const { directory, file } = fixture();
    expect(qixiangMerchantKeyPath({ credentialDirectory: directory })).toBe(file);
    expect(qixiangCheckoutKeyPath({ credentialDirectory: directory })).toBe(join(directory, 'qixiang-checkout-key'));
    expect(loadQixiangMerchantKey(file)).toBe('TEST_ONLY_ROTATED_KEY');
  });

  it('rejects relative paths, group-readable files and symlinks', () => {
    expect(() => qixiangMerchantKeyPath({ explicitFile: 'relative/key' })).toThrow(/ABSOLUTE/u);
    const { directory, file } = fixture();
    chmodSync(file, 0o640);
    expect(() => loadQixiangMerchantKey(file)).toThrow(/PERMISSIONS/u);
    chmodSync(file, 0o600);
    const link = join(directory, 'linked-key');
    symlinkSync(file, link);
    expect(() => loadQixiangMerchantKey(link)).toThrow(/INVALID/u);
  });

  it('rejects multi-line or whitespace-padded key material', () => {
    const { file } = fixture();
    writeFileSync(file, 'FIRST\nSECOND\n', { mode: 0o600 });
    expect(() => loadQixiangMerchantKey(file)).toThrow(/INVALID/u);
    writeFileSync(file, ' padded-key ', { mode: 0o600 });
    expect(() => loadQixiangMerchantKey(file)).toThrow(/INVALID/u);
  });

  it('accepts only a canonical base64 32-byte checkout key', () => {
    const { file } = fixture();
    const encoded = Buffer.alloc(32, 7).toString('base64');
    writeFileSync(file, `${encoded}\n`, { mode: 0o600 });
    expect(loadQixiangCheckoutKey(file)).toEqual(Buffer.alloc(32, 7));
    writeFileSync(file, Buffer.alloc(31, 7).toString('base64'), { mode: 0o600 });
    expect(() => loadQixiangCheckoutKey(file)).toThrow(/CHECKOUT_KEY_INVALID/u);
    writeFileSync(file, `${encoded}=`, { mode: 0o600 });
    expect(() => loadQixiangCheckoutKey(file)).toThrow(/CHECKOUT_KEY_INVALID/u);
  });
});
