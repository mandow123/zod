import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';

export type UploadGrant = Readonly<{
  url: string;
  method: 'PUT';
  expiresAt: Date;
  headers: Record<string, string>;
}>;

export type StoredObjectMetadata = Readonly<{
  sizeBytes: number;
  mimeType: string;
  sha256Base64: string | null;
  metadataSha256: string | null;
}>;

export type ObjectStorageReadinessProbeResult = Readonly<{
  provider: 's3'; endpoint: string; bucket: string; objectKey: string; sha256Digest: string;
  put: true; head: true; get: true; delete: true; deleteConfirmed: true;
}>;

export interface PrivateObjectStore {
  createUploadGrant(input: Readonly<{
    objectKey: string; mimeType: string; sizeBytes: number; sha256Hex: string; expiresAt: Date;
  }>): Promise<UploadGrant>;
  head(objectKey: string): Promise<StoredObjectMetadata>;
  createDownloadUrl(objectKey: string, fileName: string, expiresAt: Date): Promise<string>;
  readBytes(objectKey: string): Promise<Uint8Array>;
  delete(objectKey: string): Promise<void>;
  readinessProbe?(probeId: string): Promise<ObjectStorageReadinessProbeResult>;
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export class S3PrivateObjectStore implements PrivateObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;

  constructor(config: RuntimeConfig) {
    if (config.OBJECT_STORAGE_PROVIDER !== 's3') throw new Error('OBJECT_STORAGE_PROVIDER must be s3.');
    this.bucket = required(config.OBJECT_STORAGE_BUCKET, 'OBJECT_STORAGE_BUCKET');
    const endpoint = new URL(required(config.OBJECT_STORAGE_ENDPOINT, 'OBJECT_STORAGE_ENDPOINT'));
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('OBJECT_STORAGE_ENDPOINT must not contain credentials, query parameters, or a fragment.');
    }
    this.endpoint = endpoint.toString();
    this.client = new S3Client({
      endpoint: this.endpoint,
      region: required(config.OBJECT_STORAGE_REGION, 'OBJECT_STORAGE_REGION'),
      forcePathStyle: config.objectStorageForcePathStyle,
      credentials: {
        accessKeyId: required(config.OBJECT_STORAGE_ACCESS_KEY, 'OBJECT_STORAGE_ACCESS_KEY'),
        secretAccessKey: required(config.OBJECT_STORAGE_SECRET_KEY, 'OBJECT_STORAGE_SECRET_KEY'),
      },
    });
  }

  async createUploadGrant(input: { objectKey: string; mimeType: string; sizeBytes: number; sha256Hex: string; expiresAt: Date }) {
    const checksum = Buffer.from(input.sha256Hex, 'hex').toString('base64');
    const command = new PutObjectCommand({
      Bucket: this.bucket, Key: input.objectKey, ContentType: input.mimeType, ContentLength: input.sizeBytes,
      ChecksumSHA256: checksum, ServerSideEncryption: 'AES256', Metadata: { sha256: input.sha256Hex },
    });
    const expiresIn = Math.max(1, Math.floor((input.expiresAt.getTime() - Date.now()) / 1000));
    return {
      url: await getSignedUrl(this.client, command, { expiresIn }), method: 'PUT' as const, expiresAt: input.expiresAt,
      headers: {
        'content-type': input.mimeType,
        'content-length': String(input.sizeBytes),
        'x-amz-checksum-sha256': checksum,
        'x-amz-server-side-encryption': 'AES256',
        'x-amz-meta-sha256': input.sha256Hex,
      },
    };
  }

  async head(objectKey: string) {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return {
        sizeBytes: result.ContentLength ?? 0,
        mimeType: result.ContentType ?? 'application/octet-stream',
        sha256Base64: result.ChecksumSHA256 ?? null,
        metadataSha256: result.Metadata?.sha256 ?? null,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) throw new AppError('EVIDENCE_OBJECT_NOT_FOUND', 409, '尚未检测到上传完成的证据文件。');
      throw new AppError('OBJECT_STORAGE_UNAVAILABLE', 503, '证据存储服务暂时不可用，请稍后重试。');
    }
  }

  async createDownloadUrl(objectKey: string, fileName: string, expiresAt: Date) {
    const safeName = fileName.replace(/["\\\r\n]/gu, '_').slice(0, 120);
    const command = new GetObjectCommand({
      Bucket: this.bucket, Key: objectKey,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    });
    const expiresIn = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    return getSignedUrl(this.client, command, { expiresIn });
  }

  async readBytes(objectKey: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    if (!result.Body) throw new AppError('EVIDENCE_OBJECT_NOT_FOUND', 409, '证据文件不存在。');
    return result.Body.transformToByteArray();
  }

  async delete(objectKey: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  async readinessProbe(probeId: string): Promise<ObjectStorageReadinessProbeResult> {
    if (!/^[0-9a-f-]{36}$/u.test(probeId)) throw new Error('OBJECT_STORAGE_PROBE_ID_INVALID');
    const objectKey = `readiness/inquiry-only/${probeId}.probe`;
    const body = Buffer.from(`kai-cloudpay-inquiry-only-readiness:${probeId}`, 'utf8');
    const sha256Hex = createHash('sha256').update(body).digest('hex');
    const checksum = Buffer.from(sha256Hex, 'hex').toString('base64');
    let deleted = false;
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: objectKey, Body: body, ContentType: 'application/octet-stream',
        ContentLength: body.byteLength, ChecksumSHA256: checksum, ServerSideEncryption: 'AES256',
        Metadata: { sha256: sha256Hex, readinessProbeId: probeId },
      }));
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      if (head.ContentLength !== body.byteLength || head.Metadata?.sha256 !== sha256Hex
        || head.Metadata?.readinessprobeid !== probeId) throw new Error('OBJECT_STORAGE_PROBE_HEAD_MISMATCH');
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      if (!object.Body) throw new Error('OBJECT_STORAGE_PROBE_GET_EMPTY');
      const downloaded = Buffer.from(await object.Body.transformToByteArray());
      if (!downloaded.equals(body)) throw new Error('OBJECT_STORAGE_PROBE_GET_MISMATCH');
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      deleted = true;
      let deleteConfirmed = false;
      try {
        await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      } catch (error) {
        deleteConfirmed = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
      }
      if (!deleteConfirmed) throw new Error('OBJECT_STORAGE_PROBE_DELETE_NOT_CONFIRMED');
      return {
        provider: 's3', endpoint: this.endpoint, bucket: this.bucket, objectKey,
        sha256Digest: `sha256:${sha256Hex}`, put: true, head: true, get: true, delete: true, deleteConfirmed: true,
      };
    } finally {
      if (!deleted) {
        try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey })); } catch { /* best effort */ }
      }
    }
  }
}

export function createPrivateObjectStore(config: RuntimeConfig) {
  return config.readiness.capabilities.objectStorage.available ? new S3PrivateObjectStore(config) : null;
}
