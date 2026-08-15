import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { WorkerLogger } from '../refunds/processor.js';
import type { PrivateObjectStore } from '../storage/object-store.js';
import type { MalwareScanner } from './scanner.js';

export type EvidenceJob = Readonly<{
  id: string; evidenceId: string; attempts: number; createdAt: Date;
}>;

type EvidenceJobRow = QueryResultRow & {
  id: string; aggregate_id: string; attempts: number; created_at: Date;
};

export type ScanRecord = QueryResultRow & {
  id: string; dispute_id: string; submitted_by: string; object_key: string; mime_type: string;
  size_bytes: string; sha256_digest: string; status: string;
};

export interface EvidenceWorkerStore {
  claim(now: Date, staleBefore: Date, limit: number): Promise<EvidenceJob[]>;
  getEvidence(evidenceId: string): Promise<ScanRecord | null>;
  verified(evidenceId: string, now: Date): Promise<void>;
  rejected(evidenceId: string, reason: string, now: Date): Promise<void>;
  scanFailed(evidenceId: string, reason: string, now: Date): Promise<void>;
  completeJob(jobId: string, now: Date): Promise<void>;
  failJob(jobId: string, code: string, availableAt: Date, maxAttempts: number): Promise<{ attempts: number; deadLettered: boolean }>;
}

export class EvidenceScanStore implements EvidenceWorkerStore {
  constructor(private readonly database: Database) {}

  async claim(now: Date, staleBefore: Date, limit: number) {
    return this.database.transaction(async (client) => {
      const result = await client.query<EvidenceJobRow>(
        `WITH candidates AS (
           SELECT id FROM outbox_events WHERE topic = 'evidence.scan' AND processed_at IS NULL
             AND dead_lettered_at IS NULL AND available_at <= $1 AND (locked_at IS NULL OR locked_at < $2)
           ORDER BY available_at, created_at LIMIT $3 FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events o SET locked_at = $1 FROM candidates c WHERE o.id = c.id
         RETURNING o.id, o.aggregate_id, o.attempts, o.created_at`, [now, staleBefore, limit],
      );
      return result.rows.map((row) => ({
        id: row.id, evidenceId: row.aggregate_id, attempts: row.attempts, createdAt: new Date(row.created_at),
      }));
    });
  }

  async getEvidence(evidenceId: string) {
    const result = await this.database.query<ScanRecord>(
      `SELECT id, dispute_id, submitted_by, object_key, mime_type, size_bytes::text, sha256_digest, status
       FROM dispute_evidence WHERE id = $1`, [evidenceId],
    );
    return result.rows[0] ?? null;
  }

  async verified(evidenceId: string, now: Date) {
    await this.transition(evidenceId, 'verified', 'clean', now);
  }

  async rejected(evidenceId: string, reason: string, now: Date) {
    await this.transition(evidenceId, 'rejected', reason, now);
  }

  async scanFailed(evidenceId: string, reason: string, now: Date) {
    await this.transition(evidenceId, 'scan_failed', reason, now);
  }

  async completeJob(jobId: string, now: Date) {
    await this.database.query(`UPDATE outbox_events SET processed_at = $2, locked_at = NULL, last_error = NULL WHERE id = $1`, [jobId, now]);
  }

  async failJob(jobId: string, code: string, availableAt: Date, maxAttempts: number) {
    const result = await this.database.query<{ attempts: number; dead_lettered_at: Date | null }>(
      `UPDATE outbox_events SET attempts = attempts + 1, last_error = $2, available_at = $3, locked_at = NULL,
         dead_lettered_at = CASE WHEN attempts + 1 >= $4 THEN now() ELSE NULL END
       WHERE id = $1 RETURNING attempts, dead_lettered_at`, [jobId, code.slice(0, 300), availableAt, maxAttempts],
    );
    return { attempts: result.rows[0]?.attempts ?? maxAttempts, deadLettered: Boolean(result.rows[0]?.dead_lettered_at) };
  }

