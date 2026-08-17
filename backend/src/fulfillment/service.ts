import { createHash } from 'node:crypto';
import { decryptPii, encryptPii, secretHash } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { SubjectAccess } from '../subjects/types.js';
import { ComputeProviderError, type ComputeProviderAdapter } from './provider.js';
import type { FulfillmentStore } from './store.js';
import { ENTER_COMPUTE_STATES, fulfillmentActions, type FulfillmentRecord } from './types.js';
import { parseCreditOrderQuantity } from '../credit-orders/types.js';
import type { FulfillmentIssueRecord } from './store.js';
import { formatCreditDisplayMicros } from '../credits/display.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

export class FulfillmentService {
  private readonly auditPepper: string;
  private readonly piiKey: string;
  private readonly allocatedAcceleratorCount: number;
  private readonly nodeAcceleratorCountFallback: number;

  constructor(private readonly store: FulfillmentStore, private readonly subjects: SubjectAccess,
    private readonly provider: ComputeProviderAdapter, config: RuntimeConfig,
    private readonly now: () => Date = () => new Date()) {
    if (!config.AUDIT_PEPPER) throw new Error('AUDIT_PEPPER is required.');
    this.auditPepper = config.AUDIT_PEPPER;
    if (!config.PII_ENCRYPTION_KEY) throw new Error('PII_ENCRYPTION_KEY is required.');
    this.piiKey = config.PII_ENCRYPTION_KEY;
    this.allocatedAcceleratorCount = config.COMPUTE_ALLOCATED_ACCELERATOR_COUNT ?? 1;
    this.nodeAcceleratorCountFallback = config.COMPUTE_NODE_ACCELERATOR_COUNT ?? 8;
  }

  async onOrderConfirmed(orderId: string) {
    return this.provision(null, orderId);
  }

