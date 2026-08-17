import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite,type Results,type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe,expect,it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresCreditLedgerStore } from '../src/credits/store.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../src/credits/types.js';
import { PostgresVastMarketStore,type VastQuoteRecord } from '../src/vast-market/store.js';

function result<T>(value: Results<T>) { return { ...value,rowCount:value.rows.length||value.affectedRows||0,
  command:'',oid:0,rowAsArray:false }; }
function adapter(pglite: PGlite): Database { return { health:async()=>true,
  schemaReadiness:async()=>({ ready:true,expected:null,applied:null,missing:[],mismatched:[] }),
  query:async <Row extends Record<string,unknown>>(text:string,values?:unknown[])=>result(await pglite.query<Row>(text,values)),
  transaction:async <T>(work:(client:PoolClient)=>Promise<T>)=>pglite.transaction(async (transaction:Transaction)=>
    work({ query:async(text:string,values?:unknown[])=>result(await transaction.query(text,values)) } as unknown as PoolClient)),
  close:()=>pglite.close() } as unknown as Database; }
async function migrate(pglite:PGlite) { const names=(await readdir(new URL('../migrations',import.meta.url)))
  .filter((name)=>name.endsWith('.sql')).sort(); for(const name of names) await pglite.exec(await readFile(
    fileURLToPath(new URL(`../migrations/${name}`,import.meta.url)),'utf8')); }

