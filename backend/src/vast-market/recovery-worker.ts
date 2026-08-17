import type { VastMarketService } from './service.js';

type Logger = Readonly<{ info(fields: Record<string, unknown>,message: string): void;
  error(fields: Record<string, unknown>,message: string): void }>;

export class VastReconciliationWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly service: VastMarketService,private readonly logger: Logger,
    private readonly intervalMs = 30_000) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(),this.intervalMs);
    this.timer.unref();
    void this.run();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.service.reconcileProviderInventory();
      if (result.resolved || result.orphanInstances.length) this.logger.info({
        resolved: result.resolved,orphanInstances: result.orphanInstances,
      },'Vast.ai reconciliation completed');
    } catch (error) { this.logger.error({ err: error },'Vast.ai reconciliation failed'); }
    finally { this.running = false; }
  }
}
