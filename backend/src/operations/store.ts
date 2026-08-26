import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';

export type OperationalCounts = Readonly<{
  paymentPending: number;
  paymentOverdue: number;
  paymentDeadLetters: number;
  refundProviderPendingStale: number;
  outboxPending: number;
  outboxDeadLetters: number;
  evidencePendingScanStale: number;
  evidenceScanFailed: number;
  invoiceRequestedStale: number;
  invoiceProcessingStale: number;
  invoiceRedPendingStale: number;
  disputesReadyForReview: number;
  deliveryStale: number;
  reservationOverdue: number;
  auditEvents24h: number;
  backupSucceeded24h: number;
  backupFailures24h: number;
  restoreDrillSucceeded90d: number;
  oldestOutboxAgeSeconds: number;
  adminLoginSucceeded24h: number;
  adminLoginDenied24h: number;
  adminLoginFailed24h: number;
  adminSecurityDenials24h: number;
  adminOperationFailures24h: number;
  adminActiveSessions: number;
  adminRevokedSessions24h: number;
}>;

type SnapshotRow = QueryResultRow & Record<keyof OperationalCounts, string | number | null>;

const fields: Array<keyof OperationalCounts> = [
  'paymentPending', 'paymentOverdue', 'paymentDeadLetters', 'refundProviderPendingStale',
  'outboxPending', 'outboxDeadLetters', 'evidencePendingScanStale', 'evidenceScanFailed',
  'invoiceRequestedStale', 'invoiceProcessingStale', 'invoiceRedPendingStale',
  'disputesReadyForReview', 'deliveryStale', 'reservationOverdue', 'auditEvents24h', 'oldestOutboxAgeSeconds',
  'backupSucceeded24h', 'backupFailures24h', 'restoreDrillSucceeded90d',
  'adminLoginSucceeded24h', 'adminLoginDenied24h', 'adminLoginFailed24h',
  'adminSecurityDenials24h', 'adminOperationFailures24h', 'adminActiveSessions', 'adminRevokedSessions24h',
];

export type InquiryOperationalReadiness = Readonly<{
  backupArtifactReady: boolean;
  backupArtifact: Readonly<{artifactName:string;location:string;encryptedSizeBytes:number;
    sha256Digest:string;schemaVersion:string}>|null;
  restoreDrillReady: boolean;
  kaiPairedProbeReady: boolean;
  appSessionProbeReady: boolean;
  kaiPairedProbeEvidence: Readonly<{payloadDigest:string;metadata:Record<string,unknown>}>|null;
  appSessionProbeEvidence: Readonly<{payloadDigest:string;metadata:Record<string,unknown>}>|null;
}>;

const restoreInvariantKeys = [
  'listing_capacity_invalid', 'order_amount_invalid', 'duplicate_success_payment', 'refund_amount_invalid',
  'kai_credit_transaction_unbalanced', 'kai_credit_account_negative', 'kai_credit_order_invalid',
  'kai_credit_reservation_invalid', 'kai_credit_listing_capacity_invalid', 'kai_credit_delivery_invalid',
  'kai_credit_acceptance_invalid', 'kai_credit_delivery_issue_invalid', 'kai_credit_mutual_refund_invalid',
  'kai_credit_supplier_settlement_invalid', 'kai_credit_dispute_adjudication_invalid',
  'kai_credit_post_acceptance_refund_invalid', 'kai_credit_post_acceptance_adjudication_invalid',
] as const;

export interface OperationsStore {
  snapshot(now: Date): Promise<OperationalCounts>;
  inquiryReadiness(now: Date, currentDatabaseFingerprint: string): Promise<InquiryOperationalReadiness>;
}

export class PostgresOperationsStore implements OperationsStore {
  constructor(private readonly database: Database) {}

