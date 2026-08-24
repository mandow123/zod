import type { DualRewardStore } from './store.js';
import { parseCommerceNetEvent } from './types.js';
import type { RewardDomain,RewardMode,RewardOrderClaimInput } from './types.js';

export class DualRewardInternalService {
  constructor(private readonly store:DualRewardStore,
    private readonly modes:Readonly<Record<RewardDomain,RewardMode>>) {}

  claimOrder(input:RewardOrderClaimInput) {
    return this.store.claimForOrder(input,this.modes);
  }

  consumeCommerceEvent(payload:unknown) {
    if(this.modes.streamer==='off'&&this.modes.invite==='off')return Promise.resolve({status:'off' as const});
    return this.store.consume(parseCommerceNetEvent(payload),this.modes);
  }

  matureDue(now=new Date(),limit=100) {
    if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error('REWARD_WORKER_LIMIT_INVALID');
    return this.store.matureDue(now,limit,this.modes);
  }

  transferAvailable(input:Readonly<{domain:RewardDomain;ownerUserId:string;targetSubjectId:string;
    clientRequestId:string;payloadDigest:string;now?:Date}>) {
    if(this.modes[input.domain]!=='on')return Promise.resolve({status:'frozen' as const});
    if(!/^[A-Za-z0-9:_-]{16,120}$/u.test(input.clientRequestId))throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    if(!/^sha256:[a-f0-9]{64}$/u.test(input.payloadDigest))throw new Error('PAYLOAD_DIGEST_REQUIRED');
    return this.store.transferAvailable({...input,now:input.now??new Date()});
  }
}
