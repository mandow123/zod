import { constantTimeEqual } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { OperationalCounts, OperationsStore } from './store.js';

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const metricNames: Record<keyof OperationalCounts, string> = {
  paymentPending: 'payment_pending', paymentOverdue: 'payment_overdue', paymentDeadLetters: 'payment_dead_letters',
  refundProviderPendingStale: 'refund_provider_pending_stale', outboxPending: 'outbox_pending',
  outboxDeadLetters: 'outbox_dead_letters', evidencePendingScanStale: 'evidence_pending_scan_stale',
  evidenceScanFailed: 'evidence_scan_failed', invoiceRequestedStale: 'invoice_requested_stale',
  invoiceProcessingStale: 'invoice_processing_stale', invoiceRedPendingStale: 'invoice_red_pending_stale',
  disputesReadyForReview: 'disputes_ready_for_review', deliveryStale: 'delivery_stale',
  reservationOverdue: 'reservation_overdue', auditEvents24h: 'audit_events_24h',
  backupSucceeded24h: 'backup_succeeded_24h', backupFailures24h: 'backup_failures_24h',
  restoreDrillSucceeded90d: 'restore_drill_succeeded_90d',
  oldestOutboxAgeSeconds: 'oldest_outbox_age_seconds',
};

export class OperationsService {
  private readonly token: string;

  constructor(private readonly store: OperationsStore, config: RuntimeConfig, private readonly now: () => Date = () => new Date()) {
    this.token = required(config.METRICS_BEARER_TOKEN, 'METRICS_BEARER_TOKEN');
  }

  authorizeMetrics(authorization: string | undefined) {
    const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? '');
    if (!match?.[1] || !constantTimeEqual(match[1], this.token)) {
      throw new AppError('METRICS_UNAUTHORIZED', 401, '监控凭证无效。');
    }
  }

  async summary(principal: AccountPrincipal) {
    if (principal.role !== 'operator' && principal.role !== 'admin') throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要运营权限。');
    const capturedAt = this.now();
    const counts = await this.store.snapshot(capturedAt);
    return { status: this.status(counts), capturedAt: capturedAt.toISOString(), counts };
  }

  async prometheus() {
    const capturedAt = this.now();
    const counts = await this.store.snapshot(capturedAt);
    const status = this.status(counts);
    const lines = [
      '# HELP cloudpay_operational_items Current operational queue and exception counts.',
      '# TYPE cloudpay_operational_items gauge',
    ];
    for (const [key, name] of Object.entries(metricNames) as Array<[keyof OperationalCounts, string]>) {
      if (key === 'oldestOutboxAgeSeconds') continue;
      lines.push(`cloudpay_operational_items{kind="${name}"} ${counts[key]}`);
    }
    lines.push(
      '# HELP cloudpay_outbox_oldest_age_seconds Age of the oldest pending outbox event.',
      '# TYPE cloudpay_outbox_oldest_age_seconds gauge',
      `cloudpay_outbox_oldest_age_seconds ${counts.oldestOutboxAgeSeconds}`,
      '# HELP cloudpay_operational_health Operational health: 2 healthy, 1 warning, 0 critical.',
      '# TYPE cloudpay_operational_health gauge',
      `cloudpay_operational_health ${status === 'healthy' ? 2 : status === 'warning' ? 1 : 0}`,
      '# HELP cloudpay_metrics_snapshot_timestamp_seconds Unix timestamp of this snapshot.',
      '# TYPE cloudpay_metrics_snapshot_timestamp_seconds gauge',
      `cloudpay_metrics_snapshot_timestamp_seconds ${Math.floor(capturedAt.getTime() / 1000)}`,
    );
    return `${lines.join('\n')}\n`;
  }

  private status(counts: OperationalCounts): 'healthy' | 'warning' | 'critical' {
    if (counts.paymentDeadLetters || counts.outboxDeadLetters || counts.evidenceScanFailed || counts.backupFailures24h) return 'critical';
    if (counts.paymentOverdue || counts.refundProviderPendingStale || counts.evidencePendingScanStale
      || counts.invoiceRequestedStale || counts.invoiceProcessingStale || counts.invoiceRedPendingStale
      || counts.disputesReadyForReview || counts.deliveryStale || counts.reservationOverdue
      || counts.oldestOutboxAgeSeconds > 900 || !counts.backupSucceeded24h || !counts.restoreDrillSucceeded90d) return 'warning';
    return 'healthy';
  }
}
