import {
  advanceQixiangPending, decodeQixiangPendingTopup, parseQixiangPendingTopup, qixiangPendingForSubject,
  QIXIANG_RAIL, type QixiangPendingPhase, type QixiangPendingTopup,
} from './qixiang-topups.ts';

export type QixiangPendingPersistenceDependencies = Readonly<{
  get: () => Promise<string | null>;
  set: (value: string) => Promise<void>;
  remove: () => Promise<void>;
  digest: (value: string) => Promise<string>;
  randomUuid: () => string;
  now: () => string;
}>;

export type QixiangPendingPersistence = Readonly<{
  load: (subjectFingerprint: string) => Promise<QixiangPendingTopup | null>;
  prepareCreate: (subjectFingerprint: string, amountCents: number) => Promise<QixiangPendingTopup>;
  advance: (
    expected: QixiangPendingTopup,
    phase: Exclude<QixiangPendingPhase, 'create_persisted'>,
    topupId?: string | null,
  ) => Promise<QixiangPendingTopup>;
  prepareRecheck: (
    subjectFingerprint: string,
    topupId: string,
    amountCents: number,
    expectedVersion: number,
  ) => Promise<QixiangPendingTopup>;
  clearTerminal: (expected: QixiangPendingTopup) => Promise<void>;
}>;

function sameAttempt(current: QixiangPendingTopup, expected: QixiangPendingTopup) {
  return current.subjectFingerprint === expected.subjectFingerprint
    && current.idempotencyKey === expected.idempotencyKey
    && current.requestDigest === expected.requestDigest
    && current.createdAt === expected.createdAt;
}

export function qixiangCreateRequestCanonical(amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new Error('QIXIANG_AMOUNT_INVALID');
  return `{"amountCents":${amountCents},"rail":"${QIXIANG_RAIL}"}`;
}

export function qixiangRecheckRequestCanonical(topupId: string, expectedVersion: number) {
  if (!topupId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('QIXIANG_RECHECK_INVALID');
  }
  return `{"expectedVersion":${expectedVersion},"topupId":"${topupId}"}`;
}

export function createQixiangPendingPersistence(
  dependencies: QixiangPendingPersistenceDependencies,
): QixiangPendingPersistence {
  async function load(subjectFingerprint: string) {
    const raw = await dependencies.get();
    if (raw === null) return null;
    return qixiangPendingForSubject(parseQixiangPendingTopup(raw), subjectFingerprint);
  }

  async function prepareCreate(subjectFingerprint: string, amountCents: number) {
    const requestDigest = await dependencies.digest(qixiangCreateRequestCanonical(amountCents));
    const existing = await load(subjectFingerprint);
    if (existing) {
      if (existing.amountCents !== amountCents || existing.requestDigest !== requestDigest) {
        throw new Error('QIXIANG_PENDING_UNRESOLVED');
      }
      return existing;
    }
    const now = dependencies.now();
    const pending = decodeQixiangPendingTopup({
      schemaVersion: 1, subjectFingerprint, phase: 'create_persisted', amountCents, rail: QIXIANG_RAIL,
      idempotencyKey: `qixiang-topup:${dependencies.randomUuid()}`, requestDigest, topupId: null,
      createdAt: now, updatedAt: now,
    });
    await dependencies.set(JSON.stringify(pending));
    return pending;
  }

  async function advance(
    expected: QixiangPendingTopup,
    phase: Exclude<QixiangPendingPhase, 'create_persisted'>,
    topupId = expected.topupId,
  ) {
    const current = await load(expected.subjectFingerprint);
    if (!current || !sameAttempt(current, expected)) throw new Error('QIXIANG_PENDING_CHANGED');
    const updated = advanceQixiangPending(current, phase, dependencies.now(), topupId);
    await dependencies.set(JSON.stringify(updated));
    return updated;
  }

  async function prepareRecheck(
    subjectFingerprint: string,
    topupId: string,
    amountCents: number,
    expectedVersion: number,
  ) {
    const requestDigest = await dependencies.digest(qixiangRecheckRequestCanonical(topupId, expectedVersion));
    const current = await load(subjectFingerprint);
    if (current && (current.topupId !== topupId || current.amountCents !== amountCents)) {
      throw new Error('QIXIANG_PENDING_UNRESOLVED');
    }
    if (current?.phase === 'recheck_pending' && current.requestDigest === requestDigest) return current;
    const now = dependencies.now();
    const updated = decodeQixiangPendingTopup({
      schemaVersion: 1, subjectFingerprint, phase: 'recheck_pending', amountCents, rail: QIXIANG_RAIL,
      idempotencyKey: `qixiang-recheck:${dependencies.randomUuid()}`, requestDigest, topupId,
      createdAt: current?.createdAt ?? now, updatedAt: now,
    });
    await dependencies.set(JSON.stringify(updated));
    return updated;
  }

  async function clearTerminal(expected: QixiangPendingTopup) {
    const current = await load(expected.subjectFingerprint);
    if (!current) return;
    if (!sameAttempt(current, expected)) throw new Error('QIXIANG_PENDING_CHANGED');
    await dependencies.remove();
  }

  return { load, prepareCreate, advance, prepareRecheck, clearTerminal };
}
