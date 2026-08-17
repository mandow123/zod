import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AccountStore } from '../src/account/store.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import { CursorService } from '../src/market/cursor.js';
import { MarketService } from '../src/market/service.js';
import type { CreateOrderResult, MarketStore } from '../src/market/store.js';
import type {
  ComputeDemand, ComputeResource, MarketListing, OrderRecord, ProviderAsset, ResourceKind, SupplierProfile, SupplierResource,
} from '../src/market/types.js';
import type { SubjectAccess } from '../src/subjects/types.js';

class MemoryMarketStore implements MarketStore {
  supplier: SupplierProfile | null = null;
  resources = new Map<string, ComputeResource>();
  listings = new Map<string, MarketListing & { supplierId: string; reserved: number; sold: number }>();
  orders = new Map<string, OrderRecord>();
  demands = new Map<string, ComputeDemand>();
  idempotency = new Map<string, { payloadHash: string; orderId: string }>();
  resourceRequests = new Map<string, { payloadDigest: string; resourceId: string }>();
  resourceFingerprints = new Map<string, string>();
  resourceVerification = new Map<string, SupplierResource['verification']>();
  resourceResubmissions = new Map<string, string>();
  providerAssets: ProviderAsset[] = [];

  async listVerifiedResources(input: { kind?: ResourceKind; region?: string; query?: string; limit: number }) {
    return [...this.resources.values()]
      .filter((resource) => resource.status === 'verified')
      .filter((resource) => !input.kind || resource.kind === input.kind)
      .filter((resource) => !input.region || resource.region === input.region)
      .filter((resource) => !input.query || `${resource.productCode} ${resource.region}`.includes(input.query))
      .slice(0, input.limit)
      .map((resource) => ({
        id: resource.id, productCode: resource.productCode, kind: resource.kind, region: resource.region,
        specifications: resource.specifications, capacityTotal: resource.capacityTotal,
        capacityUnit: resource.capacityUnit, createdAt: new Date(),
      }));
  }