describe('Vast market PostgreSQL hold contract',() => {
  it('freezes and releases cent-aligned card-hours exactly once under one idempotency key',{ timeout:30_000 },async () => {
    const pglite=new PGlite(); await migrate(pglite); const database=adapter(pglite);
    const userId=randomUUID(); const subjectId=randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'vast-buyer','Vast 买家')`,[userId]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)
      VALUES($1,'personal','Vast 买家',$2)`,[subjectId,userId]);
    const ledger=new PostgresCreditLedgerStore(database); const accounts=await ledger.ensureSubjectAccounts(subjectId);
    const available=accounts.find((account)=>account.kind==='available')!.accountId;
    await ledger.post({ id:randomUUID(),idempotencyOwner:`subject:${subjectId}`,scope:'VAST_TEST_FUND',
      idempotencyKey:`vast-fund-${randomUUID()}`,payloadDigest:`sha256:${'a'.repeat(64)}`,referenceType:'adjustment',
      description:'Vast 测试卡时',entries:[{ accountId:available,amountMicros:10_000_000n,memo:'测试入账' },
        { accountId:KAI_CREDIT_PLATFORM_ACCOUNTS.issuance,amountMicros:-10_000_000n,memo:'测试发行' }] });
    const store=new PostgresVastMarketStore(database); const quoteId=randomUUID(); const quotedAt=new Date();
    const quote:VastQuoteRecord={ id:quoteId,buyerSubjectId:subjectId,offer:{ offerId:'123',gpuName:'RTX 4090',
      gpuCount:1,gpuMemoryMb:24576,region:'Shanghai, CN',reliability:0.998,providerCostMicrosPerHour:500_000n,
      updatedAt:quotedAt },configuration:{ image:'vastai/base-image:latest',diskGb:32,runtype:'ssh_direct' },
      creditMicrosPerHour:1_000_000n,durationHours:2,totalCreditMicros:2_000_000n,pricingPolicyVersion:'ops-v1',
      status:'active',quotedAt,expiresAt:new Date(quotedAt.getTime()+120_000) };
    await store.createQuote(quote);
    const orderId=randomUUID(); const request=`vast-order-${randomUUID()}`; const common={ id:orderId,
      orderNumber:`ZV20260817060000${orderId.replaceAll('-','').slice(0,10)}`,buyerSubjectId:subjectId,userId,
      quoteId,clientRequestId:request,payloadDigest:`sha256:${'b'.repeat(64)}`,providerRequestKey:randomUUID(),
      reconciliationDeadlineAt:new Date(quotedAt.getTime()+300_000),now:quotedAt };
    const created=await store.reserve(common); expect(created).toMatchObject({ status:'created',order:{ status:'reserved',totalCreditMicros:2_000_000n } });
    await expect(store.reserve(common)).resolves.toMatchObject({ status:'replayed',order:{ id:orderId } });
    await expect(store.reserve({ ...common,payloadDigest:`sha256:${'c'.repeat(64)}` })).resolves.toEqual({ status:'conflict' });
    const held=await balances(database,subjectId); expect(held).toEqual({ available:'8000000',reserved:'2000000' });
    await store.failAndRelease(orderId,'VAST_OFFER_UNAVAILABLE',new Date());
    await store.failAndRelease(orderId,'VAST_OFFER_UNAVAILABLE',new Date());
    expect(await balances(database,subjectId)).toEqual({ available:'10000000',reserved:'0' });
    const releaseCount=await database.query<{ count:string }>(`SELECT count(*)::text AS count FROM kai_credit_transactions
      WHERE scope='VAST_ORDER_RELEASE' AND reference_id=$1`,[orderId]);
    expect(releaseCount.rows[0]?.count).toBe('1');

    const captureQuoteId=randomUUID();
    await store.createQuote({ ...quote,id:captureQuoteId,status:'active',quotedAt:new Date(),
      expiresAt:new Date(Date.now()+120_000) });
    const captureOrderId=randomUUID(); const captureRequest=`vast-capture-${randomUUID()}`;
    const captureReserved=await store.reserve({ ...common,id:captureOrderId,
      orderNumber:`ZV20260817060100${captureOrderId.replaceAll('-','').slice(0,10)}`,quoteId:captureQuoteId,
      clientRequestId:captureRequest,payloadDigest:`sha256:${'d'.repeat(64)}`,providerRequestKey:randomUUID(),now:new Date(),
      reconciliationDeadlineAt:new Date(Date.now()+300_000) });
    expect(captureReserved).toMatchObject({ status:'created',order:{ status:'reserved' } });
    const provisioning=await store.markProvisioning(captureOrderId,'9001',new Date());
    expect(provisioning).toMatchObject({ status:'provisioning',providerContractId:'9001' });
    await expect(store.markProvisioning(captureOrderId,'9001',new Date())).resolves.toMatchObject({ status:'provisioning' });
    expect(await balances(database,subjectId)).toEqual({ available:'8000000',reserved:'0' });
    const capture=await database.query<{ count:string;sum:string;reserved:string;clearing:string }>(`SELECT
      count(DISTINCT t.id)::text AS count,COALESCE(sum(e.amount_micros),0)::text AS sum,
      COALESCE(sum(e.amount_micros) FILTER(WHERE e.account_id=$2),0)::text AS reserved,
      COALESCE(sum(e.amount_micros) FILTER(WHERE e.account_id=$3),0)::text AS clearing
      FROM kai_credit_transactions t JOIN kai_credit_entries e ON e.transaction_id=t.id
      WHERE t.scope='VAST_ORDER_CAPTURE' AND t.reference_id=$1`,
    [captureOrderId,accounts.find((account)=>account.kind==='reserved')!.accountId,KAI_CREDIT_PLATFORM_ACCOUNTS.clearing]);
    expect(capture.rows[0]).toEqual({ count:'1',sum:'0',reserved:'-2000000',clearing:'2000000' });
    await expect(database.query(`UPDATE vast_external_orders SET provider_contract_id=9002 WHERE id=$1`,
      [captureOrderId])).rejects.toThrow(/provider contract is immutable/u);
    await database.close();
  });

  it('rejects sub-cent quote values at the storage boundary',{ timeout:30_000 },async () => {
    const pglite=new PGlite(); await migrate(pglite); const database=adapter(pglite);
    const userId=randomUUID(); const subjectId=randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'vast-cent','Vast 整分')`,[userId]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)
      VALUES($1,'personal','Vast 整分',$2)`,[subjectId,userId]);
    const date=new Date(); await expect(new PostgresVastMarketStore(database).createQuote({ id:randomUUID(),buyerSubjectId:subjectId,
      offer:{ offerId:'123',gpuName:'H100',gpuCount:1,gpuMemoryMb:81920,region:'CN',reliability:0.99,
        providerCostMicrosPerHour:1n,updatedAt:date },configuration:{ image:'vastai/base-image:latest',diskGb:32,runtype:'ssh' },
      creditMicrosPerHour:10_001n,durationHours:1,totalCreditMicros:10_001n,pricingPolicyVersion:'ops-v1',status:'active',
      quotedAt:date,expiresAt:new Date(date.getTime()+60_000) })).rejects.toThrow();
    await database.close();
  });
});

async function balances(database:Database,subjectId:string) {
  const result=await database.query<{ account_kind:string;amount:string }>(`SELECT a.account_kind,
    COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text AS amount FROM kai_credit_accounts a
    LEFT JOIN kai_credit_entries e ON e.account_id=a.id LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
    WHERE a.subject_id=$1 AND a.account_kind IN ('available','reserved') GROUP BY a.id,a.account_kind`,[subjectId]);
  return Object.fromEntries(result.rows.map((row)=>[row.account_kind,row.amount]));
}
