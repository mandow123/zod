import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { ResourceEvidenceCategory, ResourceEvidenceChecklist, ResourceEvidenceRecord, ResourceEvidenceStatus } from './types.js';

type EvidenceRow = QueryResultRow & {
  id: string; resource_id: string; supplier_id: string; submitted_by: string; category: ResourceEvidenceCategory;
  object_key: string; file_name: string; mime_type: ResourceEvidenceRecord['mimeType']; size_bytes: string;
  sha256_digest: string; status: ResourceEvidenceStatus; scan_result: string | null; retention_until: Date;
  created_at: Date; uploaded_at: Date | null; verified_at: Date | null; rejected_at: Date | null;
};

const columns = `id, resource_id, supplier_id, submitted_by, category, object_key, file_name, mime_type,
  size_bytes::text, sha256_digest, status, scan_result, retention_until, created_at, uploaded_at, verified_at, rejected_at`;

function mapEvidence(row: EvidenceRow): ResourceEvidenceRecord {
  return {
    id: row.id, resourceId: row.resource_id, supplierId: row.supplier_id, submittedBy: row.submitted_by,
    category: row.category, objectKey: row.object_key, fileName: row.file_name, mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes), sha256Digest: row.sha256_digest, status: row.status, scanResult: row.scan_result,
    retentionUntil: new Date(row.retention_until), createdAt: new Date(row.created_at),
    uploadedAt: row.uploaded_at ? new Date(row.uploaded_at) : null,
    verifiedAt: row.verified_at ? new Date(row.verified_at) : null,
    rejectedAt: row.rejected_at ? new Date(row.rejected_at) : null,
  };
}

function categoryState(evidence: ResourceEvidenceRecord | null) {
  if (!evidence) return 'missing' as const;
  if (evidence.status === 'pending_upload') return 'uploading' as const;
  if (evidence.status === 'pending_scan') return 'checking' as const;
  if (evidence.status === 'verified') return 'ready' as const;
  return 'needs_replacement' as const;
}

const evidenceCategories = ['ownership', 'configuration', 'availability'] as const;

function rejectedCategories(checks: Record<string, unknown> | null) {
  if (!checks) return new Set<ResourceEvidenceCategory>(evidenceCategories);
  const hasExplicitDecision = evidenceCategories.some((category) => typeof checks[category] === 'boolean');
  const rejected = evidenceCategories.filter((category) => checks[category] === false);
  return new Set<ResourceEvidenceCategory>(hasExplicitDecision && rejected.length > 0 ? rejected : evidenceCategories);
}

export type CreateResourceEvidenceResult =
  | Readonly<{ status: 'created' | 'replayed'; evidence: ResourceEvidenceRecord }>
  | Readonly<{ status: 'not_found' | 'invalid_state' | 'limit_reached' | 'idempotency_conflict' }>;

export type SubmitResourceEvidenceResult =
  | Readonly<{ status: 'created' | 'replayed'; runId: string; submittedAt: Date }>
  | Readonly<{ status: 'not_found' | 'invalid_state' | 'materials_incomplete' | 'idempotency_conflict' }>;

export class ResourceEvidenceStore {
  constructor(private readonly database: Database) {}