  async listListings(input: { kind?: ResourceKind; region?: string; query?: string; limit: number }) {
    return [...this.listings.values()]
      .filter((listing) => !input.kind || listing.kind === input.kind)
      .filter((listing) => !input.region || listing.region === input.region)
      .filter((listing) => !input.query || `${listing.productCode} ${listing.region}`.includes(input.query))
      .filter((listing) => Number(listing.availableQuantity) - listing.reserved - listing.sold > 0)
      .slice(0, input.limit)
      .map((listing) => ({ ...listing, availableQuantity: String(Number(listing.availableQuantity) - listing.reserved - listing.sold) }));
  }
  async getSupplierBySubject(subjectId: string) { return this.supplier?.subjectId === subjectId ? this.supplier : null; }
  async submitSupplier(input: { subjectId: string; userId: string; legalName: string; creditCode: string; contactName: string }) {
    this.supplier = {
      id: this.supplier?.id ?? randomUUID(), subjectId: input.subjectId, legalName: input.legalName,
      creditCode: input.creditCode, contactName: input.contactName, status: 'submitted', rejectionReason: null,
    };
    return this.supplier;
  }
  async reviewSupplier(input: { supplierId: string; approved: boolean; reason?: string }) {
    if (!this.supplier || this.supplier.id !== input.supplierId || this.supplier.status !== 'submitted') return null;
    this.supplier = {
      ...this.supplier, status: input.approved ? 'approved' : 'rejected',
      rejectionReason: input.approved ? null : input.reason ?? '资料未通过审核',
    };
    return this.supplier;
  }
  async listSupplierResources(subjectId: string) {
    return this.supplier?.subjectId === subjectId
      ? [...this.resources.values()].map((resource) => ({ ...resource, verification: this.resourceVerification.get(resource.id) ?? null }))
      : [];
  }
  async listSupplierListings(subjectId: string) {
    if (this.supplier?.subjectId !== subjectId) return [];
    return [...this.listings.values()].map((listing) => ({
      id: listing.id, resourceId: [...this.resources.values()].find((resource) => resource.productCode === listing.productCode)?.id ?? randomUUID(),
      productCode: listing.productCode, region: listing.region, totalQuantity: listing.availableQuantity,
      reservedQuantity: String(listing.reserved), soldQuantity: String(listing.sold), capacityUnit: listing.capacityUnit,
      unitPriceCents: listing.unitPriceCents, currency: listing.currency, minimumQuantity: listing.minimumQuantity,
      status: 'active' as const, startsAt: new Date(listing.createdAt.getTime() - 1_000), expiresAt: listing.expiresAt, createdAt: listing.createdAt,
    }));
  }
  async getResourceContract(resourceId: string) {
    const resource = this.resources.get(resourceId);
    return resource ? {
      kind: resource.kind, capacityUnit: resource.capacityUnit, specifications: resource.specifications,
    } : null;
  }
  async listProviderAssets() { return this.providerAssets; }
  async countProviderAssets(subjectId: string) {
    return this.supplier?.subjectId === subjectId ? this.providerAssets.length : 0;
  }
  async getProviderAsset(_subjectId: string, assetId: string) { return this.providerAssets.find((asset) => asset.id === assetId) ?? null; }
  async createResource(input: {
    id: string; assetId: string; subjectId: string; requestedByUserId: string; kind: ResourceKind; productCode: string; region: string;
    specifications: Record<string, unknown>; capacityTotal: string; capacityUnit: string;
    assetFingerprint: string; assetIdentityKind: 'hardware_serial' | 'cloud_resource_id' | 'internal_asset_id'; clientRequestId: string; payloadDigest: string;
  }) {
    if (!this.supplier || this.supplier.subjectId !== input.subjectId || this.supplier.status !== 'approved') return null;
    const requestKey = `${this.supplier.id}:${input.clientRequestId}`;
    const request = this.resourceRequests.get(requestKey);
    if (request) return request.payloadDigest === input.payloadDigest
      ? { status: 'replayed' as const, resource: this.resources.get(request.resourceId)! }
      : { status: 'idempotency_conflict' as const };
    const identityKey = `${input.assetIdentityKind}:${input.assetFingerprint}`;
    const existingId = this.resourceFingerprints.get(identityKey);
    const existing = existingId ? this.resources.get(existingId) : undefined;
    if (existing) return { status: 'existing' as const, resource: existing };
    const resource: ComputeResource = {
      id: input.id, supplierId: this.supplier.id, kind: input.kind, productCode: input.productCode,
      region: input.region, specifications: input.specifications, capacityTotal: input.capacityTotal,
      capacityUnit: input.capacityUnit, status: 'pending_verification',
      deliveryReadiness: { status: 'unbound', label: '待接入节点', nodeLastSeenAt: null },
    };
    this.resources.set(resource.id, resource);
    this.resourceRequests.set(requestKey, { payloadDigest: input.payloadDigest, resourceId: resource.id });
    this.resourceFingerprints.set(identityKey, resource.id);
    this.resourceVerification.set(resource.id, { status: 'pending', requestedAt: new Date(), completedAt: null, failureReason: null });
    return { status: 'created' as const, resource };
  }
  async resubmitResourceVerification(input: {
    id: string; resourceId: string; subjectId: string; requestedByUserId: string; clientRequestId: string;
  }) {
    if (this.supplier?.subjectId !== input.subjectId) return { status: 'not_found' as const };
    const replay = this.resourceResubmissions.get(input.clientRequestId);
    if (replay) return replay === input.resourceId
      ? { status: 'replayed' as const, resource: (await this.listSupplierResources(input.subjectId)).find((item) => item.id === replay)! }
      : { status: 'idempotency_conflict' as const };
    const resource = this.resources.get(input.resourceId);
    if (!resource || resource.status !== 'rejected' || this.resourceVerification.get(resource.id)?.status !== 'failed') {
      return { status: resource ? 'invalid_state' as const : 'not_found' as const };
    }
    const updated: ComputeResource = { ...resource, status: 'pending_verification' };
    this.resources.set(updated.id, updated);
    this.resourceVerification.set(updated.id, { status: 'pending', requestedAt: new Date(), completedAt: null, failureReason: null });
    this.resourceResubmissions.set(input.clientRequestId, input.resourceId);
    return { status: 'created' as const, resource: { ...updated, verification: this.resourceVerification.get(updated.id)! } };
  }
  async completeResourceVerification(input: { resourceId: string; passed: boolean }) {
    const resource = this.resources.get(input.resourceId);
    if (!resource || resource.status !== 'pending_verification') return null;
    const updated: ComputeResource = { ...resource, status: input.passed ? 'verified' : 'rejected' };
    this.resources.set(updated.id, updated);
    this.resourceVerification.set(updated.id, {
      status: input.passed ? 'passed' : 'failed', requestedAt: new Date(Date.now() - 1000), completedAt: new Date(),
      failureReason: input.passed ? null : '未达到验真要求',
    });
    return updated;
  }
  async createListing(input: {
    id: string; subjectId: string; publishedByUserId: string; resourceId: string; capacityTotal: string; unitPriceCents: number;
    minimumQuantity: string; startsAt: Date; expiresAt: Date; sla: Record<string, unknown>;
  }) {
    const resource = this.resources.get(input.resourceId);
    if (!resource || resource.status !== 'verified' || this.supplier?.subjectId !== input.subjectId) return null;
    const listing = {
      id: input.id, productCode: resource.productCode, kind: resource.kind, region: resource.region,
      specifications: resource.specifications, availableQuantity: input.capacityTotal, capacityUnit: resource.capacityUnit,
      unitPriceCents: input.unitPriceCents, currency: 'CNY' as const, minimumQuantity: input.minimumQuantity,
      sla: input.sla, expiresAt: input.expiresAt, createdAt: new Date(), supplierId: resource.supplierId, reserved: 0, sold: 0,
    };
    this.listings.set(listing.id, listing);
    return listing;
  }
  async createDemand(input: {
    id: string; buyerId: string; kind: ResourceKind; title: string; productHint: string; region: string;
    quantity: string; capacityUnit: string; desiredStartAt: Date; deadlineAt: Date; description: string;
  }) {
    const now = new Date();
    const demand: ComputeDemand = { ...input, status: 'open', createdAt: now, updatedAt: now };
    this.demands.set(demand.id, demand);
    return demand;
  }
  async listDemands(userId: string) { return [...this.demands.values()].filter((demand) => demand.buyerId === userId); }
  async cancelDemand(userId: string, demandId: string) {
    const demand = this.demands.get(demandId);
    if (!demand || demand.buyerId !== userId || demand.status !== 'open') return null;
    const updated = { ...demand, status: 'cancelled' as const, updatedAt: new Date() };
    this.demands.set(demandId, updated);
    return updated;
  }
  async createOrder(input: {
    id: string; orderNumber: string; buyerId: string; listingId: string; quantity: string; reservationExpiresAt: Date;
    idempotencyKey: string; payloadHash: string;
  }): Promise<CreateOrderResult> {
    const key = `${input.buyerId}:${input.idempotencyKey}`;
    const previous = this.idempotency.get(key);
    if (previous) {
      if (previous.payloadHash !== input.payloadHash) return { status: 'idempotency_conflict' };
      return { status: 'replayed', order: this.orders.get(previous.orderId)! };
    }
    const listing = this.listings.get(input.listingId);
    const quantity = Number(input.quantity);
    if (!listing || Number(listing.availableQuantity) - listing.reserved - listing.sold < quantity || quantity < Number(listing.minimumQuantity)) {
      return { status: 'listing_unavailable' };
    }
    listing.reserved += quantity;
    const subtotalCents = Math.ceil(quantity * listing.unitPriceCents);
    const now = new Date();
    const order: OrderRecord = {
      id: input.id, orderNumber: input.orderNumber, buyerId: input.buyerId, supplierId: listing.supplierId,
      listingId: input.listingId, status: 'payment_pending', quantity: input.quantity,
      capacityUnit: listing.capacityUnit, unitPriceCents: listing.unitPriceCents, subtotalCents, feeCents: 0,
      totalCents: subtotalCents, currency: 'CNY', reservationExpiresAt: input.reservationExpiresAt,
      createdAt: now, updatedAt: now,
    };
    this.orders.set(order.id, order);
    this.idempotency.set(key, { payloadHash: input.payloadHash, orderId: order.id });
    return { status: 'created', order };
  }
  async listOrders(userId: string) { return [...this.orders.values()].filter((order) => order.buyerId === userId || this.supplier?.subjectId === userId); }
  async getOrder(userId: string, orderId: string) {
    const order = this.orders.get(orderId);
    return order && (order.buyerId === userId || this.supplier?.subjectId === userId) ? order : null;
  }
  async cancelOrder(userId: string, orderId: string) {
    const order = this.orders.get(orderId);
    if (!order || order.buyerId !== userId || order.status !== 'payment_pending') return null;
    const updated = { ...order, status: 'cancelled' as const, updatedAt: new Date() };
    this.orders.set(order.id, updated);
    this.listings.get(order.listingId)!.reserved -= Number(order.quantity);
    return updated;
  }
  async startDelivery(userId: string, orderId: string) {
    const order = this.orders.get(orderId);
    if (!order || this.supplier?.subjectId !== userId || order.status !== 'paid') return null;
    const updated = { ...order, status: 'delivering' as const, updatedAt: new Date() };
    this.orders.set(order.id, updated);
    return updated;
  }
  async markDeliveryReady(userId: string, orderId: string) {
    const order = this.orders.get(orderId);
    if (!order || this.supplier?.subjectId !== userId || order.status !== 'delivering') return null;
    const updated = { ...order, status: 'acceptance_pending' as const, updatedAt: new Date() };
    this.orders.set(order.id, updated);
    return updated;
  }
  async acceptDelivery(userId: string, orderId: string) {
    const order = this.orders.get(orderId);
    if (!order || order.buyerId !== userId || order.status !== 'acceptance_pending') return null;
    const updated = { ...order, status: 'accepted' as const, updatedAt: new Date() };
    this.orders.set(order.id, updated);
    const listing = this.listings.get(order.listingId)!;
    listing.reserved -= Number(order.quantity);
    listing.sold += Number(order.quantity);
    return updated;
  }
  async markOrderPaid(orderId: string, _paymentIntentId: string) {
    const order = this.orders.get(orderId);
    if (!order || order.status !== 'payment_pending') return null;
    const updated = { ...order, status: 'paid' as const, updatedAt: new Date() };
    this.orders.set(order.id, updated);
    return updated;
  }
  async expireReservations(now: Date) {
    let count = 0;
    for (const order of this.orders.values()) {
      if (order.status === 'payment_pending' && order.reservationExpiresAt <= now) {
        await this.cancelOrder(order.buyerId, order.id);
        count += 1;
      }
    }
    return count;
  }
}

