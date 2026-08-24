import { ApiError } from './api-client.ts';
import {
  commerceClosureGate, decodeCommerceOrderCreateResponse, decodeCommerceOrderDetailResponse,
  type CommerceClosureGateInput, type CommerceOrder,
} from './commerce-closure.ts';
import type { CommerceClosurePendingPersistence } from './commerce-closure-persistence-core.ts';
import {
  decodeQixiangTopup, decodeQixiangTopupDetail, type QixiangCheckout, type QixiangTopup,
} from './qixiang-topups.ts';

export type CommerceClosureOrderApi = Readonly<{
  create: (
    listingId: string,
    quantity: string,
    idempotencyKey: string,
  ) => Promise<Readonly<{ ok: true; replayed: boolean; order: CommerceOrder }>>;
  detail: (orderId: string) => Promise<Readonly<{ ok: true; order: CommerceOrder }>>;
}>;

export type CommerceClosureTopupApi = Readonly<{
  detail: (topupId: string) => Promise<Readonly<{ topup: QixiangTopup; checkout: QixiangCheckout | null }>>;
}>;

export type CommerceClosureFlowDependencies = Readonly<{
  pending: CommerceClosurePendingPersistence;
  orders: CommerceClosureOrderApi;
  topups: CommerceClosureTopupApi;
}>;

function fundingRequired(reason: unknown) {
  return reason instanceof ApiError && reason.status === 409 && reason.code === 'KAI_CREDIT_INSUFFICIENT';
}

function strictCreateResult(result: Awaited<ReturnType<CommerceClosureOrderApi['create']>>) {
  return decodeCommerceOrderCreateResponse(result);
}

function strictDetailResult(
  result: Awaited<ReturnType<CommerceClosureOrderApi['detail']>>,
  expectedOrderId: string,
) {
  return decodeCommerceOrderDetailResponse(result, expectedOrderId);
}

function createRuntime(dependencies: CommerceClosureFlowDependencies) {
  async function startOrder(subjectFingerprint: string, listingId: string, quantity: string) {
    const pending = await dependencies.pending.prepareOrder(subjectFingerprint, listingId, quantity);
    if (pending.orderId !== null) {
      const result = strictDetailResult(await dependencies.orders.detail(pending.orderId), pending.orderId);
      return { kind: 'order_created', order: result.order, pending } as const;
    }
    if (pending.phase !== 'order_create_persisted') {
      return { kind: 'resume_funding', pending } as const;
    }
    try {
      const result = strictCreateResult(await dependencies.orders.create(
        pending.listingId, pending.quantity, pending.idempotencyKey,
      ));
      const completed = await dependencies.pending.markOrderCreated(pending, result.order.id);
      return { kind: 'order_created', replayed: result.replayed, order: result.order, pending: completed } as const;
    } catch (reason) {
      if (!fundingRequired(reason)) throw reason;
      const awaitingFunding = await dependencies.pending.markFundingRequired(pending);
      return { kind: 'funding_required', pending: awaitingFunding } as const;
    }
  }

  async function openOriginalCreditWallet(subjectFingerprint: string) {
    const pending = await dependencies.pending.load(subjectFingerprint);
    if (!pending) throw new Error('COMMERCE_CLOSURE_PENDING_REQUIRED');
    const opened = await dependencies.pending.markWalletOpened(pending);
    return {
      pending: opened,
      returnTarget: { listingId: opened.listingId, quantity: opened.quantity },
    } as const;
  }

  async function attachFundingTopup(subjectFingerprint: string, rawTopup: unknown) {
    const topup = decodeQixiangTopup(rawTopup);
    const pending = await dependencies.pending.load(subjectFingerprint);
    if (!pending) throw new Error('COMMERCE_CLOSURE_PENDING_REQUIRED');
    if (pending.topupId !== null) {
      if (pending.topupId !== topup.id) throw new Error('COMMERCE_CLOSURE_TOPUP_CONFLICT');
      const updated = topup.status === 'succeeded'
        ? await dependencies.pending.markFundingSucceeded(pending, topup.id) : pending;
      return { topup, pending: updated } as const;
    }
    const updated = await dependencies.pending.linkFundingTopup(
      pending, topup.id, topup.status === 'succeeded',
    );
    return { topup, pending: updated } as const;
  }

  async function observeFundingReturn(subjectFingerprint: string) {
    const pending = await dependencies.pending.load(subjectFingerprint);
    if (!pending || pending.topupId === null) return { kind: 'no_topup', pending } as const;
    const detail = decodeQixiangTopupDetail(
      await dependencies.topups.detail(pending.topupId), pending.topupId,
    );
    const updated = detail.topup.status === 'succeeded'
      ? await dependencies.pending.markFundingSucceeded(pending, detail.topup.id) : pending;
    return { kind: 'topup_loaded', ...detail, pending: updated } as const;
  }

  async function retryOriginalOrder(subjectFingerprint: string) {
    const pending = await dependencies.pending.load(subjectFingerprint);
    if (!pending) throw new Error('COMMERCE_CLOSURE_PENDING_REQUIRED');
    const retrying = pending.phase === 'funding_succeeded'
      ? await dependencies.pending.markOrderRetry(pending)
      : pending.phase === 'order_retry_persisted' ? pending : null;
    if (!retrying) throw new Error('COMMERCE_CLOSURE_FUNDING_NOT_CONFIRMED');
    try {
      const result = strictCreateResult(await dependencies.orders.create(
        retrying.listingId, retrying.quantity, retrying.idempotencyKey,
      ));
      const completed = await dependencies.pending.markOrderCreated(retrying, result.order.id);
      return { kind: 'order_created', replayed: result.replayed, order: result.order, pending: completed } as const;
    } catch (reason) {
      if (!fundingRequired(reason)) throw reason;
      const awaitingFunding = await dependencies.pending.markFundingRequired(retrying);
      return { kind: 'funding_required', pending: awaitingFunding } as const;
    }
  }

  async function recover(subjectFingerprint: string) {
    const pending = await dependencies.pending.load(subjectFingerprint);
    if (!pending) return { kind: 'none' } as const;
    if (pending.orderId !== null) {
      const result = strictDetailResult(await dependencies.orders.detail(pending.orderId), pending.orderId);
      return { kind: 'order_loaded', order: result.order, pending } as const;
    }
    if (pending.topupId !== null) return observeFundingReturn(subjectFingerprint);
    return { kind: 'pending', pending } as const;
  }

  async function acknowledgeOrder(subjectFingerprint: string) {
    const pending = await dependencies.pending.load(subjectFingerprint);
    if (!pending) return;
    await dependencies.pending.clearCompleted(pending);
  }

  return {
    startOrder,
    openOriginalCreditWallet,
    attachFundingTopup,
    observeFundingReturn,
    retryOriginalOrder,
    recover,
    acknowledgeOrder,
  } as const;
}

/**
 * The dependency factory is intentionally lazy. A disabled/inquiry/malformed
 * readiness response returns null before SecureStore, API clients, or return
 * listeners can be constructed by a future UI integration.
 */
export function createCommerceClosureRuntime(
  gate: CommerceClosureGateInput,
  dependencies: () => CommerceClosureFlowDependencies,
) {
  const capability = commerceClosureGate(gate);
  if (!capability) return null;
  return { capability, ...createRuntime(dependencies()) } as const;
}
