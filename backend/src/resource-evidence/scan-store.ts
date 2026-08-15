import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { EvidenceJob, EvidenceWorkerStore, ScanRecord } from '../evidence/worker.js';
import { ResourceEvidenceStore } from './store.js';

type JobRow = QueryResultRow & {
  id: string; aggregate_id: string; attempts: number; created_at: Date;
};

export class ResourceEvidenceScanStore implements EvidenceWorkerStore {
  private readonly evidence: ResourceEvidenceStore;

  constructor(private readonly database: Database) {
    this.evidence = new ResourceEvidenceStore(database);
  }

  async claim(now: Date, staleBefore: Date, limit: number): Promise<EvidenceJob[]> {
    return this.database.transaction(async (client) => {
      const result = await client.query<JobRow>(
        `WITH candidates AS (
           SELECT id FROM outbox_events WHERE topic = 'resource.evidence.scan' AND processed_at IS NULL
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

  async getEvidence(evidenceId: string): Promise<ScanRecord | null> {
    const result = await this.database.query<ScanRecord>(
      `SELECT id, resource_id AS dispute_id, submitted_by, object_key, mime_type,
         size_bytes::text, sha256_digest, status
       FROM resource_verification_evidence WHERE id = $1`, [evidenceId],
    );
    return result.rows[0] ?? null;
  }

  async verified(evidenceId: string, now: Date) { await this.evidence.transitionScan(evidenceId, 'verified', 'clean', now); }
  async rejected(evidenceId: string, reason: string, now: Date) { await this.evidence.transitionScan(evidenceId, 'rejected', reason, now); }
  async scanFailed(evidenceId: string, reason: string, now: Date) { await this.evidence.transitionScan(evidenceId, 'scan_failed', reason, now); }

  async completeJob(jobId: string, now: Date) {
    await this.database.query(
      `UPDATE outbox_events SET processed_at = $2, locked_at = NULL, last_error = NULL WHERE id = $1`, [jobId, now],
    );
  }

  async failJob(jobId: string, code: string, availableAt: Date, maxAttempts: number) {
    const result = await this.database.query<{ attempts: number; dead_lettered_at: Date | null }>(
      `UPDATE outbox_events SET attempts = attempts + 1, last_error = $2, available_at = $3, locked_at = NULL,
         dead_lettered_at = CASE WHEN attempts + 1 >= $4 THEN now() ELSE NULL END
       WHERE id = $1 RETURNING attempts, dead_lettered_at`, [jobId, code.slice(0, 300), availableAt, maxAttempts],
    );
    return { attempts: result.rows[0]?.attempts ?? maxAttempts, deadLettered: Boolean(result.rows[0]?.dead_lettered_at) };
  }
}
