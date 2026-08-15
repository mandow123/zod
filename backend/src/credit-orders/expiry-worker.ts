import type { CreditOrderStore } from './store.js';

type Logger = Readonly<{
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}>;

export class CreditOrderExpiryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly store: CreditOrderStore,
    private readonly logger: Logger,
    private readonly intervalMs = 15_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start() {
    if (this.timer || this.stopping) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  async tick() { await this.run(); }

  private async run() {
    if (this.running || this.stopping) return this.running ?? Promise.resolve();
    this.running = this.process().catch((error: unknown) => {
      this.logger.error({ error: error instanceof Error ? error.message : 'ORDER_EXPIRY_UNKNOWN' }, 'credit order expiry failed');
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async process() {
    let expired = 0;
    do {
      expired = await this.store.expireReservations(this.now(), 50);
      if (expired) this.logger.info({ expired }, 'credit order reservations expired');
    } while (expired === 50 && !this.stopping);
  }
}
