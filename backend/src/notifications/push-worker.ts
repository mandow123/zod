import type { RuntimeConfig } from '../config.js';
import { decryptPii } from '../account/crypto.js';
import type { WorkerLogger } from '../refunds/processor.js';
import type { PushProvider } from './push-provider.js';
import type { PushOutboxJob, PushOutboxStore, ReceiptResult, TicketResult } from './push-store.js';

function codeOf(error: unknown) {
  if (error instanceof Error && /^[A-Z0-9_:-]{1,100}$/u.test(error.message)) return error.message;
  return 'PUSH_PROVIDER_TEMPORARY_FAILURE';
}

function resultCode(result: { message?: string; details?: { error?: string } }) {
  return result.details?.error?.slice(0, 100) || result.message?.slice(0, 100) || 'PUSH_DELIVERY_FAILED';
}

function invalidDevice(code: string) {
  return code === 'DeviceNotRegistered';
}

function receiptTargets(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.receipts)) throw new Error('PUSH_RECEIPT_PAYLOAD_INVALID');
  const targets = payload.receipts.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as { installationId?: unknown; ticketId?: unknown };
    return typeof item.installationId === 'string' && typeof item.ticketId === 'string'
      ? [{ installationId: item.installationId, ticketId: item.ticketId }] : [];
  });
  if (!targets.length || targets.length !== payload.receipts.length) throw new Error('PUSH_RECEIPT_PAYLOAD_INVALID');
  return targets;
}

export class PushProcessor {
  private readonly piiKey: string;

  constructor(
    private readonly store: PushOutboxStore,
    private readonly provider: PushProvider,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!config.PII_ENCRYPTION_KEY) throw new Error('PII_ENCRYPTION_KEY is required.');
    this.piiKey = config.PII_ENCRYPTION_KEY;
  }

  async process(job: PushOutboxJob) {
    if (job.topic === 'push.receipt') return this.processReceipts(job);
    const notification = await this.store.loadNotification(job.aggregateId);
    if (!notification || !notification.installations.length) return this.store.complete(job.id, this.now());
    const decrypted: Array<{ installationId: string; token: string }> = [];
    const localFailures: TicketResult[] = [];
    for (const installation of notification.installations) {
      try {
        decrypted.push({ installationId: installation.id, token: decryptPii(installation.tokenCiphertext, this.piiKey) });
      } catch {
        localFailures.push({ installationId: installation.id, status: 'invalid_device', errorCode: 'PUSH_TOKEN_DECRYPT_FAILED' });
      }
    }
    const tickets = decrypted.length ? await this.provider.send(decrypted.map((target) => ({
      to: target.token, title: notification.title, body: notification.body,
      data: { ...notification.data, notificationId: notification.notificationId }, sound: 'default', priority: 'high',
    }))) : [];
    const results: TicketResult[] = [...localFailures, ...tickets.map((ticket, index) => {
      const installationId = decrypted[index]!.installationId;
      if (ticket.status === 'ok' && ticket.id) return { installationId, status: 'accepted' as const, ticketId: ticket.id };
      const errorCode = resultCode(ticket);
      return { installationId, status: invalidDevice(errorCode) ? 'invalid_device' as const : 'failed' as const, errorCode };
    })];
    await this.store.recordTickets(job, results, this.now(), new Date(this.now().getTime() + 15 * 60_000));
  }

  private async processReceipts(job: PushOutboxJob) {
    const targets = receiptTargets(job.payload);
    const receipts = await this.provider.receipts(targets.map((target) => target.ticketId));
    if (targets.some((target) => !receipts[target.ticketId])) throw new Error('PUSH_RECEIPT_PENDING');
    const results: ReceiptResult[] = targets.map((target) => {
      const receipt = receipts[target.ticketId]!;
      if (receipt.status === 'ok') return { ...target, status: 'delivered' as const };
      const errorCode = resultCode(receipt);
      return { ...target, status: invalidDevice(errorCode) ? 'invalid_device' as const : 'failed' as const, errorCode };
    });
    await this.store.recordReceipts(job, results, this.now());
  }
}

export class PushOutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly store: PushOutboxStore,
    private readonly processor: PushProcessor,
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
      const jobs = await this.store.claim(now, new Date(now.getTime() - 5 * 60_000), 20);
      await Promise.all(jobs.map((job) => this.handle(job)));
    } catch (error) {
      this.logger.error({ err: error }, 'push outbox polling failed');
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private async handle(job: PushOutboxJob) {
    try {
      await this.processor.process(job);
    } catch (error) {
      const code = codeOf(error);
      const failureNumber = job.attempts + 1;
      const delay = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(failureNumber - 1, 8));
      const failed = await this.store.fail(job.id, code, new Date(this.now().getTime() + delay), 8);
      const fields = { jobId: job.id, notificationId: job.aggregateId, code, attempts: failed.attempts };
      if (failed.deadLettered) this.logger.error(fields, 'push job dead-lettered; in-app notification remains available');
      else this.logger.info(fields, 'push job scheduled for retry');
    }
  }
}
