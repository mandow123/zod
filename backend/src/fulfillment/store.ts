import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from '../database.js';
import type { FulfillmentAttestation, FulfillmentRecord, SafeConnectionDescriptor } from './types.js';

type FulfillmentRow = {
  id: string; order_id: string; buyer_subject_id: string; supplier_subject_id: string; resource_id: string;
  provider_key: string; provider_lease_id: string | null; status: FulfillmentRecord['status'];
  provisional_provider_lease_id: string | null;
  connection: SafeConnectionDescriptor | null; attestation_digest: string | null; failure_code: string | null;
  failure_retryable: boolean | null; created_at: Date; provisioning_at: Date | null; ready_at: Date | null;
  allocated_accelerator_count: number; resource_slot_limit: number; provisioning_deadline_at: Date;
  running_at: Date | null; stopping_at: Date | null; hard_expires_at: Date | null; stopped_at: Date | null;
  failed_at: Date | null; updated_at: Date;
};

const columns = `id, order_id, buyer_subject_id, supplier_subject_id, resource_id, provider_key,
  provisional_provider_lease_id,
  provider_lease_id, status, connection, attestation_digest, failure_code, failure_retryable, created_at,
  provisioning_at, ready_at, running_at, stopping_at, hard_expires_at, stopped_at, failed_at, updated_at,
  allocated_accelerator_count, resource_slot_limit, provisioning_deadline_at`;

type IssueRow = {
  id: string; order_id: string; fulfillment_id: string; buyer_subject_id: string; kind: 'access' | 'metering';
  status: 'open' | 'resolved'; description_ciphertext: string; description_digest: string; opened_at: Date;
  outcome: 'full_refund' | 'partial_refund' | 'reject_refund' | null; reason_ciphertext: string | null;
  reason_digest: string | null; metered_credit_micros: string | null; remedy_refund_credit_micros: string | null;
  provider_credit_micros: string | null; buyer_refund_credit_micros: string | null; decided_at: Date | null;
  order_number: string; title: string; quantity: string; capacity_unit: string;
};
const issueColumns = `i.id,i.order_id,i.fulfillment_id,i.buyer_subject_id,i.kind,i.status,
  i.description_ciphertext,i.description_digest,i.opened_at,d.outcome,d.reason_ciphertext,d.reason_digest,
  COALESCE(d.metered_credit_micros,
    CEIL(m.consumed_capacity_micros*o.unit_credit_micros::numeric/1000000)::bigint)::text AS metered_credit_micros,
  d.remedy_refund_credit_micros::text,d.provider_credit_micros::text,
  d.buyer_refund_credit_micros::text,d.decided_at,o.order_number,
  COALESCE(o.listing_snapshot->>'title','算力订单') AS title,o.quantity::text,o.capacity_unit`;
function mapIssue(row: IssueRow): FulfillmentIssueRecord {
  return { id: row.id, orderId: row.order_id, orderNumber: row.order_number, title: row.title,
    quantity: row.quantity, capacityUnit: row.capacity_unit,
    fulfillmentId: row.fulfillment_id, buyerSubjectId: row.buyer_subject_id,
    kind: row.kind, status: row.status, descriptionCiphertext: row.description_ciphertext,
    descriptionDigest: row.description_digest, openedAt: new Date(row.opened_at), outcome: row.outcome,
    reasonCiphertext: row.reason_ciphertext, reasonDigest: row.reason_digest,
    meteredCreditMicros: row.metered_credit_micros === null ? null : BigInt(row.metered_credit_micros),
    remedyRefundCreditMicros: row.remedy_refund_credit_micros === null ? null : BigInt(row.remedy_refund_credit_micros),
    providerCreditMicros: row.provider_credit_micros === null ? null : BigInt(row.provider_credit_micros),
    buyerRefundCreditMicros: row.buyer_refund_credit_micros === null ? null : BigInt(row.buyer_refund_credit_micros),
    decidedAt: row.decided_at ? new Date(row.decided_at) : null };
}

function map(row: FulfillmentRow): FulfillmentRecord {
  return {
    id: row.id, orderId: row.order_id, buyerSubjectId: row.buyer_subject_id,
    supplierSubjectId: row.supplier_subject_id, resourceId: row.resource_id, providerKey: row.provider_key,
    providerLeaseId: row.provider_lease_id, provisionalProviderLeaseId: row.provisional_provider_lease_id,
    status: row.status, connection: row.connection,
    attestationDigest: row.attestation_digest, failureCode: row.failure_code,
    failureRetryable: row.failure_retryable, createdAt: new Date(row.created_at),
    allocatedAcceleratorCount: row.allocated_accelerator_count, resourceSlotLimit: row.resource_slot_limit,
    provisioningDeadlineAt: new Date(row.provisioning_deadline_at),
    provisioningAt: row.provisioning_at ? new Date(row.provisioning_at) : null,
    readyAt: row.ready_at ? new Date(row.ready_at) : null,
    runningAt: row.running_at ? new Date(row.running_at) : null,
    stoppingAt: row.stopping_at ? new Date(row.stopping_at) : null,
    hardExpiresAt: row.hard_expires_at ? new Date(row.hard_expires_at) : null,
    stoppedAt: row.stopped_at ? new Date(row.stopped_at) : null,
    failedAt: row.failed_at ? new Date(row.failed_at) : null, updatedAt: new Date(row.updated_at),
  };
}

function bindingSnapshot(value: Record<string, unknown>): ComputeBindingSnapshot | null {
  const bindingId = value.bindingId; const bindingGeneration = value.bindingGeneration;
  const policyDigest = value.bindingPolicyDigest; const nodeId = value.bindingNodeId;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (typeof bindingId !== 'string' || !uuid.test(bindingId) || typeof nodeId !== 'string' || !uuid.test(nodeId)
    || !Number.isInteger(bindingGeneration) || Number(bindingGeneration) < 1
    || typeof policyDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(policyDigest)) return null;
  return { bindingId, bindingGeneration: Number(bindingGeneration), policyDigest, nodeId };
}

export type ProvisionContext = Readonly<{
  orderId: string; userId: string | null; supplierSubjectId?: string; providerKey: string; now: Date;
  allocatedAcceleratorCount?: number; nodeAcceleratorCountFallback?: number;
}>;

export type ComputeBindingSnapshot = Readonly<{
  bindingId: string; bindingGeneration: number; policyDigest: string; nodeId: string;
}>;

export type FulfillmentIssueRecord = Readonly<{
  id: string; orderId: string; orderNumber: string; title: string; quantity: string; capacityUnit: string;
  fulfillmentId: string; buyerSubjectId: string; kind: 'access' | 'metering';
  status: 'open' | 'resolved'; descriptionCiphertext: string; descriptionDigest: string; openedAt: Date;
  outcome: 'full_refund' | 'partial_refund' | 'reject_refund' | null; reasonCiphertext: string | null;
  reasonDigest: string | null; meteredCreditMicros: bigint | null; remedyRefundCreditMicros: bigint | null;
  providerCreditMicros: bigint | null; buyerRefundCreditMicros: bigint | null; decidedAt: Date | null;
}>;

