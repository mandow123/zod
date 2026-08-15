import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { CreditOrderRecord } from './types.js';
import { formatCreditMicros, totalCreditMicros } from './types.js';
import { formatCreditDisplayMicros } from '../credits/display.js';

type OrderRow = QueryResultRow & {
  id: string; order_number: string; buyer_subject_id: string; supplier_subject_id: string; created_by_user_id: string;
  listing_id: string; status: CreditOrderRecord['status']; quantity: string; capacity_unit: string;
  unit_credit_micros: string; total_credit_micros: string; listing_snapshot: Record<string, unknown>;
  reservation_expires_at: Date; confirmed_at: Date | null; confirmed_by_user_id: string | null;
  delivery_started_at: Date | null; delivery_ready_at: Date | null; accepted_at: Date | null; accepted_by_user_id: string | null;
  closed_at: Date | null; created_at: Date; updated_at: Date;
};

const orderColumns = `id, order_number, buyer_subject_id, supplier_subject_id, created_by_user_id, listing_id,
  status, quantity::text, capacity_unit, unit_credit_micros::text, total_credit_micros::text,
  listing_snapshot, reservation_expires_at, confirmed_at, confirmed_by_user_id, delivery_started_at,
  delivery_ready_at, accepted_at, accepted_by_user_id, closed_at, created_at, updated_at`;
const joinedOrderColumns = `o.id, o.order_number, o.buyer_subject_id, o.supplier_subject_id,
  o.created_by_user_id, o.listing_id, o.status, o.quantity::text, o.capacity_unit,
  o.unit_credit_micros::text, o.total_credit_micros::text, o.listing_snapshot,
  o.reservation_expires_at, o.confirmed_at, o.confirmed_by_user_id, o.delivery_started_at,
  o.delivery_ready_at, o.accepted_at, o.accepted_by_user_id, o.closed_at, o.created_at, o.updated_at`;

function mapOrder(row: OrderRow): CreditOrderRecord {
  return {
    id: row.id, orderNumber: row.order_number, buyerSubjectId: row.buyer_subject_id,
    supplierSubjectId: row.supplier_subject_id, createdByUserId: row.created_by_user_id, listingId: row.listing_id,
    status: row.status, quantity: row.quantity, capacityUnit: row.capacity_unit,
    unitCreditMicros: BigInt(row.unit_credit_micros), totalCreditMicros: BigInt(row.total_credit_micros),
    listingSnapshot: row.listing_snapshot, reservationExpiresAt: new Date(row.reservation_expires_at),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null, confirmedByUserId: row.confirmed_by_user_id,
    deliveryStartedAt: row.delivery_started_at ? new Date(row.delivery_started_at) : null,
    deliveryReadyAt: row.delivery_ready_at ? new Date(row.delivery_ready_at) : null,
    acceptedAt: row.accepted_at ? new Date(row.accepted_at) : null, acceptedByUserId: row.accepted_by_user_id,
    closedAt: row.closed_at ? new Date(row.closed_at) : null, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  };
}

export type CreateCreditOrderResult =
  | Readonly<{ status: 'created' | 'replayed'; order: CreditOrderRecord }>
  | Readonly<{ status: 'conflict' | 'commerce_unavailable' | 'listing_unavailable' | 'insufficient_credits' | 'self_purchase' }>;

export type CreditOrderActionResult =
  | Readonly<{ status: 'confirmed' | 'cancelled' | 'provisioning' | 'acceptance_pending' | 'accepted' | 'disputed' | 'refunded' | 'settled' | 'escalated' | 'aftercare_pending' | 'aftercare_escalated' | 'replayed'; order: CreditOrderRecord }>
  | Readonly<{ status: 'not_due'; availableAt: Date }>
  | Readonly<{ status: 'conflict' | 'not_found' | 'expired' | 'invalid_state' }>;

export type CreditOrderListSide = 'all' | 'buyer' | 'provider';
export type CreditOrderListCursor = Readonly<{ createdAt: Date; id: string }>;

