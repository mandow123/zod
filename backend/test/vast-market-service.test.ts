import { describe,expect,it } from 'vitest';
import type { AccountPrincipal } from '../src/account/types.js';
import type { SubjectAccess } from '../src/subjects/types.js';
import { VastMarketService } from '../src/vast-market/service.js';
import { VastProviderError,type VastAiProvider } from '../src/vast-market/provider.js';
import type { VastExternalOrderRecord,VastMarketStore,VastQuoteRecord,VastReserveResult } from '../src/vast-market/store.js';
import type { VastInstance,VastOffer,VastPricingPolicy } from '../src/vast-market/types.js';

const subjectId = '10000000-0000-4000-8000-000000000001';
const principal: AccountPrincipal = { userId: 'buyer-user',sessionId: 'session',role: 'member' };
const subjects = { current: async () => ({ subjectId,userId: principal.userId,kind: 'personal' as const,
  displayName: '买家',subjectStatus: 'active' as const,role: 'owner' as const,permissions: ['orders.buy' as const] }) } as SubjectAccess;
const now = new Date('2026-08-17T06:00:00.000Z');
const offer = (cost=500_000n): VastOffer => ({ offerId: '123',gpuName: 'RTX 4090',gpuCount: 1,gpuMemoryMb: 24576,
  region: 'Shanghai, CN',reliability: 0.998,providerCostMicrosPerHour: cost,updatedAt: now });
const policy: VastPricingPolicy = { version: 'ops-v1',cardHourMicrosPerProviderUsd: 2_000_000n,markupBasisPoints: 0,
  quoteTtlSeconds: 120,reconciliationGraceSeconds: 300,defaultImage: 'vastai/base-image:latest',defaultDiskGb: 32,
  defaultRuntype: 'ssh_direct' };

class FakeProvider implements VastAiProvider {
  available = true; current: VastOffer | null = offer(); instances: VastInstance[] = []; creates = 0;
  createError: unknown = null;
  async search() { return this.current ? [this.current] : []; }
  async getOffer() { return this.current; }
  async createInstance(input: { label: string }) {
    this.creates += 1;
    if (this.createError) throw this.createError;
    const instance = { contractId: '9001',label: input.label,offerId: '123',status: 'created' };
    this.instances.push(instance); return { contractId: instance.contractId };
  }
  async listInstances() { return this.instances; }
}

class MemoryStore implements VastMarketStore {
  quotes = new Map<string,VastQuoteRecord>(); orders = new Map<string,VastExternalOrderRecord>(); requests = new Map<string,string>();
  reserveCalls = 0; releaseCalls = 0; stale = 0;
  async createQuote(value: VastQuoteRecord) { this.quotes.set(value.id,value); return value; }
  async getQuote(buyer: string,id: string) { const value=this.quotes.get(id); return value?.buyerSubjectId===buyer ? value : null; }
  async markQuoteStale(_buyer: string,id: string) { const value=this.quotes.get(id); if (value) this.quotes.set(id,{ ...value,status:'stale' }); this.stale+=1; }
  async findOrderByRequest(buyer: string,key: string) { const id=this.requests.get(`${buyer}:${key}`); return id ? this.orders.get(id) ?? null : null; }
  async getOrder(buyer: string,id: string) { const value=this.orders.get(id); return value?.buyerSubjectId===buyer ? value : null; }
  async listOrders(buyer: string,limit: number) { return [...this.orders.values()].filter((value) => value.buyerSubjectId===buyer).slice(0,limit); }
  async reserve(input: Parameters<VastMarketStore['reserve']>[0]): Promise<VastReserveResult> {
    this.reserveCalls+=1; const quote=this.quotes.get(input.quoteId); if (!quote || quote.status!=='active') return { status:'quote_unavailable' };
    const order: VastExternalOrderRecord = { id:input.id,orderNumber:input.orderNumber,buyerSubjectId:input.buyerSubjectId,
      createdByUserId:input.userId,quoteId:input.quoteId,clientRequestId:input.clientRequestId,payloadDigest:input.payloadDigest,
      providerOfferId:quote.offer.offerId,providerRequestKey:input.providerRequestKey,providerContractId:null,
      configuration:quote.configuration,status:'reserved',totalCreditMicros:quote.totalCreditMicros,failureCode:null,
      reconciliationDeadlineAt:input.reconciliationDeadlineAt,provisioningAt:null,failedAt:null,createdAt:input.now,updatedAt:input.now };
    this.orders.set(order.id,order); this.requests.set(`${input.buyerSubjectId}:${input.clientRequestId}`,order.id);
    this.quotes.set(quote.id,{ ...quote,status:'consumed' }); return { status:'created',order };
  }
  async markPendingReconciliation(id: string,code: string,date: Date) { return this.update(id,{ status:'pending_reconciliation',failureCode:code,updatedAt:date }); }
  async markProvisioning(id: string,contractId: string,date: Date) { return this.update(id,{ status:'provisioning',providerContractId:contractId,provisioningAt:date,failureCode:null,updatedAt:date }); }
  async failAndRelease(id: string,code: string,date: Date) { this.releaseCalls+=1; return this.update(id,{ status:'failed',failureCode:code,failedAt:date,updatedAt:date }); }
  async providerBindings() { return [...this.orders.values()].map((order) => ({ orderId:order.id,
    providerRequestKey:order.providerRequestKey,providerContractId:order.providerContractId,status:order.status })); }
  private update(id: string,patch: Partial<VastExternalOrderRecord>) { const value={ ...this.orders.get(id)!,...patch }; this.orders.set(id,value); return value; }
}

