import { describe, expect, it } from 'vitest';
import type { AccountPrincipal } from '../src/account/types.js';
import { encryptPii } from '../src/account/crypto.js';
import { loadConfig } from '../src/config.js';
import { CreditOrderService } from '../src/credit-orders/service.js';
import type { CreditOrderStore } from '../src/credit-orders/store.js';
import type { CreditOrderRecord } from '../src/credit-orders/types.js';
import type { SubjectAccess } from '../src/subjects/types.js';

const providerSubjectId = '10000000-0000-4000-8000-000000000001';
const buyerSubjectId = '10000000-0000-4000-8000-000000000002';
const providerUserId = '10000000-0000-4000-8000-000000000003';
const orderId = '10000000-0000-4000-8000-000000000004';

function computeEnabledConfig() {
  return loadConfig({
    NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32),
    PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), COMPUTE_PROVIDER: 'sidecar-v1',
    COMPUTE_PROVIDER_URL: 'https://h100-sidecar.internal', COMPUTE_PROVIDER_TOKEN: 'q'.repeat(48),
    COMPUTE_ALLOCATED_ACCELERATOR_COUNT: '1', COMPUTE_NODE_ACCELERATOR_COUNT: '8',
    NODE_GPU_FINGERPRINT_PEPPER: 'g'.repeat(40), NODE_CLAIM_TOKEN_PEPPER: 'n'.repeat(40),
    NODE_CLAIM_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
    NODE_SUPPORTED_AGENT_VERSIONS: '1.0.0',
  });
}

function order(status: CreditOrderRecord['status']): CreditOrderRecord {
  const now = new Date('2026-08-12T12:00:00.000Z');
  return {
    id: orderId, orderNumber: 'KC20260812DELIVERY001', buyerSubjectId, supplierSubjectId: providerSubjectId,
    createdByUserId: '10000000-0000-4000-8000-000000000005', listingId: '10000000-0000-4000-8000-000000000006',
    status, quantity: '2.000000', capacityUnit: 'GPU时', unitCreditMicros: 31_137_725n,
    totalCreditMicros: 62_275_450n, listingSnapshot: { title: '独享 H100', productCode: 'H100-SXM-80G', region: '华东-上海' },
    reservationExpiresAt: new Date('2026-08-12T12:30:00.000Z'), confirmedAt: now,
    confirmedByUserId: providerUserId, deliveryStartedAt: now,
    deliveryReadyAt: status === 'acceptance_pending' ? now : null, acceptedAt: null, acceptedByUserId: null,
    closedAt: null, createdAt: now, updatedAt: now,
  };
}

