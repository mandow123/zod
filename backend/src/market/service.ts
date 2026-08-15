import { randomBytes, randomUUID } from 'node:crypto';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import { encryptPii, secretHash } from '../account/crypto.js';
import type { AccountStore } from '../account/store.js';
import type { AccountPrincipal } from '../account/types.js';
import { CursorService } from './cursor.js';
import type { MarketStore } from './store.js';
import type { ProviderAsset, ResourceKind } from './types.js';
import type { SubjectAccess } from '../subjects/types.js';
import type { SubjectPermission } from '../subjects/types.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function decimalQuantity(value: string) {
  const normalized = value.trim().replace(/^0+(?=\d)/u, '');
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(normalized) || Number(normalized) <= 0) {
    throw new AppError('MARKET_QUANTITY_INVALID', 400, '数量必须是大于零且最多六位小数的数字。');
  }
  return normalized;
}

function publicSpecifications(value: Record<string, unknown>) {
  const forbidden = /password|secret|token|credential|private.?key|ssh|endpoint|ip.?address/iu;
  const walk = (current: unknown): boolean => {
    if (Array.isArray(current)) return current.every(walk);
    if (!current || typeof current !== 'object') return true;
    return Object.entries(current).every(([key, nested]) => !forbidden.test(key) && walk(nested));
  };
  if (!walk(value)) throw new AppError('RESOURCE_SPECIFICATIONS_SENSITIVE', 400, '公开资源参数中不能包含密码、密钥、地址或访问凭证。');
  return value;
}

function computeProductSpecifications(value: Record<string, unknown>) {
  const specifications = publicSpecifications(value);
  if (!Number.isInteger(specifications.gpuCount)
    || Number(specifications.gpuCount) < 1 || Number(specifications.gpuCount) > 64) {
    throw new AppError('COMPUTE_GPU_COUNT_INVALID', 400, '请填写 1 至 64 之间的实际 GPU 数量。');
  }
  if (!Number.isInteger(specifications.memoryGiBPerGpu)
    || Number(specifications.memoryGiBPerGpu) < 1 || Number(specifications.memoryGiBPerGpu) > 2_048) {
    throw new AppError('COMPUTE_GPU_MEMORY_INVALID', 400, '请填写每张 GPU 的实际显存容量（GiB）。');
  }
  return specifications;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableValue(nested)]));
}

export class MarketService {
  private readonly cursor: CursorService;
  private readonly auditPepper: string;
  private readonly piiKey: string;
  private readonly computeFulfillmentAvailable: boolean;

  constructor(
    private readonly store: MarketStore,
    private readonly accountStore: AccountStore,
    config: RuntimeConfig,
    private readonly subjects: SubjectAccess,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.cursor = new CursorService(required(config.CURSOR_SECRET, 'CURSOR_SECRET'));
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
    this.piiKey = required(config.PII_ENCRYPTION_KEY, 'PII_ENCRYPTION_KEY');
    this.computeFulfillmentAvailable = config.readiness.capabilities.computeFulfillment.available;
  }

