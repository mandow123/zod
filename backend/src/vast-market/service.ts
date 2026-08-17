import { createHash, randomUUID } from 'node:crypto';
import type { AccountPrincipal } from '../account/types.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import { AppError } from '../errors.js';
import type { SubjectAccess } from '../subjects/types.js';
import { VastProviderError, type VastAiProvider, type VastSearchInput } from './provider.js';
import type { VastExternalOrderRecord, VastMarketStore, VastQuoteRecord } from './store.js';
import { VAST_PROVIDER_SOURCE, type VastPricingPolicy } from './types.js';
import type { VastOffer } from './types.js';

export class VastMarketService {
  constructor(private readonly store: VastMarketStore, private readonly subjects: SubjectAccess,
    private readonly provider: VastAiProvider, private readonly policy: VastPricingPolicy | null,
    private readonly now: () => Date = () => new Date()) {}

  async catalog(input: VastSearchInput) {
    if (!this.available()) return { availability: 'unavailable' as const, providerSource: VAST_PROVIDER_SOURCE,
      updatedAt: this.now().toISOString(), resources: [] };
    try {
      const offers = await this.provider.search(input);
      const updatedAt = this.now();
      return { availability: 'available' as const, providerSource: VAST_PROVIDER_SOURCE,
        updatedAt: updatedAt.toISOString(), resources: offers.map((offer) => this.serializeOffer(offer, updatedAt)) };
    } catch (error) {
      if (error instanceof VastProviderError) return { availability: 'unavailable' as const,
        providerSource: VAST_PROVIDER_SOURCE, updatedAt: this.now().toISOString(), resources: [] };
      throw error;
    }
  }

  async quote(principal: AccountPrincipal, input: Readonly<{ offerId: string; durationHours: number }>) {
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    this.requireAvailable();
    const offer = await this.offer(input.offerId);
    if (!offer) throw new AppError('VAST_OFFER_UNAVAILABLE', 409, '这份算力刚刚已被租用，请重新选择。');
    const quotedAt = this.now();
    const rate = this.creditRate(offer.providerCostMicrosPerHour);
    const quote: VastQuoteRecord = {
      id: randomUUID(),buyerSubjectId: subject.subjectId,offer,
      configuration: { image: this.policy!.defaultImage,diskGb: this.policy!.defaultDiskGb,
        runtype: this.policy!.defaultRuntype },
      creditMicrosPerHour: rate,durationHours: input.durationHours,totalCreditMicros: rate * BigInt(input.durationHours),
      pricingPolicyVersion: this.policy!.version,status: 'active',quotedAt,
      expiresAt: new Date(quotedAt.getTime() + this.policy!.quoteTtlSeconds * 1_000),
    };
    return this.serializeQuote(await this.store.createQuote(quote));
  }