  async snapshot(now: Date): Promise<OperationalCounts> {
    const result = await this.database.query<SnapshotRow>(
      `SELECT
         (SELECT count(*) FROM payment_intents WHERE status = 'pending')::text AS "paymentPending",
         (SELECT count(*) FROM payment_intents WHERE status = 'pending' AND expires_at <= $1)::text AS "paymentOverdue",
         (SELECT count(*) FROM payment_intents WHERE reconciliation_dead_lettered_at IS NOT NULL)::text AS "paymentDeadLetters",
         (SELECT count(*) FROM refunds WHERE status = 'provider_pending' AND updated_at < $1 - interval '2 hours')::text AS "refundProviderPendingStale",
         (SELECT count(*) FROM outbox_events WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND available_at <= $1)::text AS "outboxPending",
         (SELECT count(*) FROM outbox_events WHERE dead_lettered_at IS NOT NULL)::text AS "outboxDeadLetters",
         (SELECT count(*) FROM dispute_evidence WHERE status = 'pending_scan' AND uploaded_at < $1 - interval '30 minutes')::text AS "evidencePendingScanStale",
         (SELECT count(*) FROM dispute_evidence WHERE status = 'scan_failed')::text AS "evidenceScanFailed",
         (SELECT count(*) FROM invoices WHERE status = 'requested' AND created_at < $1 - interval '24 hours')::text AS "invoiceRequestedStale",
         (SELECT count(*) FROM invoices WHERE status = 'processing' AND processing_started_at < $1 - interval '2 hours')::text AS "invoiceProcessingStale",
         (SELECT count(*) FROM invoices WHERE status = 'red_pending' AND updated_at < $1 - interval '24 hours')::text AS "invoiceRedPendingStale",
         (SELECT count(*) FROM disputes WHERE status IN ('open', 'evidence_pending') AND evidence_deadline <= $1)::text AS "disputesReadyForReview",
         (SELECT count(*) FROM orders WHERE status IN ('paid', 'delivery_pending', 'delivering', 'acceptance_pending')
            AND updated_at < $1 - interval '24 hours')::text AS "deliveryStale",
         (SELECT count(*) FROM capacity_reservations WHERE status = 'active' AND expires_at <= $1)::text AS "reservationOverdue",
         (SELECT count(*) FROM audit_events WHERE created_at >= $1 - interval '24 hours')::text AS "auditEvents24h",
         (SELECT count(*) FROM backup_runs WHERE status = 'succeeded' AND completed_at >= $1 - interval '24 hours')::text AS "backupSucceeded24h",
         (SELECT count(*) FROM backup_runs WHERE status = 'failed' AND completed_at >= $1 - interval '24 hours')::text AS "backupFailures24h",
         (SELECT count(*) FROM restore_drills WHERE status = 'succeeded' AND completed_at >= $1 - interval '90 days')::text AS "restoreDrillSucceeded90d",
         COALESCE((SELECT floor(extract(epoch FROM ($1 - min(created_at))))
           FROM outbox_events WHERE processed_at IS NULL AND dead_lettered_at IS NULL), 0)::text AS "oldestOutboxAgeSeconds",
         (SELECT count(*) FROM admin_audit_events
           WHERE occurred_at >= $1 - interval '24 hours'
             AND action = 'admin.auth.login.succeeded' AND outcome = 'succeeded')::text AS "adminLoginSucceeded24h",
         (SELECT count(*) FROM admin_audit_events
           WHERE occurred_at >= $1 - interval '24 hours'
             AND action = 'admin.auth.login.failed' AND outcome = 'denied')::text AS "adminLoginDenied24h",
         (SELECT count(*) FROM admin_audit_events
           WHERE occurred_at >= $1 - interval '24 hours'
             AND action = 'admin.auth.login.failed' AND outcome = 'failed')::text AS "adminLoginFailed24h",
         (SELECT count(*) FROM admin_audit_events
           WHERE occurred_at >= $1 - interval '24 hours' AND outcome = 'denied'
             AND action IN ('admin.auth.origin.denied', 'admin.auth.session.denied',
               'admin.auth.csrf.denied', 'admin.auth.permission.denied'))::text AS "adminSecurityDenials24h",
         (SELECT count(*) FROM admin_audit_events
           WHERE occurred_at >= $1 - interval '24 hours' AND outcome = 'failed')::text AS "adminOperationFailures24h",
         (SELECT count(*) FROM admin_sessions
           WHERE status = 'active' AND idle_expires_at > $1 AND absolute_expires_at > $1)::text AS "adminActiveSessions",
         (SELECT count(*) FROM admin_sessions
           WHERE status = 'revoked' AND revoked_at >= $1 - interval '24 hours')::text AS "adminRevokedSessions24h"`,
      [now],
    );
    const row = result.rows[0];
    if (!row) throw new Error('OPERATIONS_SNAPSHOT_EMPTY');
    return Object.fromEntries(fields.map((field) => [field, Math.max(0, Number(row[field] ?? 0))])) as OperationalCounts;
  }