export interface FulfillmentStore {
  getForSubject(subjectId: string, orderId: string): Promise<Readonly<{
    orderExists: boolean; record: FulfillmentRecord | null; usage: Readonly<{
      purchasedCapacityMicros: bigint; capacityUnit: string; consumedCapacityMicros: bigint;
      purchasedCreditMicros: bigint; consumedCreditMicros: bigint; remainingCreditMicros: bigint;
      measuredAt: Date; evidenceDigest: string; acceptedAt: Date | null; orderStatus: string; issueOpen: boolean;
      acceptedActor: 'buyer' | 'system' | 'operator' | null;
    }> | null;
  }>>;
  beginProvision(input: ProvisionContext): Promise<Readonly<{
    status: 'started' | 'existing' | 'capacity_exhausted' | 'binding_unavailable' | 'cleanup_required' | 'not_found' | 'invalid_state'; record?: FulfillmentRecord;
    quantity?: string; capacityUnit?: string; binding?: ComputeBindingSnapshot;
  }>>;
  recordProvisionalLease(input: Readonly<{ fulfillmentId: string; providerLeaseId: string; now: Date }>): Promise<FulfillmentRecord>;
  markReady(input: Readonly<{
    fulfillmentId: string; providerLeaseId: string; connection: SafeConnectionDescriptor;
    attestation: FulfillmentAttestation; hardExpiresAt: Date; now: Date;
  }>): Promise<FulfillmentRecord>;
  markFailed(input: Readonly<{
    fulfillmentId: string; code: string; retryable: boolean; now: Date;
  }>): Promise<FulfillmentRecord>;
  beginAccess(input: Readonly<{ buyerSubjectId: string; orderId: string; now: Date }>): Promise<FulfillmentRecord | null>;
  recordAccess(input: Readonly<{
    fulfillmentId: string; sessionId: string; ticketDigest: string; expiresAt: Date; now: Date;
  }>): Promise<FulfillmentRecord | null>;
  beginStop(input: Readonly<{ buyerSubjectId: string; orderId: string; now: Date }>): Promise<FulfillmentRecord | null>;
  completeStop(input: Readonly<{
    fulfillmentId: string; consumedCapacityMicros: bigint; evidenceDigest: string; stoppedAt: Date; now: Date;
  }>): Promise<FulfillmentRecord>;
  accept(input: Readonly<{ buyerSubjectId: string; userId: string | null; actor: 'buyer' | 'system';
    orderId: string; now: Date }>): Promise<Readonly<{
    record: FulfillmentRecord; capturedCreditMicros: bigint; refundedCreditMicros: bigint;
    acceptedActor: 'buyer' | 'system' | 'operator';
  }> | null>;
  claimExpired(now: Date, limit: number): Promise<FulfillmentRecord[]>;
  autoAcceptDue(now: Date, limit: number): Promise<number>;
  settleDue(now: Date, limit: number): Promise<number>;
  reportIssue(input: Readonly<{
    buyerSubjectId: string; userId: string; orderId: string; kind: 'access' | 'metering';
    descriptionCiphertext: string; descriptionDigest: string; now: Date;
  }>): Promise<Readonly<{ id: string; status: 'open'; openedAt: Date }> | null>;
  listProvisioning(limit: number): Promise<Array<{ orderId: string }>>;
  listExpiredProvisioning(now: Date, limit: number): Promise<FulfillmentRecord[]>;
  listActive(limit: number): Promise<FulfillmentRecord[]>;
  listStopping(limit: number): Promise<FulfillmentRecord[]>;
  issueForSubject(subjectId: string, orderId: string): Promise<FulfillmentIssueRecord | null>;
  listOpenIssues(limit: number): Promise<FulfillmentIssueRecord[]>;
  decideIssue(input: Readonly<{
    operatorId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    outcome: 'full_refund' | 'partial_refund' | 'reject_refund'; remedyRefundCreditMicros: bigint | null;
    reasonCiphertext: string; reasonDigest: string; now: Date;
  }>): Promise<Readonly<{ status: 'decided' | 'replayed'; issue: FulfillmentIssueRecord }>
    | Readonly<{ status: 'conflict' | 'not_found' | 'invalid_state' | 'refund_exceeds_metered' }>>;
}

export class PostgresFulfillmentStore implements FulfillmentStore {
  constructor(private readonly database: Database) {}

