import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { S3PrivateObjectStore } from '../src/storage/object-store.js';

describe('private evidence object storage', () => {
  it('creates short-lived signed uploads with checksum and server-side encryption requirements', async () => {
    const config = loadConfig({
      NODE_ENV: 'test', OBJECT_STORAGE_PROVIDER: 's3', OBJECT_STORAGE_ENDPOINT: 'https://storage.example.com',
      OBJECT_STORAGE_REGION: 'cn-east-1', OBJECT_STORAGE_BUCKET: 'cloudpay-private',
      OBJECT_STORAGE_ACCESS_KEY: 'access-key', OBJECT_STORAGE_SECRET_KEY: 'secret-key',
      OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    });
    const store = new S3PrivateObjectStore(config);
    const sha256Hex = 'a'.repeat(64);
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const grant = await store.createUploadGrant({
      objectKey: 'quarantine/disputes/test/evidence.pdf', mimeType: 'application/pdf',
      sizeBytes: 1024, sha256Hex, expiresAt,
    });
    expect(grant.method).toBe('PUT');
    expect(grant.url).toContain('X-Amz-Signature=');
    expect(grant.url).not.toContain('secret-key');
    expect(grant.headers).toMatchObject({
      'content-type': 'application/pdf', 'content-length': '1024',
      'x-amz-server-side-encryption': 'AES256', 'x-amz-meta-sha256': sha256Hex,
    });
    expect(grant.headers['x-amz-checksum-sha256']).toBe(Buffer.from(sha256Hex, 'hex').toString('base64'));
  });
});
