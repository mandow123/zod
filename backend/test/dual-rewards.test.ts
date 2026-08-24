import { randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite,type Results,type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe,expect,it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { PostgresDualRewardStore } from '../src/rewards/store.js';
import { parseCommerceNetEvent,rewardMicros } from '../src/rewards/types.js';
import type { NetRevisedEvent,NetSettledEvent } from '../src/rewards/types.js';

function result<T>(value:Results<T>){return{...value,rowCount:value.rows.length||value.affectedRows||0,command:'',oid:0,rowAsArray:false};}
function adapter(p:PGlite):Database{return{health:async()=>true,schemaReadiness:async()=>({ready:true,expected:null,applied:null,missing:[],mismatched:[]}),
  query:async<Row extends Record<string,unknown>>(text:string,values?:unknown[])=>result(await p.query<Row>(text,values)),
  transaction:async<T>(work:(client:PoolClient)=>Promise<T>)=>p.transaction(async(tx:Transaction)=>work({query:async(text:string,values?:unknown[])=>result(await tx.query(text,values))}as unknown as PoolClient)),close:()=>p.close()}as unknown as Database;}
async function migrate(p:PGlite){for(const name of(await readdir(new URL('../migrations',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())
  await p.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`,import.meta.url)),'utf8'));}

const streamerPolicy={version:'streamer-v1',basisPoints:100,attributionTtlDays:30,refundObservationDays:1};
const invitePolicy={version:'invite-v1',basisPoints:30,attributionTtlDays:7,firstOrderQualificationDays:30,refundObservationDays:1};
const DAY_MS_FOR_TEST=86_400_000;

async function fixture(options:{streamer?:boolean;invite?:boolean}={streamer:true,invite:true}) {
  const p=new PGlite();await migrate(p);const db=adapter(p),now=new Date('2026-08-20T00:00:00.000Z');
  const streamerUser=randomUUID(),inviterUser=randomUUID(),buyerUser=randomUUID(),reviewer=randomUUID();
  const streamerSubject=randomUUID(),inviterSubject=randomUUID(),buyerSubject=randomUUID();
  await db.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES
    ($1,'reward-streamer','主播'),($2,'reward-inviter','邀请人'),($3,'reward-buyer','买家'),($4,'reward-reviewer','审核员')`,
  [streamerUser,inviterUser,buyerUser,reviewer]);
  await db.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES
    ($1,'personal','主播',$2),($3,'personal','邀请人',$4),($5,'personal','买家',$6)`,
  [streamerSubject,streamerUser,inviterSubject,inviterUser,buyerSubject,buyerUser]);
  const productKind='compute_offer',productId=randomUUID(),streamerAttribution=randomUUID(),inviteAttribution=randomUUID();
  if(options.streamer!==false) {
    const partner=randomUUID(),code=randomUUID();
    await db.query(`INSERT INTO streamer_partners(id,user_id,subject_id,beneficial_owner_digest,status,applied_at,
      reviewed_at,reviewed_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,'approved',$5,$5,$6,$5,$5)`,
    [partner,streamerUser,streamerSubject,`sha256:${'a'.repeat(64)}`,now,reviewer]);
    await db.query(`INSERT INTO streamer_promotion_codes(id,partner_id,owner_user_id,campaign_id,product_kind,
      product_id,code,status,policy_version,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,'STREAMER123','active',
      $7,$8,$9)`,[code,partner,streamerUser,randomUUID(),productKind,productId,streamerPolicy.version,
      new Date(now.getTime()+40*86_400_000),new Date(now.getTime()-1_000)]);
    await db.query(`INSERT INTO streamer_attributions(id,buyer_user_id,buyer_subject_id,partner_id,owner_user_id,
      owner_beneficial_owner_digest,buyer_beneficial_owner_digest,promotion_code_id,product_kind,product_id,policy_version,
      policy_snapshot,payload_digest,status,attributed_at,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,'active',$14,$15,$14)`,[
      streamerAttribution,buyerUser,buyerSubject,partner,streamerUser,`sha256:${'a'.repeat(64)}`,`sha256:${'d'.repeat(64)}`,
      code,productKind,productId,streamerPolicy.version,JSON.stringify(streamerPolicy),`sha256:${'b'.repeat(64)}`,
      new Date(now.getTime()-500),new Date(now.getTime()+30*86_400_000),
    ]);
  }
  if(options.invite!==false) {
    const code=randomUUID();
    await db.query(`INSERT INTO invite_codes(id,inviter_user_id,owner_subject_id,beneficial_owner_digest,code,status,
      policy_version,expires_at,created_at) VALUES($1,$2,$3,$4,'INVITER123','active',$5,$6,$7)`,[
      code,inviterUser,inviterSubject,`sha256:${'c'.repeat(64)}`,invitePolicy.version,
      new Date(now.getTime()+40*86_400_000),new Date(now.getTime()-2_000),
    ]);
    await db.query(`INSERT INTO invite_attributions(id,invitee_user_id,invitee_subject_id,inviter_user_id,
      inviter_subject_id,invite_code_id,inviter_beneficial_owner_digest,invitee_beneficial_owner_digest,
      policy_version,policy_snapshot,payload_digest,attributed_at,registered_at,first_order_deadline,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$13)`,[inviteAttribution,buyerUser,
      buyerSubject,inviterUser,inviterSubject,code,`sha256:${'c'.repeat(64)}`,`sha256:${'d'.repeat(64)}`,
      invitePolicy.version,JSON.stringify(invitePolicy),`sha256:${'e'.repeat(64)}`,new Date(now.getTime()-2_000),
      new Date(now.getTime()-1_500),new Date(now.getTime()+30*86_400_000),
    ]);
  }
  return{p,db,store:new PostgresDualRewardStore(db),now,streamerUser,inviterUser,buyerUser,streamerSubject,
    inviterSubject,buyerSubject,productKind,productId};
}

function settled(f:Awaited<ReturnType<typeof fixture>>,orderId:string,version=1n,eventId=`settled-${randomUUID()}`):NetSettledEvent {
  return{type:'commerce.order.net_settled.v1',source:'commerce',eventId,orderKind:'credit_order',orderId,
    sourceVersion:version,buyerUserId:f.buyerUser,buyerSubjectId:f.buyerSubject,productKind:f.productKind,
    productId:f.productId,finalNetConsumedMicros:10_000_000n,settledAt:new Date(f.now.getTime()+1_000)};
}
function revised(f:Awaited<ReturnType<typeof fixture>>,orderId:string,previous:bigint,next:bigint,version:bigint):NetRevisedEvent {
  return{type:'commerce.order.net_revised.v1',source:'commerce',eventId:`revised-${randomUUID()}`,orderKind:'credit_order',
    orderId,sourceVersion:version,buyerUserId:f.buyerUser,buyerSubjectId:f.buyerSubject,productKind:f.productKind,
    productId:f.productId,previousNetConsumedMicros:previous,newNetConsumedMicros:next,reason:'partial_refund',
    revisedAt:new Date(f.now.getTime()+Number(version)*1_000)};
}

describe('dual reward B0/B1 core',()=>{
  it('keeps both new domains and legacy intake fail-closed unless explicitly and completely configured',async()=>{
    const off=loadConfig({STREAMER_REWARDS_MODE:'invalid',INVITE_REWARDS_MODE:'invalid'});
    expect(off).toMatchObject({streamerRewardsMode:'off',inviteRewardsMode:'off',legacyCreatorCommissionMode:'off'});
    expect(off.readiness.capabilities.streamerRewards).toMatchObject({mode:'off',available:false,missing:[]});
    const missing=loadConfig({NODE_ENV:'production',STREAMER_REWARDS_MODE:'on'});
    expect(missing.readiness.capabilities.streamerRewards.available).toBe(false);
    expect(missing.readiness.releaseBlockers).toContain('STREAMER_REFERRAL_SIGNING_SECRET');
    const valid=loadConfig({STREAMER_REWARDS_MODE:'shadow',INVITE_REWARDS_MODE:'shadow',
      STREAMER_REFERRAL_SIGNING_SECRET:'s'.repeat(32),INVITE_REFERRAL_SIGNING_SECRET:'i'.repeat(32),
      STREAMER_REWARD_POLICY_JSON:JSON.stringify(streamerPolicy),INVITE_REWARD_POLICY_JSON:JSON.stringify(invitePolicy)});
    expect(valid.readiness.capabilities.streamerRewards).toMatchObject({mode:'shadow',available:false});
    expect(valid.readiness.capabilities.inviteRewards).toMatchObject({mode:'shadow',available:false});
    expect(valid.readiness.releaseBlockers).toContain(
      'STREAMER_REWARDS_RUNTIME_INTEGRATION(pending atomic commerce claim and final-net producer)');
    expect(valid.readiness.releaseBlockers).toContain(
      'INVITE_REWARDS_RUNTIME_INTEGRATION(pending atomic commerce claim and final-net producer)');
    const activationBlocked=loadConfig({STREAMER_REWARDS_MODE:'on',STREAMER_REFERRAL_SIGNING_SECRET:'s'.repeat(32),
      STREAMER_REWARD_POLICY_JSON:JSON.stringify(streamerPolicy)});
    expect(activationBlocked.readiness.capabilities.streamerRewards.available).toBe(false);
    expect(activationBlocked.readiness.releaseBlockers).toContain(
      'STREAMER_REWARDS_RUNTIME_INTEGRATION(pending atomic commerce claim and final-net producer)');
    const same=loadConfig({...valid,STREAMER_REFERRAL_SIGNING_SECRET:'x'.repeat(32),INVITE_REFERRAL_SIGNING_SECRET:'x'.repeat(32)} as never);
    expect(same.readiness.capabilities.streamerRewards.available).toBe(false);
    expect(same.readiness.capabilities.inviteRewards.available).toBe(false);
    const serverSource=await readFile(new URL('../src/server.ts',import.meta.url),'utf8');
    expect(serverSource).not.toMatch(/RewardCommerceEventWorker|PostgresDualRewardStore/u);
  });

  it('accepts only authoritative versioned two-decimal net-consumption events',()=>{
    expect(rewardMicros(10_000_000n,100)).toBe(100_000n);
    expect(()=>rewardMicros(10_000_001n,100)).toThrow('REWARD_AMOUNT_CONTRACT_INVALID');
    const base={source:'commerce',eventId:'event-12345678',orderKind:'credit_order',orderId:randomUUID(),sourceVersion:'1',
      buyerUserId:randomUUID(),buyerSubjectId:randomUUID(),productKind:'compute_offer',productId:randomUUID()};
    expect(parseCommerceNetEvent({...base,type:'commerce.order.net_settled.v1',finalNetConsumedMicros:'10000',
      settledAt:'2026-08-20T00:00:00.000Z'})).toMatchObject({finalNetConsumedMicros:10_000n,sourceVersion:1n});
    expect(()=>parseCommerceNetEvent({...base,type:'commerce.order.net_settled.v1',finalNetConsumedMicros:'0',
      settledAt:'2026-08-20T00:00:00.000Z'})).toThrow();
    expect(()=>parseCommerceNetEvent({...base,type:'commerce.order.net_revised.v1',previousNetConsumedMicros:'10000',
      newNetConsumedMicros:'20000',reason:'increase',revisedAt:'2026-08-20T00:00:00.000Z'})).toThrow();
  });

  it('rejects streamer self-promotion by user, beneficial owner, or mismatched buyer subject', {timeout:30_000},async()=>{
    const f=await fixture({streamer:true,invite:false});
    const context=(await f.db.query<{partner_id:string;promotion_code_id:string}>(`SELECT partner_id,promotion_code_id
      FROM streamer_attributions LIMIT 1`)).rows[0]!;
    const insert=async(buyerUserId:string,buyerSubjectId:string,buyerDigest:string)=>f.db.query(`INSERT INTO
      streamer_attributions(id,buyer_user_id,buyer_subject_id,partner_id,owner_user_id,
      owner_beneficial_owner_digest,buyer_beneficial_owner_digest,promotion_code_id,product_kind,product_id,
      policy_version,policy_snapshot,payload_digest,status,attributed_at,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,'active',$14,$15,$14)`,[
      randomUUID(),buyerUserId,buyerSubjectId,context.partner_id,f.streamerUser,`sha256:${'a'.repeat(64)}`,buyerDigest,
      context.promotion_code_id,f.productKind,f.productId,streamerPolicy.version,JSON.stringify(streamerPolicy),
      `sha256:${randomUUID().replaceAll('-','').padEnd(64,'0')}`,new Date(f.now.getTime()-100),new Date(f.now.getTime()+DAY_MS_FOR_TEST),
    ]);
    const secondStreamerSubject=randomUUID();
    await f.db.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES($1,'organization','主播别名主体',$2)`,
      [secondStreamerSubject,f.streamerUser]);
    await expect(insert(f.streamerUser,secondStreamerSubject,`sha256:${'z'.repeat(64)}`)).rejects.toThrow();
    const aliasUser=randomUUID(),aliasSubject=randomUUID();
    await f.db.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'reward-alias','别名账号')`,[aliasUser]);
    await f.db.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES($1,'personal','别名账号',$2)`,
      [aliasSubject,aliasUser]);
    await expect(insert(aliasUser,aliasSubject,`sha256:${'a'.repeat(64)}`)).rejects.toThrow();
    await expect(insert(aliasUser,f.buyerSubject,`sha256:${'z'.repeat(64)}`)).rejects.toThrow(/active approved product code/u);
    await f.db.close();
  });

  it('gives exact-product streamer attribution priority, posts final net once, matures, transfers and freezes on late refund',
    {timeout:30_000},async()=>{
      const f=await fixture(),orderId=randomUUID();
      const claim=await f.store.claimForOrder({orderKind:'credit_order',orderId,buyerUserId:f.buyerUser,
        buyerSubjectId:f.buyerSubject,productKind:f.productKind,productId:f.productId,orderedAt:f.now});
      expect(claim).toMatchObject({status:'claimed',domain:'streamer'});
      expect(await f.store.claimForOrder({orderKind:'credit_order',orderId,buyerUserId:f.buyerUser,
        buyerSubjectId:f.buyerSubject,productKind:f.productKind,productId:f.productId,orderedAt:f.now}))
        .toMatchObject({status:'existing',domain:'streamer'});
      const event=settled(f,orderId);
      expect(await f.store.consume(event,{streamer:'on',invite:'on'})).toMatchObject({status:'processed',domain:'streamer',
        orderStatus:'observation',rewardMicros:100_000n});
      expect(await f.store.consume(event,{streamer:'on',invite:'on'})).toMatchObject({status:'replayed'});
      const transactions=await f.db.query<{count:string}>(`SELECT count(*)::text count FROM reward_transactions`);
      expect(transactions.rows[0]?.count).toBe('1');
      expect(await f.store.consume({...event,finalNetConsumedMicros:9_000_000n},{streamer:'on',invite:'on'}))
        .toMatchObject({status:'conflict'});
      expect((await f.db.query<{count:string}>(`SELECT count(*)::text count FROM reward_transactions`)).rows[0]?.count).toBe('1');
      const old=settled(f,orderId,1n,`old-${randomUUID()}`);
      expect(await f.store.consume(old,{streamer:'on',invite:'on'})).toMatchObject({status:'ignored'});
      expect(await f.store.matureDue(new Date(f.now.getTime()+2*86_400_000),10,{streamer:'on',invite:'on'})).toBe(1);
      const transfer=await f.store.transferAvailable({domain:'streamer',ownerUserId:f.streamerUser,
        targetSubjectId:f.streamerSubject,clientRequestId:'streamer-transfer-0001',payloadDigest:`sha256:${'f'.repeat(64)}`,
        now:new Date(f.now.getTime()+3*86_400_000)});
      expect(transfer).toMatchObject({status:'created',rewardMicros:100_000n});
      expect(await f.store.transferAvailable({domain:'streamer',ownerUserId:f.streamerUser,
        targetSubjectId:f.streamerSubject,clientRequestId:'streamer-transfer-0001',payloadDigest:`sha256:${'f'.repeat(64)}`,
        now:new Date(f.now.getTime()+3*86_400_000)})).toMatchObject({status:'replayed',rewardMicros:100_000n});
      expect(await f.store.transferAvailable({domain:'streamer',ownerUserId:f.streamerUser,
        targetSubjectId:f.streamerSubject,clientRequestId:'streamer-transfer-0001',payloadDigest:`sha256:${'0'.repeat(64)}`,
        now:new Date(f.now.getTime()+3*86_400_000)})).toMatchObject({status:'conflict'});
      expect(await f.store.consume(revised(f,orderId,10_000_000n,5_000_000n,2n),{streamer:'on',invite:'on'}))
        .toMatchObject({status:'processed',orderStatus:'recovery_required',rewardMicros:50_000n});
      expect(await f.store.consume(revised(f,orderId,5_000_000n,2_000_000n,3n),{streamer:'on',invite:'on'}))
        .toMatchObject({status:'processed',orderStatus:'recovery_required',rewardMicros:20_000n});
      expect((await f.db.query<{final:string;version:string}>(`SELECT final_net_consumed_micros::text final,
        source_version::text version FROM streamer_commission_orders WHERE order_id=$1`,[orderId])).rows[0])
        .toEqual({final:'2000000',version:'3'});
      const frozen=await f.db.query<{account_kind:string;status:string}>(`SELECT account_kind,status FROM reward_accounts
        WHERE domain='streamer' AND owner_user_id=$1 ORDER BY account_kind`,[f.streamerUser]);
      expect(frozen.rows.filter(row=>['pending','available'].includes(row.account_kind)).every(row=>row.status==='frozen')).toBe(true);
      const laterOrder=randomUUID();
      expect(await f.store.claimForOrder({orderKind:'credit_order',orderId:laterOrder,buyerUserId:f.buyerUser,
        buyerSubjectId:f.buyerSubject,productKind:f.productKind,productId:f.productId,orderedAt:f.now}))
        .toMatchObject({status:'claimed',domain:'streamer'});
      expect(await f.store.consume(settled(f,laterOrder),{streamer:'on',invite:'on'})).toMatchObject({orderStatus:'observation'});
      expect(await f.store.matureDue(new Date(f.now.getTime()+4*86_400_000),10,{streamer:'on',invite:'on'})).toBe(1);
      expect(await f.store.transferAvailable({domain:'streamer',ownerUserId:f.streamerUser,
        targetSubjectId:f.streamerSubject,clientRequestId:'streamer-transfer-0002',payloadDigest:`sha256:${'2'.repeat(64)}`,
        now:new Date(f.now.getTime()+4*86_400_000)})).toMatchObject({status:'frozen'});
      expect((await f.db.query(`SELECT id FROM idempotency_records WHERE actor_id=$1 AND idempotency_key='streamer-transfer-0002'`,
        [f.streamerUser])).rows).toEqual([]);
      expect(await f.store.consume(revised(f,laterOrder,10_000_000n,0n,2n),{streamer:'on',invite:'on'}))
        .toMatchObject({status:'processed',orderStatus:'reversed'});
      const ledger=await f.db.query<{domain:string;total:string}>(`SELECT t.domain,sum(e.amount_micros)::text total FROM reward_transactions t
        JOIN reward_entries e ON e.transaction_id=t.id WHERE t.status='posted' GROUP BY t.domain`);
      expect(ledger.rows).toEqual([{domain:'streamer',total:'0'}]);
      const serialized=JSON.stringify((await f.db.query<{metadata:unknown}>(`SELECT metadata FROM audit_events
        WHERE entity_type='streamer_reward'`)).rows);
      expect(serialized).not.toMatch(/STREAMER123|reward-streamer|token|signature/iu);
      await f.db.close();
  });

  it('keeps invitation independent and reverses partial then zero net revisions without cross-domain entries',
    {timeout:30_000},async()=>{
      const f=await fixture({streamer:false,invite:true}),orderId=randomUUID();
      expect(await f.store.claimForOrder({orderKind:'credit_order',orderId,buyerUserId:f.buyerUser,
        buyerSubjectId:f.buyerSubject,productKind:f.productKind,productId:f.productId,orderedAt:f.now}))
        .toMatchObject({status:'claimed',domain:'invite'});
      expect(await f.store.consume(settled(f,orderId),{streamer:'on',invite:'on'})).toMatchObject({rewardMicros:30_000n});
      const version3=revised(f,orderId,7_000_000n,4_000_000n,3n);
      expect(await f.store.consume(version3,{streamer:'on',invite:'on'})).toMatchObject({status:'retryable'});
      expect((await f.db.query(`SELECT id FROM reward_event_receipts WHERE event_id=$1`,[version3.eventId])).rows).toEqual([]);
      expect(await f.store.consume(revised(f,orderId,10_000_000n,7_000_000n,2n),{streamer:'on',invite:'on'}))
        .toMatchObject({status:'processed',orderStatus:'observation',rewardMicros:20_000n});
      expect(await f.store.consume(version3,{streamer:'on',invite:'on'}))
        .toMatchObject({status:'processed',orderStatus:'observation',rewardMicros:10_000n});
      expect(await f.store.consume(revised(f,orderId,4_000_000n,0n,4n),{streamer:'on',invite:'on'}))
        .toMatchObject({status:'processed',orderStatus:'reversed',rewardMicros:0n});
      const accounts=await f.db.query<{domain:string;amount:string}>(`SELECT a.domain,COALESCE(sum(e.amount_micros)
        FILTER(WHERE t.status='posted'),0)::text amount FROM reward_accounts a LEFT JOIN reward_entries e ON e.account_id=a.id
        LEFT JOIN reward_transactions t ON t.id=e.transaction_id WHERE a.owner_user_id=$1 GROUP BY a.domain`,[f.inviterUser]);
      expect(accounts.rows).toEqual([{domain:'invite',amount:'0'}]);
      expect((await f.db.query(`SELECT 1 FROM reward_entries e JOIN reward_transactions t ON t.id=e.transaction_id
        JOIN reward_accounts a ON a.id=e.account_id WHERE e.domain<>t.domain OR e.domain<>a.domain`)).rows).toEqual([]);
      const pendingTx=randomUUID();
      await f.db.query(`INSERT INTO reward_transactions(id,domain,idempotency_owner,scope,idempotency_key,payload_digest,
        association_id,description,status) VALUES($1,'streamer','test','REWARD_TRANSFER','cross-domain-test-0001',$2,NULL,
        '跨域拒绝测试','pending')`,[pendingTx,`sha256:${'1'.repeat(64)}`]);
      await expect(f.db.query(`INSERT INTO reward_entries(id,domain,transaction_id,account_id,amount_micros,memo)
        VALUES($1,'streamer',$2,'00000000-0000-4000-8000-000000000302',10000,'应拒绝')`,[randomUUID(),pendingTx]))
        .rejects.toThrow(/domain or state is invalid/u);
      await f.db.close();
  });

  it('keeps shadow qualification outside global claims and lets an on-domain invitation win', {timeout:30_000},async()=>{
    const f=await fixture(),orderId=randomUUID();
    expect(await f.store.claimForOrder({orderKind:'credit_order',orderId,buyerUserId:f.buyerUser,
      buyerSubjectId:f.buyerSubject,productKind:f.productKind,productId:f.productId,orderedAt:f.now},
    {streamer:'off',invite:'off'})).toMatchObject({status:'unattributed'});
    expect((await f.db.query(`SELECT id FROM reward_order_claims`)).rows).toEqual([]);
    expect(await f.store.claimForOrder({orderKind:'credit_order',orderId,buyerUserId:f.buyerUser,
      buyerSubjectId:f.buyerSubject,productKind:f.productKind,productId:f.productId,orderedAt:f.now},
    {streamer:'shadow',invite:'on'})).toMatchObject({status:'claimed',domain:'invite'});
    expect((await f.db.query<{domain:string}>(`SELECT domain FROM reward_order_claims WHERE order_id=$1`,[orderId])).rows)
      .toEqual([{domain:'invite'}]);
    expect((await f.db.query(`SELECT id FROM audit_events WHERE action='STREAMER_REWARD_SHADOW_QUALIFIED'
      AND entity_id=$1`,[orderId])).rows).toHaveLength(1);
    expect(await f.store.consume(settled(f,orderId),{streamer:'shadow',invite:'on'})).toMatchObject({status:'processed',domain:'invite'});
    const pureShadowOrder=randomUUID();
    expect(await f.store.claimForOrder({orderKind:'credit_order',orderId:pureShadowOrder,buyerUserId:f.buyerUser,
      buyerSubjectId:f.buyerSubject,productKind:f.productKind,productId:f.productId,orderedAt:f.now},
    {streamer:'shadow',invite:'off'})).toMatchObject({status:'shadow_qualified'});
    expect((await f.db.query(`SELECT id FROM reward_order_claims WHERE order_id=$1`,[pureShadowOrder])).rows).toEqual([]);
    expect((await f.db.query<{domain:string}>(`SELECT DISTINCT domain FROM reward_transactions`)).rows).toEqual([{domain:'invite'}]);
    expect((await f.db.query(`SELECT id FROM kai_credit_transactions WHERE scope IN ('STREAMER_REWARD_TRANSFER','INVITE_REWARD_TRANSFER')`)).rows).toEqual([]);
    await f.db.close();
  });

  it('gives each reward domain its own maturity batch quota', {timeout:30_000},async()=>{
    const f=await fixture();
    const inviteOrder=randomUUID();
    expect(await f.store.claimForOrder({orderKind:'credit_order',orderId:inviteOrder,buyerUserId:f.buyerUser,
      buyerSubjectId:f.buyerSubject,productKind:f.productKind,productId:f.productId,orderedAt:f.now},
    {streamer:'off',invite:'on'})).toMatchObject({status:'claimed',domain:'invite'});
    expect(await f.store.consume(settled(f,inviteOrder),{streamer:'off',invite:'on'}))
      .toMatchObject({status:'processed',domain:'invite'});
    for(let index=0;index<2;index+=1) {
      const streamerOrder=randomUUID();
      expect(await f.store.claimForOrder({orderKind:'credit_order',orderId:streamerOrder,buyerUserId:f.buyerUser,
        buyerSubjectId:f.buyerSubject,productKind:f.productKind,productId:f.productId,orderedAt:f.now},
      {streamer:'on',invite:'off'})).toMatchObject({status:'claimed',domain:'streamer'});
      expect(await f.store.consume(settled(f,streamerOrder),{streamer:'on',invite:'off'}))
        .toMatchObject({status:'processed',domain:'streamer'});
    }
    expect(await f.store.matureDue(new Date(f.now.getTime()+2*DAY_MS_FOR_TEST),1,{streamer:'on',invite:'on'})).toBe(2);
    expect((await f.db.query<{domain:string;available:string;observation:string}>(`SELECT 'streamer' domain,
      count(*) FILTER(WHERE status='available')::text available,
      count(*) FILTER(WHERE status='observation')::text observation FROM streamer_commission_orders
      UNION ALL SELECT 'invite',count(*) FILTER(WHERE status='available')::text,
      count(*) FILTER(WHERE status='observation')::text FROM invite_reward_orders ORDER BY domain`)).rows).toEqual([
      {domain:'invite',available:'1',observation:'0'},
      {domain:'streamer',available:'1',observation:'1'},
    ]);
    await f.db.close();
  });
});
