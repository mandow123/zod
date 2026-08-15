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
}>;

type SnapshotRow = QueryResultRow & Record<keyof OperationalCounts, string | number | null>;

const fields: Array<keyof OperationalCounts> = [
  'paymentPending', 'paymentOverdue', 'paymentDeadLetters', 'refundProviderPendingStale',
  'outboxPending', 'outboxDeadLetters', 'evidencePendingScanStale', 'evidenceScanFailed',
  'invoiceRequestedStale', 'invoiceProcessingStale', 'invoiceRedPendingStale',
  'disputesReadyForReview', 'deliveryStale', 'reservationOverdue', 'auditEvents24h', 'oldestOutboxAgeSeconds',
  'backupSucceeded24h', 'backupFailures24h', 'restoreDrillSucceeded90d',
];

export interface OperationsStore { snapshot(now: Date): Promise<OperationalCounts>; }

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
           FROM outbox_events WHERE processed_at IS NULL AND dead_lettered_at IS NULL), 0)::text AS "oldestOutboxAgeSeconds"`,
      [now],
    );
    const row = result.rows[0];
    if (!row) throw new Error('OPERATIONS_SNAPSHOT_EMPTY');
    return Object.fromEntries(fields.map((field) => [field, Math.max(0, Number(row[field] ?? 0))])) as OperationalCounts;
  }
}
