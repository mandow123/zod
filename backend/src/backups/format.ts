import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('KCPBK001', 'ascii');
const TAG_LENGTH = 16;
const MAX_HEADER_LENGTH = 16 * 1024;

export type BackupHeader = Readonly<{
  version: 1;
  cipher: 'AES-256-GCM';
  archiveFormat: 'postgres-custom';
  createdAt: string;
  databaseFingerprint: string;
  keyId: string;
  schemaVersion: string | null;
  postgresMajor: number;
  iv: string;
}>;

function encryptionKey(base64Key: string) {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must contain exactly 32 bytes.');
  return key;
}

function prefixFor(header: BackupHeader) {
  const body = Buffer.from(JSON.stringify(header), 'utf8');
  if (body.length > MAX_HEADER_LENGTH) throw new Error('BACKUP_HEADER_TOO_LARGE');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([MAGIC, length, body]);
}

class EncryptBackupTransform extends Transform {
  private emittedPrefix = false;
  private readonly cipher;

  constructor(private readonly prefix: Buffer, key: Buffer, iv: Buffer) {
    super();
    this.cipher = createCipheriv('aes-256-gcm', key, iv);
    this.cipher.setAAD(prefix);
  }

  private emitPrefix() {
    if (!this.emittedPrefix) { this.push(this.prefix); this.emittedPrefix = true; }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try { this.emitPrefix(); this.push(this.cipher.update(chunk)); callback(); } catch (error) { callback(error as Error); }
  }

  override _flush(callback: (error?: Error | null) => void) {
    try {
      this.emitPrefix();
      this.push(this.cipher.final());
      this.push(this.cipher.getAuthTag());
      callback();
    } catch (error) { callback(error as Error); }
  }
}

class DecryptBackupTransform extends Transform {
  private readonly decipher;

  constructor(prefix: Buffer, key: Buffer, iv: Buffer, tag: Buffer) {
    super();
    this.decipher = createDecipheriv('aes-256-gcm', key, iv);
    this.decipher.setAAD(prefix);
    this.decipher.setAuthTag(tag);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try { this.push(this.decipher.update(chunk)); callback(); } catch (error) { callback(error as Error); }
  }

  override _flush(callback: (error?: Error | null) => void) {
    try { this.push(this.decipher.final()); callback(); } catch { callback(new Error('BACKUP_AUTHENTICATION_FAILED')); }
  }
}

export async function encryptBackupStream(
  source: Readable,
  outputPath: string,
  base64Key: string,
  metadata: Omit<BackupHeader, 'version' | 'cipher' | 'archiveFormat' | 'iv'>,
) {
  const key = encryptionKey(base64Key);
  const iv = randomBytes(12);
  const header: BackupHeader = {
    version: 1, cipher: 'AES-256-GCM', archiveFormat: 'postgres-custom', ...metadata, iv: iv.toString('base64url'),
  };
  const prefix = prefixFor(header);
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  await pipeline(source, new EncryptBackupTransform(prefix, key, iv), output);
  return header;
}

export async function readBackupHeader(path: string) {
  const handle = await open(path, 'r');
  try {
    const fixed = Buffer.alloc(MAGIC.length + 4);
    const fixedRead = await handle.read(fixed, 0, fixed.length, 0);
    if (fixedRead.bytesRead !== fixed.length || !fixed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('BACKUP_FORMAT_INVALID');
    const headerLength = fixed.readUInt32BE(MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_LENGTH) throw new Error('BACKUP_HEADER_INVALID');
    const body = Buffer.alloc(headerLength);
    const bodyRead = await handle.read(body, 0, body.length, fixed.length);
    if (bodyRead.bytesRead !== body.length) throw new Error('BACKUP_HEADER_TRUNCATED');
    const header = JSON.parse(body.toString('utf8')) as BackupHeader;
    if (header.version !== 1 || header.cipher !== 'AES-256-GCM' || header.archiveFormat !== 'postgres-custom'
      || !header.createdAt || !header.databaseFingerprint || !header.keyId || !Number.isInteger(header.postgresMajor)
      || header.postgresMajor < 12 || !header.iv) throw new Error('BACKUP_HEADER_INVALID');
    const iv = Buffer.from(header.iv, 'base64url');
    if (iv.length !== 12) throw new Error('BACKUP_HEADER_INVALID');
    const prefix = Buffer.concat([fixed, body]);
    const stat = await handle.stat();
    if (stat.size <= prefix.length + TAG_LENGTH) throw new Error('BACKUP_PAYLOAD_TRUNCATED');
    const tag = Buffer.alloc(TAG_LENGTH);
    const tagRead = await handle.read(tag, 0, TAG_LENGTH, stat.size - TAG_LENGTH);
    if (tagRead.bytesRead !== TAG_LENGTH) throw new Error('BACKUP_TAG_TRUNCATED');
    return { header, prefix, iv, tag, ciphertextStart: prefix.length, ciphertextEnd: stat.size - TAG_LENGTH - 1, sizeBytes: stat.size };
  } finally { await handle.close(); }
}

export async function decryptedBackupStream(path: string, base64Key: string) {
  const parsed = await readBackupHeader(path);
  const source = createReadStream(path, { start: parsed.ciphertextStart, end: parsed.ciphertextEnd });
  const decrypt = new DecryptBackupTransform(parsed.prefix, encryptionKey(base64Key), parsed.iv, parsed.tag);
  return { header: parsed.header, sizeBytes: parsed.sizeBytes, stream: source.pipe(decrypt) };
}

export async function verifyEncryptedBackup(path: string, base64Key: string) {
  const decrypted = await decryptedBackupStream(path, base64Key);
  let plaintextSizeBytes = 0;
  await pipeline(decrypted.stream, new Writable({
    write(chunk: Buffer, _encoding, callback) { plaintextSizeBytes += chunk.length; callback(); },
  }));
  if (plaintextSizeBytes < 1) throw new Error('BACKUP_ARCHIVE_EMPTY');
  return { header: decrypted.header, encryptedSizeBytes: decrypted.sizeBytes, plaintextSizeBytes };
}

export async function sha256File(path: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), new Writable({ write(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(); } }));
  return `sha256:${hash.digest('hex')}`;
}