const config = loadConfig({
  NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://api.cloudpay.kai.com', DATABASE_URL: 'postgresql://test/cloudpay',
  ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32),
  AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'e'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  COMPUTE_PROVIDER: 'sidecar-v1', COMPUTE_PROVIDER_URL: 'https://h100-sidecar.internal',
  COMPUTE_PROVIDER_TOKEN: 'q'.repeat(48), COMPUTE_ALLOCATED_ACCELERATOR_COUNT: '1',
  COMPUTE_NODE_ACCELERATOR_COUNT: '8', NODE_GPU_FINGERPRINT_PEPPER: 'g'.repeat(40),
  NODE_CLAIM_TOKEN_PEPPER: 'n'.repeat(40),
  NODE_CLAIM_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'), NODE_SUPPORTED_AGENT_VERSIONS: '1.0.0',
});
const supplier: AccountPrincipal = { userId: 'supplier-user', sessionId: 'supplier-session', role: 'member' };
const operator: AccountPrincipal = { userId: 'operator-user', sessionId: 'operator-session', role: 'operator' };
const buyer: AccountPrincipal = { userId: 'buyer-user', sessionId: 'buyer-session', role: 'member' };
const context = { requestId: 'market-test-request', ip: '127.0.0.1' };

function harness() {
  const store = new MemoryMarketStore();
  const audits: string[] = [];
  const accountStore = { recordAudit: async (input: { action: string }) => { audits.push(input.action); } } as unknown as AccountStore;
  const subjects: SubjectAccess = { current: async (userId) => ({
    userId, subjectId: userId, kind: 'personal', displayName: userId, subjectStatus: 'active', role: 'owner',
    permissions: ['subject.manage', 'provider.read', 'provider.profile.manage', 'provider.resource.manage', 'provider.offer.manage', 'provider.listing.manage'],
  }) };
  return { store, audits, service: new MarketService(store, accountStore, config, subjects) };
}

