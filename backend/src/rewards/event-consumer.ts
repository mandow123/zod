import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { WorkerLogger } from '../refunds/processor.js';
import type { DualRewardInternalService } from './service.js';

export type RewardCommerceJob=Readonly<{id:string;topic:'commerce.order.net_settled.v1'|'commerce.order.net_revised.v1';
  payload:Record<string,unknown>;attempts:number}>;

type JobRow=QueryResultRow&{id:string;topic:RewardCommerceJob['topic'];payload:Record<string,unknown>;attempts:number};

export class PostgresRewardCommerceEventSource {
  constructor(private readonly database:Database) {}
  claim(now:Date,staleBefore:Date,limit:number) {
    return this.database.transaction(async(client)=>{
      const result=await client.query<JobRow>(`WITH candidates AS (
        SELECT id FROM outbox_events WHERE topic IN ('commerce.order.net_settled.v1','commerce.order.net_revised.v1')
          AND processed_at IS NULL AND dead_lettered_at IS NULL AND available_at<=$1
          AND (locked_at IS NULL OR locked_at<$2) ORDER BY available_at,created_at,id
          LIMIT $3 FOR UPDATE SKIP LOCKED
      ) UPDATE outbox_events o SET locked_at=$1 FROM candidates c WHERE o.id=c.id
        RETURNING o.id,o.topic,o.payload,o.attempts`,[now,staleBefore,limit]);
      return result.rows.map(row=>({id:row.id,topic:row.topic,payload:row.payload,attempts:row.attempts}));
    });
  }
  complete(id:string,now:Date){return this.database.query(`UPDATE outbox_events SET processed_at=$2,locked_at=NULL,
    last_error=NULL WHERE id=$1`,[id,now]).then(()=>undefined);}
  defer(id:string,availableAt:Date){return this.database.query(`UPDATE outbox_events SET available_at=$2,locked_at=NULL
    WHERE id=$1 AND processed_at IS NULL`,[id,availableAt]).then(()=>undefined);}
  fail(id:string,error:string,availableAt:Date,maxAttempts:number){return this.database.query(`UPDATE outbox_events SET
    attempts=attempts+1,last_error=$2,available_at=$3,locked_at=NULL,
    dead_lettered_at=CASE WHEN attempts+1>=$4 THEN now() ELSE NULL END WHERE id=$1`,[
    id,error.slice(0,300),availableAt,maxAttempts,
  ]).then(()=>undefined);}
}

export class RewardCommerceEventWorker {
  private timer:NodeJS.Timeout|null=null;
  private running=false;
  constructor(private readonly source:PostgresRewardCommerceEventSource,private readonly service:DualRewardInternalService,
    private readonly logger:WorkerLogger,private readonly intervalMs=30_000,private readonly limit=50,
    private readonly maxAttempts=8) {}
  start(){if(this.timer)return;void this.tick();this.timer=setInterval(()=>void this.tick(),this.intervalMs);this.timer.unref();}
  stop(){if(this.timer){clearInterval(this.timer);this.timer=null;}}
  async runOnce(now=new Date()) {
    const jobs=await this.source.claim(now,new Date(now.getTime()-120_000),this.limit);
    let completed=0,failed=0,deferred=0;
    for(const job of jobs) {
      try {
        const result=await this.service.consumeCommerceEvent({source:'commerce',...job.payload,type:job.topic});
        if(result.status==='off'||result.status==='retryable'){
          await this.source.defer(job.id,new Date(now.getTime()+(result.status==='retryable'?5_000:300_000)));deferred+=1;
        }
        else {await this.source.complete(job.id,now);completed+=1;}
      } catch(error) {
        const delay=Math.min(300_000,5_000*2**Math.min(job.attempts,6));
        await this.source.fail(job.id,error instanceof Error?error.message:'REWARD_EVENT_FAILED',
          new Date(now.getTime()+delay),this.maxAttempts);failed+=1;
      }
    }
    const matured=await this.service.matureDue(now,this.limit);
    return{claimed:jobs.length,completed,failed,deferred,matured};
  }
  private async tick(){if(this.running)return;this.running=true;try{const result=await this.runOnce();
    if(result.claimed||result.matured)this.logger.info(result,'dual reward commerce events reconciled');
  }catch(error){this.logger.error({err:error},'dual reward commerce event worker failed');}finally{this.running=false;}}
}
