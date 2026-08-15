import type { WorkerLogger } from '../refunds/processor.js';
import type { PostgresDeviceCommerceStore } from './store.js';

export class DeviceOrderExpiryWorker {
  private timer: NodeJS.Timeout | null = null; private running = false;
  constructor(private readonly store: PostgresDeviceCommerceStore, private readonly logger: WorkerLogger,
    private readonly intervalMs = 30_000, private readonly now: () => Date = () => new Date()) {}
  start(){ if(this.timer)return; this.timer=setInterval(()=>void this.tick(),this.intervalMs);this.timer.unref();void this.tick(); }
  async stop(){if(this.timer)clearInterval(this.timer);this.timer=null;while(this.running)await new Promise(resolve=>setTimeout(resolve,10));}
  async tick(){if(this.running)return;this.running=true;try{const count=await this.store.expireReservations(this.now(),100);if(count)this.logger.info({count},'expired physical device reservations');}
    catch(error){this.logger.error({err:error},'physical device reservation expiry failed');}finally{this.running=false;}}
}
