import { constantTimeEqual } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import { adminProcessMetrics, type AdminMetricReader } from '../admin/metrics.js';
import type { RuntimeConfig } from '../config.js';
import { databaseFingerprint } from '../backups/postgres.js';
import { readBackupHeader, sha256File } from '../backups/format.js';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppError } from '../errors.js';
import type { OperationalCounts, OperationsStore } from './store.js';
import { probeEvidenceDigest } from './probe-evidence.js';

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
  adminLoginSucceeded24h: 'admin_login_succeeded_24h',
  adminLoginDenied24h: 'admin_login_denied_24h',
  adminLoginFailed24h: 'admin_login_failed_24h',
  adminSecurityDenials24h: 'admin_security_denials_24h',
  adminOperationFailures24h: 'admin_operation_failures_24h',
  adminActiveSessions: 'admin_active_sessions',
  adminRevokedSessions24h: 'admin_revoked_sessions_24h',
};

export class OperationsService {
  private readonly token: string;
  private readonly databaseFingerprint: string | null;
  private readonly auditPepper: string | null;
  private readonly publicOrigin: string;
  private readonly backupDirectory: string | null;
  private readonly backupKeyId: string | null;
  private readonly backupVerificationCache=new Map<string,{mtimeMs:number;size:number;digest:string;checkedAt:number;ready:boolean}>();

  constructor(
    private readonly store: OperationsStore,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly adminMetrics: AdminMetricReader = adminProcessMetrics,
    private readonly localBackupVerifier?: (artifact:NonNullable<Awaited<ReturnType<OperationsStore['inquiryReadiness']>>['backupArtifact']>)=>Promise<boolean>,
  ) {
    this.token = required(config.METRICS_BEARER_TOKEN, 'METRICS_BEARER_TOKEN');
    this.databaseFingerprint = config.DATABASE_URL ? databaseFingerprint(config.DATABASE_URL) : null;
    this.auditPepper = config.AUDIT_PEPPER ?? null;
    this.publicOrigin=config.PUBLIC_ORIGIN;
    this.backupDirectory=config.BACKUP_LOCAL_DIRECTORY??null;
    this.backupKeyId=config.BACKUP_KEY_ID??null;
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
    const processAdminMetrics = this.adminMetrics.snapshot();
    const status = this.status(counts);
    const lines = [
      '# HELP cloudpay_operational_items Current operational queue and exception counts.',
      '# TYPE cloudpay_operational_items gauge',
    ];
    for (const [key, name] of Object.entries(metricNames) as Array<[keyof OperationalCounts, string]>) {
      if (key === 'oldestOutboxAgeSeconds' || key.startsWith('admin')) continue;
      lines.push(`cloudpay_operational_items{kind="${name}"} ${counts[key]}`);
    }
    lines.push(
      '# HELP cloudpay_outbox_oldest_age_seconds Age of the oldest pending outbox event.',
      '# TYPE cloudpay_outbox_oldest_age_seconds gauge',
      `cloudpay_outbox_oldest_age_seconds ${counts.oldestOutboxAgeSeconds}`,
      '# HELP cloudpay_operational_health Operational health: 2 healthy, 1 warning, 0 critical.',
      '# TYPE cloudpay_operational_health gauge',
      `cloudpay_operational_health ${status === 'healthy' ? 2 : status === 'warning' ? 1 : 0}`,
      '# HELP cloudpay_admin_login_events_24h Administrator login results recorded during the last 24 hours.',
      '# TYPE cloudpay_admin_login_events_24h gauge',
      `cloudpay_admin_login_events_24h{result="succeeded"} ${counts.adminLoginSucceeded24h}`,
      `cloudpay_admin_login_events_24h{result="denied"} ${counts.adminLoginDenied24h}`,
      `cloudpay_admin_login_events_24h{result="failed"} ${counts.adminLoginFailed24h}`,
      '# HELP cloudpay_admin_security_denials_24h Administrator origin, session, CSRF and permission denials recorded during the last 24 hours.',
      '# TYPE cloudpay_admin_security_denials_24h gauge',
      `cloudpay_admin_security_denials_24h ${counts.adminSecurityDenials24h}`,
      '# HELP cloudpay_admin_operation_failures_24h Administrator operations with a failed audit outcome during the last 24 hours.',
      '# TYPE cloudpay_admin_operation_failures_24h gauge',
      `cloudpay_admin_operation_failures_24h ${counts.adminOperationFailures24h}`,
      '# HELP cloudpay_admin_audit_append_failures_total Administrator audit append calls that threw in this process.',
      '# TYPE cloudpay_admin_audit_append_failures_total counter',
      `cloudpay_admin_audit_append_failures_total ${processAdminMetrics.auditAppendFailuresTotal}`,
      '# HELP cloudpay_admin_http_5xx_total HTTP 5xx responses from the fixed administrator API boundary in this process.',
      '# TYPE cloudpay_admin_http_5xx_total counter',
      `cloudpay_admin_http_5xx_total ${processAdminMetrics.http5xxTotal}`,
      '# HELP cloudpay_admin_active_sessions Currently unexpired active administrator sessions.',
      '# TYPE cloudpay_admin_active_sessions gauge',
      `cloudpay_admin_active_sessions ${counts.adminActiveSessions}`,
      '# HELP cloudpay_admin_revoked_sessions_24h Administrator sessions revoked during the last 24 hours.',
      '# TYPE cloudpay_admin_revoked_sessions_24h gauge',
      `cloudpay_admin_revoked_sessions_24h ${counts.adminRevokedSessions24h}`,
      '# HELP cloudpay_metrics_snapshot_timestamp_seconds Unix timestamp of this snapshot.',
      '# TYPE cloudpay_metrics_snapshot_timestamp_seconds gauge',
      `cloudpay_metrics_snapshot_timestamp_seconds ${Math.floor(capturedAt.getTime() / 1000)}`,
    );
    return `${lines.join('\n')}\n`;
  }

