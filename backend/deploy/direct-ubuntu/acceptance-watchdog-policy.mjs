export const ACCEPTANCE_MODE = 'always_rollback';

export function acceptanceWatchdogDecision({ reportResult, nowMs, deadlineMs }) {
  if (reportResult === 'passed' || reportResult === 'failed') {
    return {
      action: 'rollback',
      reason: `Technical acceptance ${reportResult}; acceptance_mode=${ACCEPTANCE_MODE}.`,
      technicalAcceptanceResult: reportResult,
    };
  }
  if (nowMs >= deadlineMs) {
    return {
      action: 'rollback',
      reason: `No complete technical acceptance report was recorded within 10 minutes; acceptance_mode=${ACCEPTANCE_MODE}.`,
      technicalAcceptanceResult: 'not_recorded',
    };
  }
  return { action: 'wait', technicalAcceptanceResult: 'not_recorded' };
}