  async inquiryReadiness(now: Date, currentDatabaseFingerprint: string): Promise<InquiryOperationalReadiness> {
    const result = await this.database.query<{
      backup_artifact:unknown;restore_drill_ready:boolean;kai_paired_probe:unknown;app_session_probe:unknown;
    }>(`WITH current_backup AS (
      SELECT b.* FROM backup_runs b
      WHERE status='succeeded' AND completed_at >= $1::timestamptz - interval '24 hours'
        AND artifact_name ~ '^cloudpay-postgres-[A-Za-z0-9_-]+\\.kcpb$'
        AND object_key='local://'||artifact_name AND encrypted_size_bytes > 0
        AND encrypted_sha256_digest ~ '^sha256:[a-f0-9]{64}$' AND schema_version='0066_compute_data_flywheel_v1.sql'
        AND EXISTS(SELECT 1 FROM audit_events a WHERE a.action='DATABASE_BACKUP_COMPLETED'
          AND a.entity_type='BACKUP_RUN' AND a.entity_id=b.id::text
          AND a.payload_digest=substring(b.encrypted_sha256_digest from 8)
          AND a.metadata @> jsonb_build_object('artifactName',b.artifact_name,'objectKey',b.object_key,
            'sizeBytes',b.encrypted_size_bytes,'schemaVersion',b.schema_version,'databaseFingerprint',$2::text,
            'durability','local_only','offsite',false))
      ORDER BY completed_at DESC LIMIT 1
    ), valid_restores AS (
      SELECT r.id FROM restore_drills r JOIN backup_runs b ON b.artifact_name=r.backup_artifact_name
      WHERE r.status='succeeded' AND r.completed_at >= $1::timestamptz - interval '90 days'
        AND b.status='succeeded' AND b.object_key='local://'||b.artifact_name AND b.encrypted_size_bytes>0
        AND b.encrypted_sha256_digest ~ '^sha256:[a-f0-9]{64}$'
        AND b.schema_version='0066_compute_data_flywheel_v1.sql'
        AND EXISTS(SELECT 1 FROM audit_events a WHERE a.action='DATABASE_BACKUP_COMPLETED'
          AND a.entity_type='BACKUP_RUN' AND a.entity_id=b.id::text
          AND a.payload_digest=substring(b.encrypted_sha256_digest from 8)
          AND a.metadata @> jsonb_build_object('artifactName',b.artifact_name,'objectKey',b.object_key,
            'sizeBytes',b.encrypted_size_bytes,'schemaVersion',b.schema_version,'databaseFingerprint',$2::text,
            'durability','local_only','offsite',false))
        AND r.schema_version='0066_compute_data_flywheel_v1.sql'
        AND length(btrim(r.target_fingerprint)) > 0 AND r.target_fingerprint <> $2::text
        AND jsonb_typeof(r.verified_invariants)='object'
        AND r.verified_invariants ?& $3::text[]
        AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(r.verified_invariants) entry WHERE entry.value IS DISTINCT FROM '0')
    ) SELECT
      (SELECT jsonb_build_object('artifactName',artifact_name,'location',object_key,
        'encryptedSizeBytes',encrypted_size_bytes::text,'sha256Digest',encrypted_sha256_digest,
        'schemaVersion',schema_version) FROM current_backup) AS backup_artifact,
      EXISTS(SELECT 1 FROM valid_restores) AS restore_drill_ready,
      (SELECT jsonb_build_object('payloadDigest',a.payload_digest,'metadata',a.metadata)
       FROM audit_events a WHERE a.action='INQUIRY_ONLY_KAI_PAIRED_PROBE_PASSED'
        AND a.entity_type='PRODUCTION_READINESS_PROBE' AND a.created_at >= $1::timestamptz - interval '30 minutes'
        AND a.metadata->>'producer'='record-inquiry-readiness.mjs@2'
        AND a.metadata->>'databaseFingerprint'=$2::text
        AND a.metadata->>'publicOrigin' ~ '^https://'
        AND length(btrim(a.metadata->>'probeOrigin')) > 0
        AND a.metadata->>'probeSubjectSha256' ~ '^[a-f0-9]{64}$'
        AND a.metadata->>'commerceStateDigest' ~ '^sha256:[a-f0-9]{64}$'
        AND a.metadata @> '{"profile":"inquiry_only","me":true,"legal":true,"consent":true,"subjects":true,"subjectSelection":true,"formalInquiry":true,"cancel":true,"commerceUnchanged":true,"schemaVersion":"0066_compute_data_flywheel_v1.sql"}'::jsonb
       ORDER BY a.created_at DESC LIMIT 1) AS kai_paired_probe,
      (SELECT jsonb_build_object('payloadDigest',a.payload_digest,'metadata',a.metadata)
       FROM audit_events a WHERE a.action='INQUIRY_ONLY_APP_SESSION_PROBE_PASSED'
        AND a.entity_type='PRODUCTION_READINESS_PROBE' AND a.created_at >= $1::timestamptz - interval '24 hours'
        AND a.metadata->>'producer'='record-inquiry-app-session.mjs@1'
        AND a.metadata->>'databaseFingerprint'=$2::text
        AND a.metadata->>'publicOrigin' ~ '^https://'
        AND a.metadata->>'apkSha256Digest' ~ '^sha256:[a-f0-9]{64}$'
        AND a.metadata->>'reportSha256Digest' ~ '^sha256:[a-f0-9]{64}$'
        AND a.metadata @> '{"profile":"inquiry_only","packageName":"com.kaicloud.marketplace","auth":true,"me":true,"legalConsent":true,"storedSession":true,"forceStopRestart":true,"recoveredSession":true,"schemaVersion":"0066_compute_data_flywheel_v1.sql"}'::jsonb
       ORDER BY a.created_at DESC LIMIT 1) AS app_session_probe`, [now,currentDatabaseFingerprint,[...restoreInvariantKeys]]);
    const row=result.rows[0];if(!row)throw new Error('INQUIRY_READINESS_SNAPSHOT_EMPTY');
    const evidence=(value:unknown)=>{if(!value||typeof value!=='object')return null;const record=value as Record<string,unknown>;
      return typeof record.payloadDigest==='string'&&record.metadata&&typeof record.metadata==='object'
        ?{payloadDigest:record.payloadDigest,metadata:record.metadata as Record<string,unknown>}:null;};
    const artifactValue=row.backup_artifact as Record<string,unknown>|null;
    const backupArtifact=artifactValue&&typeof artifactValue.artifactName==='string'&&typeof artifactValue.location==='string'
      &&typeof artifactValue.encryptedSizeBytes==='string'&&typeof artifactValue.sha256Digest==='string'
      &&typeof artifactValue.schemaVersion==='string'?{artifactName:artifactValue.artifactName,location:artifactValue.location,
        encryptedSizeBytes:Number(artifactValue.encryptedSizeBytes),sha256Digest:artifactValue.sha256Digest,
        schemaVersion:artifactValue.schemaVersion}:null;
    const kaiPairedProbeEvidence=evidence(row.kai_paired_probe),appSessionProbeEvidence=evidence(row.app_session_probe);
    return{backupArtifactReady:Boolean(backupArtifact),backupArtifact,restoreDrillReady:Boolean(row.restore_drill_ready),
      kaiPairedProbeReady:Boolean(kaiPairedProbeEvidence),appSessionProbeReady:Boolean(appSessionProbeEvidence),
      kaiPairedProbeEvidence,appSessionProbeEvidence};
  }
}