describe('KAI credit order delivery service', () => {
  it('returns an auto-confirmed purchase when immediate provisioning is temporarily unavailable', async () => {
    let attempts = 0;
    let reservationInput: Parameters<CreditOrderStore['createReservation']>[0] | null = null;
    const confirmed = order('confirmed');
    const store = {
      createReservation: async (input: Parameters<CreditOrderStore['createReservation']>[0]) => {
        reservationInput = input;
        return { status: 'created' as const, order: confirmed };
      },
      getForSubject: async () => confirmed,
    } as unknown as CreditOrderStore;
    const subjects = { current: async () => ({
      subjectId: buyerSubjectId, kind: 'personal' as const, displayName: '买方', subjectStatus: 'active' as const,
      role: 'owner' as const, userId: confirmed.createdByUserId, permissions: ['orders.buy' as const],
    }) } as unknown as SubjectAccess;
    const fulfillment = { onOrderConfirmed: async () => { attempts += 1; throw new Error('provider unavailable'); } };
    const service = new CreditOrderService(store, subjects, computeEnabledConfig(),
      () => new Date('2026-08-12T12:00:00.000Z'), fulfillment);
    const result = await service.create({ userId: confirmed.createdByUserId } as never, {
      listingId: confirmed.listingId, quantity: '2', idempotencyKey: 'purchase-response-loss01',
    }, { requestId: 'request-create', ip: '127.0.0.1' });
    expect(result).toMatchObject({ replayed: false, order: { id: confirmed.id, status: 'confirmed' } });
    expect(attempts).toBe(1);
    expect(reservationInput).toMatchObject({
      computeFulfillmentAvailable: true, autoConfirmCompute: true, nodeAcceleratorCountFallback: 8,
    });
  });

  it('returns a retryable service error before a purchase can mutate when node delivery is not configured', async () => {
    let reservationInput: Parameters<CreditOrderStore['createReservation']>[0] | null = null;
    const store = { createReservation: async (input: Parameters<CreditOrderStore['createReservation']>[0]) => {
      reservationInput = input; return { status: 'commerce_unavailable' as const };
    } } as unknown as CreditOrderStore;
    const subjects = { current: async () => ({
      subjectId: buyerSubjectId, kind: 'personal' as const, displayName: '买方', subjectStatus: 'active' as const,
      role: 'owner' as const, userId: providerUserId, permissions: ['orders.buy' as const],
    }) } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }));
    await expect(service.create({ userId: providerUserId } as never, {
      listingId: '10000000-0000-4000-8000-000000000006', quantity: '1',
      idempotencyKey: 'compute-gate-order-0001',
    }, { requestId: 'request-gated', ip: '127.0.0.1' })).rejects.toMatchObject({
      code: 'COMPUTE_FULFILLMENT_UNAVAILABLE', statusCode: 503,
    });
    expect(reservationInput).toMatchObject({ computeFulfillmentAvailable: false });
  });

  it('returns only the order actions that the current side can execute', async () => {
    let subjectId = providerSubjectId;
    let permissions: string[] = ['orders.read', 'provider.order.manage'];
    const records = [order('reserved'), order('confirmed'), order('provisioning'), order('acceptance_pending')];
    const store = { listForSubject: async () => records } as unknown as CreditOrderStore;
    const subjects = {
      current: async () => ({
        subjectId, kind: 'personal' as const, displayName: '交易主体', subjectStatus: 'active' as const,
        role: 'owner' as const, userId: providerUserId, permissions,
      }),
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }));
    const principal: AccountPrincipal = { userId: providerUserId, sessionId: 'actions', role: 'supplier' };

    expect((await service.list(principal)).orders.map((item) => item.actions)).toEqual([
      [], [], [], [],
    ]);
    subjectId = buyerSubjectId;
    permissions = ['orders.read', 'orders.buy'];
    expect((await service.list(principal)).orders.map((item) => item.actions)).toEqual([
      [], [], [], [],
    ]);
    permissions = ['orders.read'];
    expect((await service.list(principal)).orders.every((item) => item.actions.length === 0)).toBe(true);
  });

  it('paginates one order side at a time and rejects an invalid cursor', async () => {
    const secondOrder = { ...order('confirmed'), id: '10000000-0000-4000-8000-000000000007' };
    let requestedSide = '';
    let requestedCursor: unknown = null;
    const store = {
      listForSubject: async (_subjectId: string, _limit: number, side: string, cursor: unknown) => {
        requestedSide = side; requestedCursor = cursor;
        return cursor ? [] : [order('reserved'), secondOrder];
      },
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async () => ({
        subjectId: providerSubjectId, kind: 'personal' as const, displayName: '提供方', subjectStatus: 'active' as const,
        role: 'owner' as const, userId: providerUserId, permissions: ['orders.read', 'provider.order.manage'] as const,
      }),
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }));
    const principal: AccountPrincipal = { userId: providerUserId, sessionId: 'pages', role: 'supplier' };

    const first = await service.list(principal, { limit: 1, side: 'provider' });
    expect(first.orders).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf('string');
    expect(requestedSide).toBe('provider');
    const second = await service.list(principal, { limit: 1, side: 'provider', cursor: first.nextCursor! });
    expect(second).toEqual({ orders: [], nextCursor: null });
    expect(requestedCursor).toMatchObject({ id: orderId, createdAt: new Date('2026-08-12T12:00:00.000Z') });
    await expect(service.list(principal, { cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'PAGINATION_CURSOR_INVALID' });
  });

  it('encrypts delivery credentials at the service boundary and decrypts them only for an order participant', async () => {
    let ciphertext = '';
    let digest = '';
    const store = {
      markDeliveryReady: async (input: Parameters<CreditOrderStore['markDeliveryReady']>[0]) => {
        ciphertext = input.deliveryPayloadCiphertext;
        digest = input.deliveryPayloadDigest;
        return { status: 'acceptance_pending' as const, order: order('acceptance_pending') };
      },
      deliveryForSubject: async (subjectId: string) => subjectId === providerSubjectId ? {
        order: order('acceptance_pending'), attempts: [{
          id: '10000000-0000-4000-8000-000000000007', attemptNumber: 1, status: 'ready' as const,
          deliveryPayloadCiphertext: ciphertext, deliveryPayloadDigest: digest,
          startedAt: new Date('2026-08-12T12:00:00.000Z'), readyAt: new Date('2026-08-12T12:00:00.000Z'),
        }],
      } : null,
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async () => ({
        subjectId: providerSubjectId, kind: 'personal' as const, displayName: '提供方', subjectStatus: 'active' as const,
        role: 'owner' as const, userId: providerUserId, permissions: ['orders.read', 'provider.order.manage'] as const,
      }),
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }), () => new Date('2026-08-12T12:00:00.000Z'));
    const principal: AccountPrincipal = { userId: providerUserId, sessionId: 'session-1', role: 'supplier' };
    const details = {
      endpoint: '10.0.0.8', username: 'root', temporaryPassword: 'very-secret',
      instructions: '通过控制台登录后运行验收任务。',
    };

    const ready = await service.deliveryReady(principal, orderId, details, 'provider-ready-service-001', {
      requestId: 'request-1', ip: '127.0.0.1',
    });
    expect(ready.order).toMatchObject({ status: 'acceptance_pending', side: 'provider' });
    expect(ready.order).not.toHaveProperty('delivery');
    expect(ciphertext).toMatch(/^v1\./u);
    expect(ciphertext).not.toContain(details.endpoint);
    expect(ciphertext).not.toContain(details.username);
    expect(ciphertext).not.toContain(details.temporaryPassword);

    const delivery = await service.delivery(principal, orderId);
    expect(delivery.delivery).toEqual({ details, digest, attemptNumber: 1, status: 'ready' });
  });

  it('rejects incomplete or client-invented delivery fields before writing them', async () => {
    let writes = 0;
    const store = {
      markDeliveryReady: async () => { writes += 1; return { status: 'acceptance_pending' as const, order: order('acceptance_pending') }; },
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async () => ({
        subjectId: providerSubjectId, kind: 'personal' as const, displayName: '提供方', subjectStatus: 'active' as const,
        role: 'owner' as const, userId: providerUserId, permissions: ['provider.order.manage'] as const,
      }),
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }));
    const principal: AccountPrincipal = { userId: providerUserId, sessionId: 'delivery-validation', role: 'supplier' };
    await expect(service.deliveryReady(principal, orderId, { endpoint: '10.0.0.8' }, 'provider-ready-invalid-01', {
      requestId: 'request-invalid-1', ip: '127.0.0.1',
    })).rejects.toMatchObject({ code: 'DELIVERY_DETAILS_INVALID' });
    await expect(service.deliveryReady(principal, orderId, {
      endpoint: '10.0.0.8', instructions: '登录后验收。', token: 'not-allowed',
    }, 'provider-ready-invalid-02', { requestId: 'request-invalid-2', ip: '127.0.0.1' }))
      .rejects.toMatchObject({ code: 'DELIVERY_DETAILS_INVALID' });
    expect(writes).toBe(0);
  });

  it('encrypts a buyer delivery issue and returns its plaintext only through the participant detail method', async () => {
    let ciphertext = '';
    let digest = '';
    const disputed = { ...order('acceptance_pending'), status: 'disputed' as const };
    const store = {
      reportDeliveryIssue: async (input: Parameters<CreditOrderStore['reportDeliveryIssue']>[0]) => {
        ciphertext = input.descriptionCiphertext; digest = input.descriptionDigest;
        return { status: 'disputed' as const, order: disputed };
      },
      deliveryIssueForSubject: async (subjectId: string) => subjectId === buyerSubjectId ? {
        order: disputed, requestedResolution: 'rework' as const, descriptionCiphertext: ciphertext,
        descriptionDigest: digest, status: 'open' as const, openedAt: new Date('2026-08-12T12:00:00.000Z'),
      } : null,
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async () => ({
        subjectId: buyerSubjectId, kind: 'personal' as const, displayName: '买方', subjectStatus: 'active' as const,
        role: 'owner' as const, userId: '10000000-0000-4000-8000-000000000005',
        permissions: ['orders.read', 'orders.buy'] as const,
      }),
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }), () => new Date('2026-08-12T12:00:00.000Z'));
    const principal: AccountPrincipal = {
      userId: '10000000-0000-4000-8000-000000000005', sessionId: 'session-2', role: 'member',
    };
    const description = '服务器连接后立即断开，需要重新配置。';
    const reported = await service.reportDeliveryIssue(principal, orderId, {
      requestedResolution: 'rework', description,
    }, 'buyer-report-service-0001', { requestId: 'request-2', ip: '127.0.0.1' });
    expect(reported.order).toMatchObject({ status: 'disputed', side: 'buyer' });
    expect(ciphertext).toMatch(/^v1\./u);
    expect(ciphertext).not.toContain(description);
    expect(await service.deliveryIssue(principal, orderId)).toMatchObject({
      issue: { status: 'open', requestedResolution: 'rework', description },
    });
  });

  it('returns the provider action that matches the delivery issue resolution', async () => {
    let resolution: 'rework' | 'refund' = 'rework';
    const disputed = { ...order('acceptance_pending'), status: 'disputed' as const };
    const key = Buffer.alloc(32, 7).toString('base64');
    const store = {
      deliveryIssueForSubject: async () => ({
        order: disputed, requestedResolution: resolution,
        descriptionCiphertext: encryptPii(JSON.stringify({ requestedResolution: resolution, description: '交付结果与约定不符。' }), key),
        descriptionDigest: 'issue-digest', status: 'open' as const,
        openedAt: new Date('2026-08-12T12:00:00.000Z'),
      }),
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async () => ({
        subjectId: providerSubjectId, kind: 'personal' as const, displayName: '提供方', subjectStatus: 'active' as const,
        role: 'owner' as const, userId: providerUserId,
        permissions: ['orders.read', 'orders.dispute.manage', 'provider.order.manage'] as const,
      }),
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: key,
    }));
    const principal: AccountPrincipal = { userId: providerUserId, sessionId: 'issue-actions', role: 'supplier' };
    expect((await service.deliveryIssue(principal, orderId)).issue.actions).toEqual(['start_rework']);
    resolution = 'refund';
    expect((await service.deliveryIssue(principal, orderId)).issue.actions).toEqual(['approve_refund', 'escalate_dispute']);
  });

  it('starts rework only through provider order permission', async () => {
    let requestedSubjectId = '';
    const store = {
      startRework: async (input: Parameters<CreditOrderStore['startRework']>[0]) => {
        requestedSubjectId = input.subjectId;
        return { status: 'provisioning' as const, order: order('provisioning') };
      },
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async (_userId: string, permission: string) => {
        expect(permission).toBe('provider.order.manage');
        return {
          subjectId: providerSubjectId, kind: 'personal' as const, displayName: '提供方', subjectStatus: 'active' as const,
          role: 'owner' as const, userId: providerUserId, permissions: ['provider.order.manage'] as const,
        };
      },
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }));
    const result = await service.startRework({ userId: providerUserId, sessionId: 'session-3', role: 'supplier' },
      orderId, 'provider-rework-service001', { requestId: 'request-3', ip: '127.0.0.1' });
    expect(result.order).toMatchObject({ status: 'provisioning', side: 'provider' });
    expect(requestedSubjectId).toBe(providerSubjectId);
  });

  it('approves and reads a full refund without accepting a client-supplied amount', async () => {
    const refunded = { ...order('acceptance_pending'), status: 'refunded' as const, closedAt: new Date('2026-08-12T13:00:00.000Z') };
    const store = {
      approveMutualRefund: async () => ({ status: 'refunded' as const, order: refunded }),
      mutualRefundForSubject: async () => ({
        order: refunded, creditMicros: 62_275_450n, status: 'succeeded' as const,
        approvedAt: new Date('2026-08-12T13:00:00.000Z'),
      }),
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async (_userId: string, permission: string) => ({
        subjectId: providerSubjectId, kind: 'personal' as const, displayName: '提供方', subjectStatus: 'active' as const,
        role: 'owner' as const, userId: providerUserId, permissions: [permission] as const,
      }),
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }), () => new Date('2026-08-12T13:00:00.000Z'));
    const principal: AccountPrincipal = { userId: providerUserId, sessionId: 'session-4', role: 'supplier' };
    expect(await service.approveMutualRefund(principal, orderId, 'provider-refund-service01', {
      requestId: 'request-4', ip: '127.0.0.1',
    })).toMatchObject({ order: { status: 'refunded' } });
    expect(await service.mutualRefund(principal, orderId)).toMatchObject({
      refund: { status: 'succeeded', creditAmount: '62.275450' },
    });
  });

  it('settles through provider permission and returns the exact settlement receipt', async () => {
    const acceptedAt = new Date('2026-08-05T13:00:00.000Z');
    const availableAt = new Date('2026-08-12T13:00:00.000Z');
    const closed = { ...order('accepted'), status: 'closed' as const, acceptedAt, closedAt: acceptedAt };
    const store = {
      settleSupplier: async () => ({ status: 'settled' as const, order: closed }),
      supplierSettlementForSubject: async () => ({
        order: closed, creditMicros: 62_275_450n, status: 'succeeded' as const, triggeredBy: 'provider' as const,
        acceptedAt, availableAt, settledAt: availableAt,
      }),
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async (_userId: string, permission: string) => ({
        subjectId: providerSubjectId, kind: 'personal' as const, displayName: '提供方', subjectStatus: 'active' as const,
        role: 'owner' as const, userId: providerUserId, permissions: [permission] as const,
      }),
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }), () => availableAt);
    const principal: AccountPrincipal = { userId: providerUserId, sessionId: 'session-5', role: 'supplier' };
    expect(await service.settleSupplier(principal, orderId, 'provider-settle-service01', {
      requestId: 'request-5', ip: '127.0.0.1',
    })).toMatchObject({ order: { status: 'closed', settlementAvailableAt: availableAt.toISOString() } });
    expect(await service.supplierSettlement(principal, orderId)).toMatchObject({
      settlement: { status: 'succeeded', creditAmount: '62.275450', triggeredBy: 'provider' },
    });
  });

  it('encrypts operator decision reasons and exposes the result only to order participants', async () => {
    let reasonCiphertext = '';
    const escalatedAt = new Date('2026-08-12T12:00:00.000Z');
    const decidedAt = new Date('2026-08-12T13:00:00.000Z');
    const disputed = { ...order('acceptance_pending'), status: 'disputed' as const };
    const refunded = { ...disputed, status: 'refunded' as const, closedAt: decidedAt };
    const store = {
      escalateDispute: async () => ({ status: 'escalated' as const, order: disputed }),
      listPendingDisputeAdjudications: async () => [{
        order: disputed, deliveryIssueId: '10000000-0000-4000-8000-000000000008',
        escalatedBySide: 'buyer' as const, escalatedAt, requestedResolution: 'refund' as const,
        descriptionCiphertext: encryptPii(JSON.stringify({
          requestedResolution: 'refund', description: '交付规格与挂牌不一致。',
        }), Buffer.alloc(32, 7).toString('base64')),
        descriptionDigest: 'description-digest', deliveryAttemptNumber: 1,
        deliveryPayloadCiphertext: encryptPii(JSON.stringify({ endpoint: '10.0.0.8' }),
          Buffer.alloc(32, 7).toString('base64')),
        deliveryPayloadDigest: 'delivery-digest',
      }],
      decideDispute: async (input: Parameters<CreditOrderStore['decideDispute']>[0]) => {
        reasonCiphertext = input.reasonCiphertext;
        return { status: 'decided' as const, order: refunded, decisionId: 'decision-1', outcome: input.outcome };
      },
      disputeAdjudicationForSubject: async () => ({
        order: refunded, status: 'resolved' as const, escalatedBySide: 'buyer' as const, escalatedAt,
        outcome: 'full_refund' as const, reasonCiphertext, reasonDigest: 'reason-digest',
        creditMicros: 62_275_450n, decidedAt,
      }),
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async (_userId: string, permission: string) => ({
        subjectId: buyerSubjectId, kind: 'personal' as const, displayName: '买方', subjectStatus: 'active' as const,
        role: 'owner' as const, userId: providerUserId, permissions: [permission] as const,
      }),
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }), () => decidedAt);
    const buyer: AccountPrincipal = { userId: providerUserId, sessionId: 'session-6', role: 'member' };
    const operator: AccountPrincipal = { userId: '10000000-0000-4000-8000-000000000009', sessionId: 'session-7', role: 'operator' };
    expect(await service.escalateDispute(buyer, orderId, 'buyer-escalate-service01', {
      requestId: 'request-6', ip: '127.0.0.1',
    })).toMatchObject({ order: { status: 'disputed', side: 'buyer' } });
    expect(await service.pendingDisputeAdjudications(operator)).toMatchObject([{
      description: '交付规格与挂牌不一致。', delivery: { attemptNumber: 1, details: { endpoint: '10.0.0.8' } },
    }]);
    const reason = '交付内容与审核挂牌不一致，支持买方全额退款。';
    expect(await service.decideDispute(operator, orderId, { outcome: 'full_refund', reason },
      'operator-decision-service1', { requestId: 'request-7', ip: '127.0.0.1' }))
      .toMatchObject({ replayed: false, outcome: 'full_refund', order: { status: 'refunded' } });
    expect(reasonCiphertext).toMatch(/^v1\./u);
    expect(reasonCiphertext).not.toContain(reason);
    expect(await service.disputeAdjudication(buyer, orderId)).toMatchObject({
      adjudication: { status: 'resolved', outcome: 'full_refund', reason, creditAmount: '62.275450' },
    });
    await expect(service.decideDispute(buyer, orderId, { outcome: 'full_refund', reason },
      'buyer-illegal-decision01', { requestId: 'request-8', ip: '127.0.0.1' }))
      .rejects.toMatchObject({ code: 'OPERATOR_REQUIRED' });
  });

  it('encrypts an aftercare request and approves its exact order amount through finance permission', async () => {
    const acceptedAt = new Date('2026-08-05T00:00:00.000Z');
    const requestedAt = new Date('2026-08-06T00:00:00.000Z');
    const resolvedAt = new Date('2026-08-07T00:00:00.000Z');
    const accepted = { ...order('accepted'), capacityUnit: '资源时', acceptedAt,
      acceptedByUserId: providerUserId, closedAt: acceptedAt };
    const refunded = { ...accepted, status: 'refunded' as const };
    let ciphertext = '';
    let requestedPermission = '';
    const store = {
      getForSubject: async () => accepted,
      requestPostAcceptanceRefund: async (input: Parameters<CreditOrderStore['requestPostAcceptanceRefund']>[0]) => {
        ciphertext = input.descriptionCiphertext;
        return { status: 'aftercare_pending' as const, order: accepted };
      },
      approvePostAcceptanceRefund: async () => ({ status: 'refunded' as const, order: refunded }),
      postAcceptanceRefundForSubject: async () => ({
        order: refunded, status: 'succeeded' as const, descriptionCiphertext: ciphertext,
        descriptionDigest: 'aftercare-digest', creditMicros: 62_275_450n, requestedAt, resolvedAt,
        escalatedBySide: null, escalatedAt: null, providerResponseCiphertext: null,
        providerResponseDigest: null, outcome: null, decisionReasonCiphertext: null,
        decisionReasonDigest: null, decidedAt: null,
      }),
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async (_userId: string, permission: string) => {
        requestedPermission = permission;
        return {
          subjectId: permission === 'provider.refund.approve' ? providerSubjectId : buyerSubjectId,
          kind: 'personal' as const, displayName: '交易主体', subjectStatus: 'active' as const,
          role: 'owner' as const, userId: providerUserId, permissions: [permission] as const,
        };
      },
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }), () => requestedAt);
    const principal: AccountPrincipal = { userId: providerUserId, sessionId: 'session-8', role: 'supplier' };
    const description = '验收后持续运行时发现实际规格与订单不一致。';
    expect(await service.requestPostAcceptanceRefund(principal, orderId, description,
      '62.275450', 'buyer-aftercare-service01', { requestId: 'request-9', ip: '127.0.0.1' }))
      .toMatchObject({ order: { status: 'accepted', side: 'buyer' } });
    expect(ciphertext).toMatch(/^v1\./u);
    expect(ciphertext).not.toContain(description);
    expect(await service.approvePostAcceptanceRefund(principal, orderId,
      'provider-aftercare-service1', { requestId: 'request-10', ip: '127.0.0.1' }))
      .toMatchObject({ order: { status: 'refunded', side: 'provider' } });
    expect(requestedPermission).toBe('provider.refund.approve');
    expect(await service.postAcceptanceRefund(principal, orderId)).toMatchObject({
      aftercareRefund: { status: 'succeeded', description, creditAmount: '62.275450' },
    });
  });

  it('encrypts a provider contest and exposes one complete aftercare record to both app views', async () => {
    const requestedAt = new Date('2026-08-06T00:00:00.000Z');
    const escalatedAt = new Date('2026-08-06T01:00:00.000Z');
    const accepted = { ...order('accepted'), acceptedAt: new Date('2026-08-05T00:00:00.000Z'), closedAt: new Date('2026-08-05T00:00:00.000Z') };
    let responseCiphertext = '';
    const key = Buffer.alloc(32, 7).toString('base64');
    const store = {
      contestPostAcceptanceRefund: async (input: Parameters<CreditOrderStore['contestPostAcceptanceRefund']>[0]) => {
        responseCiphertext = input.responseCiphertext;
        return { status: 'aftercare_escalated' as const, order: accepted };
      },
      postAcceptanceRefundForSubject: async () => ({
        order: accepted, status: 'escalated' as const,
        descriptionCiphertext: encryptPii(JSON.stringify({ description: '验收后发现实际规格与订单不一致。' }), key),
        descriptionDigest: 'buyer-description-digest', creditMicros: 62_275_450n, requestedAt, resolvedAt: null,
        escalatedBySide: 'provider' as const, escalatedAt, providerResponseCiphertext: responseCiphertext,
        providerResponseDigest: 'provider-response-digest', outcome: null,
        decisionReasonCiphertext: null, decisionReasonDigest: null, decidedAt: null,
      }),
    } as unknown as CreditOrderStore;
    const subjects = {
      current: async (_userId: string, permission: string) => ({
        subjectId: providerSubjectId, kind: 'personal' as const, displayName: '提供方', subjectStatus: 'active' as const,
        role: 'owner' as const, userId: providerUserId, permissions: [permission] as never,
      }),
    } as unknown as SubjectAccess;
    const service = new CreditOrderService(store, subjects, loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PII_ENCRYPTION_KEY: key,
    }), () => escalatedAt);
    const principal: AccountPrincipal = { userId: providerUserId, sessionId: 'session-9', role: 'supplier' };
    const response = '资源规格与审核材料一致，请平台核对运行记录。';
    expect(await service.contestPostAcceptanceRefund(principal, orderId, response,
      'provider-contest-service01', { requestId: 'request-11', ip: '127.0.0.1' }))
      .toMatchObject({ order: { status: 'accepted', side: 'provider' } });
    expect(responseCiphertext).toMatch(/^v1\./u);
    expect(responseCiphertext).not.toContain(response);
    expect(await service.postAcceptanceRefund(principal, orderId)).toMatchObject({
      aftercareRefund: {
        status: 'escalated', providerResponse: response, escalatedBySide: 'provider', actions: [],
      },
    });
  });
});
