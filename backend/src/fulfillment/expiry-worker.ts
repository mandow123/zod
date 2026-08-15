import type { WorkerLogger } from '../refunds/processor.js';
import type { FulfillmentService } from './service.js';

export class FulfillmentExpiryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly service: FulfillmentService, private readonly logger: WorkerLogger,
    private readonly intervalMs = 30_000) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const count = await this.service.stopExpired(20);
      if (count) this.logger.info({ count }, 'expired compute fulfillments stopped');
      const provisioning = await this.service.reconcileProvisioning(20);
      if (provisioning) this.logger.info({ count: provisioning }, 'compute fulfillments reconciled');
      const timedOut = await this.service.expireProvisioning(20);
      if (timedOut) this.logger.info({ count: timedOut }, 'expired compute provisioning refunded');
      const active = await this.service.reconcileActive(20);
      if (active) this.logger.info({ count: active }, 'active compute fulfillments reconciled');
      const stopping = await this.service.reconcileStopping(20);
      if (stopping) this.logger.info({ count: stopping }, 'stopping compute fulfillments reconciled');
      const accepted = await this.service.autoAcceptDue(20);
      if (accepted) this.logger.info({ count: accepted }, 'compute fulfillments auto accepted');
      const settled = await this.service.settleDue(20);
      if (settled) this.logger.info({ count: settled }, 'compute fulfillment settlements posted');
    } catch (error) {
      this.logger.error({ error }, 'compute fulfillment expiry worker failed');
    } finally { this.running = false; }
  }
}