  async resources(input: { kind?: ResourceKind; region?: string; query?: string; cursor?: string; limit?: number }) {
    if (!this.computeFulfillmentAvailable) return { resources: [], nextCursor: null };
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const rows = await this.store.listVerifiedResources({
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.region?.trim() ? { region: input.region.trim() } : {}),
      ...(input.query?.trim() ? { query: input.query.trim().slice(0, 80) } : {}),
      cursor: this.cursor.decode(input.cursor), limit,
    });
    const last = rows.at(-1);
    return {
      resources: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      nextCursor: rows.length === limit && last ? this.cursor.encode({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async listings(input: { kind?: ResourceKind; region?: string; query?: string; cursor?: string; limit?: number }) {
    if (!this.computeFulfillmentAvailable) return { listings: [], nextCursor: null };
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const rows = await this.store.listListings({
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.region?.trim() ? { region: input.region.trim() } : {}),
      ...(input.query?.trim() ? { query: input.query.trim().slice(0, 80) } : {}),
      cursor: this.cursor.decode(input.cursor), limit,
    });
    const last = rows.at(-1);
    return {
      listings: rows.map((row) => this.serializeListing(row)),
      nextCursor: rows.length === limit && last ? this.cursor.encode({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async supplierProfile(principal: AccountPrincipal) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    const profile = await this.store.getSupplierBySubject(subject.subjectId);
    return profile ? this.serializeSupplier(profile) : null;
  }

  async supplierResources(principal: AccountPrincipal) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    return (await this.store.listSupplierResources(subject.subjectId)).map((resource) => ({
      ...resource,
      deliveryReadiness: {
        ...resource.deliveryReadiness,
        nodeLastSeenAt: resource.deliveryReadiness.nodeLastSeenAt?.toISOString() ?? null,
      },
      verification: resource.verification ? {
        ...resource.verification,
        requestedAt: resource.verification.requestedAt.toISOString(),
        completedAt: resource.verification.completedAt?.toISOString() ?? null,
      } : null,
    }));
  }

  async providerAssets(principal: AccountPrincipal) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    const assets = await this.store.listProviderAssets(subject.subjectId);
    const openAssets = assets.filter((asset) => !asset.views.includes('closed'));
    const summary = {
      total: assets.length,
      pendingConnection: openAssets.filter((asset) => asset.status === 'pending_connection').length,
      standby: openAssets.filter((asset) => asset.status === 'standby').length,
      operating: openAssets.filter((asset) => asset.status === 'operating').length,
      operatingIssue: openAssets.filter((asset) => asset.status === 'operating_issue').length,
      attention: assets.filter((asset) => asset.views.includes('attention')).length,
      hosted: assets.filter((asset) => asset.views.includes('hosted')).length,
      deploying: assets.filter((asset) => asset.views.includes('deploying')).length,
      repurchased: assets.filter((asset) => asset.views.includes('repurchased')).length,
      renewed: assets.filter((asset) => asset.views.includes('renewed')).length,
      closed: assets.filter((asset) => asset.views.includes('closed')).length,
    };
    return { summary, assets: assets.map((asset) => this.serializeProviderAsset(asset, subject.permissions)) };
  }

  async providerAsset(principal: AccountPrincipal, assetId: string) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    const asset = await this.store.getProviderAsset(subject.subjectId, assetId);
    if (!asset) throw new AppError('PROVIDER_ASSET_NOT_FOUND', 404, '没有找到这项资产。');
    return this.serializeProviderAsset(asset, subject.permissions);
  }

  async supplierListings(principal: AccountPrincipal) {
    const subject = await this.subjects.current(principal.userId, 'provider.read');
    return (await this.store.listSupplierListings(subject.subjectId)).map((listing) => ({
      ...listing,
      unitPriceCny: (listing.unitPriceCents / 100).toFixed(2),
      startsAt: listing.startsAt.toISOString(), expiresAt: listing.expiresAt.toISOString(), createdAt: listing.createdAt.toISOString(),
    }));
  }

  async submitSupplier(
    principal: AccountPrincipal,
    input: { legalName: string; creditCode: string; contactName: string },
    context: RequestContext,
  ) {
    const subject = await this.subjects.current(principal.userId, 'provider.profile.manage');
    if (!/^[0-9A-Z]{18}$/u.test(input.creditCode)) throw new AppError('SUPPLIER_CREDIT_CODE_INVALID', 400, '统一社会信用代码格式不正确。');
    const profile = await this.store.submitSupplier({
      subjectId: subject.subjectId, userId: principal.userId,
      legalName: input.legalName.trim(), creditCode: input.creditCode, contactName: input.contactName.trim(),
    });
    await this.audit(principal, 'SUPPLIER_PROFILE_SUBMITTED', 'SUPPLIER_PROFILE', profile.id, context, { status: profile.status });
    return this.serializeSupplier(profile);
  }

  async reviewSupplier(
    principal: AccountPrincipal,
    input: { supplierId: string; approved: boolean; reason?: string },
    context: RequestContext,
  ) {
    this.assertOperator(principal);
    const profile = await this.store.reviewSupplier({
      supplierId: input.supplierId, reviewerId: principal.userId, approved: input.approved,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    });
    if (!profile) throw new AppError('SUPPLIER_REVIEW_STATE_INVALID', 409, '供应商当前状态不能执行该审核。');
    await this.audit(principal, input.approved ? 'SUPPLIER_APPROVED' : 'SUPPLIER_REJECTED', 'SUPPLIER_PROFILE', profile.id, context, {});
    return this.serializeSupplier(profile);
  }

  async createResource(
    principal: AccountPrincipal,
    input: {
      kind: ResourceKind; productCode: string; region: string; specifications: Record<string, unknown>;
      capacityTotal: string; capacityUnit: string; assetReference: string;
      assetIdentityKind: 'hardware_serial' | 'cloud_resource_id' | 'internal_asset_id';
    },
    clientRequestId: string,
    context: RequestContext,
  ) {
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    if (input.kind !== 'gpu' || input.capacityUnit.trim() !== 'GPU时') {
      throw new AppError('COMPUTE_PRODUCT_CONTRACT_UNSUPPORTED', 400, '当前上架只支持按 GPU时计量的整卡 GPU 资源。');
    }
    const specifications = computeProductSpecifications(input.specifications);
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(clientRequestId)) {
      throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '资源提交缺少有效的请求标识。');
    }
    const rawAssetReference = input.assetReference.normalize('NFKC').trim();
    const assetReference = input.assetIdentityKind === 'cloud_resource_id'
      ? rawAssetReference
      : rawAssetReference.toUpperCase().replace(/\s+/gu, '');
    if (assetReference.length < 4 || assetReference.length > 160) {
      throw new AppError('RESOURCE_IDENTITY_INVALID', 400, '请填写 4 至 160 个字符的设备序列号、云资源 ID 或唯一资产编号。');
    }
    const normalized = {
      kind: input.kind, productCode: input.productCode.trim().toUpperCase(), region: input.region.trim(),
      specifications, capacityTotal: decimalQuantity(input.capacityTotal),
      capacityUnit: input.capacityUnit.trim(),
    };
    const assetFingerprint = secretHash(
      `resource-identity:v1:${input.assetIdentityKind}:${input.assetIdentityKind === 'internal_asset_id' ? `${subject.subjectId}:` : ''}${assetReference}`,
      this.auditPepper,
    );
    const result = await this.store.createResource({
      id: randomUUID(), assetId: randomUUID(), subjectId: subject.subjectId, requestedByUserId: principal.userId,
      ...normalized,
      assetFingerprint, assetIdentityKind: input.assetIdentityKind,
      clientRequestId, payloadDigest: secretHash(JSON.stringify(stableValue({ ...normalized, assetFingerprint })), this.auditPepper),
    });
    if (!result) throw new AppError('SUPPLIER_APPROVAL_REQUIRED', 403, '供应商资料审核通过后才能提交资源验真。');
    if (!('resource' in result)) {
      if (result.status === 'idempotency_conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的资源资料。');
      throw new AppError(
        'RESOURCE_IDENTITY_CLAIMED', 409, '该资产标识已进入其他主体的权属核验，请通过消息联系平台处理；平台不会披露对方信息。',
      );
    }
    if (result.status === 'created') {
      await this.audit(principal, 'RESOURCE_VERIFICATION_REQUESTED', 'RESOURCE', result.resource.id, context, { kind: result.resource.kind });
    }
    return { replayed: result.status === 'replayed', recovered: result.status === 'existing', resource: {
      ...result.resource,
      deliveryReadiness: {
        ...result.resource.deliveryReadiness,
        nodeLastSeenAt: result.resource.deliveryReadiness.nodeLastSeenAt?.toISOString() ?? null,
      },
    } };
  }

