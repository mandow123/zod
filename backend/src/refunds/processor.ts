import type { RuntimeConfig } from '../config.js';
import { secretHash } from '../account/crypto.js';
import { AppError } from '../errors.js';
import type { RefundOutboxJob, RefundOutboxStore } from '../outbox/store.js';
import type { PaymentProvider } from '../payment/providers.js';
import type { PaymentProviderName } from '../payment/types.js';
import type { RefundExecutionStore } from './execution-store.js';

type ProcessResult = Readonly<{ status: 'complete' }> | Readonly<{ status: 'reschedule'; topic: RefundOutboxJob['topic']; at: Date }>;

function errorCode(error: unknown) {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error && /^[A-Z0-9_:-]{1,100}$/u.test(error.message)) return error.message;
  return 'REFUND_PROVIDER_TEMPORARY_FAILURE';
}

export class RefundProcessor {
  private readonly auditPepper: string;

  constructor(
    private readonly executions: RefundExecutionStore,
    private readonly providers: ReadonlyMap<PaymentProviderName, PaymentProvider>,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!config.AUDIT_PEPPER) throw new Error('AUDIT_PEPPER is required.');
    this.auditPepper = config.AUDIT_PEPPER;
  }

  async process(job: RefundOutboxJob): Promise<ProcessResult> {
    const execution = await this.executions.getExecution(job.aggregateId);
    if (!execution || ['succeeded', 'failed', 'rejected', 'cancelled'].includes(execution.status)) return { status: 'complete' };
    if (execution.status !== 'provider_pending') return { status: 'complete' };
    const provider = this.providers.get(execution.provider);
    if (!provider) throw new AppError('REFUND_PROVIDER_UNAVAILABLE', 503, '退款渠道尚未配置。');
    const request = {
      refundReference: execution.id,
      providerReference: execution.providerReference,
      amountCents: execution.amountCents,
      originalAmountCents: execution.originalAmountCents,
      currency: execution.currency,
      reason: execution.reason,
    } as const;
    if (job.topic === 'refund.reconcile' && this.now().getTime() - job.createdAt.getTime() > 48 * 60 * 60_000) {
      await this.executions.fail(execution.id, 'refund_reconciliation_timeout', this.now());
      return { status: 'complete' };
    }
    let result;
    if (job.topic === 'refund.execute') {
      try {
        result = await provider.executeRefund?.(request);
      } catch (executionError) {
        try {
          result = await provider.queryRefund?.(request);
        } catch {
          throw executionError;
        }
      }
    } else {
      result = await provider.queryRefund?.(request);
    }
    if (!result) throw new AppError('REFUND_PROVIDER_UNSUPPORTED', 503, '退款渠道能力尚未启用。');
    if (result.status === 'failed') {
      await this.executions.fail(execution.id, 'provider_reported_failed', this.now());
      return { status: 'complete' };
    }
    if (result.status === 'pending') {
      await this.executions.markProviderPending(execution.id, result.providerRefundId);
      return { status: 'reschedule', topic: 'refund.reconcile', at: new Date(this.now().getTime() + 5 * 60_000) };
    }
    const digest = secretHash(JSON.stringify(result), this.auditPepper);
    await this.executions.complete({
      refundId: execution.id, providerRefundId: result.providerRefundId,
      eventId: `${job.topic}:${execution.id}:${result.providerRefundId}:succeeded`, payloadDigest: digest, now: this.now(),
    });
    return { status: 'complete' };
  }

  async wechatNotification(headers: Record<string, string | undefined>, rawBody: string) {
    const provider = this.providers.get('wechat');
    if (!provider?.verifyWechatRefundNotification) throw new AppError('REFUND_PROVIDER_UNAVAILABLE', 503, '微信退款回调能力未配置。');
    return this.executions.applyVerifiedEvent(provider.verifyWechatRefundNotification(headers, rawBody), this.now());
  }

  failPermanently(refundId: string, code: string) {
    return this.executions.fail(refundId, code, this.now());
  }
}

export type WorkerLogger = Readonly<{
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}>;

export class RefundOutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly outbox: RefundOutboxStore,
    private readonly processor: RefundProcessor,
    private readonly logger: WorkerLogger,
    private readonly pollMilliseconds = 2_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMilliseconds);
    this.timer.unref();
    void this.tick();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      const jobs = await this.outbox.claim(now, new Date(now.getTime() - 5 * 60_000), 10);
      await Promise.all(jobs.map((job) => this.handle(job)));
    } catch (error) {
      this.logger.error({ err: error }, 'refund outbox polling failed');
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private async handle(job: RefundOutboxJob) {
    try {
      const result = await this.processor.process(job);
      if (result.status === 'complete') await this.outbox.complete(job.id, this.now());
      else await this.outbox.reschedule(job.id, result.topic, result.at);
    } catch (error) {
      const code = errorCode(error);
      const failureNumber = job.attempts + 1;
      const delay = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(failureNumber - 1, 8));
      if (failureNumber >= 12) await this.processor.failPermanently(job.aggregateId, code);
      const failed = await this.outbox.fail(job.id, code, new Date(this.now().getTime() + delay), 12);
      if (failed.deadLettered) {
        this.logger.error({ jobId: job.id, refundId: job.aggregateId, code }, 'refund job dead-lettered');
      } else {
        this.logger.info({ jobId: job.id, refundId: job.aggregateId, code, attempts: failed.attempts }, 'refund job scheduled for retry');
      }
    }
  }
}
