export type AdminProcessMetricSnapshot = Readonly<{
  auditAppendFailuresTotal: number;
  http5xxTotal: number;
}>;

export interface AdminMetricRecorder {
  recordAuditAppendFailure(): void;
  recordHttp5xx(): void;
}

export interface AdminMetricReader {
  snapshot(): AdminProcessMetricSnapshot;
}

/**
 * Process-local counters intentionally accept no labels or caller-supplied
 * values. Prometheus aggregates the per-instance series at query time.
 */
export class AdminProcessMetrics implements AdminMetricRecorder, AdminMetricReader {
  private auditAppendFailures = 0;
  private http5xx = 0;

  recordAuditAppendFailure(): void {
    this.auditAppendFailures = Math.min(Number.MAX_SAFE_INTEGER, this.auditAppendFailures + 1);
  }

  recordHttp5xx(): void {
    this.http5xx = Math.min(Number.MAX_SAFE_INTEGER, this.http5xx + 1);
  }

  snapshot(): AdminProcessMetricSnapshot {
    return Object.freeze({
      auditAppendFailuresTotal: this.auditAppendFailures,
      http5xxTotal: this.http5xx,
    });
  }
}

export const adminProcessMetrics = new AdminProcessMetrics();
