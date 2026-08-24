export const ACCEPTANCE_MODE: 'always_rollback';
export function acceptanceWatchdogDecision(input: Readonly<{
  reportResult: 'passed' | 'failed' | null;
  nowMs: number;
  deadlineMs: number;
}>): Readonly<{
  action: 'wait' | 'rollback';
  reason?: string;
  technicalAcceptanceResult: 'passed' | 'failed' | 'not_recorded';
}>;