export interface CreditOrderStore {
  createReservation(input: Readonly<{
    id: string; orderNumber: string; buyerSubjectId: string; userId: string; listingId: string; quantity: string;
    quantityScaled: bigint; clientRequestId: string; payloadDigest: string; expiresAt: Date; now: Date;
    requestId: string; ipHash: string; computeFulfillmentAvailable: boolean;
    autoConfirmCompute?: boolean; nodeAcceleratorCountFallback?: number;
  }>): Promise<CreateCreditOrderResult>;
  getForSubject(subjectId: string, orderId: string): Promise<CreditOrderRecord | null>;
  listForSubject(subjectId: string, limit: number, side?: CreditOrderListSide, cursor?: CreditOrderListCursor | null): Promise<CreditOrderRecord[]>;
  expireReservations(now: Date, limit: number): Promise<number>;
  confirm(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  cancel(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  startDelivery(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  startRework(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  markDeliveryReady(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    deliveryPayloadCiphertext: string; deliveryPayloadDigest: string; requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  accept(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    evidenceDigest: string | null; requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  reportDeliveryIssue(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    requestedResolution: 'rework' | 'refund'; descriptionCiphertext: string; descriptionDigest: string;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  approveMutualRefund(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  escalateDispute(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  decideDispute(input: Readonly<{
    operatorId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    outcome: 'full_refund' | 'resume_acceptance'; reasonCiphertext: string; reasonDigest: string;
    decisionDigest: string; requestId: string; ipHash: string; now: Date;
  }>): Promise<Readonly<{
    status: 'decided' | 'replayed'; order: CreditOrderRecord; decisionId: string; outcome: 'full_refund' | 'resume_acceptance';
  }> | Readonly<{ status: 'conflict' | 'not_found' | 'invalid_state' }>>;
  settleSupplier(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  settleDueSupplierOrders(now: Date, limit: number): Promise<number>;
  requestPostAcceptanceRefund(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    descriptionCiphertext: string; descriptionDigest: string; creditMicros: bigint;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  approvePostAcceptanceRefund(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  contestPostAcceptanceRefund(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    responseCiphertext: string; responseDigest: string; requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  escalatePostAcceptanceRefund(input: Readonly<{
    subjectId: string; userId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    requestId: string; ipHash: string; now: Date;
  }>): Promise<CreditOrderActionResult>;
  decidePostAcceptanceRefund(input: Readonly<{
    operatorId: string; orderId: string; clientRequestId: string; payloadDigest: string;
    outcome: 'approve_refund' | 'reject_refund'; reasonCiphertext: string; reasonDigest: string;
    decisionDigest: string; requestId: string; ipHash: string; now: Date;
  }>): Promise<Readonly<{
    status: 'decided' | 'replayed'; order: CreditOrderRecord; decisionId: string;
    outcome: 'full_refund' | 'partial_refund' | 'reject_refund';
  }> | Readonly<{ status: 'conflict' | 'not_found' | 'invalid_state' }>>;
  deliveryForSubject(subjectId: string, orderId: string): Promise<Readonly<{
    order: CreditOrderRecord; attempts: ReadonlyArray<Readonly<{
      id: string; attemptNumber: number; status: 'provisioning' | 'ready' | 'completed' | 'superseded' | 'refunded';
      deliveryPayloadCiphertext: string | null; deliveryPayloadDigest: string | null;
      startedAt: Date; readyAt: Date | null;
    }>>;
  }> | null>;
  deliveryIssueForSubject(subjectId: string, orderId: string): Promise<Readonly<{
    order: CreditOrderRecord; requestedResolution: 'rework' | 'refund'; descriptionCiphertext: string;
    descriptionDigest: string; status: 'open' | 'rework_started' | 'reworked' | 'escalated' | 'dismissed' | 'refunded'; openedAt: Date;
  }> | null>;
  mutualRefundForSubject(subjectId: string, orderId: string): Promise<Readonly<{
    order: CreditOrderRecord; creditMicros: bigint; status: 'succeeded'; approvedAt: Date;
  }> | null>;
  supplierSettlementForSubject(subjectId: string, orderId: string): Promise<Readonly<{
    order: CreditOrderRecord; creditMicros: bigint; status: 'succeeded'; triggeredBy: 'provider' | 'system';
    acceptedAt: Date; availableAt: Date; settledAt: Date;
  }> | null>;
  disputeAdjudicationForSubject(subjectId: string, orderId: string): Promise<Readonly<{
    order: CreditOrderRecord; status: 'pending' | 'resolved'; escalatedBySide: 'buyer' | 'provider';
    escalatedAt: Date; outcome: 'full_refund' | 'resume_acceptance' | null; reasonCiphertext: string | null;
    reasonDigest: string | null; creditMicros: bigint | null; decidedAt: Date | null;
  }> | null>;
  listPendingDisputeAdjudications(limit: number): Promise<ReadonlyArray<Readonly<{
    order: CreditOrderRecord; deliveryIssueId: string; escalatedBySide: 'buyer' | 'provider'; escalatedAt: Date;
    requestedResolution: 'refund'; descriptionCiphertext: string; descriptionDigest: string;
    deliveryAttemptNumber: number; deliveryPayloadCiphertext: string; deliveryPayloadDigest: string;
  }>>>;
  postAcceptanceRefundForSubject(subjectId: string, orderId: string): Promise<Readonly<{
    order: CreditOrderRecord; status: 'pending' | 'escalated' | 'succeeded' | 'rejected';
    descriptionCiphertext: string; descriptionDigest: string; creditMicros: bigint;
    requestedAt: Date; resolvedAt: Date | null; escalatedBySide: 'buyer' | 'provider' | null;
    escalatedAt: Date | null; providerResponseCiphertext: string | null; providerResponseDigest: string | null;
    outcome: 'full_refund' | 'partial_refund' | 'reject_refund' | null; decisionReasonCiphertext: string | null;
    decisionReasonDigest: string | null; decidedAt: Date | null;
  }> | null>;
  listPendingPostAcceptanceRefundAdjudications(limit: number): Promise<ReadonlyArray<Readonly<{
    order: CreditOrderRecord; refundId: string; escalatedBySide: 'buyer' | 'provider'; escalatedAt: Date;
    descriptionCiphertext: string; descriptionDigest: string; providerResponseCiphertext: string | null;
    providerResponseDigest: string | null; deliveryAttemptNumber: number;
    deliveryPayloadCiphertext: string; deliveryPayloadDigest: string; creditMicros: bigint;
  }>>>;
}

export class PostgresCreditOrderStore implements CreditOrderStore {
  constructor(private readonly database: Database) {}

  async createReservation(input: Parameters<CreditOrderStore['createReservation']>[0]): Promise<CreateCreditOrderResult> {
    return this.database.transaction(async (client) => {
      const request = await client.query<{ payload_digest: string; state: string; order_id: string | null }>(
        `SELECT payload_digest, state, order_id FROM kai_credit_order_requests
         WHERE buyer_subject_id = $1 AND client_request_id = $2 FOR UPDATE`, [input.buyerSubjectId, input.clientRequestId],
      );
      const replay = request.rows[0];
      if (replay) {
        if (replay.payload_digest !== input.payloadDigest) return { status: 'conflict' };
        if (replay.state === 'completed' && replay.order_id) {
          const existing = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders WHERE id = $1`, [replay.order_id]);
          if (!existing.rows[0]) throw new Error('KAI_CREDIT_ORDER_REPLAY_MISSING');
          return { status: 'replayed', order: mapOrder(existing.rows[0]) };
        }
        await client.query(`UPDATE kai_credit_order_requests SET state = 'processing', last_result = NULL
          WHERE buyer_subject_id = $1 AND client_request_id = $2`, [input.buyerSubjectId, input.clientRequestId]);
      } else {
        await client.query(`INSERT INTO kai_credit_order_requests(buyer_subject_id, client_request_id, payload_digest)
          VALUES ($1, $2, $3)`, [input.buyerSubjectId, input.clientRequestId, input.payloadDigest]);
      }
      if (!input.computeFulfillmentAvailable) return this.retryable(client, input, 'commerce_unavailable');

      const listingResult = await client.query<{
        id: string; offer_id: string; resource_id: string; supplier_id: string; supplier_subject_id: string;
        title: string; product_code: string; region: string; capacity_unit: string; minimum_quantity: string;
        available: string; unit_credit_micros: string; reference_cny_micros: string; audit_snapshot: Record<string, unknown>;
        service_mode: string; resource_kind: string; binding_id: string; binding_generation: number;
        binding_policy_digest: string; binding_node_id: string;
        resource_specifications: Record<string, unknown>; published_by: string;
      }>(`SELECT l.id, l.offer_id, l.resource_id, l.supplier_id, s.subject_id AS supplier_subject_id,
          o.title, o.service_mode, r.kind AS resource_kind, r.specifications AS resource_specifications,
          b.id AS binding_id, b.generation AS binding_generation, b.policy_digest AS binding_policy_digest,
          b.node_id AS binding_node_id,
          r.product_code, r.region, l.capacity_unit, l.minimum_quantity::text, l.published_by,
          (l.capacity_total - l.capacity_reserved - l.capacity_sold)::text AS available,
          l.unit_credit_micros::text, l.reference_cny_micros::text, l.audit_snapshot
         FROM credit_market_listings l JOIN offer_templates o ON o.id = l.offer_id
         JOIN compute_resources r ON r.id = l.resource_id JOIN supplier_profiles s ON s.id = l.supplier_id
         JOIN compute_resource_bindings b ON b.resource_id = r.id
         JOIN compute_nodes n ON n.id = b.node_id
         JOIN compute_resource_delivery_readiness dr ON dr.resource_id=r.id
         WHERE l.id = $1 AND l.status = 'active' AND l.starts_at <= $2 AND l.expires_at > $2
           AND o.status = 'approved' AND o.audit_valid_until > $2 AND r.status = 'verified' AND s.status = 'approved'
           AND dr.status='ready' AND b.status='ready' AND n.status='ready'
         FOR UPDATE OF l, r, b, n`, [input.listingId, input.now]);
      const listing = listingResult.rows[0];
      const unavailable = !listing || scaled(listing.available) < input.quantityScaled
        || input.quantityScaled < scaled(listing.minimum_quantity)
        || listing.resource_kind !== 'gpu' || listing.capacity_unit !== 'GPU时' || listing.service_mode !== 'dedicated';
      if (unavailable) return this.retryable(client, input, 'listing_unavailable');
      if (listing.supplier_subject_id === input.buyerSubjectId) return this.retryable(client, input, 'self_purchase');
      const autoConfirmCompute = input.autoConfirmCompute === true;
      if (autoConfirmCompute) {
        const reviewedGpuCount = listing.resource_specifications.gpuCount;
        const resourceSlotLimit = Number.isInteger(reviewedGpuCount) && Number(reviewedGpuCount) >= 1
          && Number(reviewedGpuCount) <= 64
          ? Number(reviewedGpuCount)
          : input.nodeAcceleratorCountFallback;
        if (!resourceSlotLimit || resourceSlotLimit < 1 || resourceSlotLimit > 64) {
          return this.retryable(client, input, 'listing_unavailable');
        }
        const occupied = await client.query<{ count: string }>(`SELECT count(*)::text AS count
          FROM kai_credit_orders existing
          JOIN credit_market_listings existing_listing ON existing_listing.id=existing.listing_id
          WHERE existing_listing.resource_id=$1
            AND existing.status IN ('confirmed','provisioning','ready','in_service','release_pending')`,
        [listing.resource_id]);
        if (BigInt(occupied.rows[0]?.count ?? '0') >= BigInt(resourceSlotLimit)) {
          return this.retryable(client, input, 'listing_unavailable');
        }
      }

      const unitCreditMicros = BigInt(listing.unit_credit_micros);
      const totalMicros = totalCreditMicros(input.quantityScaled, unitCreditMicros);
      const accounts = await this.ensureBuyerAccounts(client, input.buyerSubjectId);
      const balance = await client.query<{ amount: string }>(`SELECT COALESCE(sum(e.amount_micros), 0)::text AS amount
        FROM kai_credit_entries e JOIN kai_credit_transactions t ON t.id = e.transaction_id
        WHERE e.account_id = $1 AND t.status = 'posted'`, [accounts.available]);
      if (BigInt(balance.rows[0]?.amount ?? '0') < totalMicros) return this.retryable(client, input, 'insufficient_credits');

      const reservationTransactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
          payload_digest, reference_type, reference_id, description, status)
        VALUES ($1, $2, 'CREDIT_ORDER_RESERVE', $3, $4, 'order_reservation', $5, $6, 'pending')`,
      [reservationTransactionId, `subject:${input.buyerSubjectId}`, `order-reserve:${input.id}`, input.payloadDigest,
        input.id, `订单 ${input.orderNumber} 预留卡时`]);
      await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
        ($1, $2, $3, $4, '订单预留'), ($5, $2, $6, $7, '订单预留')`,
      [randomUUID(), reservationTransactionId, accounts.available, (-totalMicros).toString(), randomUUID(), accounts.reserved, totalMicros.toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`, [reservationTransactionId, input.now]);

      const snapshot = {
        title: listing.title, productCode: listing.product_code, region: listing.region,
        offerId: listing.offer_id, resourceId: listing.resource_id, supplierId: listing.supplier_id,
        bindingId: listing.binding_id, bindingGeneration: listing.binding_generation,
        bindingPolicyDigest: listing.binding_policy_digest, bindingNodeId: listing.binding_node_id,
        unitCreditMicros: listing.unit_credit_micros, referenceCnyMicros: listing.reference_cny_micros,
        audits: listing.audit_snapshot,
        fulfillmentMode: autoConfirmCompute ? 'compute_sidecar_v1' : 'legacy_delivery',
      };
      const order = await client.query<OrderRow>(`INSERT INTO kai_credit_orders(id, order_number, buyer_subject_id,
          supplier_subject_id, created_by_user_id, listing_id, client_request_id, payload_digest, quantity,
          capacity_unit, unit_credit_micros, total_credit_micros, listing_snapshot, reservation_expires_at,
          status, confirmed_at, confirmed_by_user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17)
        RETURNING ${orderColumns}`,
      [input.id, input.orderNumber, input.buyerSubjectId, listing.supplier_subject_id, input.userId, listing.id,
        input.clientRequestId, input.payloadDigest, input.quantity, listing.capacity_unit, unitCreditMicros.toString(),
        totalMicros.toString(), JSON.stringify(snapshot), input.expiresAt,
        autoConfirmCompute ? 'confirmed' : 'reserved', autoConfirmCompute ? input.now : null,
        autoConfirmCompute ? listing.published_by : null]);
      await client.query(`INSERT INTO kai_credit_order_reservations(id, order_id, listing_id, buyer_subject_id,
          quantity, credit_micros, reservation_transaction_id, expires_at, status, secured_at, secured_by_user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [randomUUID(), input.id, listing.id, input.buyerSubjectId, input.quantity, totalMicros.toString(),
        reservationTransactionId, input.expiresAt, autoConfirmCompute ? 'secured' : 'active',
        autoConfirmCompute ? input.now : null, autoConfirmCompute ? listing.published_by : null]);
      await client.query(`UPDATE credit_market_listings SET capacity_reserved = capacity_reserved + $2,
        status = CASE WHEN capacity_total - capacity_reserved - capacity_sold - $2 < minimum_quantity THEN 'sold_out' ELSE status END
        WHERE id = $1`, [listing.id, input.quantity]);
      if (autoConfirmCompute) {
        await this.event(client, input.id, listing.published_by, 'system', 'ORDER_AUTO_CONFIRMED', null, 'confirmed', {
          reason: 'active_listing_capacity_commitment', resourceId: listing.resource_id, quantity: input.quantity,
          capacityUnit: listing.capacity_unit, totalCreditMicros: totalMicros.toString(),
        });
      } else {
        await this.event(client, input.id, input.userId, 'user', 'ORDER_RESERVED', null, 'reserved', {
          quantity: input.quantity, capacityUnit: listing.capacity_unit, totalCreditMicros: totalMicros.toString(),
        });
      }
      await client.query(`INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id,
          request_id, ip_hash, payload_digest, metadata)
        VALUES ($1, $2, 'user', 'KAI_CREDIT_ORDER_RESERVED', 'KAI_CREDIT_ORDER', $3, $4, $5, $6, $7::jsonb)`,
      [randomUUID(), input.userId, input.id, input.requestId, input.ipHash, input.payloadDigest, JSON.stringify({
        buyerSubjectId: input.buyerSubjectId, listingId: input.listingId, quantity: input.quantity,
        totalCreditMicros: totalMicros.toString(),
      })]);
      await this.notifySupplier(client, listing.supplier_subject_id, input.id, input.orderNumber, listing.title,
        input.quantity, listing.capacity_unit, autoConfirmCompute);
      await client.query(`UPDATE kai_credit_order_requests SET state = 'completed', order_id = $3, last_result = 'created'
        WHERE buyer_subject_id = $1 AND client_request_id = $2`, [input.buyerSubjectId, input.clientRequestId, input.id]);
      return { status: 'created', order: mapOrder(order.rows[0]!) };
    });
  }

  async getForSubject(subjectId: string, orderId: string) {
    const result = await this.database.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
      WHERE id = $1 AND (buyer_subject_id = $2 OR supplier_subject_id = $2)`, [orderId, subjectId]);
    return result.rows[0] ? mapOrder(result.rows[0]) : null;
  }

  async listForSubject(subjectId: string, limit: number, side: CreditOrderListSide = 'all', cursor: CreditOrderListCursor | null = null) {
    const ownership = side === 'buyer'
      ? 'buyer_subject_id = $1'
      : side === 'provider'
        ? 'supplier_subject_id = $1'
        : '(buyer_subject_id = $1 OR supplier_subject_id = $1)';
    const result = await this.database.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
      WHERE ${ownership} AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $4`, [subjectId, cursor?.createdAt ?? null, cursor?.id ?? null, limit]);
    return result.rows.map(mapOrder);
  }

  async confirm(input: Parameters<CreditOrderStore['confirm']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'confirm');
      const replay = await this.actionReplay(client, input, 'confirm');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND supplier_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const replayAfterLock = await this.actionReplay(client, input, 'confirm');
      if (replayAfterLock) return replayAfterLock;
      const order = mapOrder(row);
      const reservation = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_reservations
        WHERE order_id = $1 FOR UPDATE`, [order.id]);
      if (order.status === 'confirmed' && reservation.rows[0]?.status === 'secured') {
        await this.saveAction(client, input, 'confirm', 'confirmed');
        return { status: 'replayed', order };
      }
      if (order.status !== 'reserved' || reservation.rows[0]?.status !== 'active') {
        const status = order.status === 'expired' ? 'expired' : 'invalid_state';
        await this.saveAction(client, input, 'confirm', status);
        return { status };
      }
      if (order.reservationExpiresAt <= input.now) {
        await this.expireLockedReservation(client, order, input.now);
        await this.saveAction(client, input, 'confirm', 'expired');
        return { status: 'expired' };
      }
      await client.query(`UPDATE kai_credit_order_reservations SET status = 'secured', secured_at = $2,
        secured_by_user_id = $3 WHERE order_id = $1 AND status = 'active'`, [order.id, input.now, input.userId]);
      const updated = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'confirmed',
        confirmed_at = $2, confirmed_by_user_id = $3 WHERE id = $1 RETURNING ${orderColumns}`,
      [order.id, input.now, input.userId]);
      await this.event(client, order.id, input.userId, 'provider', 'ORDER_CONFIRMED', 'reserved', 'confirmed', {});
      await this.audit(client, input, 'KAI_CREDIT_ORDER_CONFIRMED', { supplierSubjectId: input.subjectId });
      await this.notifyUser(client, order.createdByUserId, '提供方已确认订单',
        `订单 ${order.orderNumber} 已确认，预留卡时现已进入履约担保。`, 'buyer_order', order.id, order.buyerSubjectId);
      await this.saveAction(client, input, 'confirm', 'confirmed');
      return { status: 'confirmed', order: mapOrder(updated.rows[0]!) };
    });
  }

  async cancel(input: Parameters<CreditOrderStore['cancel']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'cancel');
      const replay = await this.actionReplay(client, input, 'cancel');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND buyer_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const replayAfterLock = await this.actionReplay(client, input, 'cancel');
      if (replayAfterLock) return replayAfterLock;
      const order = mapOrder(row);
      const reservation = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_reservations
        WHERE order_id = $1 FOR UPDATE`, [order.id]);
      if (order.status === 'cancelled' && reservation.rows[0]?.status === 'released') {
        await this.saveAction(client, input, 'cancel', 'cancelled');
        return { status: 'replayed', order };
      }
      if (order.status !== 'reserved' || reservation.rows[0]?.status !== 'active') {
        const status = order.status === 'expired' ? 'expired' : 'invalid_state';
        await this.saveAction(client, input, 'cancel', status);
        return { status };
      }
      if (order.reservationExpiresAt <= input.now) {
        await this.expireLockedReservation(client, order, input.now);
        await this.saveAction(client, input, 'cancel', 'expired');
        return { status: 'expired' };
      }
      const released = await this.releaseLockedReservation(client, order, input.now, 'released', 'buyer_cancelled_before_confirmation');
      const updated = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'cancelled', closed_at = $2
        WHERE id = $1 RETURNING ${orderColumns}`, [order.id, input.now]);
      await this.event(client, order.id, input.userId, 'user', 'ORDER_CANCELLED', 'reserved', 'cancelled', {
        releasedCreditMicros: released.creditMicros.toString(),
      });
      await this.audit(client, input, 'KAI_CREDIT_ORDER_CANCELLED', { buyerSubjectId: input.subjectId });
      await this.notifySubject(client, order.supplierSubjectId, '买方已取消订单',
        `订单 ${order.orderNumber} 已在确认前取消，可售数量已恢复。`, 'provider_order', order.id);
      await this.saveAction(client, input, 'cancel', 'cancelled');
      return { status: 'cancelled', order: mapOrder(updated.rows[0]!) };
    });
  }

  async startDelivery(input: Parameters<CreditOrderStore['startDelivery']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'start_delivery');
      const replay = await this.actionReplay(client, input, 'start_delivery');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND supplier_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const replayAfterLock = await this.actionReplay(client, input, 'start_delivery');
      if (replayAfterLock) return replayAfterLock;
      const order = mapOrder(row);
      if (isComputeOrder(order)) {
        await this.saveAction(client, input, 'start_delivery', 'invalid_state');
        return { status: 'invalid_state' };
      }
      const reservation = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_reservations
        WHERE order_id = $1 FOR UPDATE`, [order.id]);
      if (order.status === 'provisioning' && reservation.rows[0]?.status === 'secured') {
        await this.saveAction(client, input, 'start_delivery', 'provisioning');
        return { status: 'replayed', order };
      }
      if (order.status !== 'confirmed' || reservation.rows[0]?.status !== 'secured') {
        await this.saveAction(client, input, 'start_delivery', 'invalid_state');
        return { status: 'invalid_state' };
      }
      await client.query(`INSERT INTO kai_credit_order_deliveries(id, order_id, supplier_subject_id,
          attempt_number, started_by_user_id, started_at, status) VALUES ($1, $2, $3, 1, $4, $5, 'provisioning')`,
      [randomUUID(), order.id, input.subjectId, input.userId, input.now]);
      const updated = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'provisioning',
        delivery_started_at = $2 WHERE id = $1 RETURNING ${orderColumns}`, [order.id, input.now]);
      await this.event(client, order.id, input.userId, 'provider', 'DELIVERY_STARTED', 'confirmed', 'provisioning', {});
      await this.audit(client, input, 'KAI_CREDIT_ORDER_DELIVERY_STARTED', { supplierSubjectId: input.subjectId });
      await this.notifyUser(client, order.createdByUserId, '提供方已开始交付',
        `订单 ${order.orderNumber} 已进入配置阶段。`, 'buyer_order', order.id, order.buyerSubjectId);
      await this.saveAction(client, input, 'start_delivery', 'provisioning');
      return { status: 'provisioning', order: mapOrder(updated.rows[0]!) };
    });
  }

  async startRework(input: Parameters<CreditOrderStore['startRework']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'start_rework');
      const replay = await this.actionReplay(client, input, 'start_rework');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND supplier_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const order = mapOrder(row);
      const issue = await client.query<{ id: string; status: string; requested_resolution: string }>(`SELECT
        id, status, requested_resolution FROM kai_credit_order_delivery_issues
        WHERE order_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`, [order.id]);
      const attempts = await client.query<{ maximum: number }>(`SELECT COALESCE(max(attempt_number), 0)::integer AS maximum
        FROM kai_credit_order_deliveries WHERE order_id = $1`, [order.id]);
      if (order.status !== 'disputed' || issue.rows[0]?.status !== 'open'
        || issue.rows[0].requested_resolution !== 'rework') {
        await this.saveAction(client, input, 'start_rework', 'invalid_state');
        return { status: 'invalid_state' };
      }
      const nextAttempt = (attempts.rows[0]?.maximum ?? 0) + 1;
      await client.query(`UPDATE kai_credit_order_delivery_issues SET status = 'rework_started' WHERE id = $1`, [issue.rows[0].id]);
      await client.query(`INSERT INTO kai_credit_order_deliveries(id, order_id, supplier_subject_id,
          attempt_number, started_by_user_id, started_at, status) VALUES ($1, $2, $3, $4, $5, $6, 'provisioning')`,
      [randomUUID(), order.id, input.subjectId, nextAttempt, input.userId, input.now]);
      const updated = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'provisioning',
        delivery_started_at = $2, delivery_ready_at = NULL WHERE id = $1 RETURNING ${orderColumns}`,
      [order.id, input.now]);
      await this.event(client, order.id, input.userId, 'provider', 'DELIVERY_REWORK_STARTED',
        'disputed', 'provisioning', { attemptNumber: nextAttempt });
      await this.audit(client, input, 'KAI_CREDIT_ORDER_DELIVERY_REWORK_STARTED', {
        supplierSubjectId: input.subjectId, attemptNumber: nextAttempt,
      });
      await this.notifyUser(client, order.createdByUserId, '提供方正在重新交付',
        `订单 ${order.orderNumber} 已开始处理交付问题。`, 'buyer_order', order.id, order.buyerSubjectId);
      await this.saveAction(client, input, 'start_rework', 'provisioning');
      return { status: 'provisioning', order: mapOrder(updated.rows[0]!) };
    });
  }

  async markDeliveryReady(input: Parameters<CreditOrderStore['markDeliveryReady']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'delivery_ready');
      const replay = await this.actionReplay(client, input, 'delivery_ready');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND supplier_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const replayAfterLock = await this.actionReplay(client, input, 'delivery_ready');
      if (replayAfterLock) return replayAfterLock;
      const order = mapOrder(row);
      if (isComputeOrder(order)) {
        await this.saveAction(client, input, 'delivery_ready', 'invalid_state');
        return { status: 'invalid_state' };
      }
      const delivery = await client.query<{ id: string; attempt_number: number; status: string; delivery_payload_digest: string | null }>(
        `SELECT id, attempt_number, status, delivery_payload_digest FROM kai_credit_order_deliveries
         WHERE order_id = $1 ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`, [order.id],
      );
      const existing = delivery.rows[0];
      if (order.status === 'acceptance_pending' && existing?.status === 'ready'
        && existing.delivery_payload_digest === input.deliveryPayloadDigest) {
        await this.saveAction(client, input, 'delivery_ready', 'acceptance_pending');
        return { status: 'replayed', order };
      }
      if (order.status !== 'provisioning' || existing?.status !== 'provisioning') {
        await this.saveAction(client, input, 'delivery_ready', 'invalid_state');
        return { status: 'invalid_state' };
      }
      await client.query(`UPDATE kai_credit_order_deliveries SET status = 'ready', ready_by_user_id = $2,
        ready_at = $3, delivery_payload_ciphertext = $4, delivery_payload_digest = $5 WHERE id = $1`,
      [existing?.id, input.userId, input.now, input.deliveryPayloadCiphertext, input.deliveryPayloadDigest]);
      if ((existing?.attempt_number ?? 1) > 1) {
        await client.query(`UPDATE kai_credit_order_delivery_issues SET status = 'reworked', resolved_at = $2
          WHERE order_id = $1 AND status = 'rework_started'`, [order.id, input.now]);
        await client.query(`UPDATE kai_credit_order_deliveries SET status = 'superseded'
          WHERE order_id = $1 AND attempt_number < $2 AND status = 'ready'`, [order.id, existing!.attempt_number]);
      }
      const updated = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'acceptance_pending',
        delivery_ready_at = $2 WHERE id = $1 RETURNING ${orderColumns}`, [order.id, input.now]);
      await this.event(client, order.id, input.userId, 'provider', 'DELIVERY_READY', 'provisioning', 'acceptance_pending', {
        deliveryPayloadDigest: input.deliveryPayloadDigest, attemptNumber: existing?.attempt_number ?? 1,
      });
      await this.audit(client, input, 'KAI_CREDIT_ORDER_DELIVERY_READY', {
        supplierSubjectId: input.subjectId, deliveryPayloadDigest: input.deliveryPayloadDigest,
        attemptNumber: existing?.attempt_number ?? 1,
      });
      await this.notifyUser(client, order.createdByUserId, '交付已完成，请验收',
        `订单 ${order.orderNumber} 已提交交付结果，请查看详情并验收。`, 'buyer_order', order.id, order.buyerSubjectId);
      await this.saveAction(client, input, 'delivery_ready', 'acceptance_pending');
      return { status: 'acceptance_pending', order: mapOrder(updated.rows[0]!) };
    });
  }

  async accept(input: Parameters<CreditOrderStore['accept']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'accept');
      const replay = await this.actionReplay(client, input, 'accept');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND buyer_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const replayAfterLock = await this.actionReplay(client, input, 'accept');
      if (replayAfterLock) return replayAfterLock;
      const order = mapOrder(row);
      if (isComputeOrder(order)) {
        await this.saveAction(client, input, 'accept', 'invalid_state');
        return { status: 'invalid_state' };
      }
      const reservation = await client.query<{
        id: string; status: string; listing_id: string; quantity: string; credit_micros: string;
      }>(`SELECT id, status, listing_id, quantity::text, credit_micros::text
        FROM kai_credit_order_reservations WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const delivery = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_deliveries
        WHERE order_id = $1 ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`, [order.id]);
      if (order.status === 'accepted' && reservation.rows[0]?.status === 'captured') {
        await this.saveAction(client, input, 'accept', 'accepted');
        return { status: 'replayed', order };
      }
      const held = reservation.rows[0];
      if (order.status !== 'acceptance_pending' || held?.status !== 'secured' || delivery.rows[0]?.status !== 'ready') {
        await this.saveAction(client, input, 'accept', 'invalid_state');
        return { status: 'invalid_state' };
      }
      const listing = await client.query<{ id: string }>(`SELECT id FROM credit_market_listings WHERE id = $1 FOR UPDATE`, [held.listing_id]);
      if (!listing.rows[0]) throw new Error('KAI_CREDIT_ORDER_LISTING_MISSING');
      const accounts = await this.ensureCaptureAccounts(client, order.buyerSubjectId, order.supplierSubjectId);
      const captureTransactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
          payload_digest, reference_type, reference_id, description, status)
        VALUES ($1, $2, 'CREDIT_ORDER_CAPTURE', $3, $4, 'order_capture', $5, $6, 'pending')`,
      [captureTransactionId, `subject:${order.buyerSubjectId}`, `order-capture:${order.id}`, input.payloadDigest,
        order.id, `订单 ${order.orderNumber} 验收扣款`]);
      await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
        ($1, $2, $3, $4, '订单验收扣款'), ($5, $2, $6, $7, '提供方待结算')`,
      [randomUUID(), captureTransactionId, accounts.buyerReserved, (-BigInt(held.credit_micros)).toString(),
        randomUUID(), accounts.supplierReceivable, held.credit_micros]);
      await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`, [captureTransactionId, input.now]);
      await client.query(`UPDATE kai_credit_order_reservations SET status = 'captured', resolved_at = $2,
        resolution_transaction_id = $3, resolution_reason = 'buyer_accepted_delivery' WHERE id = $1`,
      [held.id, input.now, captureTransactionId]);
      await client.query(`UPDATE credit_market_listings SET capacity_reserved = capacity_reserved - $2,
        capacity_sold = capacity_sold + $2 WHERE id = $1`, [held.listing_id, held.quantity]);
      const completedDelivery = await client.query<{ id: string }>(`UPDATE kai_credit_order_deliveries SET status = 'completed'
        WHERE id = (SELECT id FROM kai_credit_order_deliveries WHERE order_id = $1 AND status = 'ready'
          ORDER BY attempt_number DESC LIMIT 1) RETURNING id`, [order.id]);
      if (!completedDelivery.rows[0]) throw new Error('KAI_CREDIT_ORDER_READY_DELIVERY_MISSING');
      await client.query(`INSERT INTO kai_credit_order_acceptances(id, order_id, buyer_subject_id,
          accepted_by_user_id, result, evidence_digest, capture_transaction_id, accepted_at, delivery_attempt_id)
        VALUES ($1, $2, $3, $4, 'accepted', $5, $6, $7, $8)`,
      [randomUUID(), order.id, input.subjectId, input.userId, input.evidenceDigest, captureTransactionId,
        input.now, completedDelivery.rows[0].id]);
      const updated = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'accepted', accepted_at = $2,
        accepted_by_user_id = $3, closed_at = $2 WHERE id = $1 RETURNING ${orderColumns}`, [order.id, input.now, input.userId]);
      await this.event(client, order.id, input.userId, 'user', 'DELIVERY_ACCEPTED', 'acceptance_pending', 'accepted', {
        evidenceDigest: input.evidenceDigest, captureTransactionId,
      });
      await this.audit(client, input, 'KAI_CREDIT_ORDER_ACCEPTED', {
        buyerSubjectId: input.subjectId, evidenceDigest: input.evidenceDigest,
        capturedCreditMicros: held.credit_micros, captureTransactionId,
      });
      await this.notifySubject(client, order.supplierSubjectId, '买方已验收',
        `订单 ${order.orderNumber} 已验收，卡时已进入待结算账户。`, 'provider_order', order.id);
      await this.saveAction(client, input, 'accept', 'accepted');
      return { status: 'accepted', order: mapOrder(updated.rows[0]!) };
    });
  }

  async reportDeliveryIssue(input: Parameters<CreditOrderStore['reportDeliveryIssue']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'report_delivery_issue');
      const replay = await this.actionReplay(client, input, 'report_delivery_issue');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND buyer_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const order = mapOrder(row);
      const reservation = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_reservations
        WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const delivery = await client.query<{ id: string; status: string }>(`SELECT id, status FROM kai_credit_order_deliveries
        WHERE order_id = $1 ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`, [order.id]);
      const existing = await client.query<{ request_payload_digest: string }>(`SELECT request_payload_digest
        FROM kai_credit_order_delivery_issues WHERE delivery_attempt_id = $1`, [delivery.rows[0]?.id]);
      if (order.status === 'disputed' && existing.rows[0]?.request_payload_digest === input.payloadDigest) {
        await this.saveAction(client, input, 'report_delivery_issue', 'disputed');
        return { status: 'replayed', order };
      }
      if (order.status !== 'acceptance_pending' || reservation.rows[0]?.status !== 'secured'
        || delivery.rows[0]?.status !== 'ready' || existing.rows[0]) {
        await this.saveAction(client, input, 'report_delivery_issue', 'invalid_state');
        return { status: 'invalid_state' };
      }
      await client.query(`INSERT INTO kai_credit_order_delivery_issues(id, order_id, buyer_subject_id,
          opened_by_user_id, requested_resolution, description_ciphertext, description_digest,
          request_payload_digest, opened_at, delivery_attempt_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
          (SELECT id FROM kai_credit_order_deliveries WHERE order_id = $2 AND status = 'ready'
            ORDER BY attempt_number DESC LIMIT 1))`,
      [randomUUID(), order.id, input.subjectId, input.userId, input.requestedResolution,
        input.descriptionCiphertext, input.descriptionDigest, input.payloadDigest, input.now]);
      const updated = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'disputed'
        WHERE id = $1 RETURNING ${orderColumns}`, [order.id]);
      await this.event(client, order.id, input.userId, 'user', 'DELIVERY_ISSUE_REPORTED',
        'acceptance_pending', 'disputed', {
          requestedResolution: input.requestedResolution, descriptionDigest: input.descriptionDigest,
        });
      await this.audit(client, input, 'KAI_CREDIT_ORDER_DELIVERY_ISSUE_REPORTED', {
        buyerSubjectId: input.subjectId, requestedResolution: input.requestedResolution,
        descriptionDigest: input.descriptionDigest,
      });
      await this.notifySubject(client, order.supplierSubjectId, '买方反馈交付问题',
        `订单 ${order.orderNumber} 的交付需要处理，请打开订单查看。`, 'provider_order', order.id);
      await this.saveAction(client, input, 'report_delivery_issue', 'disputed');
      return { status: 'disputed', order: mapOrder(updated.rows[0]!) };
    });
  }

  async approveMutualRefund(input: Parameters<CreditOrderStore['approveMutualRefund']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'approve_refund');
      const replay = await this.actionReplay(client, input, 'approve_refund');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND supplier_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const order = mapOrder(row);
      const issue = await client.query<{ id: string; status: string; requested_resolution: string; delivery_attempt_id: string }>(`SELECT
        id, status, requested_resolution, delivery_attempt_id FROM kai_credit_order_delivery_issues
        WHERE order_id = $1 ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`, [order.id]);
      const held = await client.query<{
        id: string; status: string; listing_id: string; quantity: string; credit_micros: string;
      }>(`SELECT id, status, listing_id, quantity::text, credit_micros::text
        FROM kai_credit_order_reservations WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const activeIssue = issue.rows[0]; const reservation = held.rows[0];
      if (order.status !== 'disputed' || activeIssue?.status !== 'open'
        || activeIssue.requested_resolution !== 'refund' || reservation?.status !== 'secured') {
        await this.saveAction(client, input, 'approve_refund', 'invalid_state');
        return { status: 'invalid_state' };
      }
      const listing = await client.query<{ status: string }>(`SELECT status FROM credit_market_listings
        WHERE id = $1 FOR UPDATE`, [reservation.listing_id]);
      if (!listing.rows[0]) throw new Error('KAI_CREDIT_ORDER_LISTING_MISSING');
      const accounts = await this.ensureBuyerAccounts(client, order.buyerSubjectId);
      const refundTransactionId = randomUUID();
      const creditMicros = BigInt(reservation.credit_micros);
      await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
          payload_digest, reference_type, reference_id, description, status)
        VALUES ($1, $2, 'CREDIT_ORDER_MUTUAL_REFUND', $3, $4, 'refund', $5, $6, 'pending')`,
      [refundTransactionId, `subject:${order.buyerSubjectId}`, `order-mutual-refund:${order.id}`,
        input.payloadDigest, order.id, `订单 ${order.orderNumber} 协商全额退款`]);
      await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
        ($1, $2, $3, $4, '协商退款退回'), ($5, $2, $6, $7, '协商退款退回')`,
      [randomUUID(), refundTransactionId, accounts.available, creditMicros.toString(), randomUUID(),
        accounts.reserved, (-creditMicros).toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`,
      [refundTransactionId, input.now]);
      await client.query(`UPDATE kai_credit_order_reservations SET status = 'released', resolved_at = $2,
        resolution_transaction_id = $3, resolution_reason = 'mutual_full_refund' WHERE id = $1`,
      [reservation.id, input.now, refundTransactionId]);
      await client.query(`UPDATE credit_market_listings l SET capacity_reserved = capacity_reserved - $2,
        status = CASE WHEN l.status = 'sold_out' AND l.starts_at <= $3 AND l.expires_at > $3
          AND EXISTS (SELECT 1 FROM offer_templates o JOIN compute_resources r ON r.id = o.resource_id
            JOIN supplier_profiles s ON s.id = o.supplier_id WHERE o.id = l.offer_id AND o.status = 'approved'
            AND o.audit_valid_until > $3 AND r.status = 'verified' AND s.status = 'approved')
          THEN 'active' ELSE l.status END WHERE l.id = $1`, [reservation.listing_id, reservation.quantity, input.now]);
      await client.query(`UPDATE kai_credit_order_deliveries SET status = 'refunded'
        WHERE id = $1 AND status = 'ready'`, [activeIssue.delivery_attempt_id]);
      await client.query(`UPDATE kai_credit_order_delivery_issues SET status = 'refunded', resolved_at = $2
        WHERE id = $1`, [activeIssue.id, input.now]);
      const updated = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'refunded', closed_at = $2
        WHERE id = $1 RETURNING ${orderColumns}`, [order.id, input.now]);
      await client.query(`INSERT INTO kai_credit_order_mutual_refunds(id, order_id, delivery_issue_id,
          buyer_subject_id, supplier_subject_id, approved_by_user_id, credit_micros,
          refund_transaction_id, status, approved_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded', $9)`,
      [randomUUID(), order.id, activeIssue.id, order.buyerSubjectId, order.supplierSubjectId, input.userId,
        creditMicros.toString(), refundTransactionId, input.now]);
      await this.event(client, order.id, input.userId, 'provider', 'MUTUAL_FULL_REFUND_APPROVED',
        'disputed', 'refunded', { refundedCreditMicros: creditMicros.toString(), refundTransactionId });
      await this.audit(client, input, 'KAI_CREDIT_ORDER_MUTUAL_FULL_REFUND_APPROVED', {
        supplierSubjectId: input.subjectId, refundedCreditMicros: creditMicros.toString(), refundTransactionId,
      });
      await this.notifyUser(client, order.createdByUserId, '卡时已退回',
        `订单 ${order.orderNumber} 已完成全额退款，卡时已退回可用账户。`, 'buyer_order', order.id, order.buyerSubjectId);
      await this.saveAction(client, input, 'approve_refund', 'refunded');
      return { status: 'refunded', order: mapOrder(updated.rows[0]!) };
    });
  }

  async escalateDispute(input: Parameters<CreditOrderStore['escalateDispute']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'escalate_dispute');
      const replay = await this.actionReplay(client, input, 'escalate_dispute');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND (buyer_subject_id = $2 OR supplier_subject_id = $2) FOR UPDATE`,
      [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const order = mapOrder(row);
      const side = order.buyerSubjectId === input.subjectId ? 'buyer' as const : 'provider' as const;
      const issue = await client.query<{
        id: string; status: string; requested_resolution: string; delivery_attempt_id: string;
      }>(`SELECT id, status, requested_resolution, delivery_attempt_id FROM kai_credit_order_delivery_issues
        WHERE order_id = $1 ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`, [order.id]);
      const held = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_reservations
        WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const delivery = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_deliveries
        WHERE id = $1 FOR UPDATE`, [issue.rows[0]?.delivery_attempt_id]);
      const activeIssue = issue.rows[0];
      if (order.status !== 'disputed' || activeIssue?.status !== 'open'
        || activeIssue.requested_resolution !== 'refund' || held.rows[0]?.status !== 'secured'
        || delivery.rows[0]?.status !== 'ready') {
        await this.saveAction(client, input, 'escalate_dispute', 'invalid_state');
        return { status: 'invalid_state' };
      }
      await client.query(`UPDATE kai_credit_order_delivery_issues SET status = 'escalated' WHERE id = $1`,
      [activeIssue.id]);
      await client.query(`INSERT INTO kai_credit_order_dispute_escalations(id, order_id, delivery_issue_id,
          buyer_subject_id, supplier_subject_id, escalated_by_user_id, escalated_by_side, escalated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), order.id, activeIssue.id, order.buyerSubjectId, order.supplierSubjectId,
        input.userId, side, input.now]);
      await this.event(client, order.id, input.userId, side === 'buyer' ? 'user' : 'provider',
        'DELIVERY_DISPUTE_ESCALATED', 'disputed', 'disputed', { escalatedBySide: side });
      await this.audit(client, input, 'KAI_CREDIT_ORDER_DISPUTE_ESCALATED', { escalatedBySide: side });
      if (side === 'buyer') await this.notifySubject(client, order.supplierSubjectId, '退款申请已提交平台处理',
        `订单 ${order.orderNumber} 正在等待平台处理。`, 'provider_order', order.id);
      else await this.notifyUser(client, order.createdByUserId, '退款申请已提交平台处理',
        `订单 ${order.orderNumber} 正在等待平台处理。`, 'buyer_order', order.id, order.buyerSubjectId);
      await this.saveAction(client, input, 'escalate_dispute', 'escalated');
      return { status: 'escalated', order };
    });
  }

  async decideDispute(input: Parameters<CreditOrderStore['decideDispute']>[0]) {
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `kai-credit-dispute-decision:${input.operatorId}:${input.clientRequestId}`,
      ]);
      const replay = await client.query<{
        order_id: string; payload_digest: string; decision_id: string; outcome: 'full_refund' | 'resume_acceptance';
      }>(`SELECT r.order_id, r.payload_digest, r.decision_id, d.outcome
        FROM kai_credit_order_dispute_decision_requests r
        JOIN kai_credit_order_dispute_decisions d ON d.id = r.decision_id
        WHERE r.operator_id = $1 AND r.client_request_id = $2`, [input.operatorId, input.clientRequestId]);
      if (replay.rows[0]) {
        if (replay.rows[0].order_id !== input.orderId || replay.rows[0].payload_digest !== input.payloadDigest) {
          return { status: 'conflict' as const };
        }
        const orderResult = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders WHERE id = $1`,
        [input.orderId]);
        if (!orderResult.rows[0]) throw new Error('KAI_CREDIT_DISPUTE_DECISION_REPLAY_MISSING');
        return {
          status: 'replayed' as const, order: mapOrder(orderResult.rows[0]),
          decisionId: replay.rows[0].decision_id, outcome: replay.rows[0].outcome,
        };
      }
      const operator = await client.query<{ id: string }>(`SELECT id FROM users
        WHERE id = $1 AND role IN ('operator', 'admin') AND status = 'active' FOR UPDATE`, [input.operatorId]);
      if (!operator.rows[0]) return { status: 'not_found' as const };
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 FOR UPDATE`, [input.orderId]);
      if (!current.rows[0]) return { status: 'not_found' as const };
      const order = mapOrder(current.rows[0]);
      const escalationResult = await client.query<{
        id: string; delivery_issue_id: string; status: string;
      }>(`SELECT id, delivery_issue_id, status FROM kai_credit_order_dispute_escalations
        WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const escalation = escalationResult.rows[0];
      const issue = await client.query<{ status: string; requested_resolution: string; delivery_attempt_id: string }>(
        `SELECT status, requested_resolution, delivery_attempt_id FROM kai_credit_order_delivery_issues
         WHERE id = $1 FOR UPDATE`, [escalation?.delivery_issue_id],
      );
      const heldResult = await client.query<{
        id: string; status: string; listing_id: string; quantity: string; credit_micros: string;
      }>(`SELECT id, status, listing_id, quantity::text, credit_micros::text
        FROM kai_credit_order_reservations WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const held = heldResult.rows[0];
      const delivery = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_deliveries
        WHERE id = $1 FOR UPDATE`, [issue.rows[0]?.delivery_attempt_id]);
      if (order.status !== 'disputed' || escalation?.status !== 'pending'
        || issue.rows[0]?.status !== 'escalated' || issue.rows[0].requested_resolution !== 'refund'
        || held?.status !== 'secured' || delivery.rows[0]?.status !== 'ready') {
        return { status: 'invalid_state' as const };
      }

      let refundTransactionId: string | null = null;
      let updated: OrderRow;
      if (input.outcome === 'full_refund') {
        const listing = await client.query<{ id: string }>(`SELECT id FROM credit_market_listings
          WHERE id = $1 FOR UPDATE`, [held.listing_id]);
        if (!listing.rows[0]) throw new Error('KAI_CREDIT_ORDER_LISTING_MISSING');
        const accounts = await this.ensureBuyerAccounts(client, order.buyerSubjectId);
        refundTransactionId = randomUUID();
        await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
            payload_digest, reference_type, reference_id, description, status)
          VALUES ($1, $2, 'CREDIT_ORDER_ADJUDICATED_REFUND', $3, $4, 'refund', $5, $6, 'pending')`,
        [refundTransactionId, `subject:${order.buyerSubjectId}`, `order-adjudicated-refund:${order.id}`,
          input.decisionDigest, order.id, `订单 ${order.orderNumber} 平台裁定全额退款`]);
        await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
          ($1, $2, $3, $4, '平台裁定退款'), ($5, $2, $6, $7, '平台裁定退款')`,
        [randomUUID(), refundTransactionId, accounts.available, held.credit_micros, randomUUID(), accounts.reserved,
          (-BigInt(held.credit_micros)).toString()]);
        await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`,
        [refundTransactionId, input.now]);
        await client.query(`UPDATE kai_credit_order_reservations SET status = 'released', resolved_at = $2,
          resolution_transaction_id = $3, resolution_reason = 'platform_adjudicated_full_refund' WHERE id = $1`,
        [held.id, input.now, refundTransactionId]);
        await client.query(`UPDATE credit_market_listings l SET capacity_reserved = capacity_reserved - $2,
          status = CASE WHEN l.status = 'sold_out' AND l.starts_at <= $3 AND l.expires_at > $3
            AND EXISTS (SELECT 1 FROM offer_templates o JOIN compute_resources r ON r.id = o.resource_id
              JOIN supplier_profiles s ON s.id = o.supplier_id WHERE o.id = l.offer_id AND o.status = 'approved'
              AND o.audit_valid_until > $3 AND r.status = 'verified' AND s.status = 'approved')
            THEN 'active' ELSE l.status END WHERE l.id = $1`, [held.listing_id, held.quantity, input.now]);
        await client.query(`UPDATE kai_credit_order_deliveries SET status = 'refunded'
          WHERE id = $1 AND status = 'ready'`, [issue.rows[0].delivery_attempt_id]);
        await client.query(`UPDATE kai_credit_order_delivery_issues SET status = 'refunded', resolved_at = $2
          WHERE id = $1`, [escalation.delivery_issue_id, input.now]);
        const result = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'refunded', closed_at = $2
          WHERE id = $1 RETURNING ${orderColumns}`, [order.id, input.now]);
        updated = result.rows[0]!;
      } else {
        await client.query(`UPDATE kai_credit_order_delivery_issues SET status = 'dismissed', resolved_at = $2
          WHERE id = $1`, [escalation.delivery_issue_id, input.now]);
        const result = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'acceptance_pending'
          WHERE id = $1 RETURNING ${orderColumns}`, [order.id]);
        updated = result.rows[0]!;
      }
      await client.query(`UPDATE kai_credit_order_dispute_escalations SET status = 'resolved', resolved_at = $2
        WHERE id = $1`, [escalation.id, input.now]);
      const decisionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_order_dispute_decisions(id, order_id, escalation_id,
          delivery_issue_id, operator_id, outcome, reason_ciphertext, reason_digest, decision_digest,
          credit_micros, refund_transaction_id, decided_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [decisionId, order.id, escalation.id, escalation.delivery_issue_id, input.operatorId, input.outcome,
        input.reasonCiphertext, input.reasonDigest, input.decisionDigest,
        input.outcome === 'full_refund' ? held.credit_micros : '0', refundTransactionId, input.now]);
      await client.query(`INSERT INTO kai_credit_order_dispute_decision_requests(operator_id, client_request_id,
          order_id, payload_digest, decision_id) VALUES ($1, $2, $3, $4, $5)`,
      [input.operatorId, input.clientRequestId, order.id, input.payloadDigest, decisionId]);
      const toStatus = input.outcome === 'full_refund' ? 'refunded' : 'acceptance_pending';
      await this.event(client, order.id, input.operatorId, 'operator', 'DELIVERY_DISPUTE_DECIDED',
        'disputed', toStatus, { outcome: input.outcome, reasonDigest: input.reasonDigest,
          refundedCreditMicros: input.outcome === 'full_refund' ? held.credit_micros : '0', refundTransactionId });
      await client.query(`INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id,
          request_id, ip_hash, payload_digest, metadata) VALUES
        ($1, $2, 'operator', 'KAI_CREDIT_ORDER_DISPUTE_DECIDED', 'KAI_CREDIT_ORDER', $3, $4, $5, $6, $7::jsonb)`,
      [randomUUID(), input.operatorId, order.id, input.requestId, input.ipHash, input.payloadDigest, JSON.stringify({
        outcome: input.outcome, reasonDigest: input.reasonDigest,
        refundedCreditMicros: input.outcome === 'full_refund' ? held.credit_micros : '0', refundTransactionId,
      })]);
      const title = input.outcome === 'full_refund' ? '平台已完成退款处理' : '平台已完成争议处理';
      const buyerBody = input.outcome === 'full_refund'
        ? `订单 ${order.orderNumber} 已全额退款，卡时已退回。`
        : `订单 ${order.orderNumber} 已恢复待验收，请查看裁定结果。`;
      const providerBody = input.outcome === 'full_refund'
        ? `订单 ${order.orderNumber} 已由平台裁定全额退款。`
        : `订单 ${order.orderNumber} 已恢复待验收。`;
      await this.notifyUser(client, order.createdByUserId, title, buyerBody, 'buyer_order', order.id, order.buyerSubjectId);
      await this.notifySubject(client, order.supplierSubjectId, title, providerBody, 'provider_order', order.id);
      return { status: 'decided' as const, order: mapOrder(updated), decisionId, outcome: input.outcome };
    });
  }

  async settleSupplier(input: Parameters<CreditOrderStore['settleSupplier']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'settle');
      const replay = await this.actionReplay(client, input, 'settle');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND supplier_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const order = mapOrder(row);
      const aftercare = await client.query<{ status: string }>(`SELECT status
        FROM kai_credit_order_post_acceptance_refunds WHERE order_id = $1 FOR UPDATE`, [order.id]);
      if (order.status === 'closed') {
        const existing = await client.query<{ order_id: string }>(`SELECT order_id FROM kai_credit_supplier_settlements
          WHERE order_id = $1`, [order.id]);
        if (existing.rows[0]) {
          await this.saveAction(client, input, 'settle', 'settled');
          return { status: 'replayed', order };
        }
      }
      if (order.status !== 'accepted' || ['pending', 'escalated'].includes(aftercare.rows[0]?.status ?? '')) {
        await this.saveAction(client, input, 'settle', 'invalid_state');
        return { status: 'invalid_state' };
      }
      const acceptance = await this.lockAcceptance(client, order.id);
      if (!acceptance) throw new Error('KAI_CREDIT_ORDER_ACCEPTANCE_MISSING');
      if (acceptance.available_at > input.now) return { status: 'not_due', availableAt: acceptance.available_at };
      const settled = await this.settleLockedSupplierOrder(client, order, acceptance, input.now, {
        triggeredBy: 'provider', userId: input.userId, requestId: input.requestId,
        ipHash: input.ipHash, payloadDigest: input.payloadDigest,
      });
      await this.saveAction(client, input, 'settle', 'settled');
      return { status: 'settled', order: settled };
    });
  }

  async settleDueSupplierOrders(now: Date, limit: number) {
    return this.database.transaction(async (client) => {
      const candidates = await client.query<OrderRow>(`SELECT ${joinedOrderColumns}
        FROM kai_credit_orders o JOIN kai_credit_order_acceptances a ON a.order_id = o.id
        WHERE o.status = 'accepted' AND a.accepted_at + interval '7 days' <= $1
          AND NOT EXISTS (SELECT 1 FROM kai_credit_order_post_acceptance_refunds p
            WHERE p.order_id = o.id AND p.status IN ('pending', 'escalated'))
        ORDER BY a.accepted_at, o.id LIMIT $2 FOR UPDATE OF o SKIP LOCKED`, [now, limit]);
      for (const row of candidates.rows) {
        const order = mapOrder(row);
        const acceptance = await this.lockAcceptance(client, order.id);
        if (!acceptance || acceptance.available_at > now) throw new Error('KAI_CREDIT_SETTLEMENT_CANDIDATE_INVALID');
        await this.settleLockedSupplierOrder(client, order, acceptance, now, {
          triggeredBy: 'system', userId: null, requestId: 'credit-settlement-worker',
          ipHash: null, payloadDigest: `order-settlement:${order.id}:${order.totalCreditMicros}`,
        });
      }
      return candidates.rows.length;
    });
  }

  async requestPostAcceptanceRefund(input: Parameters<CreditOrderStore['requestPostAcceptanceRefund']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'request_post_acceptance_refund');
      const replay = await this.actionReplay(client, input, 'request_post_acceptance_refund');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND buyer_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const order = mapOrder(row);
      const acceptance = await this.lockAcceptance(client, order.id);
      const held = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_reservations
        WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const existing = await client.query<{ description_digest: string; status: string; credit_micros: string }>(`SELECT description_digest, status,
          credit_micros::text
        FROM kai_credit_order_post_acceptance_refunds WHERE order_id = $1 FOR UPDATE`, [order.id]);
      if (order.status === 'accepted' && existing.rows[0]?.status === 'pending'
        && existing.rows[0].description_digest === input.descriptionDigest
        && BigInt(existing.rows[0].credit_micros) === input.creditMicros) {
        await this.saveAction(client, input, 'request_post_acceptance_refund', 'aftercare_pending');
        return { status: 'replayed', order };
      }
      if (order.status !== 'accepted' || !acceptance || input.now >= acceptance.available_at
        || input.creditMicros <= 0n || input.creditMicros > order.totalCreditMicros
        || held.rows[0]?.status !== 'captured' || existing.rows[0]) {
        await this.saveAction(client, input, 'request_post_acceptance_refund', 'invalid_state');
        return { status: 'invalid_state' };
      }
      await client.query(`INSERT INTO kai_credit_order_post_acceptance_refunds(id, order_id, acceptance_id,
          buyer_subject_id, supplier_subject_id, requested_by_user_id, description_ciphertext,
          description_digest, credit_micros, requested_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [randomUUID(), order.id, acceptance.id, order.buyerSubjectId, order.supplierSubjectId, input.userId,
        input.descriptionCiphertext, input.descriptionDigest, input.creditMicros.toString(), input.now]);
      await this.event(client, order.id, input.userId, 'user', 'POST_ACCEPTANCE_REFUND_REQUESTED',
        'accepted', 'accepted', { descriptionDigest: input.descriptionDigest,
          requestedCreditMicros: input.creditMicros.toString() });
      await this.audit(client, input, 'KAI_CREDIT_POST_ACCEPTANCE_REFUND_REQUESTED', {
        buyerSubjectId: input.subjectId, descriptionDigest: input.descriptionDigest,
        requestedCreditMicros: input.creditMicros.toString(),
      });
      await this.notifySubject(client, order.supplierSubjectId, '买方提交了售后退款申请',
        `订单 ${order.orderNumber} 的卡时已暂停结算，请查看售后说明。`, 'provider_order', order.id);
      await this.saveAction(client, input, 'request_post_acceptance_refund', 'aftercare_pending');
      return { status: 'aftercare_pending', order };
    });
  }

  async approvePostAcceptanceRefund(input: Parameters<CreditOrderStore['approvePostAcceptanceRefund']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'approve_post_acceptance_refund');
      const replay = await this.actionReplay(client, input, 'approve_post_acceptance_refund');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND supplier_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      const row = current.rows[0];
      if (!row) return { status: 'not_found' };
      const order = mapOrder(row);
      const refundResult = await client.query<{
        id: string; acceptance_id: string; status: string; credit_micros: string; approved_by_user_id: string | null;
      }>(`SELECT id, acceptance_id, status, credit_micros::text, approved_by_user_id
        FROM kai_credit_order_post_acceptance_refunds WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const refund = refundResult.rows[0];
      if (refund?.status === 'succeeded' && refund.approved_by_user_id) {
        await this.saveAction(client, input, 'approve_post_acceptance_refund', 'refunded');
        return { status: 'replayed', order };
      }
      const acceptance = await this.lockAcceptance(client, order.id);
      const held = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_reservations
        WHERE order_id = $1 FOR UPDATE`, [order.id]);
      if (order.status !== 'accepted' || refund?.status !== 'pending' || !acceptance
        || held.rows[0]?.status !== 'captured') {
        await this.saveAction(client, input, 'approve_post_acceptance_refund', 'invalid_state');
        return { status: 'invalid_state' };
      }
      const subjects = await client.query<{ id: string }>(`SELECT id FROM trading_subjects
        WHERE id = ANY($1::uuid[]) AND status IN ('active', 'suspended') ORDER BY id FOR UPDATE`,
      [[order.buyerSubjectId, order.supplierSubjectId].sort()]);
      if (subjects.rows.length !== 2) throw new Error('TRADING_SUBJECT_REQUIRED');
      await client.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
        VALUES ($1, 'subject', $2, $3, 'available', false)
        ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
      [randomUUID(), order.buyerSubjectId, `subject:${order.buyerSubjectId}:available`]);
      const accounts = await client.query<{ id: string; subject_id: string; account_kind: string }>(`SELECT id,
        subject_id, account_kind FROM kai_credit_accounts WHERE
        (subject_id = $1 AND account_kind = 'available')
        OR (subject_id = $2 AND account_kind = 'supplier_receivable') ORDER BY id FOR UPDATE`,
      [order.buyerSubjectId, order.supplierSubjectId]);
      const buyerAvailable = accounts.rows.find((account) => account.subject_id === order.buyerSubjectId)?.id;
      const supplierReceivable = accounts.rows.find((account) => account.subject_id === order.supplierSubjectId)?.id;
      if (!buyerAvailable || !supplierReceivable) throw new Error('KAI_CREDIT_POST_ACCEPT_REFUND_ACCOUNTS_MISSING');
      const refundTransactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
          payload_digest, reference_type, reference_id, description, status)
        VALUES ($1, $2, 'CREDIT_ORDER_POST_ACCEPT_REFUND', $3, $4, 'refund', $5, $6, 'pending')`,
      [refundTransactionId, `subject:${order.buyerSubjectId}`, `order-post-accept-refund:${order.id}`,
        input.payloadDigest, order.id, `订单 ${order.orderNumber} 验收后全额退款`]);
      await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
        ($1, $2, $3, $4, '验收后退款退回'), ($5, $2, $6, $7, '验收后退款转出')`,
      [randomUUID(), refundTransactionId, buyerAvailable, refund.credit_micros, randomUUID(), supplierReceivable,
        (-BigInt(refund.credit_micros)).toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`,
      [refundTransactionId, input.now]);
      const fullRefund = BigInt(refund.credit_micros) === order.totalCreditMicros;
      const updatedResult = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = $2
        WHERE id = $1 RETURNING ${orderColumns}`, [order.id, fullRefund ? 'refunded' : 'accepted']);
      await client.query(`UPDATE kai_credit_order_post_acceptance_refunds SET status = 'succeeded',
        approved_by_user_id = $2, refund_transaction_id = $3, resolved_at = $4 WHERE id = $1`,
      [refund.id, input.userId, refundTransactionId, input.now]);
      await this.event(client, order.id, input.userId, 'provider', 'POST_ACCEPTANCE_REFUND_APPROVED',
        'accepted', fullRefund ? 'refunded' : 'accepted', { refundedCreditMicros: refund.credit_micros, refundTransactionId });
      await this.audit(client, input, 'KAI_CREDIT_POST_ACCEPTANCE_REFUND_APPROVED', {
        supplierSubjectId: input.subjectId, refundedCreditMicros: refund.credit_micros, refundTransactionId,
      });
      await this.notifyUser(client, order.createdByUserId, fullRefund ? '售后退款已完成' : '补偿卡时已到账',
        `订单 ${order.orderNumber} 的 ${formatCreditDisplayMicros(BigInt(refund.credit_micros))} 卡时已退回可用账户。`,
        'buyer_order', order.id, order.buyerSubjectId);
      await this.saveAction(client, input, 'approve_post_acceptance_refund', 'refunded');
      return { status: 'refunded', order: mapOrder(updatedResult.rows[0]!) };
    });
  }

  async contestPostAcceptanceRefund(input: Parameters<CreditOrderStore['contestPostAcceptanceRefund']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'contest_post_acceptance_refund');
      const replay = await this.actionReplay(client, input, 'contest_post_acceptance_refund');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND supplier_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      if (!current.rows[0]) return { status: 'not_found' };
      const order = mapOrder(current.rows[0]);
      const refundResult = await client.query<{ id: string; status: string }>(`SELECT id, status
        FROM kai_credit_order_post_acceptance_refunds WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const refund = refundResult.rows[0];
      const existing = await client.query<{ escalated_by_side: string; provider_response_digest: string | null }>(
        `SELECT escalated_by_side, provider_response_digest
         FROM kai_credit_post_acceptance_refund_escalations WHERE order_id = $1 FOR UPDATE`, [order.id],
      );
      if (order.status === 'accepted' && refund?.status === 'escalated'
        && existing.rows[0]?.escalated_by_side === 'provider'
        && existing.rows[0].provider_response_digest === input.responseDigest) {
        await this.saveAction(client, input, 'contest_post_acceptance_refund', 'aftercare_escalated');
        return { status: 'replayed', order };
      }
      if (order.status !== 'accepted' || refund?.status !== 'pending' || existing.rows[0]) {
        await this.saveAction(client, input, 'contest_post_acceptance_refund', 'invalid_state');
        return { status: 'invalid_state' };
      }
      await client.query(`UPDATE kai_credit_order_post_acceptance_refunds SET status = 'escalated'
        WHERE id = $1`, [refund.id]);
      await client.query(`INSERT INTO kai_credit_post_acceptance_refund_escalations(id, order_id, refund_id,
          buyer_subject_id, supplier_subject_id, escalated_by_user_id, escalated_by_side,
          provider_response_ciphertext, provider_response_digest, escalated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'provider', $7, $8, $9)`,
      [randomUUID(), order.id, refund.id, order.buyerSubjectId, order.supplierSubjectId, input.userId,
        input.responseCiphertext, input.responseDigest, input.now]);
      await this.event(client, order.id, input.userId, 'provider', 'POST_ACCEPTANCE_REFUND_CONTESTED',
        'accepted', 'accepted', { responseDigest: input.responseDigest });
      await this.audit(client, input, 'KAI_CREDIT_POST_ACCEPTANCE_REFUND_CONTESTED', {
        supplierSubjectId: input.subjectId, responseDigest: input.responseDigest,
      });
      await this.notifyUser(client, order.createdByUserId, '售后申请已交平台处理',
        `订单 ${order.orderNumber} 的提供方提出异议，卡时继续暂停结算。`, 'buyer_order', order.id, order.buyerSubjectId);
      await this.saveAction(client, input, 'contest_post_acceptance_refund', 'aftercare_escalated');
      return { status: 'aftercare_escalated', order };
    });
  }

  async escalatePostAcceptanceRefund(input: Parameters<CreditOrderStore['escalatePostAcceptanceRefund']>[0]): Promise<CreditOrderActionResult> {
    return this.database.transaction(async (client) => {
      await this.lockActionRequest(client, input, 'escalate_post_acceptance_refund');
      const replay = await this.actionReplay(client, input, 'escalate_post_acceptance_refund');
      if (replay) return replay;
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 AND buyer_subject_id = $2 FOR UPDATE`, [input.orderId, input.subjectId]);
      if (!current.rows[0]) return { status: 'not_found' };
      const order = mapOrder(current.rows[0]);
      const refundResult = await client.query<{ id: string; status: string; requested_at: Date }>(`SELECT id, status, requested_at
        FROM kai_credit_order_post_acceptance_refunds WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const refund = refundResult.rows[0];
      const existing = await client.query<{ escalated_by_side: string }>(`SELECT escalated_by_side
        FROM kai_credit_post_acceptance_refund_escalations WHERE order_id = $1 FOR UPDATE`, [order.id]);
      if (order.status === 'accepted' && refund?.status === 'escalated'
        && existing.rows[0]?.escalated_by_side === 'buyer') {
        await this.saveAction(client, input, 'escalate_post_acceptance_refund', 'aftercare_escalated');
        return { status: 'replayed', order };
      }
      if (order.status !== 'accepted' || refund?.status !== 'pending' || existing.rows[0]
        || input.now.getTime() < new Date(refund.requested_at).getTime() + 24 * 60 * 60 * 1_000) {
        await this.saveAction(client, input, 'escalate_post_acceptance_refund', 'invalid_state');
        return { status: 'invalid_state' };
      }
      await client.query(`UPDATE kai_credit_order_post_acceptance_refunds SET status = 'escalated'
        WHERE id = $1`, [refund.id]);
      await client.query(`INSERT INTO kai_credit_post_acceptance_refund_escalations(id, order_id, refund_id,
          buyer_subject_id, supplier_subject_id, escalated_by_user_id, escalated_by_side, escalated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'buyer', $7)`,
      [randomUUID(), order.id, refund.id, order.buyerSubjectId, order.supplierSubjectId, input.userId, input.now]);
      await this.event(client, order.id, input.userId, 'user', 'POST_ACCEPTANCE_REFUND_ESCALATED',
        'accepted', 'accepted', { waitedHours: 24 });
      await this.audit(client, input, 'KAI_CREDIT_POST_ACCEPTANCE_REFUND_ESCALATED', {
        buyerSubjectId: input.subjectId, waitedHours: 24,
      });
      await this.notifySubject(client, order.supplierSubjectId, '售后申请已交平台处理',
        `订单 ${order.orderNumber} 超过 24 小时未处理，卡时继续暂停结算。`, 'provider_order', order.id);
      await this.saveAction(client, input, 'escalate_post_acceptance_refund', 'aftercare_escalated');
      return { status: 'aftercare_escalated', order };
    });
  }

  async decidePostAcceptanceRefund(input: Parameters<CreditOrderStore['decidePostAcceptanceRefund']>[0]) {
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `kai-credit-post-acceptance-decision:${input.operatorId}:${input.clientRequestId}`,
      ]);
      const replay = await client.query<{
        order_id: string; payload_digest: string; decision_id: string;
        outcome: 'full_refund' | 'partial_refund' | 'reject_refund';
      }>(`SELECT r.order_id, r.payload_digest, r.decision_id, d.outcome
        FROM kai_credit_post_acceptance_refund_decision_requests r
        JOIN kai_credit_post_acceptance_refund_decisions d ON d.id = r.decision_id
        WHERE r.operator_id = $1 AND r.client_request_id = $2`, [input.operatorId, input.clientRequestId]);
      if (replay.rows[0]) {
        if (replay.rows[0].order_id !== input.orderId || replay.rows[0].payload_digest !== input.payloadDigest) {
          return { status: 'conflict' as const };
        }
        const orderResult = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders WHERE id = $1`,
        [input.orderId]);
        if (!orderResult.rows[0]) throw new Error('KAI_CREDIT_POST_ACCEPTANCE_DECISION_REPLAY_MISSING');
        return { status: 'replayed' as const, order: mapOrder(orderResult.rows[0]),
          decisionId: replay.rows[0].decision_id, outcome: replay.rows[0].outcome };
      }
      const operator = await client.query<{ id: string }>(`SELECT id FROM users
        WHERE id = $1 AND role IN ('operator', 'admin') AND status = 'active' FOR UPDATE`, [input.operatorId]);
      if (!operator.rows[0]) return { status: 'not_found' as const };
      const current = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
        WHERE id = $1 FOR UPDATE`, [input.orderId]);
      if (!current.rows[0]) return { status: 'not_found' as const };
      const order = mapOrder(current.rows[0]);
      const refundResult = await client.query<{
        id: string; status: string; credit_micros: string;
      }>(`SELECT id, status, credit_micros::text FROM kai_credit_order_post_acceptance_refunds
        WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const refund = refundResult.rows[0];
      const escalationResult = await client.query<{ id: string; status: string }>(`SELECT id, status
        FROM kai_credit_post_acceptance_refund_escalations WHERE order_id = $1 FOR UPDATE`, [order.id]);
      const escalation = escalationResult.rows[0];
      const acceptance = await this.lockAcceptance(client, order.id);
      const held = await client.query<{ status: string }>(`SELECT status FROM kai_credit_order_reservations
        WHERE order_id = $1 FOR UPDATE`, [order.id]);
      if (order.status !== 'accepted' || refund?.status !== 'escalated' || escalation?.status !== 'pending'
        || !acceptance || held.rows[0]?.status !== 'captured') return { status: 'invalid_state' as const };
      const decisionOutcome: 'full_refund' | 'partial_refund' | 'reject_refund' = input.outcome === 'reject_refund' ? 'reject_refund'
        : (BigInt(refund.credit_micros) === order.totalCreditMicros ? 'full_refund' : 'partial_refund');

      let refundTransactionId: string | null = null;
      let updated: OrderRow = current.rows[0];
      if (decisionOutcome !== 'reject_refund') {
        const subjects = await client.query<{ id: string }>(`SELECT id FROM trading_subjects
          WHERE id = ANY($1::uuid[]) AND status IN ('active', 'suspended') ORDER BY id FOR UPDATE`,
        [[order.buyerSubjectId, order.supplierSubjectId].sort()]);
        if (subjects.rows.length !== 2) throw new Error('TRADING_SUBJECT_REQUIRED');
        await client.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
          VALUES ($1, 'subject', $2, $3, 'available', false)
          ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
        [randomUUID(), order.buyerSubjectId, `subject:${order.buyerSubjectId}:available`]);
        const accounts = await client.query<{ id: string; subject_id: string; account_kind: string }>(`SELECT id,
          subject_id, account_kind FROM kai_credit_accounts WHERE
          (subject_id = $1 AND account_kind = 'available')
          OR (subject_id = $2 AND account_kind = 'supplier_receivable') ORDER BY id FOR UPDATE`,
        [order.buyerSubjectId, order.supplierSubjectId]);
        const buyerAvailable = accounts.rows.find((account) => account.subject_id === order.buyerSubjectId)?.id;
        const supplierReceivable = accounts.rows.find((account) => account.subject_id === order.supplierSubjectId)?.id;
        if (!buyerAvailable || !supplierReceivable) throw new Error('KAI_CREDIT_POST_ACCEPT_DECISION_ACCOUNTS_MISSING');
        refundTransactionId = randomUUID();
        await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
            payload_digest, reference_type, reference_id, description, status)
          VALUES ($1, $2, 'CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND', $3, $4, 'refund', $5, $6, 'pending')`,
        [refundTransactionId, `subject:${order.buyerSubjectId}`, `order-post-accept-decision:${order.id}`,
          input.decisionDigest, order.id, `订单 ${order.orderNumber} 验收后平台裁定全额退款`]);
        await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
          ($1, $2, $3, $4, '验收后平台退款'), ($5, $2, $6, $7, '验收后平台退款转出')`,
        [randomUUID(), refundTransactionId, buyerAvailable, refund.credit_micros, randomUUID(), supplierReceivable,
          (-BigInt(refund.credit_micros)).toString()]);
        await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`,
        [refundTransactionId, input.now]);
        const fullRefund = BigInt(refund.credit_micros) === order.totalCreditMicros;
        if ((decisionOutcome === 'full_refund') !== fullRefund) throw new Error('KAI_CREDIT_AFTERCARE_OUTCOME_AMOUNT_MISMATCH');
        const update = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = $2
          WHERE id = $1 RETURNING ${orderColumns}`, [order.id, fullRefund ? 'refunded' : 'accepted']);
        updated = update.rows[0]!;
        await client.query(`UPDATE kai_credit_order_post_acceptance_refunds SET status = 'succeeded',
          approved_by_user_id = NULL, refund_transaction_id = $2, resolved_at = $3 WHERE id = $1`,
        [refund.id, refundTransactionId, input.now]);
      } else {
        await client.query(`UPDATE kai_credit_order_post_acceptance_refunds SET status = 'rejected',
          approved_by_user_id = NULL, refund_transaction_id = NULL, resolved_at = $2 WHERE id = $1`,
        [refund.id, input.now]);
      }
      await client.query(`UPDATE kai_credit_post_acceptance_refund_escalations
        SET status = 'resolved', resolved_at = $2 WHERE id = $1`, [escalation.id, input.now]);
      const decisionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_post_acceptance_refund_decisions(id, order_id, refund_id,
          escalation_id, operator_id, outcome, reason_ciphertext, reason_digest, decision_digest,
          credit_micros, refund_transaction_id, decided_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [decisionId, order.id, refund.id, escalation.id, input.operatorId, decisionOutcome,
        input.reasonCiphertext, input.reasonDigest, input.decisionDigest,
        decisionOutcome !== 'reject_refund' ? refund.credit_micros : '0', refundTransactionId, input.now]);
      await client.query(`INSERT INTO kai_credit_post_acceptance_refund_decision_requests(operator_id,
          client_request_id, order_id, payload_digest, decision_id) VALUES ($1, $2, $3, $4, $5)`,
      [input.operatorId, input.clientRequestId, order.id, input.payloadDigest, decisionId]);
      await this.event(client, order.id, input.operatorId, 'operator', 'POST_ACCEPTANCE_REFUND_DECIDED',
        'accepted', decisionOutcome === 'full_refund' ? 'refunded' : 'accepted', {
          outcome: decisionOutcome, reasonDigest: input.reasonDigest,
          refundedCreditMicros: decisionOutcome !== 'reject_refund' ? refund.credit_micros : '0', refundTransactionId,
        });
      await client.query(`INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id,
          request_id, ip_hash, payload_digest, metadata) VALUES
        ($1, $2, 'operator', 'KAI_CREDIT_POST_ACCEPTANCE_REFUND_DECIDED', 'KAI_CREDIT_ORDER',
          $3, $4, $5, $6, $7::jsonb)`,
      [randomUUID(), input.operatorId, order.id, input.requestId, input.ipHash, input.payloadDigest, JSON.stringify({
        outcome: decisionOutcome, reasonDigest: input.reasonDigest,
        refundedCreditMicros: decisionOutcome !== 'reject_refund' ? refund.credit_micros : '0', refundTransactionId,
      })]);
      const approved = decisionOutcome !== 'reject_refund';
      const partial = decisionOutcome === 'partial_refund';
      const title = approved ? (partial ? '补偿卡时已到账' : '售后退款已完成') : '售后申请已处理';
      const amount = formatCreditDisplayMicros(BigInt(refund.credit_micros));
      const buyerBody = approved
        ? `订单 ${order.orderNumber} 已退回 ${amount} 卡时。`
        : `订单 ${order.orderNumber} 的补偿申请未获支持，卡时将按原结算安排处理。`;
      const providerBody = approved
        ? `订单 ${order.orderNumber} 已由平台裁定退回 ${amount} 卡时。`
        : `订单 ${order.orderNumber} 的售后申请已驳回，卡时恢复结算。`;
      await this.notifyUser(client, order.createdByUserId, title, buyerBody, 'buyer_order', order.id, order.buyerSubjectId);
      await this.notifySubject(client, order.supplierSubjectId, title, providerBody, 'provider_order', order.id);
      return { status: 'decided' as const, order: mapOrder(updated), decisionId, outcome: decisionOutcome };
    });
  }

  async deliveryForSubject(subjectId: string, orderId: string) {
    const orderResult = await this.database.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders
      WHERE id = $1 AND (buyer_subject_id = $2 OR supplier_subject_id = $2)`, [orderId, subjectId]);
    const order = orderResult.rows[0];
    if (!order) return null;
    const attempts = await this.database.query<{
      id: string; attempt_number: number; status: 'provisioning' | 'ready' | 'completed' | 'superseded' | 'refunded';
      delivery_payload_ciphertext: string | null; delivery_payload_digest: string | null;
      started_at: Date; ready_at: Date | null;
    }>(`SELECT id, attempt_number, status, delivery_payload_ciphertext, delivery_payload_digest,
        started_at, ready_at FROM kai_credit_order_deliveries WHERE order_id = $1 ORDER BY attempt_number`, [orderId]);
    return { order: mapOrder(order), attempts: attempts.rows.map((attempt) => ({
      id: attempt.id, attemptNumber: attempt.attempt_number, status: attempt.status,
      deliveryPayloadCiphertext: attempt.delivery_payload_ciphertext,
      deliveryPayloadDigest: attempt.delivery_payload_digest, startedAt: new Date(attempt.started_at),
      readyAt: attempt.ready_at ? new Date(attempt.ready_at) : null,
    })) };
  }

  async deliveryIssueForSubject(subjectId: string, orderId: string) {
    const result = await this.database.query<OrderRow & {
      requested_resolution: 'rework' | 'refund'; description_ciphertext: string;
      description_digest: string; issue_status: 'open' | 'rework_started' | 'reworked' | 'escalated' | 'dismissed' | 'refunded'; opened_at: Date;
    }>(`SELECT ${joinedOrderColumns}, i.requested_resolution, i.description_ciphertext,
        i.description_digest, i.status AS issue_status, i.opened_at
      FROM kai_credit_orders o JOIN kai_credit_order_delivery_issues i ON i.order_id = o.id
      WHERE o.id = $1 AND (o.buyer_subject_id = $2 OR o.supplier_subject_id = $2)
      ORDER BY i.opened_at DESC LIMIT 1`, [orderId, subjectId]);
    const row = result.rows[0];
    return row ? {
      order: mapOrder(row), requestedResolution: row.requested_resolution,
      descriptionCiphertext: row.description_ciphertext, descriptionDigest: row.description_digest,
      status: row.issue_status, openedAt: new Date(row.opened_at),
    } : null;
  }

  async mutualRefundForSubject(subjectId: string, orderId: string) {
    const result = await this.database.query<OrderRow & {
      credit_micros: string; refund_status: 'succeeded'; approved_at: Date;
    }>(`SELECT ${joinedOrderColumns}, r.credit_micros::text, r.status AS refund_status, r.approved_at
      FROM kai_credit_orders o JOIN kai_credit_order_mutual_refunds r ON r.order_id = o.id
      WHERE o.id = $1 AND (o.buyer_subject_id = $2 OR o.supplier_subject_id = $2)`, [orderId, subjectId]);
    const row = result.rows[0];
    return row ? {
      order: mapOrder(row), creditMicros: BigInt(row.credit_micros), status: row.refund_status,
      approvedAt: new Date(row.approved_at),
    } : null;
  }

  async supplierSettlementForSubject(subjectId: string, orderId: string) {
    const result = await this.database.query<OrderRow & {
      credit_micros: string; settlement_status: 'succeeded'; triggered_by: 'provider' | 'system';
      accepted_at: Date; available_at: Date; settled_at: Date;
    }>(`SELECT ${joinedOrderColumns}, s.credit_micros::text, s.status AS settlement_status,
        s.triggered_by, a.accepted_at, s.available_at, s.settled_at
      FROM kai_credit_orders o JOIN kai_credit_supplier_settlements s ON s.order_id = o.id
      JOIN kai_credit_order_acceptances a ON a.id = s.acceptance_id
      WHERE o.id = $1 AND (o.buyer_subject_id = $2 OR o.supplier_subject_id = $2)`, [orderId, subjectId]);
    const row = result.rows[0];
    return row ? {
      order: mapOrder(row), creditMicros: BigInt(row.credit_micros), status: row.settlement_status,
      triggeredBy: row.triggered_by, acceptedAt: new Date(row.accepted_at),
      availableAt: new Date(row.available_at), settledAt: new Date(row.settled_at),
    } : null;
  }

  async postAcceptanceRefundForSubject(subjectId: string, orderId: string) {
    const result = await this.database.query<OrderRow & {
      refund_status: 'pending' | 'escalated' | 'succeeded' | 'rejected'; description_ciphertext: string;
      description_digest: string; credit_micros: string; requested_at: Date; resolved_at: Date | null;
      escalated_by_side: 'buyer' | 'provider' | null; escalated_at: Date | null;
      provider_response_ciphertext: string | null; provider_response_digest: string | null;
      outcome: 'full_refund' | 'partial_refund' | 'reject_refund' | null; decision_reason_ciphertext: string | null;
      decision_reason_digest: string | null; decided_at: Date | null;
    }>(`SELECT ${joinedOrderColumns}, p.status AS refund_status, p.description_ciphertext,
        p.description_digest, p.credit_micros::text, p.requested_at, p.resolved_at,
        e.escalated_by_side, e.escalated_at, e.provider_response_ciphertext, e.provider_response_digest,
        d.outcome, d.reason_ciphertext AS decision_reason_ciphertext,
        d.reason_digest AS decision_reason_digest, d.decided_at
      FROM kai_credit_orders o JOIN kai_credit_order_post_acceptance_refunds p ON p.order_id = o.id
      LEFT JOIN kai_credit_post_acceptance_refund_escalations e ON e.refund_id = p.id
      LEFT JOIN kai_credit_post_acceptance_refund_decisions d ON d.refund_id = p.id
      WHERE o.id = $1 AND (o.buyer_subject_id = $2 OR o.supplier_subject_id = $2)`, [orderId, subjectId]);
    const row = result.rows[0];
    return row ? {
      order: mapOrder(row), status: row.refund_status, descriptionCiphertext: row.description_ciphertext,
      descriptionDigest: row.description_digest, creditMicros: BigInt(row.credit_micros),
      requestedAt: new Date(row.requested_at), resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
      escalatedBySide: row.escalated_by_side, escalatedAt: row.escalated_at ? new Date(row.escalated_at) : null,
      providerResponseCiphertext: row.provider_response_ciphertext,
      providerResponseDigest: row.provider_response_digest, outcome: row.outcome,
      decisionReasonCiphertext: row.decision_reason_ciphertext,
      decisionReasonDigest: row.decision_reason_digest,
      decidedAt: row.decided_at ? new Date(row.decided_at) : null,
    } : null;
  }

  async listPendingPostAcceptanceRefundAdjudications(limit: number) {
    const result = await this.database.query<OrderRow & {
      refund_id: string; escalated_by_side: 'buyer' | 'provider'; escalated_at: Date;
      description_ciphertext: string; description_digest: string;
      provider_response_ciphertext: string | null; provider_response_digest: string | null;
      attempt_number: number; delivery_payload_ciphertext: string; delivery_payload_digest: string;
      credit_micros: string;
    }>(`SELECT ${joinedOrderColumns}, p.id AS refund_id, e.escalated_by_side, e.escalated_at,
        p.description_ciphertext, p.description_digest, p.credit_micros::text, e.provider_response_ciphertext,
        e.provider_response_digest, dl.attempt_number, dl.delivery_payload_ciphertext, dl.delivery_payload_digest
      FROM kai_credit_post_acceptance_refund_escalations e
      JOIN kai_credit_order_post_acceptance_refunds p ON p.id = e.refund_id
      JOIN kai_credit_orders o ON o.id = e.order_id
      JOIN kai_credit_order_acceptances a ON a.id = p.acceptance_id
      JOIN kai_credit_order_deliveries dl ON dl.id = a.delivery_attempt_id
      WHERE e.status = 'pending' ORDER BY e.escalated_at, e.id LIMIT $1`, [limit]);
    return result.rows.map((row) => ({
      order: mapOrder(row), refundId: row.refund_id, escalatedBySide: row.escalated_by_side,
      escalatedAt: new Date(row.escalated_at), descriptionCiphertext: row.description_ciphertext,
      descriptionDigest: row.description_digest,
      providerResponseCiphertext: row.provider_response_ciphertext,
      providerResponseDigest: row.provider_response_digest, deliveryAttemptNumber: row.attempt_number,
      deliveryPayloadCiphertext: row.delivery_payload_ciphertext,
      deliveryPayloadDigest: row.delivery_payload_digest, creditMicros: BigInt(row.credit_micros),
    }));
  }

  async disputeAdjudicationForSubject(subjectId: string, orderId: string) {
    const result = await this.database.query<OrderRow & {
      escalation_status: 'pending' | 'resolved'; escalated_by_side: 'buyer' | 'provider'; escalated_at: Date;
      outcome: 'full_refund' | 'resume_acceptance' | null; reason_ciphertext: string | null;
      reason_digest: string | null; credit_micros: string | null; decided_at: Date | null;
    }>(`SELECT ${joinedOrderColumns}, e.status AS escalation_status, e.escalated_by_side, e.escalated_at,
        d.outcome, d.reason_ciphertext, d.reason_digest, d.credit_micros::text, d.decided_at
      FROM kai_credit_orders o JOIN kai_credit_order_dispute_escalations e ON e.order_id = o.id
      LEFT JOIN kai_credit_order_dispute_decisions d ON d.escalation_id = e.id
      WHERE o.id = $1 AND (o.buyer_subject_id = $2 OR o.supplier_subject_id = $2)`, [orderId, subjectId]);
    const row = result.rows[0];
    return row ? {
      order: mapOrder(row), status: row.escalation_status, escalatedBySide: row.escalated_by_side,
      escalatedAt: new Date(row.escalated_at), outcome: row.outcome, reasonCiphertext: row.reason_ciphertext,
      reasonDigest: row.reason_digest, creditMicros: row.credit_micros === null ? null : BigInt(row.credit_micros),
      decidedAt: row.decided_at ? new Date(row.decided_at) : null,
    } : null;
  }

  async listPendingDisputeAdjudications(limit: number) {
    const result = await this.database.query<OrderRow & {
      delivery_issue_id: string; escalated_by_side: 'buyer' | 'provider'; escalated_at: Date;
      requested_resolution: 'refund'; description_ciphertext: string; description_digest: string;
      attempt_number: number; delivery_payload_ciphertext: string; delivery_payload_digest: string;
    }>(`SELECT ${joinedOrderColumns}, e.delivery_issue_id, e.escalated_by_side, e.escalated_at,
        i.requested_resolution, i.description_ciphertext, i.description_digest, d.attempt_number,
        d.delivery_payload_ciphertext, d.delivery_payload_digest
      FROM kai_credit_order_dispute_escalations e JOIN kai_credit_orders o ON o.id = e.order_id
      JOIN kai_credit_order_delivery_issues i ON i.id = e.delivery_issue_id
      JOIN kai_credit_order_deliveries d ON d.id = i.delivery_attempt_id
      WHERE e.status = 'pending' ORDER BY e.escalated_at, e.id LIMIT $1`, [limit]);
    return result.rows.map((row) => ({
      order: mapOrder(row), deliveryIssueId: row.delivery_issue_id, escalatedBySide: row.escalated_by_side,
      escalatedAt: new Date(row.escalated_at), requestedResolution: row.requested_resolution,
      descriptionCiphertext: row.description_ciphertext, descriptionDigest: row.description_digest,
      deliveryAttemptNumber: row.attempt_number, deliveryPayloadCiphertext: row.delivery_payload_ciphertext,
      deliveryPayloadDigest: row.delivery_payload_digest,
    }));
  }

  async expireReservations(now: Date, limit: number) {
    return this.database.transaction(async (client) => {
      const candidates = await client.query<{
        id: string; order_id: string; listing_id: string; buyer_subject_id: string; quantity: string;
        credit_micros: string; created_by_user_id: string; order_number: string;
      }>(`SELECT r.id, r.order_id, r.listing_id, r.buyer_subject_id, r.quantity::text, r.credit_micros::text,
          o.created_by_user_id, o.order_number
        FROM kai_credit_order_reservations r JOIN kai_credit_orders o ON o.id = r.order_id
        WHERE r.status = 'active' AND r.expires_at <= $1 AND o.status = 'reserved'
        ORDER BY r.expires_at, r.created_at LIMIT $2 FOR UPDATE OF o SKIP LOCKED`, [now, limit]);
      for (const reservation of candidates.rows) {
        const locked = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders WHERE id = $1`, [reservation.order_id]);
        if (!locked.rows[0]) throw new Error('KAI_CREDIT_ORDER_MISSING');
        await this.expireLockedReservation(client, mapOrder(locked.rows[0]), now);
      }
      return candidates.rows.length;
    });
  }

  private async lockAcceptance(client: PoolClient, orderId: string) {
    const result = await client.query<{
      id: string; accepted_at: Date; capture_transaction_id: string; available_at: Date;
    }>(`SELECT id, accepted_at, capture_transaction_id, accepted_at + interval '7 days' AS available_at
      FROM kai_credit_order_acceptances WHERE order_id = $1 FOR UPDATE`, [orderId]);
    const row = result.rows[0];
    return row ? {
      id: row.id, accepted_at: new Date(row.accepted_at), capture_transaction_id: row.capture_transaction_id,
      available_at: new Date(row.available_at),
    } : null;
  }

  private async settleLockedSupplierOrder(
    client: PoolClient,
    order: CreditOrderRecord,
    acceptance: Readonly<{ id: string; accepted_at: Date; capture_transaction_id: string; available_at: Date }>,
    now: Date,
    trigger: Readonly<{
      triggeredBy: 'provider' | 'system'; userId: string | null; requestId: string;
      ipHash: string | null; payloadDigest: string;
    }>,
  ) {
    if (order.status !== 'accepted' || acceptance.available_at > now) throw new Error('KAI_CREDIT_SETTLEMENT_NOT_DUE');
    const reservation = await client.query<{ status: string; credit_micros: string; resolution_transaction_id: string | null }>(
      `SELECT status, credit_micros::text, resolution_transaction_id FROM kai_credit_order_reservations
       WHERE order_id = $1 FOR UPDATE`, [order.id],
    );
    const held = reservation.rows[0];
    if (held?.status !== 'captured' || held.resolution_transaction_id !== acceptance.capture_transaction_id
      || BigInt(held.credit_micros) !== order.totalCreditMicros) {
      throw new Error('KAI_CREDIT_SETTLEMENT_CAPTURE_INVALID');
    }
    const compensation = await client.query<{ credit_micros: string }>(`SELECT COALESCE(sum(credit_micros), 0)::text
      AS credit_micros FROM kai_credit_order_post_acceptance_refunds
      WHERE order_id = $1 AND status = 'succeeded'`, [order.id]);
    const settlementCreditMicros = order.totalCreditMicros - BigInt(compensation.rows[0]?.credit_micros ?? '0');
    if (settlementCreditMicros <= 0n) throw new Error('KAI_CREDIT_SETTLEMENT_AMOUNT_INVALID');
    const subjects = await client.query<{ id: string }>(`SELECT id FROM trading_subjects
      WHERE id = $1 AND status IN ('active', 'suspended') FOR UPDATE`, [order.supplierSubjectId]);
    if (!subjects.rows[0]) throw new Error('ACTIVE_TRADING_SUBJECT_REQUIRED');
    await client.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
      VALUES ($1, 'subject', $2, $3, 'available', false)
      ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
    [randomUUID(), order.supplierSubjectId, `subject:${order.supplierSubjectId}:available`]);
    const accounts = await client.query<{ id: string; account_kind: 'available' | 'supplier_receivable' }>(`SELECT id,
        account_kind FROM kai_credit_accounts WHERE subject_id = $1
        AND account_kind IN ('available', 'supplier_receivable') ORDER BY id FOR UPDATE`, [order.supplierSubjectId]);
    const available = accounts.rows.find((row) => row.account_kind === 'available')?.id;
    const receivable = accounts.rows.find((row) => row.account_kind === 'supplier_receivable')?.id;
    if (!available || !receivable) throw new Error('KAI_CREDIT_SETTLEMENT_ACCOUNTS_MISSING');
    const settlementTransactionId = randomUUID();
    await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
        payload_digest, reference_type, reference_id, description, status)
      VALUES ($1, $2, 'CREDIT_SUPPLIER_SETTLEMENT', $3, $4, 'settlement', $5, $6, 'pending')`,
    [settlementTransactionId, `subject:${order.supplierSubjectId}`, `order-settlement:${order.id}`,
      `order-settlement:${order.id}:${settlementCreditMicros}`, order.id, `订单 ${order.orderNumber} 提供方结算`]);
    await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
      ($1, $2, $3, $4, '提供方结算到账'), ($5, $2, $6, $7, '提供方结算转出')`,
    [randomUUID(), settlementTransactionId, available, settlementCreditMicros.toString(), randomUUID(), receivable,
      (-settlementCreditMicros).toString()]);
    await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`,
    [settlementTransactionId, now]);
    const updated = await client.query<OrderRow>(`UPDATE kai_credit_orders SET status = 'closed'
      WHERE id = $1 AND status = 'accepted' RETURNING ${orderColumns}`, [order.id]);
    if (!updated.rows[0]) throw new Error('KAI_CREDIT_SETTLEMENT_ORDER_STATE_CHANGED');
    await client.query(`INSERT INTO kai_credit_supplier_settlements(id, order_id, acceptance_id,
        supplier_subject_id, triggered_by, settled_by_user_id, credit_micros, settlement_transaction_id,
        status, available_at, settled_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded', $9, $10)`,
    [randomUUID(), order.id, acceptance.id, order.supplierSubjectId, trigger.triggeredBy, trigger.userId,
      settlementCreditMicros.toString(), settlementTransactionId, acceptance.available_at, now]);
    await this.event(client, order.id, trigger.userId, trigger.triggeredBy === 'system' ? 'system' : 'provider',
      'SUPPLIER_CREDITS_SETTLED', 'accepted', 'closed', {
        settledCreditMicros: settlementCreditMicros.toString(), settlementTransactionId,
        availableAt: acceptance.available_at.toISOString(), triggeredBy: trigger.triggeredBy,
      });
    await client.query(`INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id,
        request_id, ip_hash, payload_digest, metadata) VALUES
      ($1, $2, $3, 'KAI_CREDIT_SUPPLIER_SETTLED', 'KAI_CREDIT_ORDER', $4, $5, $6, $7, $8::jsonb)`,
    [randomUUID(), trigger.userId, trigger.triggeredBy === 'system' ? 'system' : 'provider', order.id,
      trigger.requestId, trigger.ipHash, trigger.payloadDigest, JSON.stringify({
        supplierSubjectId: order.supplierSubjectId, settledCreditMicros: settlementCreditMicros.toString(),
        settlementTransactionId, availableAt: acceptance.available_at.toISOString(), triggeredBy: trigger.triggeredBy,
      })]);
    await this.notifySubject(client, order.supplierSubjectId, '卡时已结算',
      `订单 ${order.orderNumber} 的卡时已转入可用账户。`, 'provider_order', order.id);
    return mapOrder(updated.rows[0]);
  }

  private async actionReplay(
    client: PoolClient,
    input: Parameters<CreditOrderStore['confirm']>[0],
    action: 'confirm' | 'cancel' | 'start_delivery' | 'delivery_ready' | 'accept' | 'report_delivery_issue' | 'start_rework' | 'approve_refund' | 'settle' | 'escalate_dispute' | 'request_post_acceptance_refund' | 'approve_post_acceptance_refund' | 'contest_post_acceptance_refund' | 'escalate_post_acceptance_refund',
  ): Promise<CreditOrderActionResult | null> {
    const result = await client.query<{ order_id: string; payload_digest: string; result: 'confirmed' | 'cancelled' | 'expired' | 'provisioning' | 'acceptance_pending' | 'accepted' | 'disputed' | 'refunded' | 'settled' | 'escalated' | 'aftercare_pending' | 'aftercare_escalated' | 'invalid_state' }>(
      `SELECT order_id, payload_digest, result FROM kai_credit_order_action_requests
       WHERE subject_id = $1 AND action = $2 AND client_request_id = $3`,
      [input.subjectId, action, input.clientRequestId],
    );
    const replay = result.rows[0];
    if (!replay) return null;
    if (replay.order_id !== input.orderId || replay.payload_digest !== input.payloadDigest) return { status: 'conflict' };
    if (replay.result === 'expired' || replay.result === 'invalid_state') return { status: replay.result };
    const order = await client.query<OrderRow>(`SELECT ${orderColumns} FROM kai_credit_orders WHERE id = $1`, [replay.order_id]);
    if (!order.rows[0]) throw new Error('KAI_CREDIT_ORDER_ACTION_REPLAY_MISSING');
    return { status: 'replayed', order: mapOrder(order.rows[0]) };
  }

  private async lockActionRequest(
    client: PoolClient,
    input: Parameters<CreditOrderStore['confirm']>[0],
    action: 'confirm' | 'cancel' | 'start_delivery' | 'delivery_ready' | 'accept' | 'report_delivery_issue' | 'start_rework' | 'approve_refund' | 'settle' | 'escalate_dispute' | 'request_post_acceptance_refund' | 'approve_post_acceptance_refund' | 'contest_post_acceptance_refund' | 'escalate_post_acceptance_refund',
  ) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `kai-credit-order-action:${input.subjectId}:${action}:${input.clientRequestId}`,
    ]);
  }

  private saveAction(
    client: PoolClient,
    input: Parameters<CreditOrderStore['confirm']>[0],
    action: 'confirm' | 'cancel' | 'start_delivery' | 'delivery_ready' | 'accept' | 'report_delivery_issue' | 'start_rework' | 'approve_refund' | 'settle' | 'escalate_dispute' | 'request_post_acceptance_refund' | 'approve_post_acceptance_refund' | 'contest_post_acceptance_refund' | 'escalate_post_acceptance_refund',
    result: 'confirmed' | 'cancelled' | 'expired' | 'provisioning' | 'acceptance_pending' | 'accepted' | 'disputed' | 'refunded' | 'settled' | 'escalated' | 'aftercare_pending' | 'aftercare_escalated' | 'invalid_state',
  ) {
    return client.query(`INSERT INTO kai_credit_order_action_requests(subject_id, action, client_request_id,
      order_id, payload_digest, result) VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.subjectId, action, input.clientRequestId, input.orderId, input.payloadDigest, result]).then(() => undefined);
  }

  private async releaseLockedReservation(
    client: PoolClient,
    order: CreditOrderRecord,
    now: Date,
    targetStatus: 'expired' | 'released',
    reason: string,
  ) {
    const reservation = await client.query<{
      id: string; listing_id: string; buyer_subject_id: string; quantity: string; credit_micros: string; status: string;
    }>(`SELECT id, listing_id, buyer_subject_id, quantity::text, credit_micros::text, status
      FROM kai_credit_order_reservations WHERE order_id = $1 FOR UPDATE`, [order.id]);
    const row = reservation.rows[0];
    if (!row || row.status !== 'active') throw new Error('ACTIVE_KAI_CREDIT_ORDER_RESERVATION_REQUIRED');
    const listing = await client.query<{ status: string }>(`SELECT status FROM credit_market_listings WHERE id = $1 FOR UPDATE`, [row.listing_id]);
    if (!listing.rows[0]) throw new Error('KAI_CREDIT_ORDER_LISTING_MISSING');
    const accounts = await this.ensureBuyerAccounts(client, row.buyer_subject_id);
    const releaseTransactionId = randomUUID();
    const payloadDigest = `order-release:${order.id}:${row.credit_micros}:${reason}`;
    await client.query(`INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key,
        payload_digest, reference_type, reference_id, description, status)
      VALUES ($1, $2, 'CREDIT_ORDER_RELEASE', $3, $4, 'order_release', $5, $6, 'pending')`,
    [releaseTransactionId, `subject:${row.buyer_subject_id}`, `order-release:${order.id}`, payloadDigest,
      order.id, `订单 ${order.orderNumber} 预留释放`]);
    await client.query(`INSERT INTO kai_credit_entries(id, transaction_id, account_id, amount_micros, memo) VALUES
      ($1, $2, $3, $4, '订单预留退回'), ($5, $2, $6, $7, '订单预留退回')`,
    [randomUUID(), releaseTransactionId, accounts.available, row.credit_micros, randomUUID(),
      accounts.reserved, (-BigInt(row.credit_micros)).toString()]);
    await client.query(`UPDATE kai_credit_transactions SET status = 'posted', posted_at = $2 WHERE id = $1`, [releaseTransactionId, now]);
    await client.query(`UPDATE kai_credit_order_reservations SET status = $2, resolved_at = $3,
      resolution_transaction_id = $4, resolution_reason = $5 WHERE id = $1`,
    [row.id, targetStatus, now, releaseTransactionId, reason]);
    await client.query(`UPDATE credit_market_listings l SET capacity_reserved = capacity_reserved - $2,
      status = CASE WHEN l.status = 'sold_out' AND l.starts_at <= $3 AND l.expires_at > $3
        AND EXISTS (SELECT 1 FROM offer_templates o JOIN compute_resources r ON r.id = o.resource_id
          JOIN supplier_profiles s ON s.id = o.supplier_id WHERE o.id = l.offer_id AND o.status = 'approved'
          AND o.audit_valid_until > $3 AND r.status = 'verified' AND s.status = 'approved')
        THEN 'active' ELSE l.status END WHERE l.id = $1`, [row.listing_id, row.quantity, now]);
    return { creditMicros: BigInt(row.credit_micros), quantity: row.quantity, transactionId: releaseTransactionId };
  }

  private async expireLockedReservation(client: PoolClient, order: CreditOrderRecord, now: Date) {
    const released = await this.releaseLockedReservation(client, order, now, 'expired', 'supplier_confirmation_timeout');
    await client.query(`UPDATE kai_credit_orders SET status = 'expired', closed_at = $2 WHERE id = $1`, [order.id, now]);
    await this.event(client, order.id, null, 'system', 'ORDER_RESERVATION_EXPIRED', 'reserved', 'expired', {
      quantity: released.quantity, releasedCreditMicros: released.creditMicros.toString(),
    });
    await this.notifyUser(client, order.createdByUserId, '订单预留已退回',
      `订单 ${order.orderNumber} 未在预留时间内确认，卡时和可售数量已全部退回。`,
      'buyer_order', order.id, order.buyerSubjectId);
  }

  private audit(
    client: PoolClient,
    input: Parameters<CreditOrderStore['confirm']>[0],
    action: string,
    metadata: Record<string, unknown>,
  ) {
    return client.query(`INSERT INTO audit_events(id, actor_id, actor_kind, action, entity_type, entity_id,
      request_id, ip_hash, payload_digest, metadata) VALUES
      ($1, $2, 'user', $3, 'KAI_CREDIT_ORDER', $4, $5, $6, $7, $8::jsonb)`,
    [randomUUID(), input.userId, action, input.orderId, input.requestId, input.ipHash, input.payloadDigest,
      JSON.stringify(metadata)]).then(() => undefined);
  }

  private async notifyUser(
    client: PoolClient, userId: string, title: string, body: string, route: string, orderId: string,
    subjectId?: string,
  ) {
    const notificationId = randomUUID();
    await client.query(`INSERT INTO notifications(id, user_id, category, title, body, data) VALUES
      ($1, $2, 'order', $3, $4, $5::jsonb)`,
    [notificationId, userId, title, body, JSON.stringify({ route, orderId, ...(subjectId ? { subjectId } : {}) })]);
    await client.query(`INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload) VALUES
      ($1, 'notification.created', 'NOTIFICATION', $2, $3::jsonb)`,
    [randomUUID(), notificationId, JSON.stringify({ notificationId, userId })]);
  }

  private async notifySubject(
    client: PoolClient, subjectId: string, title: string, body: string, route: string, orderId: string,
  ) {
    const users = await client.query<{ user_id: string }>(`SELECT user_id FROM subject_memberships
      WHERE subject_id = $1 AND status = 'active' AND role IN ('owner', 'admin', 'provider_manager', 'provider_operator')`, [subjectId]);
    for (const user of users.rows) await this.notifyUser(client, user.user_id, title, body, route, orderId, subjectId);
  }

  private async retryable(client: PoolClient, input: Parameters<CreditOrderStore['createReservation']>[0], status: 'commerce_unavailable' | 'listing_unavailable' | 'insufficient_credits' | 'self_purchase') {
    await client.query(`UPDATE kai_credit_order_requests SET state = 'retryable', last_result = $3
      WHERE buyer_subject_id = $1 AND client_request_id = $2`, [input.buyerSubjectId, input.clientRequestId, status]);
    return { status } as const;
  }

  private async ensureBuyerAccounts(client: PoolClient, subjectId: string) {
    const subject = await client.query<{ id: string }>(`SELECT id FROM trading_subjects WHERE id = $1 AND status = 'active' FOR UPDATE`, [subjectId]);
    if (!subject.rows[0]) throw new Error('ACTIVE_TRADING_SUBJECT_REQUIRED');
    for (const kind of ['available', 'reserved'] as const) {
      await client.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
        VALUES ($1, 'subject', $2, $3, $4, false)
        ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
      [randomUUID(), subjectId, `subject:${subjectId}:${kind}`, kind]);
    }
    const result = await client.query<{ id: string; account_kind: 'available' | 'reserved' }>(`SELECT id, account_kind
      FROM kai_credit_accounts WHERE subject_id = $1 AND account_kind IN ('available', 'reserved') ORDER BY id FOR UPDATE`, [subjectId]);
    const accounts = Object.fromEntries(result.rows.map((row) => [row.account_kind, row.id]));
    if (!accounts.available || !accounts.reserved) throw new Error('KAI_CREDIT_BUYER_ACCOUNTS_MISSING');
    return accounts as { available: string; reserved: string };
  }

  private async ensureCaptureAccounts(client: PoolClient, buyerSubjectId: string, supplierSubjectId: string) {
    const subjects = await client.query<{ id: string }>(`SELECT id FROM trading_subjects
      WHERE id = ANY($1::uuid[]) AND status = 'active' ORDER BY id FOR UPDATE`, [[buyerSubjectId, supplierSubjectId].sort()]);
    if (subjects.rows.length !== 2) throw new Error('ACTIVE_TRADING_SUBJECT_REQUIRED');
    await client.query(`INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
      VALUES ($1, 'subject', $2, $3, 'supplier_receivable', false)
      ON CONFLICT (subject_id, account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
    [randomUUID(), supplierSubjectId, `subject:${supplierSubjectId}:supplier_receivable`]);
    const accounts = await client.query<{ id: string; subject_id: string; account_kind: string }>(`SELECT id, subject_id, account_kind
      FROM kai_credit_accounts WHERE (subject_id = $1 AND account_kind = 'reserved')
        OR (subject_id = $2 AND account_kind = 'supplier_receivable') ORDER BY id FOR UPDATE`,
    [buyerSubjectId, supplierSubjectId]);
    const buyerReserved = accounts.rows.find((row) => row.subject_id === buyerSubjectId && row.account_kind === 'reserved')?.id;
    const supplierReceivable = accounts.rows.find((row) => row.subject_id === supplierSubjectId && row.account_kind === 'supplier_receivable')?.id;
    if (!buyerReserved || !supplierReceivable) throw new Error('KAI_CREDIT_CAPTURE_ACCOUNTS_MISSING');
    return { buyerReserved, supplierReceivable };
  }

  private event(client: PoolClient, orderId: string, actorId: string | null, actorKind: 'user' | 'operator' | 'system' | 'provider',
    eventType: string, fromStatus: string | null, toStatus: string, payload: Record<string, unknown>) {
    return client.query(`INSERT INTO kai_credit_order_events(id, order_id, actor_id, actor_kind, event_type,
      from_status, to_status, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [randomUUID(), orderId, actorId, actorKind, eventType, fromStatus, toStatus, JSON.stringify(payload)]).then(() => undefined);
  }

  private async notifySupplier(client: PoolClient, subjectId: string, orderId: string, orderNumber: string,
    title: string, quantity: string, capacityUnit: string, autoConfirmed = false) {
    const users = await client.query<{ user_id: string }>(`SELECT user_id FROM subject_memberships
      WHERE subject_id = $1 AND status = 'active' AND role IN ('owner', 'admin', 'provider_manager', 'provider_operator')`, [subjectId]);
    for (const user of users.rows) {
      const notificationId = randomUUID();
      await client.query(`INSERT INTO notifications(id, user_id, category, title, body, data) VALUES
        ($1, $2, 'order', $3, $4, $5::jsonb)`, [notificationId, user.user_id,
        autoConfirmed ? '有新订单开始开通' : '有新订单待确认',
        `${title} · ${displayDecimal(quantity)} ${capacityUnit}，订单 ${orderNumber}。`,
        JSON.stringify({ route: 'provider_order', orderId, subjectId })]);
      await client.query(`INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload) VALUES
        ($1, 'notification.created', 'NOTIFICATION', $2, $3::jsonb)`,
      [randomUUID(), notificationId, JSON.stringify({ notificationId, userId: user.user_id })]);
    }
  }
}

function scaled(quantity: string) {
  const [whole = '0', fraction = ''] = quantity.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function displayDecimal(value: string) {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function isComputeOrder(order: CreditOrderRecord) {
  const mode = order.listingSnapshot.fulfillmentMode;
  return mode === 'compute_sidecar_v1' || (order.capacityUnit === 'GPU时' && mode !== 'legacy_delivery');
}
