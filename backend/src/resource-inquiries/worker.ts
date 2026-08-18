import type { WorkerLogger } from '../refunds/processor.js';
import type { ResourceInquiryService } from './service.js';

export class ResourceInquiryExpiryWorker {
  private timer:NodeJS.Timeout|null=null;
  private running=false;
  constructor(private readonly service:ResourceInquiryService,private readonly logger:WorkerLogger,
    private readonly intervalMs=30_000){}
  start(){if(this.timer)return;void this.tick();this.timer=setInterval(()=>void this.tick(),this.intervalMs);this.timer.unref();}
  stop(){if(this.timer){clearInterval(this.timer);this.timer=null;}}
  runOnce(now=new Date()){return this.service.expireDue(now,100);}
  private async tick(){if(this.running)return;this.running=true;try{const result=await this.runOnce();
    if(result.expired)this.logger.info(result,'resource inquiries expired');
  }catch(error){this.logger.error({err:error},'resource inquiry expiry failed');}finally{this.running=false;}}
}