async function approvedListing(service: MarketService, store: MemoryMarketStore) {
  const submitted = await service.submitSupplier(supplier, {
    legalName: '凯云算力有限公司', creditCode: '91310101MA1ABCDEF0', contactName: '供应负责人',
  }, context);
  await service.reviewSupplier(operator, { supplierId: submitted.id, approved: true }, context);
  const resource = await service.createResource(supplier, {
    kind: 'gpu', productCode: 'H100-SXM-80G', region: '华东-上海',
    specifications: { gpuCount: 8, memoryGiBPerGpu: 80, interconnect: 'NVLink' }, capacityTotal: '10', capacityUnit: 'GPU时', assetReference: 'ASSET-HARNESS-001', assetIdentityKind: 'hardware_serial',
  }, 'resource-create-harness-001', context);
  await service.verifyResource(operator, {
    resourceId: resource.resource.id, passed: true, evidenceDigest: `sha256:${'a'.repeat(64)}`,
    checks: { ownership: true, configuration: true, availability: true },
  }, context);
  const listing = await service.createListing(supplier, {
    resourceId: resource.resource.id, capacityTotal: '10', unitPriceCents: 1250, minimumQuantity: '1',
    startsAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    sla: { availability: '99.9%' },
  }, context);
  return { listing, resource, profile: store.supplier! };
}

