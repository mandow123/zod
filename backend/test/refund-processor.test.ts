import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { PaymentProvider } from '../src/payment/providers.js';
import type { ProviderRefundRequest, ProviderRefundResult, VerifiedRefundEvent } from '../src/payment/types.js';
import { RefundProcessor } from '../src/refunds/processor.js';
import type { RefundExecutionRecord, RefundExecutionStore, RefundEventApplyResult } from '../src/refunds/execution-store.js';

class MemoryExecutions implements RefundExecutionStore {
  record: RefundExecutionRecord = {
    id: randomUUID(), orderId: randomUUID(), userId: randomUUID(), paymentIntentId: randomUUID(),
    provider: 'wechat', providerReference: 'KP-ORIGINAL', providerRefundId: null,
    amountCents: 5000, originalAmountCents: 12800, currency: 'CNY', reason: '服务交付未达到承诺标准', status: 'provider_pending',
  };
  pendingIds: string[] = [];
  completedIds: string[] = [];
  failedIds: string[] = [];
  async getExecution(id: string) { return id === this.record.id ? this.record : null; }
  async markProviderPending(_id: string, providerRefundId: string) { this.pendingIds.push(providerRefundId); }
  async complete(input: { providerRefundId: string }) { this.completedIds.push(input.providerRefundId); this.record = { ...this.record, status: 'succeeded' }; return true; }
  async fail(id: string) { this.failedIds.push(id); this.record = { ...this.record, status: 'failed' }; }
  async applyVerifiedEvent(_event: VerifiedRefundEvent): Promise<RefundEventApplyResult> { return 'succeeded'; }
}

class PendingThenSuccessProvider implements PaymentProvider {
  readonly name = 'wechat' as const;
  executed: ProviderRefundRequest[] = [];
  queried = 0;
  async createCheckout() { return { providerPaymentId: 'unused', checkoutPayload: 'unused' }; }
  async executeRefund(input: ProviderRefundRequest): Promise<ProviderRefundResult> {
    this.executed.push(input);
    return { providerRefundId: 'WX-REFUND-01', status: 'pending' };
  }
  async queryRefund(): Promise<ProviderRefundResult> {
    this.queried += 1;
    return { providerRefundId: 'WX-REFUND-01', status: 'succeeded' };
  }
}

describe('refund provider processor', () => {
  it('moves pending channel responses to reconciliation and confirms only after provider success', async () => {
    const executions = new MemoryExecutions();
    const provider = new PendingThenSuccessProvider();
    const config = loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'a'.repeat(32), CURSOR_SECRET: 'b'.repeat(32),
      ACCESS_TOKEN_SECRET: 'c'.repeat(64), REFRESH_TOKEN_PEPPER: 'd'.repeat(32), OTP_PEPPER: 'e'.repeat(32),
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    });
    const processor = new RefundProcessor(executions, new Map([['wechat', provider]]), config, () => new Date('2026-08-11T15:00:00.000Z'));
    const createdAt = new Date('2026-08-11T14:00:00.000Z');
    const execute = await processor.process({ id: randomUUID(), topic: 'refund.execute', aggregateId: executions.record.id, payload: {}, attempts: 0, createdAt });
    expect(execute).toMatchObject({ status: 'reschedule', topic: 'refund.reconcile' });
    expect(provider.executed[0]).toMatchObject({ amountCents: 5000, originalAmountCents: 12800, refundReference: executions.record.id });
    expect(executions.completedIds).toEqual([]);
    const reconcile = await processor.process({ id: randomUUID(), topic: 'refund.reconcile', aggregateId: executions.record.id, payload: {}, attempts: 0, createdAt });
    expect(reconcile).toEqual({ status: 'complete' });
    expect(provider.queried).toBe(1);
    expect(executions.completedIds).toEqual(['WX-REFUND-01']);
  });

  it('fails closed when the configured payment provider cannot execute refunds', async () => {
    const executions = new MemoryExecutions();
    const config = loadConfig({ NODE_ENV: 'test', AUDIT_PEPPER: 'a'.repeat(32) });
    const processor = new RefundProcessor(executions, new Map(), config);
    await expect(processor.process({
      id: randomUUID(), topic: 'refund.execute', aggregateId: executions.record.id, payload: {}, attempts: 0, createdAt: new Date(),
    })).rejects.toMatchObject({ code: 'REFUND_PROVIDER_UNAVAILABLE' });
    expect(executions.completedIds).toEqual([]);
  });
});