  async purchase(principal: AccountPrincipal, quoteId: string, idempotencyKey: string) {
    this.idempotency(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    const payloadDigest = digest({ quoteId });
    const existing = await this.store.findOrderByRequest(subject.subjectId,idempotencyKey);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest) throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'请勿复用这次提交标识。');
      const reconciled = existing.status === 'pending_reconciliation' || existing.status === 'reserved'
        ? await this.reconcile(existing) : existing;
      return { replayed: true,order: this.serializeOrder(reconciled) };
    }
    this.requireAvailable();
    const quote = await this.store.getQuote(subject.subjectId,quoteId);
    if (!quote || quote.status !== 'active' || quote.expiresAt <= this.now()) {
      throw new AppError('VAST_QUOTE_EXPIRED',409,'报价已失效，请重新获取。');
    }
    const current = await this.offer(quote.offer.offerId);
    if (!current) {
      await this.store.markQuoteStale(subject.subjectId,quote.id);
      throw new AppError('VAST_OFFER_UNAVAILABLE',409,'这份算力刚刚已被租用，请重新选择。');
    }
    if (current.providerCostMicrosPerHour > quote.offer.providerCostMicrosPerHour) {
      await this.store.markQuoteStale(subject.subjectId,quote.id);
      throw new AppError('VAST_QUOTE_PRICE_CHANGED',409,'报价发生变化，请确认新报价。');
    }
    const now = this.now(); const orderId = randomUUID(); const providerRequestKey = randomUUID();
    const reserved = await this.store.reserve({ id: orderId,orderNumber: orderNumber(now,orderId),
      buyerSubjectId: subject.subjectId,userId: principal.userId,quoteId: quote.id,clientRequestId: idempotencyKey,
      payloadDigest,providerRequestKey,reconciliationDeadlineAt: new Date(now.getTime()
        + this.policy!.reconciliationGraceSeconds * 1_000),now });
    if (reserved.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'请勿复用这次提交标识。');
    if (reserved.status === 'quote_unavailable') throw new AppError('VAST_QUOTE_EXPIRED',409,'报价已失效，请重新获取。');
    if (reserved.status === 'insufficient_credits') throw new AppError('INSUFFICIENT_CREDITS',409,'可用卡时不足。');
    if (reserved.status === 'replayed') return { replayed: true,order: this.serializeOrder(reserved.order) };
    const order = reserved.order;
    let contractId: string;
    try {
      const created = await this.provider.createInstance({ offerId: order.providerOfferId,
        label: providerLabel(order.providerRequestKey),configuration: order.configuration });
      contractId = created.contractId;
    } catch (error) {
      if (!(error instanceof VastProviderError) || error.outcomeUnknown) {
        const code = error instanceof VastProviderError ? error.code : 'VAST_CREATE_OUTCOME_UNKNOWN';
        const pending = await this.store.markPendingReconciliation(order.id,code,this.now());
        return { replayed: false,order: this.serializeOrder(pending) };
      }
      await this.store.failAndRelease(order.id,error.code,this.now());
      if (error.code === 'VAST_OFFER_UNAVAILABLE') {
        throw new AppError('VAST_OFFER_UNAVAILABLE',409,'这份算力刚刚已被租用，预留卡时已退回。');
      }
      throw new AppError('VAST_CREATE_FAILED',503,'创建算力实例失败，预留卡时已退回。');
    }
    try {
      return { replayed: false,order: this.serializeOrder(await this.store.markProvisioning(
        order.id,contractId,this.now())) };
    } catch {
      // Vast has returned an authoritative contract id. Never release the hold
      // because a local write failed; the deterministic label lets recovery bind it.
      try { await this.store.markPendingReconciliation(order.id,'VAST_CONTRACT_BIND_PENDING',this.now()); } catch { /* durable order remains reserved */ }
      throw new AppError('VAST_RECONCILIATION_PENDING',503,'实例已提交，平台正在核对订单状态。');
    }
  }

  async getOrder(principal: AccountPrincipal, orderId: string) {
    const subject = await this.subjects.current(principal.userId,'orders.read');
    const order = await this.store.getOrder(subject.subjectId,orderId);
    if (!order) throw new AppError('VAST_ORDER_NOT_FOUND',404,'算力订单不存在。');
    return this.serializeOrder(order.status === 'pending_reconciliation' || order.status === 'reserved'
      ? await this.reconcile(order) : order);
  }

  async listOrders(principal: AccountPrincipal, limit=30) {
    const subject = await this.subjects.current(principal.userId,'orders.read');
    return { orders: (await this.store.listOrders(subject.subjectId,Math.min(Math.max(limit,1),50)))
      .map((order) => this.serializeOrder(order)) };
  }

  async reconcileProviderInventory() {
    this.requireAvailable();
    const [instances,bindings] = await Promise.all([this.provider.listInstances(),this.store.providerBindings()]);
    const byLabel = new Map(instances.filter((instance) => instance.label?.startsWith('zod-vast-'))
      .map((instance) => [instance.label!,instance]));
    let resolved = 0;
    for (const binding of bindings.filter((value) => value.status === 'pending_reconciliation' || value.status === 'reserved')) {
      const instance = byLabel.get(providerLabel(binding.providerRequestKey));
      if (instance) { await this.store.markProvisioning(binding.orderId,instance.contractId,this.now()); resolved += 1; }
    }
    const known = new Set(bindings.map((binding) => providerLabel(binding.providerRequestKey)));
    const orphanInstances = instances.filter((instance) => instance.label?.startsWith('zod-vast-') && !known.has(instance.label))
      .map((instance) => ({ contractId: instance.contractId,label: instance.label,status: instance.status }));
    return { resolved,orphanInstances };
  }

  private async reconcile(order: VastExternalOrderRecord) {
    try {
      const instances = await this.provider.listInstances();
      const matches = instances.filter((instance) => instance.label === providerLabel(order.providerRequestKey));
      if (matches.length === 1) return this.store.markProvisioning(order.id,matches[0]!.contractId,this.now());
      if (matches.length > 1) return this.store.markPendingReconciliation(order.id,'VAST_DUPLICATE_INSTANCES',this.now());
      if (this.now() >= order.reconciliationDeadlineAt) return this.store.failAndRelease(
        order.id,'VAST_RECONCILIATION_NOT_FOUND',this.now());
      return order;
    } catch (error) {
      if (error instanceof VastProviderError) return order;
      throw error;
    }
  }

  private async offer(offerId: string) {
    try { return await this.provider.getOffer(offerId); }
    catch (error) {
      if (error instanceof VastProviderError && error.code === 'VAST_OFFER_UNAVAILABLE') return null;
      throw new AppError('VAST_CATALOG_UNAVAILABLE',503,'即时算力目录暂不可用。');
    }
  }

  private serializeOffer(offer: VastOffer, updatedAt: Date) {
    const rate = this.creditRate(offer.providerCostMicrosPerHour);
    return { offerId: offer.offerId,providerSource: VAST_PROVIDER_SOURCE,
      updatedAt: (offer.updatedAt > updatedAt ? offer.updatedAt : updatedAt).toISOString(),
      gpu: { name: offer.gpuName,count: offer.gpuCount,memoryGb: Number((offer.gpuMemoryMb / 1024).toFixed(2)) },
      region: offer.region,reliability: Number(offer.reliability.toFixed(4)),
      pricing: { cardHoursPerHour: formatCreditDisplayMicros(rate) } };
  }

  private serializeQuote(quote: VastQuoteRecord) {
    return { quoteId: quote.id,providerSource: VAST_PROVIDER_SOURCE,offerId: quote.offer.offerId,
      quotedAt: quote.quotedAt.toISOString(),expiresAt: quote.expiresAt.toISOString(),durationHours: quote.durationHours,
      gpu: { name: quote.offer.gpuName,count: quote.offer.gpuCount,memoryGb: Number((quote.offer.gpuMemoryMb / 1024).toFixed(2)) },
      region: quote.offer.region,reliability: Number(quote.offer.reliability.toFixed(4)),
      pricing: { cardHoursPerHour: formatCreditDisplayMicros(quote.creditMicrosPerHour),
        totalCardHours: formatCreditDisplayMicros(quote.totalCreditMicros) } };
  }

  private serializeOrder(order: VastExternalOrderRecord) {
    return { id: order.id,orderNumber: order.orderNumber,quoteId: order.quoteId,providerSource: VAST_PROVIDER_SOURCE,
      status: publicStatus(order.status),amountCardHours: formatCreditDisplayMicros(order.totalCreditMicros),
      createdAt: order.createdAt.toISOString(),updatedAt: order.updatedAt.toISOString(),
      reconciliationRequired: order.status === 'pending_reconciliation' };
  }

  private creditRate(providerCostMicrosPerHour: bigint) {
    const base = divideUp(providerCostMicrosPerHour * this.policy!.cardHourMicrosPerProviderUsd,1_000_000n);
    const marked = divideUp(base * BigInt(10_000 + this.policy!.markupBasisPoints),10_000n);
    return divideUp(marked,10_000n) * 10_000n;
  }
  private available() { return this.provider.available && this.policy !== null; }
  private requireAvailable() {
    if (!this.available()) throw new AppError('VAST_MARKET_UNAVAILABLE',503,'即时算力服务尚未开放。');
  }
  private idempotency(value: string) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(value)) throw new AppError('IDEMPOTENCY_KEY_REQUIRED',400,'请重新提交。');
  }
}

function providerLabel(requestKey: string) { return `zod-vast-${requestKey}`; }
function publicStatus(status: VastExternalOrderRecord['status']) {
  if (status === 'reserved') return 'confirming' as const;
  if (status === 'failed') return 'refunded' as const;
  return status;
}
function divideUp(value: bigint,divisor: bigint) { return (value + divisor - 1n) / divisor; }
function digest(value: unknown) { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function orderNumber(now: Date,id: string) {
  return `ZV${now.toISOString().replace(/\D/gu,'').slice(0,14)}${id.replaceAll('-','').slice(0,10)}`;
}