  private async transition(evidenceId: string, status: 'verified' | 'rejected' | 'scan_failed', result: string, now: Date) {
    await this.database.transaction(async (client) => {
      const current = await client.query<ScanRecord>(
        `SELECT id, dispute_id, submitted_by, object_key, mime_type, size_bytes::text, sha256_digest, status
         FROM dispute_evidence WHERE id = $1 FOR UPDATE`, [evidenceId],
      );
      const evidence = current.rows[0];
      if (!evidence || evidence.status !== 'pending_scan') return;
      await client.query(
        `UPDATE dispute_evidence SET status = $2, scan_result = $3,
           verified_at = CASE WHEN $2::text = 'verified' THEN $4::timestamptz ELSE NULL END,
           rejected_at = CASE WHEN $2::text IN ('rejected', 'scan_failed') THEN $4::timestamptz ELSE NULL END
         WHERE id = $1`, [evidenceId, status, result.slice(0, 300), now],
      );
      await client.query(
        `INSERT INTO dispute_events(id, dispute_id, actor_id, event_type, from_status, to_status, payload)
         VALUES ($1, $2, NULL, $3, 'pending_scan', $4, $5::jsonb)`,
        [randomUUID(), evidence.dispute_id, status === 'verified' ? 'EVIDENCE_VERIFIED' : 'EVIDENCE_REJECTED', status,
          JSON.stringify({ evidenceId })],
      );
      const notificationId = randomUUID();
      const title = status === 'verified' ? '证据安全检查完成' : status === 'scan_failed' ? '证据检查暂时失败' : '证据文件未通过检查';
      const body = status === 'verified' ? '您提交的争议证据已进入可审核状态。' : status === 'scan_failed' ? '安全检查服务异常，客服将继续处理。' : '请重新上传格式正确且安全的证据文件。';
      await client.query(
        `INSERT INTO notifications(id, user_id, category, title, body, data) VALUES ($1, $2, 'order', $3, $4, $5::jsonb)`,
        [notificationId, evidence.submitted_by, title, body, JSON.stringify({ disputeId: evidence.dispute_id, evidenceId })],
      );
      await client.query(
        `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload) VALUES ($1, 'notification.created', 'NOTIFICATION', $2, $3::jsonb)`,
        [randomUUID(), notificationId, JSON.stringify({ notificationId, userId: evidence.submitted_by })],
      );
      if (status === 'scan_failed') await this.enqueueReview(client, evidence, result);
    });
  }

  private enqueueReview(client: PoolClient, evidence: ScanRecord, result: string) {
    return client.query(
      `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'evidence.review_required', 'DISPUTE_EVIDENCE', $2, $3::jsonb)`,
      [randomUUID(), evidence.id, JSON.stringify({ evidenceId: evidence.id, disputeId: evidence.dispute_id, reason: result })],
    ).then(() => undefined);
  }
}

export function detectedEvidenceType(bytes: Uint8Array, expected: string) {
  if (expected === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (expected === 'image/png') return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (expected === 'application/pdf') return Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) return false;
    if (expected === 'application/json') JSON.parse(text);
    return expected === 'text/plain' || expected === 'application/json';
  } catch {
    return false;
  }
}

function code(error: unknown) {
  if (error instanceof Error && /^[A-Z0-9_:-]{1,100}$/u.test(error.message)) return error.message;
  return 'EVIDENCE_SCAN_TEMPORARY_FAILURE';
}

export class EvidenceScanWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly store: EvidenceWorkerStore,
    private readonly objects: PrivateObjectStore,
    private readonly scanner: MalwareScanner,
    private readonly logger: WorkerLogger,
    private readonly pollMilliseconds = 2_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMilliseconds);
    this.timer.unref();
    void this.tick();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      const jobs = await this.store.claim(now, new Date(now.getTime() - 5 * 60_000), 4);
      await Promise.all(jobs.map((job) => this.handle(job)));
    } catch (error) {
      this.logger.error({ err: error }, 'evidence scan polling failed');
    } finally {
      this.running = false;
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }

  private async handle(job: EvidenceJob) {
    try {
      const evidence = await this.store.getEvidence(job.evidenceId);
      if (!evidence || evidence.status !== 'pending_scan') {
        await this.store.completeJob(job.id, this.now());
        return;
      }
      const bytes = await this.objects.readBytes(evidence.object_key);
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (bytes.byteLength !== Number(evidence.size_bytes) || digest !== evidence.sha256_digest) {
        await this.objects.delete(evidence.object_key);
        await this.store.rejected(evidence.id, 'content_digest_mismatch', this.now());
        await this.store.completeJob(job.id, this.now());
        return;
      }
      if (!detectedEvidenceType(bytes, evidence.mime_type)) {
        await this.objects.delete(evidence.object_key);
        await this.store.rejected(evidence.id, 'content_type_mismatch', this.now());
        await this.store.completeJob(job.id, this.now());
        return;
      }
      const scan = await this.scanner.scan(bytes);
      if (!scan.clean) {
        await this.objects.delete(evidence.object_key);
        await this.store.rejected(evidence.id, `malware_detected:${scan.signature ?? 'unknown'}`, this.now());
      } else await this.store.verified(evidence.id, this.now());
      await this.store.completeJob(job.id, this.now());
    } catch (error) {
      const errorCode = code(error);
      const failure = job.attempts + 1;
      if (failure >= 8) await this.store.scanFailed(job.evidenceId, errorCode, this.now());
      const retryAt = new Date(this.now().getTime() + Math.min(30 * 60_000, 10_000 * 2 ** Math.min(failure - 1, 7)));
      const failed = await this.store.failJob(job.id, errorCode, retryAt, 8);
      if (failed.deadLettered) this.logger.error({ err: error, evidenceId: job.evidenceId, errorCode }, 'evidence scan dead-lettered');
      else this.logger.info({ err: error, evidenceId: job.evidenceId, errorCode, attempts: failed.attempts }, 'evidence scan scheduled for retry');
    }
  }
}
