import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '../config.js';
import { createDatabase } from '../database.js';
import {
  databaseFingerprint, postgresProcessEnvironment, postgresServerMajor, postgresToolMajor, safeProcessError,
} from './postgres.js';
import { encryptBackupStream, sha256File, verifyEncryptedBackup } from './format.js';

const config = loadConfig(process.env);
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!config.readiness.capabilities.backup.available) {
  throw new Error(`Backup configuration is incomplete: ${config.readiness.capabilities.backup.missing.join(', ')}`);
}
if (!isAbsolute(config.BACKUP_LOCAL_DIRECTORY!)) throw new Error('BACKUP_LOCAL_DIRECTORY must be an absolute path.');

const database = createDatabase(config)!;
const startedAt = new Date();
const runId = randomUUID();
const stamp = startedAt.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
const artifactName = `cloudpay-postgres-${stamp}-${runId.slice(0, 8)}.kcpb`;
const outputPath = join(config.BACKUP_LOCAL_DIRECTORY!, artifactName);
const fingerprint = databaseFingerprint(config.DATABASE_URL);
let verified = false;

function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code.slice(0, 120);
  if (error instanceof Error) return safeProcessError(error.message).slice(0, 120);
  return 'BACKUP_UNKNOWN_ERROR';
}

async function childExit(child: ReturnType<typeof spawn>) {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 8_000) stderr += chunk.toString('utf8'); });
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(
      `PG_DUMP_FAILED:${code ?? signal ?? 'unknown'}:${safeProcessError(stderr)}`,
    )));
  });
}

try {
  await mkdir(config.BACKUP_LOCAL_DIRECTORY!, { recursive: true, mode: 0o700 });
  const schema = await database.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
  const version = await database.query<{ server_version_num: string }>('SHOW server_version_num');
  const schemaVersion = schema.rows[0]?.version ?? null;
  const postgresMajor = postgresServerMajor(version.rows[0]?.server_version_num ?? '');
  if (postgresToolMajor('pg_dump') !== postgresMajor) throw new Error('PG_DUMP_SERVER_MAJOR_MISMATCH');
  await database.query(
    `INSERT INTO backup_runs(id, status, artifact_name, schema_version, started_at)
     VALUES ($1, 'running', $2, $3, $4)`, [runId, artifactName, schemaVersion, startedAt],
  );

  const dump = spawn('pg_dump', [
    '--format=custom', '--compress=6', '--no-owner', '--no-privileges', '--serializable-deferrable',
    '--lock-wait-timeout=10s', '--exclude-table-data=backup_runs', '--exclude-table-data=restore_drills',
  ], { env: postgresProcessEnvironment(config.DATABASE_URL, config.databaseSsl), stdio: ['ignore', 'pipe', 'pipe'] });
  if (!dump.stdout) throw new Error('PG_DUMP_STDOUT_UNAVAILABLE');
  await Promise.all([
    encryptBackupStream(dump.stdout, outputPath, config.BACKUP_ENCRYPTION_KEY!, {
      createdAt: startedAt.toISOString(), databaseFingerprint: fingerprint, keyId: config.BACKUP_KEY_ID!,
      schemaVersion, postgresMajor,
    }),
    childExit(dump),
  ]);
  await verifyEncryptedBackup(outputPath, config.BACKUP_ENCRYPTION_KEY!);
  verified = true;
  const digest = await sha256File(outputPath);
  const size = (await stat(outputPath)).size;
  const year = startedAt.getUTCFullYear().toString();
  const month = String(startedAt.getUTCMonth() + 1).padStart(2, '0');
  const objectKey = `postgres/${year}/${month}/${artifactName}`;
  const retentionUntil = new Date(startedAt.getTime() + config.BACKUP_RETENTION_DAYS * 24 * 60 * 60_000);
  const client = new S3Client({
    endpoint: config.BACKUP_S3_ENDPOINT!, region: config.BACKUP_S3_REGION!, forcePathStyle: config.backupS3ForcePathStyle,
    credentials: { accessKeyId: config.BACKUP_S3_ACCESS_KEY!, secretAccessKey: config.BACKUP_S3_SECRET_KEY! },
  });
  await client.send(new PutObjectCommand({
    Bucket: config.BACKUP_S3_BUCKET!, Key: objectKey, Body: createReadStream(outputPath), ContentLength: size,
    ContentType: 'application/vnd.kai-cloudpay.postgres-backup', ServerSideEncryption: 'AES256',
    ChecksumSHA256: Buffer.from(digest.slice(7), 'hex').toString('base64'),
    ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: retentionUntil,
    Metadata: {
      database_fingerprint: fingerprint, schema_version: schemaVersion ?? 'unknown', encrypted: 'aes-256-gcm',
      key_id: config.BACKUP_KEY_ID!,
    },
  }));
  const completedAt = new Date();
  await database.transaction(async (db) => {
    await db.query(
      `UPDATE backup_runs SET status = 'succeeded', object_key = $2, encrypted_size_bytes = $3,
         encrypted_sha256_digest = $4, completed_at = $5 WHERE id = $1 AND status = 'running'`,
      [runId, objectKey, size, digest, completedAt],
    );
    await db.query(
      `INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id, payload_digest, metadata)
       VALUES ($1, NULL, 'system', 'DATABASE_BACKUP_COMPLETED', 'BACKUP_RUN', $2, $3, $4::jsonb)`,
      [randomUUID(), runId, digest.slice(7), JSON.stringify({ artifactName, objectKey, sizeBytes: size, schemaVersion })],
    );
  });
  await rm(outputPath, { force: true });
  process.stdout.write(`${JSON.stringify({
    ok: true, runId, artifactName, objectKey, keyId: config.BACKUP_KEY_ID,
    encryptedSizeBytes: size, sha256Digest: digest, retentionUntil: retentionUntil.toISOString(),
  })}\n`);
} catch (error) {
  const code = errorCode(error);
  await database.query(
    `UPDATE backup_runs SET status = 'failed', failure_code = $2, completed_at = now()
     WHERE id = $1 AND status = 'running'`, [runId, code],
  ).catch(() => undefined);
  if (!verified) await rm(outputPath, { force: true }).catch(() => undefined);
  throw error;
} finally {
  await database.close();
}