  async getForSubject(subjectId: string, orderId: string) {
    const order = await this.database.query<{ id: string }>(`SELECT id FROM kai_credit_orders
      WHERE id = $1 AND (buyer_subject_id = $2 OR supplier_subject_id = $2)`, [orderId, subjectId]);
    if (!order.rows[0]) return { orderExists: false, record: null, usage: null };
    const result = await this.database.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments WHERE order_id = $1`, [orderId]);
    const usage = await this.database.query<{
      purchased_capacity_micros: string; capacity_unit: string; consumed_capacity_micros: string;
      purchased_credit_micros: string; unit_credit_micros: string; measured_at: Date; evidence_digest: string;
      accepted_at: Date | null; accepted_actor: 'buyer' | 'system' | 'operator' | null;
      order_status: string; issue_open: boolean;
    }>(`SELECT (o.quantity * 1000000)::bigint::text AS purchased_capacity_micros, o.capacity_unit,
        m.consumed_capacity_micros::text, o.total_credit_micros::text AS purchased_credit_micros,
        o.unit_credit_micros::text, m.stopped_at AS measured_at, m.evidence_digest, a.accepted_at, a.accepted_actor,
        o.status AS order_status, EXISTS (SELECT 1 FROM compute_fulfillment_issues i
          WHERE i.fulfillment_id=f.id AND i.status='open') AS issue_open
      FROM compute_fulfillments f JOIN kai_credit_orders o ON o.id = f.order_id
      JOIN compute_fulfillment_metering m ON m.fulfillment_id = f.id
      LEFT JOIN compute_fulfillment_acceptances a ON a.fulfillment_id = f.id WHERE f.order_id = $1`, [orderId]);
    const meter = usage.rows[0];
    const consumedCreditMicros = meter
      ? (BigInt(meter.consumed_capacity_micros) * BigInt(meter.unit_credit_micros) + 999_999n) / 1_000_000n : 0n;
    return { orderExists: true, record: result.rows[0] ? map(result.rows[0]) : null, usage: meter ? {
      purchasedCapacityMicros: BigInt(meter.purchased_capacity_micros), capacityUnit: meter.capacity_unit,
      consumedCapacityMicros: BigInt(meter.consumed_capacity_micros),
      purchasedCreditMicros: BigInt(meter.purchased_credit_micros), consumedCreditMicros,
      remainingCreditMicros: BigInt(meter.purchased_credit_micros) - consumedCreditMicros,
      measuredAt: new Date(meter.measured_at), evidenceDigest: meter.evidence_digest,
      acceptedAt: meter.accepted_at ? new Date(meter.accepted_at) : null, acceptedActor: meter.accepted_actor,
      orderStatus: meter.order_status, issueOpen: meter.issue_open,
    } : null };
  }

  async beginProvision(input: ProvisionContext) {
    return this.database.transaction(async (client) => {
      const order = await client.query<{
        id: string; status: string; buyer_subject_id: string; supplier_subject_id: string; quantity: string;
        capacity_unit: string; listing_snapshot: Record<string, unknown>; service_mode: string | null;
      }>(`SELECT id, status, buyer_subject_id, supplier_subject_id, quantity::text, capacity_unit, listing_snapshot,
          (SELECT o.service_mode FROM credit_market_listings l JOIN offer_templates o ON o.id=l.offer_id
            WHERE l.id=kai_credit_orders.listing_id) AS service_mode
        FROM kai_credit_orders WHERE id = $1 FOR UPDATE`, [input.orderId]);
      const row = order.rows[0];
      if (!row) return { status: 'not_found' as const };
      if (input.supplierSubjectId && row.supplier_subject_id !== input.supplierSubjectId) {
        return { status: 'not_found' as const };
      }
      const existing = await client.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments WHERE order_id = $1 FOR UPDATE`, [row.id]);
      const existingRecord = existing.rows[0] ? map(existing.rows[0]) : null;
      const binding = bindingSnapshot(row.listing_snapshot);
      if (existingRecord && existingRecord.status !== 'provisioning') {
        return { status: 'existing' as const, record: existingRecord, quantity: row.quantity,
          capacityUnit: row.capacity_unit, ...(binding ? { binding } : {}) };
      }
      const resourceId = typeof row.listing_snapshot.resourceId === 'string' ? row.listing_snapshot.resourceId : null;
      if (!['confirmed', 'provisioning'].includes(row.status) || !resourceId) return { status: 'invalid_state' as const };
      const reservation = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_reservations
        WHERE order_id = $1 FOR UPDATE`, [row.id]);
      if (reservation.rows[0]?.status !== 'secured') return { status: 'invalid_state' as const };
      const resource = await client.query<{
        kind: string; capacity_unit: string; status: string; specifications: Record<string, unknown>;
        verification_digest: string | null; supplier_id: string;
      }>(
        `SELECT kind,capacity_unit,status,specifications,verification_digest,supplier_id
         FROM compute_resources WHERE id=$1 FOR UPDATE`, [resourceId],
      );
      if (resource.rows[0]?.kind !== 'gpu' || resource.rows[0]?.capacity_unit !== 'GPU时'
        || resource.rows[0]?.status !== 'verified' || row.capacity_unit !== 'GPU时' || row.service_mode !== 'dedicated') {
        return { status: 'invalid_state' as const };
      }
      const readyBinding = binding ? await client.query(
        `SELECT b.id FROM compute_resource_bindings b
         JOIN compute_nodes n ON n.id = b.node_id
         JOIN compute_resource_delivery_readiness dr ON dr.resource_id=b.resource_id
         WHERE b.id = $1 AND b.resource_id = $2 AND b.generation = $3 AND b.node_id = $4
           AND b.policy_digest = $5 AND dr.status='ready' AND b.status='ready' AND n.status='ready'
           AND b.resource_verification_digest = $6
           AND n.supplier_id = $7
         FOR UPDATE OF b, n`,
        [binding.bindingId, resourceId, binding.bindingGeneration, binding.nodeId, binding.policyDigest,
          resource.rows[0]?.verification_digest, resource.rows[0]?.supplier_id],
      ) : null;
      const bindingReady = Boolean(readyBinding?.rows[0]);
      if (existingRecord) {
        if (!bindingReady) {
          return { status: 'cleanup_required' as const, record: existingRecord, quantity: row.quantity,
            capacityUnit: row.capacity_unit, ...(binding ? { binding } : {}) };
        }
        return { status: 'existing' as const, record: existingRecord, quantity: row.quantity,
          capacityUnit: row.capacity_unit, binding: binding! };
      }
      const allocatedAcceleratorCount = input.allocatedAcceleratorCount ?? 1;
      const reviewedGpuCount = resource.rows[0]?.specifications.gpuCount;
      const resourceSlotLimit = Number.isInteger(reviewedGpuCount) && Number(reviewedGpuCount) >= 1
        && Number(reviewedGpuCount) <= 64
        ? Number(reviewedGpuCount)
        : input.nodeAcceleratorCountFallback;
      const quantityMicros = quantityToMicros(row.quantity);
      const durationMs = Number((quantityMicros * 3_600_000n)
        / (BigInt(allocatedAcceleratorCount) * 1_000_000n));
      const hardExpiresAt = new Date(input.now.getTime() + Math.max(1_000, durationMs));
      const provisioningDeadlineAt = new Date(Math.min(input.now.getTime() + 5 * 60_000,
        hardExpiresAt.getTime() - 60_000));
      if (allocatedAcceleratorCount !== 1 || !resourceSlotLimit || resourceSlotLimit < 1 || resourceSlotLimit > 64
        || quantityMicros < 83_334n || provisioningDeadlineAt < input.now) return { status: 'invalid_state' as const };
      const active = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM compute_fulfillments
        WHERE resource_id=$1 AND status IN ('provisioning','ready','running','stopping')`, [resourceId]);
      const id = randomUUID();
      const inserted = await client.query<FulfillmentRow>(`INSERT INTO compute_fulfillments(id, order_id,
          buyer_subject_id, supplier_subject_id, resource_id, provider_key, status, provisioning_at,
          hard_expires_at,allocated_accelerator_count,resource_slot_limit,provisioning_deadline_at)
        VALUES ($1,$2,$3,$4,$5,$6,'provisioning',$7,$8,$9,$10,$11) RETURNING ${columns}`,
      [id, row.id, row.buyer_subject_id, row.supplier_subject_id, resourceId, input.providerKey, input.now,
        hardExpiresAt, allocatedAcceleratorCount, resourceSlotLimit, provisioningDeadlineAt]);
      await client.query(`UPDATE kai_credit_orders SET status = 'provisioning', delivery_started_at = COALESCE(delivery_started_at, $2)
        WHERE id = $1`, [row.id, input.now]);
      await this.event(client, id, input.userId, input.userId ? 'provider' : 'system', 'FULFILLMENT_PROVISIONING', null,
        'provisioning', { providerKey: input.providerKey });
      const record = map(inserted.rows[0]!);
      if (!bindingReady) {
        const failed = await this.releaseProvisionFailure(client, record, 'COMPUTE_NODE_NOT_READY', false, input.now);
        return { status: 'binding_unavailable' as const, record: failed, quantity: row.quantity,
          capacityUnit: row.capacity_unit, ...(binding ? { binding } : {}) };
      }
      if (BigInt(active.rows[0]?.count ?? '0') >= BigInt(resourceSlotLimit)) {
        const failed = await this.releaseProvisionFailure(client, record, 'COMPUTE_RESOURCE_SLOTS_EXHAUSTED', false, input.now);
        return { status: 'capacity_exhausted' as const, record: failed, quantity: row.quantity, capacityUnit: row.capacity_unit };
      }
      return { status: 'started' as const, record, quantity: row.quantity, capacityUnit: row.capacity_unit, binding: binding! };
    });
  }

  async recordProvisionalLease(input: Readonly<{ fulfillmentId: string; providerLeaseId: string; now: Date }>) {
    return this.database.transaction(async (client) => {
      const current = await this.lock(client, input.fulfillmentId);
      if (current.status !== 'provisioning') return current;
      if (current.provisionalProviderLeaseId && current.provisionalProviderLeaseId !== input.providerLeaseId) {
        throw new Error('PROVIDER_LEASE_ID_CONFLICT');
      }
      const result = await client.query<FulfillmentRow>(`UPDATE compute_fulfillments
        SET provisional_provider_lease_id = COALESCE(provisional_provider_lease_id, $2), updated_at = $3
        WHERE id = $1 RETURNING ${columns}`, [current.id, input.providerLeaseId, input.now]);
      return map(result.rows[0]!);
    });
  }

  async markReady(input: Readonly<{ fulfillmentId: string; providerLeaseId: string; connection: SafeConnectionDescriptor;
    attestation: FulfillmentAttestation; hardExpiresAt: Date; now: Date }>) {
    return this.database.transaction(async (client) => {
      const current = await this.lock(client, input.fulfillmentId);
      if (current.status === 'ready' || current.status === 'running') return current;
      if (current.status !== 'provisioning') throw new Error('FULFILLMENT_NOT_PROVISIONING');
      const binding = await client.query(
        `SELECT b.id FROM compute_resource_bindings b
         JOIN compute_nodes n ON n.id = b.node_id
         JOIN compute_resources r ON r.id = b.resource_id
         JOIN compute_resource_delivery_readiness dr ON dr.resource_id=r.id
         JOIN kai_credit_orders o ON o.id = $1
         WHERE b.id = $2 AND b.resource_id = $3 AND b.generation = $4 AND b.node_id = $5
           AND b.policy_digest = $6 AND dr.status='ready' AND b.status='ready' AND n.status='ready'
           AND r.status = 'verified'
           AND b.resource_verification_digest = r.verification_digest
           AND n.supplier_id = r.supplier_id
           AND o.listing_snapshot->>'bindingId' = $2::text
           AND (o.listing_snapshot->>'bindingGeneration')::integer = $4
           AND o.listing_snapshot->>'bindingPolicyDigest' = $6
           AND o.listing_snapshot->>'bindingNodeId' = $5::text
         FOR UPDATE OF b, n, r`,
        [current.orderId, input.attestation.bindingId, current.resourceId, input.attestation.bindingGeneration,
          input.attestation.nodeId, input.attestation.policyDigest],
      );
      if (!binding.rows[0]) throw new Error('COMPUTE_BINDING_CHANGED_BEFORE_READY');
      const result = await client.query<FulfillmentRow>(`UPDATE compute_fulfillments SET status = 'ready',
          provider_lease_id = $2, connection = $3::jsonb, attestation_digest = $4, ready_at = $5,
          hard_expires_at = $6, version = version + 1
        WHERE id = $1 RETURNING ${columns}`,
      [current.id, input.providerLeaseId, JSON.stringify(input.connection), input.attestation.evidenceDigest, input.now,
        input.hardExpiresAt]);
      await client.query(`UPDATE kai_credit_orders SET status = 'ready', delivery_ready_at = $2 WHERE id = $1`,
        [current.orderId, input.now]);
      await this.event(client, current.id, null, 'system', 'FULFILLMENT_READY', 'provisioning', 'ready', {
        providerLeaseId: input.providerLeaseId, attestationDigest: input.attestation.evidenceDigest,
        observedAt: input.attestation.observedAt, heartbeatId: input.attestation.heartbeatId,
        acceleratorModel: input.attestation.acceleratorModel,
        nodeAcceleratorCount: input.attestation.nodeAcceleratorCount,
        allocatedAcceleratorCount: input.attestation.allocatedAcceleratorCount,
        driverVersion: input.attestation.driverVersion,
      });
      return map(result.rows[0]!);
    });
  }

  async markFailed(input: Readonly<{ fulfillmentId: string; code: string; retryable: boolean; now: Date }>) {
    return this.database.transaction(async (client) => {
      const current = await this.lock(client, input.fulfillmentId);
      if (current.status === 'failed') return current;
      if (!['provisioning', 'ready'].includes(current.status)) throw new Error('FULFILLMENT_FAILURE_STATE_INVALID');
      if (current.status === 'ready') {
        const access = await client.query<{ exists: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM compute_access_sessions WHERE fulfillment_id=$1
        ) AS exists`, [current.id]);
        if (access.rows[0]?.exists) throw new Error('FULFILLMENT_FAILURE_AFTER_ACCESS_INVALID');
      }
      return this.releaseProvisionFailure(client, current, input.code, input.retryable, input.now);
    });
  }

  private async releaseProvisionFailure(client: PoolClient, current: FulfillmentRecord, code: string,
    retryable: boolean, now: Date) {
      const reservation = await client.query<{
        id: string; listing_id: string; quantity: string; credit_micros: string; status: string;
      }>(`SELECT id, listing_id, quantity::text, credit_micros::text, status FROM kai_credit_order_reservations
        WHERE order_id = $1 FOR UPDATE`, [current.orderId]);
      const held = reservation.rows[0];
      if (!held || held.status !== 'secured') throw new Error('FULFILLMENT_SECURED_RESERVATION_REQUIRED');
      const accounts = await this.buyerAccounts(client, current.buyerSubjectId);
      const transactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
          payload_digest, reference_type, reference_id, description, status)
        VALUES ($1, $2, 'COMPUTE_PROVISION_FAILURE_RELEASE', $3, $4, 'order_release', $5, '算力开通失败退回卡时', 'pending')`,
      [transactionId, `subject:${current.buyerSubjectId}`, `compute-failure:${current.id}`,
        `compute-failure:${current.id}:${code}`, current.orderId]);
      await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
        ($1, $2, $3, $4, '算力开通失败退回'), ($5, $2, $6, $7, '算力开通失败解冻')`,
      [randomUUID(), transactionId, accounts.available, held.credit_micros, randomUUID(), accounts.reserved,
        (-BigInt(held.credit_micros)).toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`, [transactionId, now]);
      await client.query(`UPDATE kai_credit_order_reservations SET status = 'released', resolved_at = $2,
        resolution_transaction_id = $3, resolution_reason = 'compute_provision_failed' WHERE id = $1`,
      [held.id, now, transactionId]);
      await client.query(`UPDATE credit_market_listings SET capacity_reserved = capacity_reserved - $2,
        status = CASE WHEN status = 'sold_out' THEN 'active' ELSE status END WHERE id = $1`, [held.listing_id, held.quantity]);
      await client.query(`UPDATE kai_credit_orders SET status = 'refunded', closed_at = $2 WHERE id = $1`, [current.orderId, now]);
      const result = await client.query<FulfillmentRow>(`UPDATE compute_fulfillments SET status = 'failed',
          provider_lease_id = NULL, connection = NULL, attestation_digest = NULL,
          failure_code = $2, failure_retryable = $3, failed_at = $4, version = version + 1
        WHERE id = $1 RETURNING ${columns}`, [current.id, code, retryable, now]);
      await this.event(client, current.id, null, 'system', 'FULFILLMENT_FAILED', current.status, 'failed', {
        code, retryable, releasedCreditMicros: held.credit_micros,
      });
      return map(result.rows[0]!);
  }

  async beginAccess(input: Readonly<{ buyerSubjectId: string; orderId: string; now: Date }>) {
    return this.database.transaction(async (client) => {
      const result = await client.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments
        WHERE order_id = $1 AND buyer_subject_id = $2 FOR UPDATE`, [input.orderId, input.buyerSubjectId]);
      const row = result.rows[0];
      if (!row || !['ready', 'running'].includes(row.status)) return null;
      return map(row);
    });
  }

  async recordAccess(input: Readonly<{ fulfillmentId: string; sessionId: string; ticketDigest: string; expiresAt: Date; now: Date }>) {
    return this.database.transaction(async (client) => {
      const current = await this.lock(client, input.fulfillmentId);
      if (!['ready', 'running'].includes(current.status)) return null;
      const existing = await client.query<{ ticket_digest: string }>(`SELECT ticket_digest FROM compute_access_sessions
        WHERE id = $1 FOR UPDATE`, [input.sessionId]);
      if (existing.rows[0] && existing.rows[0].ticket_digest !== input.ticketDigest) {
        throw new Error('ACCESS_SESSION_IDEMPOTENCY_VIOLATION');
      }
      const inserted = await client.query(`INSERT INTO compute_access_sessions(id, fulfillment_id, buyer_subject_id, ticket_digest, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [input.sessionId, current.id, current.buyerSubjectId, input.ticketDigest, input.expiresAt, input.now]);
      let saved = current;
      if (current.status === 'ready') {
        const updated = await client.query<FulfillmentRow>(`UPDATE compute_fulfillments SET status='running',
          running_at=$2,version=version+1 WHERE id=$1 RETURNING ${columns}`, [current.id, input.now]);
        await client.query(`UPDATE kai_credit_orders SET status='in_service' WHERE id=$1`, [current.orderId]);
        await this.event(client, current.id, null, 'system', 'FULFILLMENT_RUNNING', 'ready', 'running', {
          firstAccessSessionId: input.sessionId,
        });
        saved = map(updated.rows[0]!);
      }
      if (inserted.rowCount) {
        await this.event(client, current.id, null, 'system', 'ACCESS_SESSION_ISSUED', 'running', 'running', {
          sessionId: input.sessionId, expiresAt: input.expiresAt.toISOString(), ticketDigest: input.ticketDigest,
        });
      }
      return saved;
    });
  }

  async beginStop(input: Readonly<{ buyerSubjectId: string; orderId: string; now: Date }>) {
    return this.database.transaction(async (client) => {
      const result = await client.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments
        WHERE order_id = $1 AND buyer_subject_id = $2 FOR UPDATE`, [input.orderId, input.buyerSubjectId]);
      const row = result.rows[0];
      if (!row) return null;
      if (row.status === 'stopping' || row.status === 'stopped') return map(row);
      if (!['ready', 'running'].includes(row.status)) return null;
      const updated = await client.query<FulfillmentRow>(`UPDATE compute_fulfillments SET status = 'stopping',
        stopping_at = $2, version = version + 1 WHERE id = $1 RETURNING ${columns}`, [row.id, input.now]);
      await client.query(`UPDATE kai_credit_orders SET status = 'release_pending' WHERE id = $1`, [row.order_id]);
      await this.event(client, row.id, null, 'system', 'FULFILLMENT_STOPPING', row.status, 'stopping', {});
      return map(updated.rows[0]!);
    });
  }

  async completeStop(input: Readonly<{ fulfillmentId: string; consumedCapacityMicros: bigint; evidenceDigest: string;
    stoppedAt: Date; now: Date }>) {
    return this.database.transaction(async (client) => {
      const current = await this.lock(client, input.fulfillmentId);
      if (current.status === 'stopped') return current;
      if (current.status !== 'stopping') throw new Error('FULFILLMENT_NOT_STOPPING');
      const purchased = await client.query<{ quantity_micros: string }>(`SELECT (quantity * 1000000)::bigint::text AS quantity_micros
        FROM kai_credit_orders WHERE id = $1 FOR UPDATE`, [current.orderId]);
      if (input.consumedCapacityMicros > BigInt(purchased.rows[0]?.quantity_micros ?? '-1')) {
        throw new Error('FULFILLMENT_METER_EXCEEDS_PURCHASE');
      }
      const result = await client.query<FulfillmentRow>(`UPDATE compute_fulfillments SET status = 'stopped',
        stopped_at = $2, version = version + 1 WHERE id = $1 RETURNING ${columns}`, [current.id, input.stoppedAt]);
      await client.query(`INSERT INTO compute_fulfillment_metering(id, fulfillment_id, consumed_capacity_micros,
        evidence_digest, stopped_at) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), current.id, input.consumedCapacityMicros.toString(), input.evidenceDigest, input.stoppedAt]);
      await client.query(`UPDATE kai_credit_orders SET status = 'acceptance_pending' WHERE id = $1`, [current.orderId]);
      await this.event(client, current.id, null, 'system', 'FULFILLMENT_STOPPED', 'stopping', 'stopped', {
        consumedCapacityMicros: input.consumedCapacityMicros.toString(), meteringEvidenceDigest: input.evidenceDigest,
      });
      return map(result.rows[0]!);
    });
  }

  async accept(input: Readonly<{ buyerSubjectId: string; userId: string | null; actor: 'buyer' | 'system';
    orderId: string; now: Date }>) {
    return this.database.transaction(async (client) => {
      const result = await client.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments
        WHERE order_id = $1 AND buyer_subject_id = $2 FOR UPDATE`, [input.orderId, input.buyerSubjectId]);
      const row = result.rows[0];
      if (!row) return null;
      const prior = await client.query<{ captured_credit_micros: string; refunded_credit_micros: string;
        accepted_actor: 'buyer' | 'system' | 'operator' }>(
        `SELECT captured_credit_micros::text, refunded_credit_micros::text,accepted_actor FROM compute_fulfillment_acceptances
         WHERE fulfillment_id = $1`, [row.id],
      );
      if (prior.rows[0]) return { record: map(row), capturedCreditMicros: BigInt(prior.rows[0].captured_credit_micros),
        refundedCreditMicros: BigInt(prior.rows[0].refunded_credit_micros), acceptedActor: prior.rows[0].accepted_actor };
      if (row.status !== 'stopped') return null;
      const order = await client.query<{ status: string; quantity_micros: string; unit_credit_micros: string; total_credit_micros: string }>(
        `SELECT status, (quantity * 1000000)::bigint::text AS quantity_micros, unit_credit_micros::text,
          total_credit_micros::text FROM kai_credit_orders WHERE id = $1 FOR UPDATE`, [row.order_id],
      );
      const metering = await client.query<{ id: string; consumed_capacity_micros: string }>(
        `SELECT id, consumed_capacity_micros::text FROM compute_fulfillment_metering WHERE fulfillment_id = $1 FOR UPDATE`, [row.id],
      );
      const reservation = await client.query<{ id: string; status: string; listing_id: string; quantity: string }>(
        `SELECT id, status, listing_id, quantity::text FROM kai_credit_order_reservations WHERE order_id = $1 FOR UPDATE`, [row.order_id],
      );
      if (order.rows[0]?.status !== 'acceptance_pending' || reservation.rows[0]?.status !== 'secured' || !metering.rows[0]) return null;
      const consumed = BigInt(metering.rows[0].consumed_capacity_micros);
      const purchased = BigInt(order.rows[0].quantity_micros);
      if (consumed > purchased) throw new Error('FULFILLMENT_METER_EXCEEDS_PURCHASE');
      const total = BigInt(order.rows[0].total_credit_micros);
      const captured = (consumed * BigInt(order.rows[0].unit_credit_micros) + 999_999n) / 1_000_000n;
      const refund = total - captured;
      const buyer = await this.buyerAccounts(client, row.buyer_subject_id);
      await client.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
        VALUES ($1, 'subject', $2, $3, 'supplier_receivable', false)
        ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
      [randomUUID(), row.supplier_subject_id, `subject:${row.supplier_subject_id}:supplier_receivable`]);
      const supplier = await client.query<{ id: string }>(`SELECT id FROM kai_credit_accounts
        WHERE subject_id = $1 AND account_kind = 'supplier_receivable' FOR UPDATE`, [row.supplier_subject_id]);
      const transactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
          payload_digest, reference_type, reference_id, description, status)
        VALUES ($1, $2, 'COMPUTE_METERED_CAPTURE', $3, $4, 'order_capture', $5, '算力实耗结算', 'pending')`,
      [transactionId, `subject:${row.buyer_subject_id}`, `compute-accept:${row.id}`,
        `compute-accept:${row.id}:${consumed}`, row.order_id]);
      await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo)
        VALUES ($1, $2, $3, $4, '算力订单冻结卡时结算')`,
      [randomUUID(), transactionId, buyer.reserved, (-total).toString()]);
      if (captured > 0n) await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo)
        VALUES ($1, $2, $3, $4, '提供方实耗待结算')`,
      [randomUUID(), transactionId, supplier.rows[0]!.id, captured.toString()]);
      if (refund > 0n) await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo)
        VALUES ($1, $2, $3, $4, '未使用卡时退回')`,
      [randomUUID(), transactionId, buyer.available, refund.toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`, [transactionId, input.now]);
      await client.query(`UPDATE kai_credit_order_reservations SET status = 'captured', resolved_at = $2,
        resolution_transaction_id = $3, resolution_reason = 'compute_metered_buyer_acceptance' WHERE id = $1`,
      [reservation.rows[0].id, input.now, transactionId]);
      await client.query(`UPDATE credit_market_listings SET capacity_reserved = capacity_reserved - $2,
        capacity_sold = capacity_sold + ($3::bigint::numeric / 1000000) WHERE id = $1`,
      [reservation.rows[0].listing_id, reservation.rows[0].quantity, consumed.toString()]);
      const acceptanceId = randomUUID();
      await client.query(`INSERT INTO compute_fulfillment_acceptances(id, fulfillment_id, order_id, buyer_subject_id,
        accepted_by_user_id, metering_id, consumed_capacity_micros, captured_credit_micros, refunded_credit_micros,
        resolution_transaction_id, accepted_at, accepted_actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [acceptanceId, row.id, row.order_id, row.buyer_subject_id, input.userId, metering.rows[0].id,
        consumed.toString(), captured.toString(), refund.toString(), transactionId, input.now, input.actor]);
      await client.query(`UPDATE kai_credit_orders SET status = 'accepted', accepted_at = $2,
        accepted_by_user_id = $3, accepted_actor=$4, closed_at = NULL WHERE id = $1`,
      [row.order_id, input.now, input.userId, input.actor]);
      await this.event(client, row.id, input.userId, input.actor === 'system' ? 'system' : 'user',
        input.actor === 'system' ? 'FULFILLMENT_AUTO_ACCEPTED' : 'FULFILLMENT_ACCEPTED', 'stopped', 'stopped', {
        consumedCapacityMicros: consumed.toString(), capturedCreditMicros: captured.toString(),
        refundedCreditMicros: refund.toString(), resolutionTransactionId: transactionId, acceptedActor: input.actor,
      });
      return { record: map(row), capturedCreditMicros: captured, refundedCreditMicros: refund, acceptedActor: input.actor };
    });
  }

  async autoAcceptDue(now: Date, limit: number) {
    const due = await this.database.query<{ order_id: string; buyer_subject_id: string }>(`SELECT f.order_id,f.buyer_subject_id
      FROM compute_fulfillments f JOIN kai_credit_orders o ON o.id=f.order_id
      WHERE f.status='stopped' AND f.stopped_at + interval '24 hours' <= $1 AND o.status='acceptance_pending'
        AND NOT EXISTS (SELECT 1 FROM compute_fulfillment_acceptances a WHERE a.fulfillment_id=f.id)
        AND NOT EXISTS (SELECT 1 FROM compute_fulfillment_issues i WHERE i.fulfillment_id=f.id AND i.status='open')
      ORDER BY f.stopped_at,f.id LIMIT $2`, [now, limit]);
    let accepted = 0;
    for (const row of due.rows) {
      if (await this.accept({ buyerSubjectId: row.buyer_subject_id, userId: null, actor: 'system',
        orderId: row.order_id, now })) accepted += 1;
    }
    return accepted;
  }

  async claimExpired(now: Date, limit: number) {
    return this.database.transaction(async (client) => {
      const result = await client.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments
        WHERE status IN ('ready', 'running', 'stopping') AND hard_expires_at <= $1 ORDER BY hard_expires_at, id
        FOR UPDATE SKIP LOCKED LIMIT $2`, [now, limit]);
      const records: FulfillmentRecord[] = [];
      for (const row of result.rows) {
        if (row.status === 'stopping') { records.push(map(row)); continue; }
        const updated = await client.query<FulfillmentRow>(`UPDATE compute_fulfillments SET status = 'stopping',
          stopping_at = $2, version = version + 1 WHERE id = $1 RETURNING ${columns}`, [row.id, now]);
        await client.query(`UPDATE kai_credit_orders SET status = 'release_pending' WHERE id = $1`, [row.order_id]);
        await this.event(client, row.id, null, 'system', 'FULFILLMENT_HARD_EXPIRY', row.status, 'stopping', {});
        records.push(map(updated.rows[0]!));
      }
      return records;
    });
  }

  async settleDue(now: Date, limit: number) {
    return this.database.transaction(async (client) => {
      const due = await client.query<{
        id: string; fulfillment_id: string; order_id: string; supplier_subject_id: string;
        captured_credit_micros: string; accepted_at: Date;
      }>(`SELECT a.id, a.fulfillment_id, a.order_id, f.supplier_subject_id,
          a.captured_credit_micros::text, a.accepted_at
        FROM compute_fulfillment_acceptances a JOIN compute_fulfillments f ON f.id = a.fulfillment_id
        WHERE a.accepted_at + interval '7 days' <= $1
          AND NOT EXISTS (SELECT 1 FROM compute_fulfillment_supplier_settlements s WHERE s.acceptance_id = a.id)
        ORDER BY a.accepted_at, a.id FOR UPDATE OF a SKIP LOCKED LIMIT $2`, [now, limit]);
      for (const row of due.rows) {
        const credit = BigInt(row.captured_credit_micros);
        let transactionId: string | null = null;
        if (credit > 0n) {
          await client.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
            VALUES ($1, 'subject', $2, $3, 'supplier_earnings_available', false)
            ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
          [randomUUID(), row.supplier_subject_id, `subject:${row.supplier_subject_id}:supplier_earnings_available`]);
          const accounts = await client.query<{ id: string; account_kind: string }>(`SELECT id, account_kind
            FROM kai_credit_accounts WHERE subject_id = $1
            AND account_kind IN ('supplier_earnings_available','supplier_receivable')
            ORDER BY id FOR UPDATE`, [row.supplier_subject_id]);
          const supplierEarnings = accounts.rows.find((account) => account.account_kind === 'supplier_earnings_available')?.id;
          const receivable = accounts.rows.find((account) => account.account_kind === 'supplier_receivable')?.id;
          if (!supplierEarnings || !receivable) throw new Error('FULFILLMENT_SETTLEMENT_ACCOUNTS_MISSING');
          transactionId = randomUUID();
          await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
            payload_digest, reference_type, reference_id, description, status)
            VALUES ($1,$2,'COMPUTE_SUPPLIER_SETTLEMENT',$3,$4,'settlement',$5,'算力实耗结算到账','pending')`,
          [transactionId, `subject:${row.supplier_subject_id}`, `compute-settle:${row.fulfillment_id}`,
            `compute-settle:${row.fulfillment_id}:${credit}`, row.order_id]);
          await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
            ($1,$2,$3,$4,'算力结算到账'),($5,$2,$6,$7,'算力待结算转出')`,
          [randomUUID(), transactionId, supplierEarnings, credit.toString(), randomUUID(), receivable, (-credit).toString()]);
          await client.query(`UPDATE kai_credit_transactions SET status='posted', posted_at=$2 WHERE id=$1`, [transactionId, now]);
        }
        await client.query(`INSERT INTO compute_fulfillment_supplier_settlements(id,fulfillment_id,acceptance_id,
          order_id,supplier_subject_id,credit_micros,settlement_transaction_id,available_at,settled_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), row.fulfillment_id, row.id, row.order_id, row.supplier_subject_id, credit.toString(),
          transactionId, new Date(row.accepted_at.getTime() + 7 * 86_400_000), now]);
        await client.query(`UPDATE kai_credit_orders SET status='closed',closed_at=$2
          WHERE id=$1 AND status='accepted'`, [row.order_id, now]);
      }
      return due.rows.length;
    });
  }

  async reportIssue(input: Readonly<{ buyerSubjectId: string; userId: string; orderId: string;
    kind: 'access' | 'metering'; descriptionCiphertext: string; descriptionDigest: string; now: Date }>) {
    return this.database.transaction(async (client) => {
      const fulfillment = await client.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments
        WHERE order_id=$1 AND buyer_subject_id=$2 FOR UPDATE`, [input.orderId, input.buyerSubjectId]);
      const row = fulfillment.rows[0];
      if (!row || row.status !== 'stopped' || !row.stopped_at
        || input.now.getTime() > new Date(row.stopped_at).getTime() + 24 * 3_600_000) return null;
      const order = await client.query<{ status: string }>(`SELECT status FROM kai_credit_orders WHERE id=$1 FOR UPDATE`, [input.orderId]);
      if (order.rows[0]?.status === 'disputed') {
        const existing = await client.query<{ id: string; status: 'open'; opened_at: Date }>(
          `SELECT id,status,opened_at FROM compute_fulfillment_issues WHERE order_id=$1`, [input.orderId],
        );
        return existing.rows[0] ? { id: existing.rows[0].id, status: existing.rows[0].status,
          openedAt: new Date(existing.rows[0].opened_at) } : null;
      }
      if (order.rows[0]?.status !== 'acceptance_pending') return null;
      const id = randomUUID();
      await client.query(`INSERT INTO compute_fulfillment_issues(id,fulfillment_id,order_id,buyer_subject_id,
        opened_by_user_id,kind,description_ciphertext,description_digest,opened_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, row.id, row.order_id, row.buyer_subject_id, input.userId, input.kind,
        input.descriptionCiphertext, input.descriptionDigest, input.now]);
      await client.query(`UPDATE kai_credit_orders SET status='disputed' WHERE id=$1`, [row.order_id]);
      await this.event(client, row.id, input.userId, 'user', 'FULFILLMENT_ISSUE_OPENED', 'stopped', 'stopped', {
        issueId: id, kind: input.kind, descriptionDigest: input.descriptionDigest,
      });
      return { id, status: 'open' as const, openedAt: input.now };
    });
  }

  async listProvisioning(limit: number) {
    const result = await this.database.query<{ order_id: string }>(`SELECT o.id AS order_id
      FROM kai_credit_orders o JOIN kai_credit_order_reservations r ON r.order_id=o.id
      LEFT JOIN compute_fulfillments f ON f.order_id=o.id
      WHERE r.status='secured' AND ((o.status='confirmed' AND f.id IS NULL) OR f.status='provisioning')
      ORDER BY COALESCE(f.updated_at,o.updated_at),o.id LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ orderId: row.order_id }));
  }

  async listExpiredProvisioning(now: Date, limit: number) {
    const result = await this.database.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments
      WHERE status='provisioning' AND provisioning_deadline_at <= $1
      ORDER BY provisioning_deadline_at,id LIMIT $2`, [now, limit]);
    return result.rows.map(map);
  }

  async listStopping(limit: number) {
    const result = await this.database.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments
      WHERE status='stopping' ORDER BY updated_at,id LIMIT $1`, [limit]);
    return result.rows.map(map);
  }

  async listActive(limit: number) {
    const result = await this.database.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments
      WHERE status IN ('ready','running') ORDER BY updated_at,id LIMIT $1`, [limit]);
    return result.rows.map(map);
  }

  async issueForSubject(subjectId: string, orderId: string) {
    const result = await this.database.query<IssueRow>(`SELECT ${issueColumns}
      FROM compute_fulfillment_issues i JOIN compute_fulfillments f ON f.id=i.fulfillment_id
      LEFT JOIN compute_fulfillment_issue_decisions d ON d.issue_id=i.id
      JOIN kai_credit_orders o ON o.id=i.order_id JOIN compute_fulfillment_metering m ON m.fulfillment_id=i.fulfillment_id
      WHERE i.order_id=$1 AND (f.buyer_subject_id=$2 OR f.supplier_subject_id=$2)`, [orderId, subjectId]);
    return result.rows[0] ? mapIssue(result.rows[0]) : null;
  }

  async listOpenIssues(limit: number) {
    const result = await this.database.query<IssueRow>(`SELECT ${issueColumns}
      FROM compute_fulfillment_issues i LEFT JOIN compute_fulfillment_issue_decisions d ON d.issue_id=i.id
      JOIN kai_credit_orders o ON o.id=i.order_id JOIN compute_fulfillment_metering m ON m.fulfillment_id=i.fulfillment_id
      WHERE i.status='open' ORDER BY i.opened_at,i.id LIMIT $1`, [limit]);
    return result.rows.map(mapIssue);
  }

  async decideIssue(input: Readonly<{ operatorId: string; orderId: string; clientRequestId: string;
    payloadDigest: string; outcome: 'full_refund' | 'partial_refund' | 'reject_refund';
    remedyRefundCreditMicros: bigint | null; reasonCiphertext: string; reasonDigest: string; now: Date }>) {
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`compute-issue-decision:${input.operatorId}:${input.clientRequestId}`]);
      const replay = await client.query<IssueRow & { payload_digest: string }>(`SELECT ${issueColumns},r.payload_digest
        FROM compute_fulfillment_issue_decision_requests r
        JOIN compute_fulfillment_issue_decisions d ON d.id=r.decision_id
        JOIN compute_fulfillment_issues i ON i.id=d.issue_id
        JOIN kai_credit_orders o ON o.id=i.order_id JOIN compute_fulfillment_metering m ON m.fulfillment_id=i.fulfillment_id
        WHERE r.operator_id=$1 AND r.client_request_id=$2`, [input.operatorId, input.clientRequestId]);
      if (replay.rows[0]) return replay.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed' as const, issue: mapIssue(replay.rows[0]) }
        : { status: 'conflict' as const };
      const issueResult = await client.query<IssueRow>(`SELECT ${issueColumns}
        FROM compute_fulfillment_issues i LEFT JOIN compute_fulfillment_issue_decisions d ON d.issue_id=i.id
        JOIN kai_credit_orders o ON o.id=i.order_id JOIN compute_fulfillment_metering m ON m.fulfillment_id=i.fulfillment_id
        WHERE i.order_id=$1 FOR UPDATE OF i`, [input.orderId]);
      const issue = issueResult.rows[0];
      if (!issue) return { status: 'not_found' as const };
      const fulfillment = await client.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments
        WHERE id=$1 FOR UPDATE`, [issue.fulfillment_id]);
      const order = await client.query<{ status: string; quantity_micros: string; unit_credit_micros: string;
        total_credit_micros: string; supplier_subject_id: string }>(`SELECT status,
        (quantity*1000000)::bigint::text AS quantity_micros,unit_credit_micros::text,total_credit_micros::text,
        supplier_subject_id FROM kai_credit_orders WHERE id=$1 FOR UPDATE`, [input.orderId]);
      const meter = await client.query<{ id: string; consumed_capacity_micros: string }>(`SELECT id,
        consumed_capacity_micros::text FROM compute_fulfillment_metering WHERE fulfillment_id=$1 FOR UPDATE`, [issue.fulfillment_id]);
      const held = await client.query<{ id: string; status: string; listing_id: string; quantity: string }>(`SELECT id,
        status,listing_id,quantity::text FROM kai_credit_order_reservations WHERE order_id=$1 FOR UPDATE`, [input.orderId]);
      if (issue.status !== 'open' || fulfillment.rows[0]?.status !== 'stopped' || order.rows[0]?.status !== 'disputed'
        || held.rows[0]?.status !== 'secured' || !meter.rows[0]) return { status: 'invalid_state' as const };
      const meteredCredit = (BigInt(meter.rows[0].consumed_capacity_micros) * BigInt(order.rows[0].unit_credit_micros)
        + 999_999n) / 1_000_000n;
      const remedy = input.outcome === 'full_refund' ? meteredCredit
        : input.outcome === 'reject_refund' ? 0n : input.remedyRefundCreditMicros;
      if (remedy === null || remedy < 0n || remedy > meteredCredit
        || (input.outcome === 'partial_refund' && (remedy === 0n || remedy === meteredCredit))) {
        return { status: 'refund_exceeds_metered' as const };
      }
      const providerCredit = meteredCredit - remedy;
      const total = BigInt(order.rows[0].total_credit_micros);
      const buyerRefund = total - providerCredit;
      const buyer = await this.buyerAccounts(client, issue.buyer_subject_id);
      await client.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
        VALUES ($1,'subject',$2,$3,'supplier_receivable',false)
        ON CONFLICT (subject_id,account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
      [randomUUID(), order.rows[0].supplier_subject_id, `subject:${order.rows[0].supplier_subject_id}:supplier_receivable`]);
      const supplier = await client.query<{ id: string }>(`SELECT id FROM kai_credit_accounts
        WHERE subject_id=$1 AND account_kind='supplier_receivable' FOR UPDATE`, [order.rows[0].supplier_subject_id]);
      const transactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
        reference_type,reference_id,description,status) VALUES
        ($1,$2,'COMPUTE_ISSUE_DECISION',$3,$4,$5,$6,'算力异议裁定结算','pending')`,
      [transactionId, `subject:${issue.buyer_subject_id}`, `compute-issue:${issue.id}`, input.payloadDigest,
        providerCredit === 0n ? 'refund' : 'order_capture', input.orderId]);
      await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
        VALUES ($1,$2,$3,$4,'算力异议冻结卡时结算')`, [randomUUID(), transactionId, buyer.reserved, (-total).toString()]);
      if (providerCredit > 0n) await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
        VALUES ($1,$2,$3,$4,'裁定后提供方待结算')`,
      [randomUUID(), transactionId, supplier.rows[0]!.id, providerCredit.toString()]);
      if (buyerRefund > 0n) await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
        VALUES ($1,$2,$3,$4,'裁定退款及未使用卡时退回')`,
      [randomUUID(), transactionId, buyer.available, buyerRefund.toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`, [transactionId, input.now]);
      await client.query(`UPDATE kai_credit_order_reservations SET status=$2,resolved_at=$3,
        resolution_transaction_id=$4,resolution_reason='compute_issue_adjudicated' WHERE id=$1`,
      [held.rows[0].id, providerCredit === 0n ? 'released' : 'captured', input.now, transactionId]);
      await client.query(`UPDATE credit_market_listings SET capacity_reserved=capacity_reserved-$2,
        capacity_sold=capacity_sold+($3::bigint::numeric/1000000) WHERE id=$1`,
      [held.rows[0].listing_id, held.rows[0].quantity, meter.rows[0].consumed_capacity_micros]);
      if (providerCredit > 0n) await client.query(`INSERT INTO compute_fulfillment_acceptances(id,fulfillment_id,
        order_id,buyer_subject_id,accepted_by_user_id,metering_id,consumed_capacity_micros,captured_credit_micros,
        refunded_credit_micros,resolution_transaction_id,accepted_at,accepted_actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'operator')`,
      [randomUUID(), issue.fulfillment_id, issue.order_id, issue.buyer_subject_id, input.operatorId, meter.rows[0].id,
        meter.rows[0].consumed_capacity_micros, providerCredit.toString(), buyerRefund.toString(), transactionId, input.now]);
      await client.query(`UPDATE kai_credit_orders SET status=$2,accepted_at=$3,accepted_by_user_id=$4,
        accepted_actor=$5,closed_at=$6
        WHERE id=$1`, [input.orderId, providerCredit === 0n ? 'refunded' : 'accepted',
        providerCredit === 0n ? null : input.now, providerCredit === 0n ? null : input.operatorId,
        providerCredit === 0n ? null : 'operator', providerCredit === 0n ? input.now : null]);
      await client.query(`UPDATE compute_fulfillment_issues SET status='resolved',resolved_at=$2 WHERE id=$1`, [issue.id, input.now]);
      const decisionId = randomUUID();
      await client.query(`INSERT INTO compute_fulfillment_issue_decisions(id,issue_id,fulfillment_id,order_id,
        operator_id,outcome,metered_credit_micros,remedy_refund_credit_micros,provider_credit_micros,
        buyer_refund_credit_micros,reason_ciphertext,reason_digest,resolution_transaction_id,decided_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [decisionId, issue.id, issue.fulfillment_id, issue.order_id, input.operatorId, input.outcome,
        meteredCredit.toString(), remedy.toString(), providerCredit.toString(), buyerRefund.toString(),
        input.reasonCiphertext, input.reasonDigest, transactionId, input.now]);
      await client.query(`INSERT INTO compute_fulfillment_issue_decision_requests(operator_id,client_request_id,
        order_id,payload_digest,decision_id) VALUES ($1,$2,$3,$4,$5)`,
      [input.operatorId, input.clientRequestId, input.orderId, input.payloadDigest, decisionId]);
      const resolved = await client.query<IssueRow>(`SELECT ${issueColumns} FROM compute_fulfillment_issues i
        LEFT JOIN compute_fulfillment_issue_decisions d ON d.issue_id=i.id
        JOIN kai_credit_orders o ON o.id=i.order_id JOIN compute_fulfillment_metering m ON m.fulfillment_id=i.fulfillment_id
        WHERE i.id=$1`, [issue.id]);
      return { status: 'decided' as const, issue: mapIssue(resolved.rows[0]!) };
    });
  }

  private async lock(client: PoolClient, id: string) {
    const result = await client.query<FulfillmentRow>(`SELECT ${columns} FROM compute_fulfillments WHERE id = $1 FOR UPDATE`, [id]);
    if (!result.rows[0]) throw new Error('FULFILLMENT_MISSING');
    return map(result.rows[0]);
  }

  private async buyerAccounts(client: PoolClient, subjectId: string) {
    const result = await client.query<{ id: string; account_kind: 'available' | 'reserved' }>(`SELECT id, account_kind
      FROM kai_credit_accounts WHERE subject_id = $1 AND account_kind IN ('available', 'reserved') ORDER BY id FOR UPDATE`, [subjectId]);
    const available = result.rows.find((row) => row.account_kind === 'available')?.id;
    const reserved = result.rows.find((row) => row.account_kind === 'reserved')?.id;
    if (!available || !reserved) throw new Error('FULFILLMENT_BUYER_ACCOUNTS_MISSING');
    return { available, reserved };
  }

  private event(client: PoolClient, id: string, actorId: string | null, actorKind: 'user' | 'provider' | 'system',
    type: string, from: string | null, to: string, payload: Record<string, unknown>) {
    return client.query(`INSERT INTO compute_fulfillment_events(id, fulfillment_id, actor_id, actor_kind,
      event_type, from_status, to_status, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [randomUUID(), id, actorId, actorKind, type, from, to, JSON.stringify(payload)]).then(() => undefined);
  }
}

function quantityToMicros(value: string) {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}