describe('verified market and order lifecycle', () => {
  it('returns an empty market while node enrollment or delivery configuration is unavailable', async () => {
    const store = new MemoryMarketStore();
    const unavailable = loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'e'.repeat(32),
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    });
    const subjects = { current: async () => { throw new Error('public market must not resolve a subject'); } } as unknown as SubjectAccess;
    const service = new MarketService(store, { recordAudit: async () => undefined } as unknown as AccountStore,
      unavailable, subjects);
    expect(await service.resources({ kind: 'gpu' })).toEqual({ resources: [], nextCursor: null });
    expect(await service.listings({ kind: 'gpu' })).toEqual({ listings: [], nextCursor: null });
  });

  it('keeps asset reads available to viewers but never advertises a forbidden management action', async () => {
    const store = new MemoryMarketStore(); const assetId = randomUUID(); const resourceId = randomUUID();
    store.providerAssets = [{
      id: assetId, resourceId, name: 'H100', productCode: 'H100', region: '上海', specifications: {},
      managementMode: 'self_managed', status: 'operating', statusLabel: '运营中', statusDetail: '设备在线。',
      materialStatus: 'verified', lifecycle: 'active', attention: null,
      deliveryReadiness: { status: 'ready', label: '节点在线，可交付', nodeLastSeenAt: new Date('2026-08-14T08:00:00.000Z') },
      nodeEnrollment: { deploymentId: assetId, generation: 1, status: 'ready' },
      nodeAction: { key: 'revoke_node_enrollment', label: '断开节点', deploymentId: assetId },
      lifecycleFacts: { renewedAt: null, repurchasedAt: null, closedAt: null }, views: ['operating'],
      nextAction: { key: 'manage_listing', label: '管理在售资源', route: 'provider_listing_manager', entityId: randomUUID(), target: 'listing' },
      updatedAt: new Date('2026-08-14T08:01:00.000Z'),
    }];
    const accounts = { recordAudit: async () => undefined } as unknown as AccountStore;
    const viewerSubjects: SubjectAccess = { current: async (userId) => ({
      userId, subjectId: userId, kind: 'personal', displayName: userId, subjectStatus: 'active', role: 'viewer',
      permissions: ['orders.read', 'provider.read'],
    }) };
    const service = new MarketService(store, accounts, config, viewerSubjects);
    const result = await service.providerAssets(supplier);
    expect(result.summary).toEqual({
      total: 1, pendingConnection: 0, standby: 0, operating: 1, operatingIssue: 0, attention: 0,
      hosted: 0, deploying: 0, repurchased: 0, renewed: 0, closed: 0,
    });
    expect(result.assets[0]?.nextAction).toEqual({
      key: 'view_resource', label: '查看资源详情', route: 'provider_resources', entityId: resourceId, target: 'resource',
    });
    expect(result.assets[0]?.nodeAction).toBeNull();
    expect((await service.providerAsset(supplier, assetId)).nextAction?.key).toBe('view_resource');
  });

  it('returns the supplier rejection reason while keeping the credit code masked', async () => {
    const { service } = harness();
    const submitted = await service.submitSupplier(supplier, {
      legalName: '凯云算力有限公司', creditCode: '91310101MA1ABCDEF0', contactName: '供应负责人',
    }, context);
    await service.reviewSupplier(operator, {
      supplierId: submitted.id, approved: false, reason: '企业名称与营业执照不一致，请核对。',
    }, context);

    await expect(service.supplierProfile(supplier)).resolves.toMatchObject({
      legalName: '凯云算力有限公司', contactName: '供应负责人', status: 'rejected',
      creditCode: '9131**********DEF0', rejectionReason: '企业名称与营业执照不一致，请核对。',
    });
  });

  it('requires an actionable per-material decision when review sends a resource back', async () => {
    const { service } = harness();
    const submitted = await service.submitSupplier(supplier, {
      legalName: '凯云算力有限公司', creditCode: '91310101MA1ABCDEF0', contactName: '供应负责人',
    }, context);
    await service.reviewSupplier(operator, { supplierId: submitted.id, approved: true }, context);
    const resource = await service.createResource(supplier, {
      kind: 'gpu', productCode: 'H100-SXM-80G', region: '华东-上海', specifications: { gpuCount: 8, memoryGiBPerGpu: 80 },
      capacityTotal: '8', capacityUnit: 'GPU时', assetReference: 'ASSET-REVIEW-001', assetIdentityKind: 'hardware_serial',
    }, 'resource-create-review-0001', context);
    await expect(service.verifyResource(operator, {
      resourceId: resource.resource.id, passed: false, evidenceDigest: `sha256:${'b'.repeat(64)}`,
      checks: { configuration: false }, failureReason: '请更换配置材料。',
    }, context)).rejects.toMatchObject({ code: 'RESOURCE_REVIEW_CHECKS_INCOMPLETE' });
    await expect(service.verifyResource(operator, {
      resourceId: resource.resource.id, passed: false, evidenceDigest: `sha256:${'b'.repeat(64)}`,
      checks: { ownership: true, configuration: false, availability: true },
    }, context)).rejects.toMatchObject({ code: 'RESOURCE_REJECTION_REASON_REQUIRED' });
    await expect(service.verifyResource(operator, {
      resourceId: resource.resource.id, passed: true, evidenceDigest: `sha256:${'b'.repeat(64)}`,
      checks: { ownership: true, configuration: false, availability: true },
    }, context)).rejects.toMatchObject({ code: 'RESOURCE_REVIEW_DECISION_INVALID' });
  });

  it('requires audited GPU count and per-GPU memory at both submission and approval', async () => {
    const { service, store } = harness();
    const submitted = await service.submitSupplier(supplier, {
      legalName: '凯云算力有限公司', creditCode: '91310101MA1ABCDEF0', contactName: '供应负责人',
    }, context);
    await service.reviewSupplier(operator, { supplierId: submitted.id, approved: true }, context);
    await expect(service.createResource(supplier, {
      kind: 'gpu', productCode: 'H100', region: '华东-上海', specifications: { memoryGiBPerGpu: 98 },
      capacityTotal: '8', capacityUnit: 'GPU时', assetReference: 'ASSET-MISSING-GPU-COUNT',
      assetIdentityKind: 'hardware_serial',
    }, 'resource-invalid-gpu-count1', context)).rejects.toMatchObject({ code: 'COMPUTE_GPU_COUNT_INVALID' });

    const legacyId = randomUUID();
    store.resources.set(legacyId, {
      id: legacyId, supplierId: submitted.id, kind: 'gpu', productCode: 'H100', region: '华东-上海',
      specifications: { gpuCount: 8 }, capacityTotal: '8', capacityUnit: 'GPU时', status: 'pending_verification',
      deliveryReadiness: { status: 'unbound', label: '待接入节点', nodeLastSeenAt: null },
    });
    store.resourceVerification.set(legacyId, {
      status: 'pending', requestedAt: new Date(), completedAt: null, failureReason: null,
    });
    await expect(service.verifyResource(operator, {
      resourceId: legacyId, passed: true, evidenceDigest: `sha256:${'a'.repeat(64)}`,
      checks: { ownership: true, configuration: true, availability: true },
    }, context)).rejects.toMatchObject({ code: 'COMPUTE_GPU_MEMORY_INVALID' });
    expect(store.resources.get(legacyId)?.status).toBe('pending_verification');
  });

  it('publishes verified resource facts without RMB pricing fields', async () => {
    const { service, store } = harness();
    const submitted = await service.submitSupplier(supplier, {
      legalName: '凯云算力有限公司', creditCode: '91310101MA1ABCDEF0', contactName: '供应负责人',
    }, context);
    await service.reviewSupplier(operator, { supplierId: submitted.id, approved: true }, context);
    const resource = await service.createResource(supplier, {
      kind: 'gpu', productCode: 'H100-SXM-80G', region: '华东-上海', specifications: { gpuCount: 8, memoryGiBPerGpu: 80 },
      capacityTotal: '128', capacityUnit: 'GPU时', assetReference: 'ASSET-PUBLIC-001', assetIdentityKind: 'hardware_serial',
    }, 'resource-create-public-001', context);
    await service.verifyResource(operator, {
      resourceId: resource.resource.id, passed: true, evidenceDigest: `sha256:${'a'.repeat(64)}`,
      checks: { ownership: true, configuration: true, availability: true },
    }, context);

    const result = await service.resources({ kind: 'gpu' });
    expect(store.resources.size).toBe(1);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({ productCode: 'H100-SXM-80G', capacityTotal: '128', capacityUnit: 'GPU时' });
    expect(result.resources[0]).not.toHaveProperty('unitPriceCents');
    expect(result.resources[0]).not.toHaveProperty('unitPriceCny');
    expect(result.resources[0]).not.toHaveProperty('currency');
  });

  it('requires supplier approval and resource verification before publishing', async () => {
    const { service } = harness();
    await service.submitSupplier(supplier, {
      legalName: '凯云算力有限公司', creditCode: '91310101MA1ABCDEF0', contactName: '负责人',
    }, context);
    await expect(service.createResource(supplier, {
      kind: 'gpu', productCode: 'H100', region: '上海', specifications: { gpuCount: 8, memoryGiBPerGpu: 80 }, capacityTotal: '10', capacityUnit: 'GPU时', assetReference: 'ASSET-UNAPPROVED-001', assetIdentityKind: 'hardware_serial',
    }, 'resource-create-unapproved-001', context)).rejects.toMatchObject({ code: 'SUPPLIER_APPROVAL_REQUIRED' });
  });

  it('rejects credentials embedded in public resource specifications', async () => {
    const { service, store } = harness();
    const submitted = await service.submitSupplier(supplier, {
      legalName: '凯云算力有限公司', creditCode: '91310101MA1ABCDEF0', contactName: '负责人',
    }, context);
    await service.reviewSupplier(operator, { supplierId: submitted.id, approved: true }, context);
    await expect(service.createResource(supplier, {
      kind: 'gpu', productCode: 'H100', region: '上海', specifications: { gpuCount: 8, memoryGiBPerGpu: 80, sshPassword: 'never-public' }, capacityTotal: '10', capacityUnit: 'GPU时', assetReference: 'ASSET-SECRET-001', assetIdentityKind: 'hardware_serial',
    }, 'resource-create-secret-0001', context)).rejects.toMatchObject({ code: 'RESOURCE_SPECIFICATIONS_SENSITIVE' });
    expect(store.resources.size).toBe(0);
  });

  it('returns the existing resource when the same private asset identity is submitted again', async () => {
    const { service, store } = harness();
    const submitted = await service.submitSupplier(supplier, {
      legalName: '凯云算力有限公司', creditCode: '91310101MA1ABCDEF0', contactName: '负责人',
    }, context);
    await service.reviewSupplier(operator, { supplierId: submitted.id, approved: true }, context);
    const payload = {
      kind: 'gpu' as const, productCode: 'H100', region: '上海', specifications: { gpuCount: 8, memoryGiBPerGpu: 80 }, capacityTotal: '10',
      capacityUnit: 'GPU时', assetReference: 'SN-SAME-RESOURCE-001', assetIdentityKind: 'hardware_serial' as const,
    };
    const created = await service.createResource(supplier, payload, 'resource-create-restore01', context);
    const recovered = await service.createResource(supplier, payload, 'resource-create-restore02', context);
    expect(created).toMatchObject({ replayed: false, recovered: false });
    expect(recovered).toMatchObject({ replayed: false, recovered: true, resource: { id: created.resource.id } });
    expect(store.resources.size).toBe(1);
    expect(JSON.stringify((await service.resources({ kind: 'gpu' })).resources)).not.toContain('SN-SAME-RESOURCE-001');
  });

  it('publishes verified capacity with signed cursor protection', async () => {
    const separate = harness();
    await approvedListing(separate.service, separate.store);
    const result = await separate.service.listings({ limit: 1 });
    expect(result.listings).toHaveLength(1);
    const cursor = new CursorService('e'.repeat(32)).encode({ createdAt: new Date().toISOString(), id: randomUUID() });
    expect(() => new CursorService('e'.repeat(32)).decode(`${cursor}tampered`)).toThrowError();
  });

  it('uses idempotency to prevent double reservations and rejects conflicting replay', async () => {
    const { service, store } = harness();
    const { listing } = await approvedListing(service, store);
    const first = await service.createOrder(buyer, { listingId: listing.id, quantity: '3', idempotencyKey: 'checkout-order-000001' }, context);
    const replay = await service.createOrder(buyer, { listingId: listing.id, quantity: '3', idempotencyKey: 'checkout-order-000001' }, context);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.order.id).toBe(first.order.id);
    expect(store.listings.get(listing.id)?.reserved).toBe(3);
    await expect(service.createOrder(buyer, { listingId: listing.id, quantity: '4', idempotencyKey: 'checkout-order-000001' }, context))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
  });

  it('never allows delivery before payment and completes only supplier-to-buyer ownership flow', async () => {
    const { service, store } = harness();
    const { listing } = await approvedListing(service, store);
    const created = await service.createOrder(buyer, { listingId: listing.id, quantity: '2', idempotencyKey: 'checkout-order-000002' }, context);
    await expect(service.startDelivery(supplier, created.order.id, context)).rejects.toMatchObject({ code: 'DELIVERY_NOT_STARTABLE' });
    await store.markOrderPaid(created.order.id, 'payment-test');
    const delivering = await service.startDelivery(supplier, created.order.id, context);
    expect(delivering.status).toBe('delivering');
    const ready = await service.deliveryReady(supplier, created.order.id, { accessMode: 'brokered' }, context);
    expect(ready.status).toBe('acceptance_pending');
    const accepted = await service.acceptDelivery(buyer, created.order.id, undefined, context);
    expect(accepted.status).toBe('accepted');
    expect(store.listings.get(listing.id)?.reserved).toBe(0);
    expect(store.listings.get(listing.id)?.sold).toBe(2);
  });

  it('publishes, lists, and cancels a buyer demand without exposing another user demand', async () => {
    const { service } = harness();
    const created = await service.createDemand(buyer, {
      kind: 'gpu', title: '两周内训练 70B 模型', productHint: 'H100 80G', region: '华东-上海',
      quantity: '128', capacityUnit: 'GPU时',
      desiredStartAt: new Date(Date.now() + 60_000).toISOString(),
      deadlineAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      description: '需要八卡节点与高速互联，分阶段交付并提供任务状态。',
    }, context);
    expect(created.status).toBe('open');
    expect(await service.demands(buyer)).toHaveLength(1);
    expect(await service.demands(supplier)).toHaveLength(0);
    expect((await service.cancelDemand(buyer, created.id, context)).status).toBe('cancelled');
    await expect(service.cancelDemand(buyer, created.id, context)).rejects.toMatchObject({ code: 'DEMAND_NOT_CANCELLABLE' });
  });

  it('returns only the current supplier resources and listing status', async () => {
    const { service, store } = harness();
    await approvedListing(service, store);
    expect(await service.supplierResources(supplier)).toHaveLength(1);
    expect(await service.supplierListings(supplier)).toHaveLength(1);
    expect(await service.supplierResources(buyer)).toHaveLength(0);
  });
});