  async checklist(subjectId: string, resourceId: string): Promise<ResourceEvidenceChecklist | null> {
    const resource = await this.database.query<{
      status: ResourceEvidenceChecklist['resourceStatus']; run_id: string | null; run_status: string | null;
      requested_at: Date | null; materials_submitted_at: Date | null; correction_note: string | null;
      correction_checks: Record<string, unknown> | null;
    }>(
      `SELECT r.status, vr.id AS run_id, vr.status AS run_status, vr.requested_at, vr.materials_submitted_at,
         CASE WHEN vr.status IN ('pending', 'running', 'failed') THEN previous.failure_reason ELSE NULL END AS correction_note,
         CASE WHEN vr.status IN ('pending', 'running', 'failed') THEN previous.checks ELSE NULL END AS correction_checks
       FROM compute_resources r JOIN supplier_profiles s ON s.id = r.supplier_id
       LEFT JOIN LATERAL (
         SELECT id, status, requested_at, materials_submitted_at FROM resource_verification_runs
         WHERE resource_id = r.id ORDER BY requested_at DESC LIMIT 1
       ) vr ON true
       LEFT JOIN LATERAL (
         SELECT failure_reason, checks FROM resource_verification_runs
         WHERE resource_id = r.id AND status = 'failed' AND failure_reason IS NOT NULL
         ORDER BY requested_at DESC LIMIT 1
       ) previous ON true
       WHERE r.id = $1 AND s.subject_id = $2`, [resourceId, subjectId],
    );
    const resourceRow = resource.rows[0];
    if (!resourceRow) return null;
    const evidence = await this.database.query<EvidenceRow>(
      `SELECT DISTINCT ON (category) ${columns} FROM resource_verification_evidence
       WHERE resource_id = $1 AND status <> 'deleted'
       ORDER BY category, created_at DESC, id DESC`, [resourceId],
    );
    const latest = new Map(evidence.rows.map((row) => [row.category, mapEvidence(row)]));
    const ownership = latest.get('ownership') ?? null;
    const configuration = latest.get('configuration') ?? null;
    const availability = latest.get('availability') ?? null;
    const replacements = resourceRow.correction_note ? rejectedCategories(resourceRow.correction_checks) : new Set<ResourceEvidenceCategory>();
    const category = (key: ResourceEvidenceCategory, item: ResourceEvidenceRecord | null) => {
      const mustReplace = replacements.has(key);
      const replacementUploaded = Boolean(item && ['pending', 'running'].includes(resourceRow.run_status ?? '') && resourceRow.requested_at
        && item.createdAt.getTime() >= new Date(resourceRow.requested_at).getTime());
      return {
        state: mustReplace && !replacementUploaded ? 'needs_replacement' as const : categoryState(item),
        reviewDecision: resourceRow.correction_note ? (mustReplace ? 'replace' as const : 'accepted' as const) : null,
        evidence: item,
      };
    };
    const categories = {
      ownership: category('ownership', ownership),
      configuration: category('configuration', configuration),
      availability: category('availability', availability),
    } as const;
    return {
      resourceId, resourceStatus: resourceRow.status,
      review: {
        runId: resourceRow.run_id,
        status: resourceRow.run_status === 'pending' ? 'collecting'
          : resourceRow.run_status === 'running' ? 'under_review'
            : resourceRow.run_status === 'passed' ? 'passed'
              : resourceRow.run_status === 'failed' ? 'failed' : 'unavailable',
        requestedAt: resourceRow.requested_at ? new Date(resourceRow.requested_at) : null,
        submittedAt: resourceRow.materials_submitted_at ? new Date(resourceRow.materials_submitted_at) : null,
        correctionNote: resourceRow.correction_note,
      },
      categories,
      readyToSubmit: resourceRow.run_status === 'pending'
        && Object.values(categories).every((item) => item.state === 'ready'),
    };
  }

