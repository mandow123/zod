import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

export interface PrivateObjectStore {
  createUploadGrant(input: Readonly<{
    objectKey: string; mimeType: string; sizeBytes: number; sha256Hex: string; expiresAt: Date;
  }>): Promise<UploadGrant>;
  head(objectKey: string): Promise<StoredObjectMetadata>;
  createDownloadUrl(objectKey: string, fileName: string, expiresAt: Date): Promise<string>;
  readBytes(objectKey: string): Promise<Uint8Array>;
  delete(objectKey: string): Promise<void>;
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export class S3PrivateObjectStore implements PrivateObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: RuntimeConfig) {
    if (config.OBJECT_STORAGE_PROVIDER !== 's3') throw new Error('OBJECT_STORAGE_PROVIDER must be s3.');
    this.bucket = required(config.OBJECT_STORAGE_BUCKET, 'OBJECT_STORAGE_BUCKET');
    this.client = new S3Client({
      endpoint: required(config.OBJECT_STORAGE_ENDPOINT, 'OBJECT_STORAGE_ENDPOINT'),
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
}

export function createPrivateObjectStore(config: RuntimeConfig) {
  return config.readiness.capabilities.objectStorage.available ? new S3PrivateObjectStore(config) : null;
}