async function quoted(service: VastMarketService) { return service.quote(principal,{ offerId:'123',durationHours:2 }); }
function setup() { const store=new MemoryStore(); const provider=new FakeProvider();
  return { store,provider,service:new VastMarketService(store,subjects,provider,policy,() => now) }; }

describe('Vast external market service',() => {
  it('returns only two-decimal card-hours and no provider money fields',async () => {
    const { service }=setup(); const catalog=await service.catalog({}); const quote=await quoted(service);
    expect(catalog.resources[0]).toMatchObject({ providerSource:'vast_ai',pricing:{ cardHoursPerHour:'1.00' } });
    expect(quote).toMatchObject({ providerSource:'vast_ai',durationHours:2,
      pricing:{ cardHoursPerHour:'1.00',totalCardHours:'2.00' } });
    expect(JSON.stringify({ catalog,quote })).not.toMatch(/usd|cny|rmb|人民币|参考价/iu);
  });

  it('reports unavailable instead of inventing inventory when configuration is absent',async () => {
    const store=new MemoryStore(); const provider=new FakeProvider(); provider.available=false;
    const service=new VastMarketService(store,subjects,provider,null,() => now);
    await expect(service.catalog({})).resolves.toMatchObject({ availability:'unavailable',resources:[] });
  });

  it('rejects a price increase or vanished offer before freezing card-hours',async () => {
    const rising=setup(); const quote=await quoted(rising.service); rising.provider.current=offer(600_000n);
    await expect(rising.service.purchase(principal,quote.quoteId,'vast-purchase-price-rise-1')).rejects.toMatchObject({ code:'VAST_QUOTE_PRICE_CHANGED' });
    expect(rising.store.reserveCalls).toBe(0); expect(rising.store.stale).toBe(1);
    const gone=setup(); const missing=await quoted(gone.service); gone.provider.current=null;
    await expect(gone.service.purchase(principal,missing.quoteId,'vast-purchase-offer-gone-1')).rejects.toMatchObject({ code:'VAST_OFFER_UNAVAILABLE' });
    expect(gone.store.reserveCalls).toBe(0);
  });

  it('keeps an unknown create outcome frozen and does not create twice on replay',async () => {
    const { service,provider,store }=setup(); const quote=await quoted(service);
    provider.createError=new VastProviderError('VAST_TIMEOUT',true,true,'timeout');
    const first=await service.purchase(principal,quote.quoteId,'vast-purchase-timeout-0001');
    expect(first.order).toMatchObject({ status:'pending_reconciliation',reconciliationRequired:true });
    const replay=await service.purchase(principal,quote.quoteId,'vast-purchase-timeout-0001');
    expect(replay).toMatchObject({ replayed:true,order:{ status:'pending_reconciliation' } });
    expect(provider.creates).toBe(1); expect(store.releaseCalls).toBe(0);
  });

  it('recovers a lost success response by deterministic label without a second instance',async () => {
    const { service,provider,store }=setup(); const quote=await quoted(service);
    provider.createInstance=async (input: { label:string }) => { provider.creates+=1;
      provider.instances.push({ contractId:'9002',label:input.label,offerId:'123',status:'created' });
      throw new VastProviderError('VAST_TIMEOUT',true,true,'response lost'); };
    await expect(service.purchase(principal,quote.quoteId,'vast-purchase-lost-response')).resolves.toMatchObject({
      order:{ status:'pending_reconciliation' } });
    const replay=await service.purchase(principal,quote.quoteId,'vast-purchase-lost-response');
    expect(replay).toMatchObject({ replayed:true,order:{ status:'provisioning' } });
    expect(provider.creates).toBe(1); expect(store.releaseCalls).toBe(0);
  });

  it('releases on a definitive failure and reports orphan provider instances',async () => {
    const failed=setup(); const quote=await quoted(failed.service);
    failed.provider.createError=new VastProviderError('VAST_OFFER_UNAVAILABLE',false,false,'gone');
    await expect(failed.service.purchase(principal,quote.quoteId,'vast-purchase-definitive-fail')).rejects.toMatchObject({ code:'VAST_OFFER_UNAVAILABLE' });
    expect(failed.store.releaseCalls).toBe(1);
    const orphan=setup(); orphan.provider.instances=[{ contractId:'9999',label:'zod-vast-orphan-key',offerId:'123',status:'running' }];
    await expect(orphan.service.reconcileProviderInventory()).resolves.toEqual({ resolved:0,
      orphanInstances:[{ contractId:'9999',label:'zod-vast-orphan-key',status:'running' }] });
  });
});