  async resubmitResourceVerification(
    principal: AccountPrincipal,
    resourceId: string,
    clientRequestId: string,
    context: RequestContext,
  ) {
    const subject = await this.subjects.current(principal.userId, 'provider.resource.manage');
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(clientRequestId)) {
      throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '重新送审缺少有效的请求标识。');
    }
    const result = await this.store.resubmitResourceVerification({
      id: randomUUID(), resourceId, subjectId: subject.subjectId,
      requestedByUserId: principal.userId, clientRequestId,
    });
    if (result.status === 'not_found') throw new AppError('RESOURCE_NOT_FOUND', 404, '没有找到这项资源。');
    if (result.status === 'invalid_state') throw new AppError('RESOURCE_RESUBMIT_STATE_INVALID', 409, '只有验真未通过的资源可以重新送审。');
    if (result.status === 'idempotency_conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了另一项资源。');
    if (!('resource' in result)) throw new Error('unhandled resource resubmission result');
    if (result.status === 'created') {
      await this.audit(principal, 'RESOURCE_VERIFICATION_RESUBMITTED', 'RESOURCE', resourceId, context, {});
    }
    const verification = result.resource.verification;
    return {
      replayed: result.status === 'replayed',
      resource: {
        ...result.resource,
        deliveryReadiness: {
          ...result.resource.deliveryReadiness,
          nodeLastSeenAt: result.resource.deliveryReadiness.nodeLastSeenAt?.toISOString() ?? null,
        },
        verification: verification ? {
          ...verification, requestedAt: verification.requestedAt.toISOString(),
          completedAt: verification.completedAt?.toISOString() ?? null,
        } : null,
      },
    };
  }

  async verifyResource(
    principal: AccountPrincipal,
    input: { resourceId: string; passed: boolean; evidenceDigest: string; checks: Record<string, unknown>; failureReason?: string },
    context: RequestContext,
  ) {
    this.assertOperator(principal);
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.evidenceDigest)) throw new AppError('RESOURCE_EVIDENCE_INVALID', 400, '验真证据摘要格式不正确。');
    const decisions = ['ownership', 'configuration', 'availability'].map((category) => input.checks[category]);
    if (decisions.some((decision) => typeof decision !== 'boolean')) {
      throw new AppError('RESOURCE_REVIEW_CHECKS_INCOMPLETE', 400, '请分别确认权属、配置和可用性材料。');
    }
    if (input.passed && decisions.some((decision) => decision !== true)) {
      throw new AppError('RESOURCE_REVIEW_DECISION_INVALID', 400, '三项材料全部通过后才能确认验真通过。');
    }
    if (!input.passed && decisions.every((decision) => decision !== false)) {
      throw new AppError('RESOURCE_REVIEW_DECISION_INVALID', 400, '退回时请标明需要更换的材料。');
    }
    if (!input.passed && !input.failureReason?.trim()) {
      throw new AppError('RESOURCE_REJECTION_REASON_REQUIRED', 400, '退回时请填写用户可以照着处理的审核意见。');
    }
    if (input.passed) {
      const contract = await this.store.getResourceContract(input.resourceId);
      if (!contract) throw new AppError('RESOURCE_VERIFICATION_STATE_INVALID', 409, '资源当前没有可完成的验真任务。');
      if (contract.kind !== 'gpu' || contract.capacityUnit !== 'GPU时') {
        throw new AppError('COMPUTE_PRODUCT_CONTRACT_UNSUPPORTED', 409, '只有按 GPU时计量的整卡 GPU 资源可以通过验真。');
      }
      computeProductSpecifications(contract.specifications);
    }
    const resource = await this.store.completeResourceVerification({
      ...input, reviewerId: principal.userId,
      ...(input.failureReason?.trim() ? { failureReason: input.failureReason.trim() } : {}),
    });
    if (!resource) throw new AppError('RESOURCE_VERIFICATION_STATE_INVALID', 409, '资源当前没有可完成的验真任务。');
    await this.audit(principal, input.passed ? 'RESOURCE_VERIFIED' : 'RESOURCE_REJECTED', 'RESOURCE', resource.id, context, {});
    return resource;
  }

  async createListing(
    principal: AccountPrincipal,
    input: {
      resourceId: string; capacityTotal: string; unitPriceCents: number; minimumQuantity: string;
      startsAt: string; expiresAt: string; sla: Record<string, unknown>;
    },
    context: RequestContext,
  ) {
    const subject = await this.subjects.current(principal.userId, 'provider.listing.manage');
    const startsAt = new Date(input.startsAt);
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(expiresAt.getTime()) || expiresAt <= startsAt || expiresAt <= this.now()) {
      throw new AppError('LISTING_WINDOW_INVALID', 400, '挂牌起止时间无效。');
    }
    const listing = await this.store.createListing({
      id: randomUUID(), subjectId: subject.subjectId, publishedByUserId: principal.userId, resourceId: input.resourceId,
      capacityTotal: decimalQuantity(input.capacityTotal), unitPriceCents: input.unitPriceCents,
      minimumQuantity: decimalQuantity(input.minimumQuantity), startsAt, expiresAt, sla: input.sla,
    });
    if (!listing) throw new AppError('RESOURCE_NOT_LISTABLE', 409, '只有已验真且属于当前供应商的资源才能挂牌。');
    await this.audit(principal, 'LISTING_PUBLISHED', 'LISTING', listing.id, context, { resourceId: input.resourceId });
    return this.serializeListing(listing);
  }

  async createDemand(
    principal: AccountPrincipal,
    input: {
      kind: ResourceKind; title: string; productHint: string; region: string; quantity: string; capacityUnit: string;
      budgetMaxCents?: number; desiredStartAt: string; deadlineAt: string; description: string;
    },
    context: RequestContext,
  ) {
    const desiredStartAt = new Date(input.desiredStartAt);
    const deadlineAt = new Date(input.deadlineAt);
    if (!Number.isFinite(desiredStartAt.getTime()) || !Number.isFinite(deadlineAt.getTime())
      || deadlineAt <= desiredStartAt || deadlineAt <= this.now()
      || deadlineAt.getTime() - this.now().getTime() > 366 * 24 * 60 * 60 * 1000) {
      throw new AppError('DEMAND_WINDOW_INVALID', 400, '需求起止时间无效，截止时间需在未来一年内。');
    }
    const demand = await this.store.createDemand({
      id: randomUUID(), buyerId: principal.userId, kind: input.kind,
      title: input.title.trim(), productHint: input.productHint.trim(), region: input.region.trim(),
      quantity: decimalQuantity(input.quantity), capacityUnit: input.capacityUnit.trim(),
      budgetMaxCents: input.budgetMaxCents ?? null, desiredStartAt, deadlineAt, description: input.description.trim(),
    });
    await this.audit(principal, 'DEMAND_PUBLISHED', 'COMPUTE_DEMAND', demand.id, context, { kind: demand.kind, region: demand.region });
    return this.serializeDemand(demand);
  }

  async demands(principal: AccountPrincipal) {
    return (await this.store.listDemands(principal.userId)).map((demand) => this.serializeDemand(demand));
  }

  async cancelDemand(principal: AccountPrincipal, demandId: string, context: RequestContext) {
    const demand = await this.store.cancelDemand(principal.userId, demandId);
    if (!demand) throw new AppError('DEMAND_NOT_CANCELLABLE', 409, '需求当前不能取消。');
    await this.audit(principal, 'DEMAND_CANCELLED', 'COMPUTE_DEMAND', demand.id, context, {});
    return this.serializeDemand(demand);
  }

  async createOrder(
    principal: AccountPrincipal,
    input: { listingId: string; quantity: string; idempotencyKey: string },
    context: RequestContext,
  ) {
    const quantity = decimalQuantity(input.quantity);
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(input.idempotencyKey)) {
      throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '下单请求缺少有效的幂等标识。');
    }
    const id = randomUUID();
    const payloadHash = secretHash(JSON.stringify({ listingId: input.listingId, quantity }), this.auditPepper);
    const result = await this.store.createOrder({
      id,
      orderNumber: `CP${this.now().toISOString().slice(0, 10).replaceAll('-', '')}${randomBytes(5).toString('hex').toUpperCase()}`,
      buyerId: principal.userId, listingId: input.listingId, quantity,
      reservationExpiresAt: new Date(this.now().getTime() + 15 * 60 * 1000),
      idempotencyKey: input.idempotencyKey, payloadHash,
    });
    if (result.status === 'idempotency_conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一幂等标识对应了不同的下单内容。');
    if (result.status === 'in_progress') throw new AppError('ORDER_CREATION_IN_PROGRESS', 409, '订单正在创建，请稍后查询。');
    if (result.status === 'listing_unavailable') throw new AppError('LISTING_CAPACITY_UNAVAILABLE', 409, '当前可售容量不足或挂牌已经失效。');
    if (result.status === 'created') await this.audit(principal, 'ORDER_CREATED', 'ORDER', result.order.id, context, { listingId: input.listingId, quantity });
    return { replayed: result.status === 'replayed', order: this.serializeOrder(result.order) };
  }

  async orders(principal: AccountPrincipal) {
    return (await this.store.listOrders(principal.userId)).map((order) => this.serializeOrder(order));
  }

  async order(principal: AccountPrincipal, orderId: string) {
    const order = await this.store.getOrder(principal.userId, orderId);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    return this.serializeOrder(order);
  }

  async cancelOrder(principal: AccountPrincipal, orderId: string, context: RequestContext) {
    const order = await this.store.cancelOrder(principal.userId, orderId);
    if (!order) throw new AppError('ORDER_NOT_CANCELLABLE', 409, '订单当前不能取消。');
    await this.audit(principal, 'ORDER_CANCELLED', 'ORDER', order.id, context, {});
    return this.serializeOrder(order);
  }

  async startDelivery(principal: AccountPrincipal, orderId: string, context: RequestContext) {
    const order = await this.store.startDelivery(principal.userId, orderId);
    if (!order) throw new AppError('DELIVERY_NOT_STARTABLE', 409, '订单未支付或不属于当前供应商。');
    await this.audit(principal, 'DELIVERY_STARTED', 'ORDER', order.id, context, {});
    return this.serializeOrder(order);
  }

  async deliveryReady(
    principal: AccountPrincipal, orderId: string, metadata: Record<string, unknown>, context: RequestContext,
  ) {
    const ciphertext = encryptPii(JSON.stringify(metadata), this.piiKey);
    const order = await this.store.markDeliveryReady(principal.userId, orderId, ciphertext);
    if (!order) throw new AppError('DELIVERY_NOT_READYABLE', 409, '交付任务当前不能标记为待验收。');
    await this.audit(principal, 'DELIVERY_READY', 'ORDER', order.id, context, {});
    return this.serializeOrder(order);
  }

  async acceptDelivery(principal: AccountPrincipal, orderId: string, evidenceDigest: string | undefined, context: RequestContext) {
    if (evidenceDigest && !/^sha256:[a-f0-9]{64}$/u.test(evidenceDigest)) throw new AppError('DELIVERY_EVIDENCE_INVALID', 400, '验收证据摘要格式不正确。');
    const order = await this.store.acceptDelivery(principal.userId, orderId, evidenceDigest);
    if (!order) throw new AppError('DELIVERY_NOT_ACCEPTABLE', 409, '订单当前不能验收。');
    await this.audit(principal, 'DELIVERY_ACCEPTED', 'ORDER', order.id, context, {});
    return this.serializeOrder(order);
  }

  private assertOperator(principal: AccountPrincipal) {
    if (!['operator', 'admin'].includes(principal.role)) throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要运营审核权限。');
  }

  private async audit(
    principal: AccountPrincipal, action: string, entityType: string, entityId: string,
    context: RequestContext, metadata: Record<string, unknown>,
  ) {
    await this.accountStore.recordAudit({
      actorId: principal.userId, actorKind: 'user', action, entityType, entityId,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      payloadDigest: secretHash(JSON.stringify(metadata), this.auditPepper), metadata,
    });
  }

  private serializeSupplier(profile: Awaited<ReturnType<MarketStore['submitSupplier']>>) {
    return {
      id: profile.id, legalName: profile.legalName,
      creditCode: `${profile.creditCode.slice(0, 4)}**********${profile.creditCode.slice(-4)}`,
      contactName: profile.contactName, status: profile.status, rejectionReason: profile.rejectionReason,
    };
  }

  private serializeProviderAsset(asset: ProviderAsset, permissions: SubjectPermission[]) {
    const requiredPermission = asset.nextAction?.key === 'resubmit_resource' ? 'provider.resource.manage'
      : ['create_offer', 'resume_offer_draft', 'resolve_offer_review', 'reaudit_expired_offer'].includes(asset.nextAction?.key ?? '')
        ? 'provider.offer.manage'
        : ['manage_listing', 'publish_approved_offer'].includes(asset.nextAction?.key ?? '') ? 'provider.listing.manage' : null;
    const nextAction = requiredPermission && !permissions.includes(requiredPermission)
      ? { key: 'view_resource' as const, label: '查看资源详情', route: 'provider_resources' as const,
        entityId: asset.resourceId, target: 'resource' as const }
      : asset.nextAction;
    const nodeAction = permissions.includes('provider.resource.manage') ? asset.nodeAction : null;
    return {
      ...asset, nextAction, nodeAction,
      deliveryReadiness: {
        ...asset.deliveryReadiness,
        nodeLastSeenAt: asset.deliveryReadiness.nodeLastSeenAt?.toISOString() ?? null,
      },
      lifecycleFacts: {
        renewedAt: asset.lifecycleFacts.renewedAt?.toISOString() ?? null,
        repurchasedAt: asset.lifecycleFacts.repurchasedAt?.toISOString() ?? null,
        closedAt: asset.lifecycleFacts.closedAt?.toISOString() ?? null,
      },
      updatedAt: asset.updatedAt.toISOString(),
    };
  }

  private serializeListing(listing: Awaited<ReturnType<MarketStore['listListings']>>[number]) {
    return {
      ...listing, expiresAt: listing.expiresAt.toISOString(), createdAt: listing.createdAt.toISOString(),
      unitPriceCny: (listing.unitPriceCents / 100).toFixed(2),
    };
  }

  private serializeDemand(demand: Awaited<ReturnType<MarketStore['createDemand']>>) {
    return {
      ...demand,
      budgetMaxCny: demand.budgetMaxCents === null ? null : (demand.budgetMaxCents / 100).toFixed(2),
      desiredStartAt: demand.desiredStartAt.toISOString(), deadlineAt: demand.deadlineAt.toISOString(),
      createdAt: demand.createdAt.toISOString(), updatedAt: demand.updatedAt.toISOString(),
    };
  }

  private serializeOrder(order: Awaited<ReturnType<MarketStore['getOrder']>> & {}) {
    if (!order) throw new Error('order is required');
    return {
      ...order,
      unitPriceCny: (order.unitPriceCents / 100).toFixed(2),
      subtotalCny: (order.subtotalCents / 100).toFixed(2),
      feeCny: (order.feeCents / 100).toFixed(2),
      totalCny: (order.totalCents / 100).toFixed(2),
      reservationExpiresAt: order.reservationExpiresAt.toISOString(),
      createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString(),
    };
  }
}
