import type { WorkerLogger } from '../refunds/processor.js';
import type { CreatorCommissionStore } from './store.js';

export class CreatorCommissionWorker {
  private timer:NodeJS.Timeout|null=null; private running=false;
  constructor(private readonly store:CreatorCommissionStore,private readonly refundObservationDays:number,
    private readonly logger:WorkerLogger,private readonly intervalMs=30_000) {}
  start(){if(this.timer)return;void this.tick();this.timer=setInterval(()=>void this.tick(),this.intervalMs);this.timer.unref();}
  stop(){if(this.timer){clearInterval(this.timer);this.timer=null;}}
  async runOnce(now=new Date()){const discovered=await this.store.discoverEligibleOrders(now);
    const lifecycle=await this.store.reconcileLifecycle(now,this.refundObservationDays,100);return {discovered,...lifecycle};}
  private async tick(){if(this.running)return;this.running=true;try{const result=await this.runOnce();
    if(result.discovered||result.completed||result.matured||result.reversed)this.logger.info(result,'creator commission lifecycle reconciled');
  }catch(error){this.logger.error({err:error},'creator commission lifecycle reconciliation failed');}finally{this.running=false;}}
}
