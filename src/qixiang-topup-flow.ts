import type { QixiangPendingPersistence } from './qixiang-topup-persistence-core.ts';
import {
  qixiangTopupGate, shouldClearQixiangPending, type QixiangCheckout, type QixiangReadinessGateInput,
  type QixiangTopup, type QixiangTopupPage,
} from './qixiang-topups.ts';

export type QixiangTopupApi = Readonly<{
  create: (amountCents: number, idempotencyKey: string) => Promise<Readonly<{
    topup: QixiangTopup; checkout: QixiangCheckout | null;
  }>>;
  list: (cursor?: string | null) => Promise<QixiangTopupPage>;
  detail: (topupId: string) => Promise<Readonly<{ topup: QixiangTopup; checkout: QixiangCheckout | null }>>;
  recheck: (topupId: string, expectedVersion: number, idempotencyKey: string) => Promise<Readonly<{
    topup: QixiangTopup;
  }>>;
}>;

export type QixiangTopupFlowDependencies = Readonly<{
  pending: QixiangPendingPersistence;
  api: QixiangTopupApi;
}>;

export function createQixiangBrowserReturnCoordinator() {
  let currentAttempt = 0;
  let completedAttempt = 0;
  let inFlight: Readonly<{ attempt: number; promise: Promise<boolean> }> | null = null;
  return {
    begin() {
      currentAttempt += 1;
      completedAttempt = 0;
      return currentAttempt;
    },
    observe(attempt: number, action: () => Promise<void>) {
      if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt !== currentAttempt) {
        return Promise.resolve(false);
      }
      if (completedAttempt === attempt) return Promise.resolve(false);
      if (inFlight?.attempt === attempt) return inFlight.promise;
      const promise = (async () => {
        try {
          await action();
          if (currentAttempt === attempt) completedAttempt = attempt;
          return true;
        } finally {
          if (inFlight?.attempt === attempt) inFlight = null;
        }
      })();
      inFlight = { attempt, promise };
      return promise;
    },
  } as const;
}

function enabled(input: QixiangReadinessGateInput) {
  const capability = qixiangTopupGate(input);
  if (!capability) throw new Error('QIXIANG_CAPABILITY_UNAVAILABLE');
  return capability;
}

async function finishTerminal(
  dependencies: QixiangTopupFlowDependencies,
  pending: Awaited<ReturnType<QixiangPendingPersistence['load']>> & {},
  topup: QixiangTopup,
) {
  if (shouldClearQixiangPending(topup)) await dependencies.pending.clearTerminal(pending);
}

export async function createOrReplayQixiangTopup(
  gate: QixiangReadinessGateInput,
  subjectFingerprint: string,
  amountCents: number,
  dependencies: QixiangTopupFlowDependencies,
) {
  const capability = enabled(gate);
  if(capability.canaryOnly&&amountCents!==501)throw new Error('QIXIANG_CANARY_AMOUNT_REQUIRED');
  if (capability.minAmountCents === null || capability.maxAmountCents === null
    || amountCents < capability.minAmountCents || amountCents > capability.maxAmountCents) {
    throw new Error('QIXIANG_AMOUNT_POLICY');
  }
  const pending = await dependencies.pending.prepareCreate(subjectFingerprint, amountCents);
  const replayCreate = pending.topupId === null;
  const result = replayCreate
    ? await dependencies.api.create(amountCents, pending.idempotencyKey)
    : await dependencies.api.detail(pending.topupId);
  if (shouldClearQixiangPending(result.topup)) {
    await finishTerminal(dependencies, pending, result.topup);
    return { ...result, pending: null } as const;
  }
  const updated = replayCreate
    ? await dependencies.pending.advance(
      pending,
      result.checkout !== null && result.topup.allowedActions.includes('open_checkout')
        ? 'checkout_opened' : 'return_observed',
      result.topup.id,
    )
    : pending;
  return { ...result, pending: updated } as const;
}

export async function recoverQixiangTopup(
  gate: QixiangReadinessGateInput,
  subjectFingerprint: string,
  dependencies: QixiangTopupFlowDependencies,
) {
  enabled(gate);
  const pending = await dependencies.pending.load(subjectFingerprint);
  if (!pending) return { kind: 'none' } as const;
  if (pending.topupId === null) return { kind: 'create_unresolved', pending } as const;
  const result = await dependencies.api.detail(pending.topupId);
  await finishTerminal(dependencies, pending, result.topup);
  return { kind: 'loaded', ...result, pending: shouldClearQixiangPending(result.topup) ? null : pending } as const;
}

export async function observeQixiangBrowserReturn(
  gate: QixiangReadinessGateInput,
  subjectFingerprint: string,
  dependencies: QixiangTopupFlowDependencies,
) {
  enabled(gate);
  const pending = await dependencies.pending.load(subjectFingerprint);
  if (!pending || pending.topupId === null) return { kind: 'none' } as const;
  const topupId = pending.topupId;
  const observed = pending.phase === 'checkout_opened'
    ? await dependencies.pending.advance(pending, 'return_observed') : pending;
  const result = await dependencies.api.detail(topupId);
  await finishTerminal(dependencies, observed, result.topup);
  return { kind: 'loaded', ...result, pending: shouldClearQixiangPending(result.topup) ? null : observed } as const;
}

export async function listQixiangTopupsWhenEnabled(
  gate: QixiangReadinessGateInput,
  cursor: string | null,
  dependencies: QixiangTopupFlowDependencies,
) {
  enabled(gate);
  return dependencies.api.list(cursor);
}

export async function loadQixiangTopupWhenEnabled(
  gate: QixiangReadinessGateInput,
  topupId: string,
  dependencies: QixiangTopupFlowDependencies,
) {
  enabled(gate);
  return dependencies.api.detail(topupId);
}

export async function recheckQixiangTopupByUser(
  gate: QixiangReadinessGateInput,
  subjectFingerprint: string,
  topup: QixiangTopup,
  dependencies: QixiangTopupFlowDependencies,
) {
  enabled(gate);
  const rechecking = await dependencies.pending.prepareRecheck(
    subjectFingerprint, topup.id, topup.payment.amountCents, topup.version,
  );
  const result = await dependencies.api.recheck(topup.id, topup.version, rechecking.idempotencyKey);
  await finishTerminal(dependencies, rechecking, result.topup);
  return { ...result, pending: shouldClearQixiangPending(result.topup) ? null : rechecking } as const;
}