  async provisionForProvider(principal: AccountPrincipal, orderId: string, idempotencyKey: string,
    _context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'provider.order.manage');
    const result = await this.provision(principal.userId, orderId, subject.subjectId);
    return this.serialize(result, 'provider');
  }

  async get(principal: AccountPrincipal, orderId: string) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const result = await this.store.getForSubject(subject.subjectId, orderId);
    if (!result.orderExists) throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    if (!result.record) return { fulfillment: null, accessAvailable: false, actions: [], usage: null };
    const side = result.record.buyerSubjectId === subject.subjectId ? 'buyer' : 'provider';
    return this.serialize(result.record, side, result.usage);
  }

  async createAccessSession(principal: AccountPrincipal, orderId: string, idempotencyKey: string,
    _context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    if (!this.provider.available) throw new AppError('COMPUTE_PROVIDER_UNAVAILABLE', 503, '算力接入服务暂不可用。');
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    const record = await this.store.beginAccess({ buyerSubjectId: subject.subjectId, orderId, now: this.now() });
    if (!record?.providerLeaseId || !record.connection || !record.attestationDigest) {
      throw new AppError('FULFILLMENT_ACCESS_NOT_AVAILABLE', 409, '算力尚未准备完成，当前不能进入。');
    }
    const sessionId = deterministicUuid(`${subject.subjectId}:${orderId}:${idempotencyKey}`);
    let session;
    try {
      session = await this.provider.createAccessSession({
        providerLeaseId: record.providerLeaseId, sessionId, ttlSeconds: 300,
      });
    } catch (error) {
      throw this.providerError(error, '算力临时入口签发失败，请稍后重试。');
    }
    if (session.protocol !== record.connection.protocol || session.host !== record.connection.host
      || session.port !== record.connection.port || session.hostKeyFingerprint !== record.connection.hostKeyFingerprint
      || session.knownHostsEntry !== record.connection.knownHostsEntry) {
      throw new AppError('PROVIDER_ACCESS_CONNECTION_MISMATCH', 503, '算力入口校验失败，请重新创建入口。');
    }
    const expiresAt = new Date(session.expiresAt);
    const saved = await this.store.recordAccess({
      fulfillmentId: record.id, sessionId,
      ticketDigest: secretHash(session.ticketDigest, this.auditPepper), expiresAt, now: this.now(),
    });
    if (!saved) throw new AppError('FULFILLMENT_ACCESS_STOPPED', 409, '算力正在停止，不能再创建入口。');
    return {
      ...this.serialize(saved, 'buyer'),
      session: { protocol: session.protocol, host: session.host, port: session.port, username: session.username,
        privateKey: session.privateKey, hostKeyFingerprint: session.hostKeyFingerprint,
        knownHostsEntry: session.knownHostsEntry, expiresAt: session.expiresAt },
    };
  }

  async stop(principal: AccountPrincipal, orderId: string, idempotencyKey: string, _context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    const record = await this.store.beginStop({ buyerSubjectId: subject.subjectId, orderId, now: this.now() });
    if (!record) throw new AppError('FULFILLMENT_NOT_STOPPABLE', 409, '算力当前不能停止。');
    if (record.status === 'stopped') return { replayed: true, ...this.serialize(record, 'buyer') };
    if (!record.providerLeaseId) throw new AppError('FULFILLMENT_PROVIDER_LEASE_MISSING', 503, '算力实例标识不可用。');
    let stopped;
    try {
      stopped = await this.provider.stop({ providerLeaseId: record.providerLeaseId, operationId: `stop:${record.id}` });
      this.assertStopReceipt(record, stopped.stoppedAt);
    } catch (error) {
      throw this.providerError(error, '停止请求已保留，平台会继续重试。');
    }
    const final = await this.store.completeStop({
      fulfillmentId: record.id, consumedCapacityMicros: BigInt(stopped.consumedCapacityMicros),
      evidenceDigest: stopped.meteringEvidenceDigest, stoppedAt: new Date(stopped.stoppedAt), now: this.now(),
    });
    return { replayed: false, ...this.serialize(final, 'buyer') };
  }

  async accept(principal: AccountPrincipal, orderId: string, idempotencyKey: string, _context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'orders.buy');
    const result = await this.store.accept({
      buyerSubjectId: subject.subjectId, userId: principal.userId, actor: 'buyer', orderId, now: this.now(),
    });
    if (!result) throw new AppError('FULFILLMENT_NOT_ACCEPTABLE', 409, '算力尚未停止或计量凭证尚未完成。');
    const serialized = this.serialize(result.record, 'buyer');
    return {
      ...serialized, fulfillment: { ...serialized.fulfillment, acceptanceMode: result.acceptedActor },
      settlement: {
        capturedCredits: formatCreditDisplayMicros(result.capturedCreditMicros),
        refundedCredits: formatCreditDisplayMicros(result.refundedCreditMicros),
      },
    };
  }

  async reportIssue(principal: AccountPrincipal, orderId: string, input: Readonly<{
    kind: 'access' | 'metering'; description: string;
  }>, idempotencyKey: string, _context: RequestContext) {
    this.assertIdempotencyKey(idempotencyKey);
    const subject = await this.subjects.current(principal.userId, 'orders.dispute.manage');
    const description = input.description.trim();
    const digest = secretHash(description, this.auditPepper);
    const issue = await this.store.reportIssue({
      buyerSubjectId: subject.subjectId, userId: principal.userId, orderId, kind: input.kind,
      descriptionCiphertext: encryptPii(JSON.stringify({ description }), this.piiKey),
      descriptionDigest: digest, now: this.now(),
    });
    if (!issue) throw new AppError('FULFILLMENT_ISSUE_NOT_REPORTABLE', 409, '算力尚未停止或当前不能提交问题。');
    return { issue: { id: issue.id, kind: input.kind, status: issue.status, openedAt: issue.openedAt.toISOString() } };
  }

  async issue(principal: AccountPrincipal, orderId: string) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const visible = await this.store.getForSubject(subject.subjectId, orderId);
    if (!visible.orderExists) throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    const issue = await this.store.issueForSubject(subject.subjectId, orderId);
    return { issue: issue ? this.serializeIssue(issue) : null };
  }

  async openIssues(principal: AccountPrincipal, limit = 50) {
    this.requireOperator(principal);
    return (await this.store.listOpenIssues(Math.min(Math.max(limit, 1), 100))).map((issue) => this.serializeIssue(issue));
  }

  async decideIssue(principal: AccountPrincipal, orderId: string, input: Readonly<{
    outcome: 'full_refund' | 'partial_refund' | 'reject_refund'; refundCredits?: string; reason: string;
  }>, idempotencyKey: string, _context: RequestContext) {
    this.requireOperator(principal);
    this.assertIdempotencyKey(idempotencyKey);
    const reason = input.reason.trim();
    const parsedRefund = input.refundCredits === undefined ? null : parseCreditOrderQuantity(input.refundCredits);
    if (input.outcome === 'partial_refund' && !parsedRefund) {
      throw new AppError('FULFILLMENT_REFUND_AMOUNT_INVALID', 400, '部分退款必须填写有效卡时。');
    }
    if (input.outcome !== 'partial_refund' && input.refundCredits !== undefined) {
      throw new AppError('FULFILLMENT_REFUND_AMOUNT_UNEXPECTED', 400, '全额退款或驳回时不能指定退款卡时。');
    }
    const reasonDigest = secretHash(reason, this.auditPepper);
    const payloadDigest = secretHash(JSON.stringify({ action: 'decide_fulfillment_issue', orderId,
      outcome: input.outcome, remedyRefundCreditMicros: parsedRefund?.scaled.toString() ?? null, reasonDigest }), this.auditPepper);
    const result = await this.store.decideIssue({ operatorId: principal.userId, orderId,
      clientRequestId: idempotencyKey, payloadDigest, outcome: input.outcome,
      remedyRefundCreditMicros: parsedRefund?.scaled ?? null,
      reasonCiphertext: encryptPii(JSON.stringify({ reason }), this.piiKey), reasonDigest, now: this.now() });
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同裁定。');
    if (result.status === 'not_found') throw new AppError('FULFILLMENT_ISSUE_NOT_FOUND', 404, '待处理异议不存在。');
    if (result.status === 'invalid_state') throw new AppError('FULFILLMENT_ISSUE_NOT_DECIDABLE', 409, '异议已处理或当前不能裁定。');
    if (result.status === 'refund_exceeds_metered') throw new AppError('FULFILLMENT_REFUND_EXCEEDS_METERED', 400,
      '补偿退款必须大于 0 且小于本单实耗卡时；如需全部退回请选择全额退款。');
    if (!('issue' in result)) throw new Error('FULFILLMENT_ISSUE_DECISION_RESULT_INVALID');
    return { replayed: result.status === 'replayed', issue: this.serializeIssue(result.issue) };
  }

  async stopExpired(limit = 20) {
    const records = await this.store.claimExpired(this.now(), limit);
    for (const record of records) {
      if (!record.providerLeaseId) continue;
      try {
        const stopped = await this.provider.stop({ providerLeaseId: record.providerLeaseId, operationId: `stop:${record.id}` });
        this.assertStopReceipt(record, stopped.stoppedAt);
        await this.store.completeStop({
          fulfillmentId: record.id, consumedCapacityMicros: BigInt(stopped.consumedCapacityMicros),
          evidenceDigest: stopped.meteringEvidenceDigest, stoppedAt: new Date(stopped.stoppedAt), now: this.now(),
        });
      } catch {
        // Remain in stopping. The worker retries the same provider operation safely.
      }
    }
    return records.length;
  }

  settleDue(limit = 20) { return this.store.settleDue(this.now(), limit); }
  autoAcceptDue(limit = 20) { return this.store.autoAcceptDue(this.now(), limit); }

  async reconcileProvisioning(limit = 20) {
    const records = await this.store.listProvisioning(limit);
    for (const record of records) {
      try { await this.provision(null, record.orderId); } catch { /* state remains retryable or is safely failed */ }
    }
    return records.length;
  }

  async expireProvisioning(limit = 20) {
    const records = await this.store.listExpiredProvisioning(this.now(), limit);
    for (const record of records) {
      try {
        if (record.provisionalProviderLeaseId) {
          try {
            await this.provider.stop({ providerLeaseId: record.provisionalProviderLeaseId,
              operationId: `stop:${record.id}` });
          } catch (error) {
            if (!(error instanceof ComputeProviderError) || error.code !== 'PROVIDER_NOT_FOUND') continue;
          }
        }
        await this.store.markFailed({ fulfillmentId: record.id, code: 'COMPUTE_PROVISION_TIMEOUT',
          retryable: false, now: this.now() });
      } catch { /* a concurrent successful provision or prior refund already resolved this record */ }
    }
    return records.length;
  }

  async reconcileStopping(limit = 20) {
    const records = await this.store.listStopping(limit);
    for (const record of records) {
      if (!record.providerLeaseId) continue;
      try {
        const status = await this.provider.getLeaseStatus({ providerLeaseId: record.providerLeaseId,
          operationId: `status:${record.id}` });
        const stopped = status.status === 'stopped' ? status.receipt
          : await this.provider.stop({ providerLeaseId: record.providerLeaseId, operationId: `stop:${record.id}` });
        this.assertStopReceipt(record, stopped.stoppedAt);
        await this.store.completeStop({ fulfillmentId: record.id,
          consumedCapacityMicros: BigInt(stopped.consumedCapacityMicros), evidenceDigest: stopped.meteringEvidenceDigest,
          stoppedAt: new Date(stopped.stoppedAt), now: this.now() });
      } catch { /* idempotent retry on the next tick */ }
    }
    return records.length;
  }

  async reconcileActive(limit = 20) {
    const records = await this.store.listActive(limit);
    for (const record of records) {
      if (!record.providerLeaseId) continue;
      try {
        const status = await this.provider.getLeaseStatus({ providerLeaseId: record.providerLeaseId,
          operationId: `status:${record.id}` });
        if (status.status === 'failed' && record.status === 'ready') {
          await this.store.markFailed({ fulfillmentId: record.id,
            code: `PROVIDER_${status.failureCode}`.slice(0, 120), retryable: false, now: this.now() });
          continue;
        }
        if (status.status !== 'stopped') continue;
        this.assertStopReceipt(record, status.receipt.stoppedAt);
        await this.store.completeStop({ fulfillmentId: record.id,
          consumedCapacityMicros: BigInt(status.receipt.consumedCapacityMicros),
          evidenceDigest: status.receipt.meteringEvidenceDigest,
          stoppedAt: new Date(status.receipt.stoppedAt), now: this.now() });
      } catch { /* provider state is retried on the next tick */ }
    }
    return records.length;
  }

  private async provision(userId: string | null, orderId: string, supplierSubjectId?: string) {
    if (!this.provider.available) throw new AppError('COMPUTE_PROVIDER_UNAVAILABLE', 503, '算力开通服务尚未配置。');
    const started = await this.store.beginProvision({
      orderId, userId, ...(supplierSubjectId ? { supplierSubjectId } : {}),
      providerKey: this.provider.key, allocatedAcceleratorCount: this.allocatedAcceleratorCount,
      nodeAcceleratorCountFallback: this.nodeAcceleratorCountFallback, now: this.now(),
    });
    if (started.status === 'not_found') throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在。');
    if (started.status === 'invalid_state' || !started.record || !started.quantity || !started.capacityUnit) {
      throw new AppError('FULFILLMENT_NOT_PROVISIONABLE', 409, '订单当前不能开通算力。');
    }
    if (started.status === 'capacity_exhausted') {
      throw new AppError('COMPUTE_RESOURCE_SLOTS_EXHAUSTED', 409, '当前 8 张显卡均已分配，本单卡时和资源预留已自动退回。');
    }
    if (started.status === 'binding_unavailable') {
      throw new AppError('COMPUTE_NODE_NOT_READY', 409, '节点状态发生变化，本单卡时和资源预留已自动退回。');
    }
    if (started.status === 'cleanup_required') {
      if (!started.record || !started.binding || !started.quantity || !started.capacityUnit || !started.record.hardExpiresAt) {
        throw new AppError('COMPUTE_PROVIDER_CLEANUP_PENDING', 503, '节点资源正在安全回收，平台会自动重试。');
      }
      if (!started.record.provisionalProviderLeaseId) {
        await this.store.markFailed({ fulfillmentId: started.record.id,
          code: 'COMPUTE_BINDING_CHANGED_BEFORE_PROVISION', retryable: false, now: this.now() });
        throw new AppError('COMPUTE_NODE_NOT_READY', 409, '节点状态发生变化，本单卡时和资源预留已自动退回。');
      }
      try {
        const providerLeaseId = started.record.provisionalProviderLeaseId;
        try { await this.provider.stop({ providerLeaseId, operationId: `stop:${started.record.id}` }); }
        catch (error) {
          if (!(error instanceof ComputeProviderError) || error.code !== 'PROVIDER_NOT_FOUND') throw error;
        }
        await this.store.markFailed({ fulfillmentId: started.record.id,
          code: 'COMPUTE_BINDING_CHANGED_BEFORE_READY', retryable: false, now: this.now() });
      } catch {
        throw new AppError('COMPUTE_PROVIDER_CLEANUP_PENDING', 503, '节点资源正在安全回收，平台会自动重试。');
      }
      throw new AppError('COMPUTE_NODE_NOT_READY', 409, '节点状态发生变化，本单卡时和资源预留已自动退回。');
    }
    if (ENTER_COMPUTE_STATES.includes(started.record.status)) return started.record;
    if (started.record.status === 'failed' || started.record.status === 'stopping' || started.record.status === 'stopped') {
      throw new AppError('FULFILLMENT_NOT_PROVISIONABLE', 409, '这笔履约不能重新开通。');
    }
    let providerAttempted = false;
    let cleanupConfirmed = false;
    let cleanupAttempted = false;
    let provisionalProviderLeaseId: string | null = null;
    try {
      if (started.capacityUnit !== 'GPU时') {
        throw new ComputeProviderError('COMPUTE_CAPACITY_UNIT_UNSUPPORTED', false, 'only GPU hours are supported');
      }
      const provisionedAt = this.now();
      const quantityMicros = parseQuantityMicros(started.quantity);
      if (quantityMicros < 83_334n) {
        throw new ComputeProviderError('COMPUTE_LEASE_DURATION_TOO_SHORT', false, 'minimum lease is five minutes');
      }
      if (started.record.provisioningDeadlineAt <= provisionedAt) {
        await this.store.markFailed({ fulfillmentId: started.record.id, code: 'COMPUTE_PROVISION_TIMEOUT',
          retryable: false, now: provisionedAt });
        throw new ComputeProviderError('COMPUTE_PROVISION_TIMEOUT', false, 'provision deadline exceeded');
      }
      const hardExpiresAt = started.record.hardExpiresAt;
      if (!hardExpiresAt) throw new ComputeProviderError('COMPUTE_PROVISION_PLAN_MISSING', false, 'lease plan missing');
      if (!started.binding) throw new ComputeProviderError('COMPUTE_BINDING_MISSING', false, 'binding snapshot missing');
      const expectedProviderLeaseId = this.provider.providerLeaseIdFor(started.record.id);
      if (!expectedProviderLeaseId) throw new ComputeProviderError('COMPUTE_PROVIDER_LEASE_ID_UNAVAILABLE', false,
        'provider lease identity unavailable');
      await this.store.recordProvisionalLease({
        fulfillmentId: started.record.id, providerLeaseId: expectedProviderLeaseId, now: this.now(),
      });
      provisionalProviderLeaseId = expectedProviderLeaseId;
      providerAttempted = true;
      const result = await this.provider.provision({
        leaseId: started.record.id, orderId, resourceId: started.record.resourceId,
        bindingId: started.binding.bindingId, bindingGeneration: started.binding.bindingGeneration,
        policyDigest: started.binding.policyDigest, nodeId: started.binding.nodeId,
        quantity: started.quantity, capacityUnit: started.capacityUnit,
        allocatedAcceleratorCount: this.allocatedAcceleratorCount, hardExpiresAt: hardExpiresAt.toISOString(),
      });
      try {
        return await this.store.markReady({
          fulfillmentId: started.record.id, providerLeaseId: result.providerLeaseId,
          connection: result.connection, attestation: result.attestation, hardExpiresAt, now: this.now(),
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'COMPUTE_BINDING_CHANGED_BEFORE_READY') throw error;
        cleanupAttempted = true;
        try { await this.provider.stop({ providerLeaseId: result.providerLeaseId, operationId: `stop:${started.record.id}` }); }
        catch (cleanupError) {
          if (!(cleanupError instanceof ComputeProviderError) || cleanupError.code !== 'PROVIDER_NOT_FOUND') {
            throw new ComputeProviderError('COMPUTE_PROVIDER_CLEANUP_PENDING', true,
              'provisioned lease cleanup has not completed');
          }
        }
        cleanupConfirmed = true;
        throw new ComputeProviderError('COMPUTE_BINDING_CHANGED_BEFORE_READY', false,
          'binding changed before lease activation');
      }
    } catch (error) {
      let providerError = error instanceof ComputeProviderError
        ? error : new ComputeProviderError('PROVIDER_UNKNOWN_ERROR', false, 'unknown provider error');
      if (providerAttempted && !cleanupAttempted && !cleanupConfirmed && provisionalProviderLeaseId) {
        cleanupAttempted = true;
        try {
          await this.provider.stop({ providerLeaseId: provisionalProviderLeaseId,
            operationId: `stop:${started.record.id}` });
          cleanupConfirmed = true;
        } catch (cleanupError) {
          cleanupConfirmed = cleanupError instanceof ComputeProviderError && cleanupError.code === 'PROVIDER_NOT_FOUND';
        }
      }
      if (providerAttempted && !cleanupConfirmed) {
        providerError = new ComputeProviderError('COMPUTE_PROVIDER_CLEANUP_PENDING', true,
          'provider outcome requires cleanup confirmation');
      }
      if (!providerError.retryable) await this.store.markFailed({
          fulfillmentId: started.record.id, code: providerError.code, retryable: false, now: this.now(),
        });
      throw this.providerError(providerError, providerError.retryable
        ? '算力开通状态暂未确认，平台会自动核对，不会重复扣款。'
        : '算力开通失败，冻结卡时和资源数量已退回。');
    }
  }

  private serialize(record: FulfillmentRecord, side: 'buyer' | 'provider', usage: Awaited<ReturnType<FulfillmentStore['getForSubject']>>['usage'] = null) {
    const accessAvailable = side === 'buyer' && this.provider.available
      && ENTER_COMPUTE_STATES.includes(record.status) && Boolean(record.providerLeaseId && record.connection && record.attestationDigest);
    const canResolveMetering = Boolean(usage && !usage.acceptedAt && !usage.issueOpen
      && usage.orderStatus === 'acceptance_pending');
    const actions = fulfillmentActions(record.status, side, canResolveMetering).filter((action) =>
      action !== 'create_access_session' || accessAvailable);
    const acceptanceDueAt = record.stoppedAt ? new Date(record.stoppedAt.getTime() + 24 * 3_600_000).toISOString() : null;
    const acceptanceMode = !record.stoppedAt ? null : usage?.issueOpen ? 'disputed' as const
      : usage?.acceptedActor ?? (usage?.acceptedAt ? 'buyer' as const : 'pending' as const);
    return {
      fulfillment: {
        id: record.id, status: record.status, connection: record.connection,
        accessExpiresAt: null,
        lastError: record.failureCode ? { code: record.failureCode, retryable: record.failureRetryable ?? false } : null,
        startedAt: record.provisioningAt?.toISOString() ?? null, readyAt: record.readyAt?.toISOString() ?? null,
        runningAt: record.runningAt?.toISOString() ?? null, stoppedAt: record.stoppedAt?.toISOString() ?? null,
        leaseExpiresAt: record.hardExpiresAt?.toISOString() ?? null,
        acceptanceDueAt, acceptanceMode,
      },
      accessAvailable,
      actions,
      usage: usage ? {
        billingModel: 'metered_capacity' as const,
        purchasedCapacity: formatMicros(usage.purchasedCapacityMicros), capacityUnit: usage.capacityUnit,
        consumedCapacity: formatMicros(usage.consumedCapacityMicros),
        purchasedCredits: formatCreditDisplayMicros(usage.purchasedCreditMicros),
        consumedCredits: formatCreditDisplayMicros(usage.consumedCreditMicros),
        remainingCredits: formatCreditDisplayMicros(usage.remainingCreditMicros),
        measuredAt: usage.measuredAt.toISOString(), evidenceDigest: usage.evidenceDigest,
        acceptedAt: usage.acceptedAt?.toISOString() ?? null,
        issueOpen: usage.issueOpen,
      } : null,
    };
  }

  private assertIdempotencyKey(value: string) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(value)) {
      throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '请求缺少有效的幂等标识。');
    }
  }

  private providerError(error: unknown, message: string) {
    const code = error instanceof ComputeProviderError ? error.code : 'PROVIDER_UNKNOWN_ERROR';
    return new AppError(code, 503, message);
  }

  private assertStopReceipt(record: FulfillmentRecord, stoppedAtInput: string) {
    const stoppedAt = new Date(stoppedAtInput).getTime();
    const earliest = record.runningAt?.getTime() ?? record.readyAt?.getTime() ?? record.provisioningAt?.getTime() ?? 0;
    if (!Number.isFinite(stoppedAt) || stoppedAt < earliest || stoppedAt > this.now().getTime() + 30_000) {
      throw new ComputeProviderError('PROVIDER_METERING_TIME_INVALID', false, 'stop receipt time is outside lease window');
    }
  }

  private serializeIssue(issue: FulfillmentIssueRecord) {
    let description: string;
    try { description = (JSON.parse(decryptPii(issue.descriptionCiphertext, this.piiKey)) as { description: string }).description; }
    catch { throw new AppError('FULFILLMENT_ISSUE_UNAVAILABLE', 503, '异议详情暂时无法读取。'); }
    let reason: string | null = null;
    if (issue.reasonCiphertext) {
      try { reason = (JSON.parse(decryptPii(issue.reasonCiphertext, this.piiKey)) as { reason: string }).reason; }
      catch { throw new AppError('FULFILLMENT_ISSUE_UNAVAILABLE', 503, '裁定详情暂时无法读取。'); }
    }
    const settlement = issue.meteredCreditMicros !== null && issue.remedyRefundCreditMicros !== null
      && issue.providerCreditMicros !== null && issue.buyerRefundCreditMicros !== null ? {
        meteredCredits: formatCreditDisplayMicros(issue.meteredCreditMicros),
        providerCredits: formatCreditDisplayMicros(issue.providerCreditMicros),
        buyerRefundCredits: formatCreditDisplayMicros(issue.buyerRefundCreditMicros),
        unusedCredits: formatCreditDisplayMicros(issue.buyerRefundCreditMicros - issue.remedyRefundCreditMicros),
        remedyRefundCredits: formatCreditDisplayMicros(issue.remedyRefundCreditMicros),
      } : null;
    return { id: issue.id, orderId: issue.orderId, orderNumber: issue.orderNumber, title: issue.title,
      quantity: issue.quantity, capacityUnit: issue.capacityUnit,
      meteredCredits: issue.meteredCreditMicros === null ? null : formatCreditDisplayMicros(issue.meteredCreditMicros),
      kind: issue.kind, status: issue.status, description,
      descriptionDigest: issue.descriptionDigest, openedAt: issue.openedAt.toISOString(), outcome: issue.outcome,
      reason, reasonDigest: issue.reasonDigest, decidedAt: issue.decidedAt?.toISOString() ?? null, settlement };
  }

  private requireOperator(principal: AccountPrincipal) {
    if (principal.role !== 'operator' && principal.role !== 'admin') {
      throw new AppError('OPERATOR_REQUIRED', 403, '需要平台运营权限。');
    }
  }
}

function parseQuantityMicros(value: string) {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

function formatMicros(value: bigint) {
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
}

function deterministicUuid(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
