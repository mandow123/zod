import { randomUUID } from 'node:crypto';
import type { Database } from '../database.js';
import type { KaiCloudVerification, KaiCloudVerificationStatus } from './types.js';

type VerificationRow = Readonly<{
  id: string; asset_id: string; subject_id: string; upstream_verification_id: string; upstream_version: number;
  status: KaiCloudVerificationStatus; start_idempotency_key: string; request_payload_digest: string;
  failure_code: string | null; failure_message: string | null; upstream_updated_at: Date;
  last_synced_at: Date; created_at: Date; updated_at: Date;
}>;

export type StoredKaiCloudVerification = Readonly<{
  id: string; assetId: string; subjectId: string; upstreamVerificationId: string; upstreamVersion: number;
  status: KaiCloudVerificationStatus; startIdempotencyKey: string; requestPayloadDigest: string;
  failure: KaiCloudVerification['failure']; upstreamUpdatedAt: Date; lastSyncedAt: Date;
  createdAt: Date; updatedAt: Date;
}>;

export class KaiCloudVerificationStore {
  constructor(private readonly database: Database) {}

  async asset(subjectId: string, assetId: string) {
    const result = await this.database.query<{ asset_id: string; resource_id: string; product_code: string;
      region: string; specifications: Record<string, unknown> }>(
      `SELECT a.id AS asset_id,r.id AS resource_id,r.product_code,r.region,r.specifications
       FROM compute_assets a JOIN supplier_profiles s ON s.id=a.supplier_id
       JOIN compute_resources r ON r.asset_id=a.id AND r.supplier_id=a.supplier_id
       WHERE a.id=$1 AND s.subject_id=$2 AND a.lifecycle_status<>'retired'
       ORDER BY r.updated_at DESC LIMIT 1`, [assetId, subjectId],
    );
    const row = result.rows[0];
    return row ? { assetId: row.asset_id, resourceId: row.resource_id, productCode: row.product_code,
      region: row.region, specifications: row.specifications } : null;
  }

  async find(subjectId: string, assetId: string) {
    const result = await this.database.query<VerificationRow>(
      `SELECT * FROM kai_cloud_resource_verifications WHERE subject_id=$1 AND asset_id=$2`, [subjectId, assetId]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async save(input: Readonly<{ id?: string; subjectId: string; assetId: string; startIdempotencyKey: string;
    requestPayloadDigest: string; verification: KaiCloudVerification; source: 'api' | 'webhook' | 'revoke'; now: Date }>) {
    return this.database.transaction(async (client) => {
      const result = await client.query<VerificationRow>(
        `INSERT INTO kai_cloud_resource_verifications(id,asset_id,subject_id,upstream_verification_id,upstream_version,status,
           start_idempotency_key,request_payload_digest,failure_code,failure_message,upstream_updated_at,last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (asset_id) DO UPDATE SET
           subject_id=EXCLUDED.subject_id,upstream_verification_id=EXCLUDED.upstream_verification_id,upstream_version=EXCLUDED.upstream_version,
           status=EXCLUDED.status,start_idempotency_key=EXCLUDED.start_idempotency_key,
           request_payload_digest=EXCLUDED.request_payload_digest,failure_code=EXCLUDED.failure_code,
           failure_message=EXCLUDED.failure_message,upstream_updated_at=EXCLUDED.upstream_updated_at,
           last_synced_at=EXCLUDED.last_synced_at
         RETURNING *`, [input.id ?? randomUUID(), input.assetId, input.subjectId, input.verification.id, input.verification.version,
          input.verification.status, input.startIdempotencyKey, input.requestPayloadDigest,
          input.verification.failure?.code ?? null, input.verification.failure?.message ?? null,
          new Date(input.verification.updatedAt), input.now],
      );
      const saved = result.rows[0]!;
      await client.query(
        `INSERT INTO kai_cloud_resource_verification_events(id,verification_id,status,source,upstream_updated_at,failure_code)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [randomUUID(), saved.id, saved.status, input.source, saved.upstream_updated_at, saved.failure_code],
      );
      return map(saved);
    });
  }

  async applyWebhook(input: Readonly<{ deliveryId: string; eventType: string; payloadDigest: string;
    verification: KaiCloudVerification; now: Date }>) {
    return this.database.transaction(async (client) => {
      const delivery = await client.query<{ payload_digest: string }>(
        `INSERT INTO kai_cloud_webhook_deliveries(delivery_id,event_type,payload_digest)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING payload_digest`,
        [input.deliveryId, input.eventType, input.payloadDigest],
      );
      if (!delivery.rowCount) {
        const previous = await client.query<{ payload_digest: string }>(
          'SELECT payload_digest FROM kai_cloud_webhook_deliveries WHERE delivery_id=$1', [input.deliveryId]);
        return previous.rows[0]?.payload_digest === input.payloadDigest ? 'replayed' as const : 'delivery_conflict' as const;
      }
      const current = await client.query<VerificationRow>(
        'SELECT * FROM kai_cloud_resource_verifications WHERE upstream_verification_id=$1 FOR UPDATE',
        [input.verification.id]);
      const row = current.rows[0]; if (!row) return 'not_found' as const;
      if (input.verification.version <= row.upstream_version) return 'stale' as const;
      const updated = await client.query<VerificationRow>(
        `UPDATE kai_cloud_resource_verifications SET status=$2,upstream_version=$3,failure_code=$4,failure_message=$5,
           upstream_updated_at=$6,last_synced_at=$7 WHERE id=$1 RETURNING *`,
        [row.id, input.verification.status, input.verification.version, input.verification.failure?.code ?? null,
          input.verification.failure?.message ?? null, new Date(input.verification.updatedAt), input.now],
      );
      await client.query(
        `INSERT INTO kai_cloud_resource_verification_events(id,verification_id,status,source,upstream_updated_at,failure_code)
         VALUES ($1,$2,$3,'webhook',$4,$5) ON CONFLICT DO NOTHING`,
        [randomUUID(), row.id, input.verification.status, new Date(input.verification.updatedAt),
          input.verification.failure?.code ?? null],
      );
      return { status: 'updated' as const, verification: map(updated.rows[0]!) };
    });
  }
}

function map(row: VerificationRow): StoredKaiCloudVerification {
  return { id: row.id, assetId: row.asset_id, subjectId: row.subject_id,
    upstreamVerificationId: row.upstream_verification_id, upstreamVersion: Number(row.upstream_version), status: row.status,
    startIdempotencyKey: row.start_idempotency_key, requestPayloadDigest: row.request_payload_digest,
    failure: row.failure_code && row.failure_message ? { code: row.failure_code, message: row.failure_message } : null,
    upstreamUpdatedAt: row.upstream_updated_at, lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