  async create(input: Readonly<{
    id: string; subjectId: string; userId: string; resourceId: string; category: ResourceEvidenceCategory;
    objectKey: string; fileName: string; mimeType: ResourceEvidenceRecord['mimeType']; sizeBytes: number;
    sha256Digest: string; retentionUntil: Date; clientRequestId: string; payloadDigest: string;
  }>): Promise<CreateResourceEvidenceResult> {
    return this.database.transaction(async (client) => {
      const resource = await client.query<{ supplier_id: string; status: ResourceEvidenceChecklist['resourceStatus'] }>(
        `SELECT r.supplier_id, r.status FROM compute_resources r JOIN supplier_profiles s ON s.id = r.supplier_id
         WHERE r.id = $1 AND s.subject_id = $2 FOR UPDATE OF r`, [input.resourceId, input.subjectId],
      );
      const row = resource.rows[0];
      if (!row) return { status: 'not_found' };
      const replay = await client.query<EvidenceRow & { payload_digest: string }>(
        `SELECT ${columns}, payload_digest FROM resource_verification_evidence
         WHERE supplier_id = $1 AND client_request_id = $2 FOR UPDATE`, [row.supplier_id, input.clientRequestId],
      );
      if (replay.rows[0]) return replay.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', evidence: mapEvidence(replay.rows[0]) }
        : { status: 'idempotency_conflict' };
      if (['verified', 'suspended', 'retired'].includes(row.status)) return { status: 'invalid_state' };
      const run = await client.query<{ status: string; requested_at: Date }>(
        `SELECT status, requested_at FROM resource_verification_runs WHERE resource_id = $1
         ORDER BY requested_at DESC LIMIT 1 FOR UPDATE`, [input.resourceId],
      );
      if (row.status !== 'pending_verification' || run.rows[0]?.status !== 'pending') return { status: 'invalid_state' };
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM resource_verification_evidence
         WHERE resource_id = $1 AND status <> 'deleted' AND created_at >= $2`,
        [input.resourceId, run.rows[0].requested_at],
      );
      if (Number(count.rows[0]?.count ?? 0) >= 12) return { status: 'limit_reached' };
      const created = await client.query<EvidenceRow>(
        `INSERT INTO resource_verification_evidence(id, resource_id, supplier_id, submitted_by, category,
          object_key, file_name, mime_type, size_bytes, sha256_digest, status, client_request_id,
          payload_digest, retention_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_upload', $11, $12, $13)
         RETURNING ${columns}`,
        [input.id, input.resourceId, row.supplier_id, input.userId, input.category, input.objectKey,
          input.fileName, input.mimeType, input.sizeBytes, input.sha256Digest, input.clientRequestId,
          input.payloadDigest, input.retentionUntil],
      );
      return { status: 'created', evidence: mapEvidence(created.rows[0]!) };
    });
  }

  async get(subjectId: string, resourceId: string, evidenceId: string) {
    const result = await this.database.query<EvidenceRow>(
      `SELECT e.${columns.replaceAll(', ', ', e.')} FROM resource_verification_evidence e
       JOIN compute_resources r ON r.id = e.resource_id JOIN supplier_profiles s ON s.id = r.supplier_id
       WHERE e.id = $1 AND e.resource_id = $2 AND s.subject_id = $3 AND e.status <> 'deleted'`,
      [evidenceId, resourceId, subjectId],
    );
    return result.rows[0] ? mapEvidence(result.rows[0]) : null;
  }

  async reviewBundle(resourceId: string) {
    const run = await this.database.query<{
      run_id: string; run_status: string; submitted_at: Date; submission_id: string; submitted_by: string;
    }>(
      `SELECT vr.id AS run_id, vr.status AS run_status, s.submitted_at, s.id AS submission_id, s.submitted_by
       FROM resource_verification_runs vr
       JOIN resource_verification_material_submissions s ON s.verification_run_id = vr.id
       WHERE vr.resource_id = $1 ORDER BY vr.requested_at DESC LIMIT 1`, [resourceId],
    );
    if (!run.rows[0]) return null;
    const evidence = await this.database.query<EvidenceRow>(
      `SELECT e.${columns.replaceAll(', ', ', e.')} FROM resource_verification_material_items i
       JOIN resource_verification_evidence e ON e.id = i.evidence_id
       WHERE i.submission_id = $1 ORDER BY i.category`, [run.rows[0].submission_id],
    );
    return {
      resourceId, runId: run.rows[0].run_id, runStatus: run.rows[0].run_status,
      submittedAt: new Date(run.rows[0].submitted_at), submittedBy: run.rows[0].submitted_by,
      materials: evidence.rows.map(mapEvidence),
    };
  }

  async submittedEvidence(resourceId: string, evidenceId: string) {
    const result = await this.database.query<EvidenceRow>(
      `SELECT e.${columns.replaceAll(', ', ', e.')} FROM resource_verification_material_items i
       JOIN resource_verification_material_submissions s ON s.id = i.submission_id
       JOIN resource_verification_evidence e ON e.id = i.evidence_id
       WHERE s.resource_id = $1 AND e.id = $2 AND e.status = 'verified'
       ORDER BY s.submitted_at DESC LIMIT 1`, [resourceId, evidenceId],
    );
    return result.rows[0] ? mapEvidence(result.rows[0]) : null;
  }

  async uploaded(evidenceId: string, now: Date) {
    return this.database.transaction(async (client) => {
      const result = await client.query<EvidenceRow>(
        `UPDATE resource_verification_evidence SET status = 'pending_scan', uploaded_at = $2
         WHERE id = $1 AND status = 'pending_upload' RETURNING ${columns}`, [evidenceId, now],
      );
      if (!result.rows[0]) return null;
      await client.query(
        `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
         VALUES ($1, 'resource.evidence.scan', 'RESOURCE_EVIDENCE', $2, $3::jsonb)`,
        [randomUUID(), evidenceId, JSON.stringify({ evidenceId })],
      );
      return mapEvidence(result.rows[0]);
    });
  }

  async discard(subjectId: string, resourceId: string, evidenceId: string) {
    const result = await this.database.query<EvidenceRow>(
      `UPDATE resource_verification_evidence e SET status = 'deleted', scan_result = 'discarded_by_submitter'
       FROM compute_resources r, supplier_profiles s
       WHERE e.id = $1 AND e.resource_id = $2 AND r.id = e.resource_id AND s.id = r.supplier_id
         AND s.subject_id = $3 AND e.status IN ('pending_upload', 'rejected', 'scan_failed')
       RETURNING e.${columns.replaceAll(', ', ', e.')}`, [evidenceId, resourceId, subjectId],
    );
    return result.rows[0] ? mapEvidence(result.rows[0]) : null;
  }

  async transitionScan(evidenceId: string, status: 'verified' | 'rejected' | 'scan_failed', result: string, now: Date) {
    return this.database.transaction(async (client) => {
      const current = await client.query<EvidenceRow>(
        `SELECT ${columns} FROM resource_verification_evidence WHERE id = $1 FOR UPDATE`, [evidenceId],
      );
      const row = current.rows[0];
      if (!row || row.status !== 'pending_scan') return null;
      const updated = await client.query<EvidenceRow>(
        `UPDATE resource_verification_evidence SET status = $2, scan_result = $3,
           verified_at = CASE WHEN $2::text = 'verified' THEN $4::timestamptz ELSE NULL END,
           rejected_at = CASE WHEN $2::text <> 'verified' THEN $4::timestamptz ELSE NULL END
         WHERE id = $1 RETURNING ${columns}`, [evidenceId, status, result.slice(0, 300), now],
      );
      if (!updated.rows[0]) return null;
      const evidence = mapEvidence(updated.rows[0]);
      const supplier = await client.query<{ subject_id: string }>(
        `SELECT subject_id FROM supplier_profiles WHERE id = $1`, [evidence.supplierId],
      );
      const notificationId = randomUUID();
      const title = status === 'verified' ? '资源材料检查完成' : status === 'scan_failed' ? '资源材料检查延迟' : '资源材料需要更换';
      const body = status === 'verified' ? '文件已通过安全检查。' : status === 'scan_failed' ? '安全检查暂时不可用，平台会继续处理。' : '文件格式或安全检查未通过，请重新上传。';
      await client.query(
        `INSERT INTO notifications(id, user_id, category, title, body, data)
         VALUES ($1, $2, 'market', $3, $4, $5::jsonb)`,
        [notificationId, evidence.submittedBy, title, body, JSON.stringify({
          route: 'provider_resource', subjectId: supplier.rows[0]?.subject_id,
          resourceId: evidence.resourceId, evidenceId: evidence.id,
        })],
      );
      await client.query(
        `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
         VALUES ($1, 'notification.created', 'NOTIFICATION', $2, $3::jsonb)`,
        [randomUUID(), notificationId, JSON.stringify({ notificationId, userId: evidence.submittedBy })],
      );
      return evidence;
    });
  }

  async submit(input: Readonly<{
    id: string; subjectId: string; userId: string; resourceId: string; clientRequestId: string;
    payloadDigest: string; now: Date;
  }>): Promise<SubmitResourceEvidenceResult> {
    return this.database.transaction(async (client) => {
      const resource = await client.query<{ supplier_id: string; status: string }>(
        `SELECT r.supplier_id, r.status FROM compute_resources r JOIN supplier_profiles s ON s.id = r.supplier_id
         WHERE r.id = $1 AND s.subject_id = $2 FOR UPDATE OF r`, [input.resourceId, input.subjectId],
      );
      const row = resource.rows[0];
      if (!row) return { status: 'not_found' };
      const replay = await client.query<{
        resource_id: string; verification_run_id: string; payload_digest: string; submitted_at: Date;
      }>(
        `SELECT resource_id, verification_run_id, payload_digest, submitted_at
         FROM resource_verification_material_submissions
         WHERE supplier_id = $1 AND client_request_id = $2 FOR UPDATE`, [row.supplier_id, input.clientRequestId],
      );
      if (replay.rows[0]) return replay.rows[0].resource_id === input.resourceId
        && replay.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', runId: replay.rows[0].verification_run_id, submittedAt: new Date(replay.rows[0].submitted_at) }
        : { status: 'idempotency_conflict' };
      if (row.status !== 'pending_verification') return { status: 'invalid_state' };
      const run = await client.query<{ id: string; status: string; requested_at: Date }>(
        `SELECT id, status, requested_at FROM resource_verification_runs WHERE resource_id = $1
         ORDER BY requested_at DESC LIMIT 1 FOR UPDATE`, [input.resourceId],
      );
      if (!run.rows[0] || run.rows[0].status !== 'pending') return { status: 'invalid_state' };
      const previous = await client.query<{ checks: Record<string, unknown> }>(
        `SELECT checks FROM resource_verification_runs
         WHERE resource_id = $1 AND status = 'failed' AND requested_at < $2
         ORDER BY requested_at DESC LIMIT 1`, [input.resourceId, run.rows[0].requested_at],
      );
      const replacements = previous.rows[0] ? rejectedCategories(previous.rows[0].checks) : new Set<ResourceEvidenceCategory>();
      const evidence = await client.query<EvidenceRow>(
        `SELECT ${columns} FROM resource_verification_evidence
         WHERE resource_id = $1 AND status <> 'deleted'
         ORDER BY category, created_at DESC, id DESC FOR UPDATE`, [input.resourceId],
      );
      const categoryEvidence = new Map<ResourceEvidenceCategory, EvidenceRow>();
      for (const item of evidence.rows) if (!categoryEvidence.has(item.category)) categoryEvidence.set(item.category, item);
      if (categoryEvidence.get('ownership')?.status !== 'verified'
        || categoryEvidence.get('configuration')?.status !== 'verified'
        || categoryEvidence.get('availability')?.status !== 'verified'
        || [...replacements].some((category) => {
          const item = categoryEvidence.get(category);
          return !item || new Date(item.created_at).getTime() < new Date(run.rows[0]!.requested_at).getTime();
        })) {
        return { status: 'materials_incomplete' };
      }
      await client.query(
        `INSERT INTO resource_verification_material_submissions(
           id, resource_id, supplier_id, verification_run_id, submitted_by, client_request_id, payload_digest, submitted_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [input.id, input.resourceId, row.supplier_id, run.rows[0].id, input.userId, input.clientRequestId, input.payloadDigest, input.now],
      );
      for (const category of ['ownership', 'configuration', 'availability'] as const) {
        const item = categoryEvidence.get(category)!;
        await client.query(
          `INSERT INTO resource_verification_material_items(submission_id, evidence_id, category, sha256_digest)
           VALUES ($1, $2, $3, $4)`, [input.id, item.id, category, item.sha256_digest],
        );
      }
      await client.query(
        `UPDATE resource_verification_runs SET status = 'running', materials_submitted_at = $2 WHERE id = $1`,
        [run.rows[0].id, input.now],
      );
      const notificationId = randomUUID();
      await client.query(
        `INSERT INTO notifications(id, user_id, category, title, body, data)
         VALUES ($1, $2, 'market', '资源材料已送审', '平台已开始核验，结果会通过消息通知。', $3::jsonb)`,
        [notificationId, input.userId, JSON.stringify({
          route: 'provider_resource', subjectId: input.subjectId,
          resourceId: input.resourceId, verificationRunId: run.rows[0].id,
        })],
      );
      await client.query(
        `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
         VALUES ($1, 'notification.created', 'NOTIFICATION', $2, $3::jsonb)`,
        [randomUUID(), notificationId, JSON.stringify({ notificationId, userId: input.userId })],
      );
      return { status: 'created', runId: run.rows[0].id, submittedAt: input.now };
    });
  }
}
