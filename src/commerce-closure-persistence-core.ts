import {
  commerceClosurePendingForSubject, decodeCommerceClosurePending, parseCommerceClosurePending,
  type CommerceClosurePending,
} from './commerce-closure.ts';

export type CommerceClosurePersistenceDependencies = Readonly<{
  get: () => Promise<string | null>;
  set: (value: string) => Promise<void>;
  remove: () => Promise<void>;
  digest: (value: string) => Promise<string>;
  randomUuid: () => string;
  now: () => string;
}>;

export type CommerceClosurePendingPersistence = Readonly<{
  load: (subjectFingerprint: string) => Promise<CommerceClosurePending | null>;
  prepareOrder: (
    subjectFingerprint: string,
    listingId: string,
    quantity: string,
  ) => Promise<CommerceClosurePending>;
  markFundingRequired: (expected: CommerceClosurePending) => Promise<CommerceClosurePending>;
  markWalletOpened: (expected: CommerceClosurePending) => Promise<CommerceClosurePending>;
  linkFundingTopup: (
    expected: CommerceClosurePending,
    topupId: string,
    succeeded: boolean,
  ) => Promise<CommerceClosurePending>;
  markFundingSucceeded: (expected: CommerceClosurePending, topupId: string) => Promise<CommerceClosurePending>;
  markOrderRetry: (expected: CommerceClosurePending) => Promise<CommerceClosurePending>;
  markOrderCreated: (expected: CommerceClosurePending, orderId: string) => Promise<CommerceClosurePending>;
  clearCompleted: (expected: CommerceClosurePending) => Promise<void>;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const QUANTITY_PATTERN = /^(?:0|[1-9]\d{0,17})\.\d{6}$/u;

export function commerceOrderRequestCanonical(listingId: string, quantity: string) {
  if (!UUID_PATTERN.test(listingId) || !QUANTITY_PATTERN.test(quantity) || quantity === '0.000000') {
    throw new Error('COMMERCE_ORDER_INTENT_INVALID');
  }
  return `{"listingId":"${listingId}","quantity":"${quantity}"}`;
}

function sameRecord(current: CommerceClosurePending, expected: CommerceClosurePending) {
  return current.subjectFingerprint === expected.subjectFingerprint
    && current.idempotencyKey === expected.idempotencyKey
    && current.requestDigest === expected.requestDigest
    && current.createdAt === expected.createdAt
    && current.updatedAt === expected.updatedAt
    && current.phase === expected.phase
    && current.topupId === expected.topupId
    && current.orderId === expected.orderId;
}

export function createCommerceClosurePendingPersistence(
  dependencies: CommerceClosurePersistenceDependencies,
): CommerceClosurePendingPersistence {
  async function load(subjectFingerprint: string) {
    const raw = await dependencies.get();
    if (raw === null) return null;
    return commerceClosurePendingForSubject(parseCommerceClosurePending(raw), subjectFingerprint);
  }

  async function prepareOrder(subjectFingerprint: string, listingId: string, quantity: string) {
    const canonical = commerceOrderRequestCanonical(listingId, quantity);
    const requestDigest = await dependencies.digest(canonical);
    const existing = await load(subjectFingerprint);
    if (existing) {
      if (existing.listingId !== listingId || existing.quantity !== quantity || existing.requestDigest !== requestDigest) {
        throw new Error('COMMERCE_CLOSURE_PENDING_UNRESOLVED');
      }
      return existing;
    }
    const now = dependencies.now();
    const pending = decodeCommerceClosurePending({
      schemaVersion: 1,
      subjectFingerprint,
      phase: 'order_create_persisted',
      listingId,
      quantity,
      idempotencyKey: `commerce-order:${dependencies.randomUuid()}`,
      requestDigest,
      topupId: null,
      orderId: null,
      createdAt: now,
      updatedAt: now,
    });
    await dependencies.set(JSON.stringify(pending));
    return pending;
  }

  async function transition(
    expected: CommerceClosurePending,
    update: Readonly<Partial<Pick<CommerceClosurePending, 'phase' | 'topupId' | 'orderId'>>>,
  ) {
    const current = await load(expected.subjectFingerprint);
    if (!current || !sameRecord(current, expected)) throw new Error('COMMERCE_CLOSURE_PENDING_CHANGED');
    const next = decodeCommerceClosurePending({ ...current, ...update, updatedAt: dependencies.now() });
    await dependencies.set(JSON.stringify(next));
    return next;
  }

  async function markFundingRequired(expected: CommerceClosurePending) {
    if (!['order_create_persisted', 'order_retry_persisted', 'funding_required'].includes(expected.phase)) {
      throw new Error('COMMERCE_CLOSURE_PHASE_INVALID');
    }
    if (expected.phase === 'funding_required') return expected;
    return transition(expected, { phase: 'funding_required' });
  }

  async function markWalletOpened(expected: CommerceClosurePending) {
    if (!['funding_required', 'wallet_opened'].includes(expected.phase)) {
      throw new Error('COMMERCE_CLOSURE_PHASE_INVALID');
    }
    if (expected.phase === 'wallet_opened') return expected;
    return transition(expected, { phase: 'wallet_opened' });
  }

  async function linkFundingTopup(expected: CommerceClosurePending, topupId: string, succeeded: boolean) {
    if (expected.phase !== 'wallet_opened' || expected.topupId !== null) {
      throw new Error('COMMERCE_CLOSURE_PHASE_INVALID');
    }
    return transition(expected, { phase: succeeded ? 'funding_succeeded' : 'wallet_opened', topupId });
  }

  async function markFundingSucceeded(expected: CommerceClosurePending, topupId: string) {
    if (!['wallet_opened', 'funding_succeeded'].includes(expected.phase)
      || expected.topupId !== topupId) throw new Error('COMMERCE_CLOSURE_PHASE_INVALID');
    if (expected.phase === 'funding_succeeded') return expected;
    return transition(expected, { phase: 'funding_succeeded' });
  }

  async function markOrderRetry(expected: CommerceClosurePending) {
    if (expected.phase !== 'funding_succeeded') throw new Error('COMMERCE_CLOSURE_PHASE_INVALID');
    return transition(expected, { phase: 'order_retry_persisted' });
  }

  async function markOrderCreated(expected: CommerceClosurePending, orderId: string) {
    if (!['order_create_persisted', 'order_retry_persisted'].includes(expected.phase)) {
      throw new Error('COMMERCE_CLOSURE_PHASE_INVALID');
    }
    return transition(expected, { phase: 'order_created', orderId });
  }

  async function clearCompleted(expected: CommerceClosurePending) {
    if (expected.phase !== 'order_created' || expected.orderId === null) {
      throw new Error('COMMERCE_CLOSURE_NOT_COMPLETED');
    }
    const current = await load(expected.subjectFingerprint);
    if (!current) return;
    if (!sameRecord(current, expected)) throw new Error('COMMERCE_CLOSURE_PENDING_CHANGED');
    await dependencies.remove();
  }

  return {
    load, prepareOrder, markFundingRequired, markWalletOpened, linkFundingTopup,
    markFundingSucceeded, markOrderRetry, markOrderCreated, clearCompleted,
  };
}