  async inquiryReleaseReadiness() {
    const capturedAt = this.now();
    if (!this.databaseFingerprint) {
      return {
        ready: false,
        backup: { ready: false }, restore: { ready: false }, kaiPaired: { ready: false }, appSession: {ready:false},
        blockers: ['DATABASE_FINGERPRINT'],
      };
    }
    const [counts, evidence] = await Promise.all([
      this.store.snapshot(capturedAt), this.store.inquiryReadiness(capturedAt, this.databaseFingerprint),
    ]);
    const evidenceAuthentic=(proof:typeof evidence.kaiPairedProbeEvidence)=>Boolean(this.auditPepper&&proof
      &&constantTimeEqual(proof.payloadDigest,probeEvidenceDigest(proof.metadata,this.auditPepper)));
    const kaiPairedProbeReady=evidence.kaiPairedProbeReady&&evidenceAuthentic(evidence.kaiPairedProbeEvidence)
      &&evidence.kaiPairedProbeEvidence?.metadata.probeOrigin===this.publicOrigin
      &&evidence.kaiPairedProbeEvidence.metadata.publicOrigin===this.publicOrigin;
    const appSessionProbeReady=evidence.appSessionProbeReady&&evidenceAuthentic(evidence.appSessionProbeEvidence)
      &&evidence.appSessionProbeEvidence?.metadata.publicOrigin===this.publicOrigin;
    const backupFileReady=Boolean(evidence.backupArtifact&&await(this.localBackupVerifier
      ?this.localBackupVerifier(evidence.backupArtifact):this.verifyLocalBackup(evidence.backupArtifact)));
    const backupReady = evidence.backupArtifactReady&&backupFileReady&&counts.backupFailures24h === 0;
    const blockers = [
      ...(backupFileReady ? [] : ['LOCAL_BACKUP_ARTIFACT_24H']),
      ...(counts.backupFailures24h === 0 ? [] : ['BACKUP_FAILURES_24H']),
      ...(evidence.restoreDrillReady ? [] : ['RESTORE_DRILL_SUCCESS_90D']),
      ...(kaiPairedProbeReady ? [] : ['KAI_PAIRED_PROBE_30M']),
      ...(appSessionProbeReady ? [] : ['APP_STORED_SESSION_PROBE_24H']),
    ];
    return {
      ready: blockers.length === 0,
      backup: { ready: backupReady },
      restore: { ready: evidence.restoreDrillReady },
      kaiPaired: { ready: kaiPairedProbeReady },
      appSession: {ready:appSessionProbeReady},
      durability:{mode:'local_only',offsiteBackup:false,highAvailability:false,
        disasterRecovery:false,riskAccepted:true} as const,
      blockers,
    };
  }

  private async verifyLocalBackup(artifact:NonNullable<Awaited<ReturnType<OperationsStore['inquiryReadiness']>>['backupArtifact']>) {
    try {
      if(!this.backupDirectory||!this.backupKeyId||artifact.location!==`local://${artifact.artifactName}`)return false;
      const directory=resolve(this.backupDirectory),path=resolve(directory,artifact.artifactName);
      if(dirname(path)!==directory)return false;
      const info=await stat(path);
      if(!info.isFile()||(info.mode&0o077)!==0||info.size!==artifact.encryptedSizeBytes)return false;
      const cached=this.backupVerificationCache.get(path);
      if(cached&&cached.mtimeMs===info.mtimeMs&&cached.size===info.size&&cached.digest===artifact.sha256Digest
        &&this.now().getTime()-cached.checkedAt<5*60_000)return cached.ready;
      const parsed=await readBackupHeader(path);
      const ready=parsed.header.databaseFingerprint===this.databaseFingerprint
        &&parsed.header.schemaVersion==='0066_compute_data_flywheel_v1.sql'
        &&parsed.header.keyId===this.backupKeyId&&await sha256File(path)===artifact.sha256Digest;
      this.backupVerificationCache.set(path,{mtimeMs:info.mtimeMs,size:info.size,digest:artifact.sha256Digest,
        checkedAt:this.now().getTime(),ready});
      return ready;
    }catch{return false;}
  }

  private status(counts: OperationalCounts): 'healthy' | 'warning' | 'critical' {
    if (counts.paymentDeadLetters || counts.outboxDeadLetters || counts.evidenceScanFailed
      || counts.backupFailures24h || counts.adminOperationFailures24h) return 'critical';
    if (counts.paymentOverdue || counts.refundProviderPendingStale || counts.evidencePendingScanStale
      || counts.invoiceRequestedStale || counts.invoiceProcessingStale || counts.invoiceRedPendingStale
      || counts.disputesReadyForReview || counts.deliveryStale || counts.reservationOverdue
      || counts.oldestOutboxAgeSeconds > 900 || !counts.backupSucceeded24h || !counts.restoreDrillSucceeded90d) return 'warning';
    return 'healthy';
  }
}
