import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../credits/types.js';
import type { VastExternalOrderStatus, VastLaunchConfiguration, VastOffer } from './types.js';

export type VastQuoteRecord = Readonly<{
  id: string;
  buyerSubjectId: string;
  offer: VastOffer;
  configuration: VastLaunchConfiguration;
  creditMicrosPerHour: bigint;
  durationHours: number;
  totalCreditMicros: bigint;
  pricingPolicyVersion: string;
  status: 'active' | 'consumed' | 'stale' | 'expired';
  quotedAt: Date;
  expiresAt: Date;
}>;

export type VastExternalOrderRecord = Readonly<{
  id: string;
  orderNumber: string;
  buyerSubjectId: string;
  createdByUserId: string;
  quoteId: string;
  clientRequestId: string;
  payloadDigest: string;
  providerOfferId: string;
  providerRequestKey: string;
  providerContractId: string | null;
  configuration: VastLaunchConfiguration;
  status: VastExternalOrderStatus;
  totalCreditMicros: bigint;
  failureCode: string | null;
  reconciliationDeadlineAt: Date;
  provisioningAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type VastReserveResult =
  | Readonly<{ status: 'created' | 'replayed'; order: VastExternalOrderRecord }>
  | Readonly<{ status: 'conflict' }>
  | Readonly<{ status: 'quote_unavailable' }>
  | Readonly<{ status: 'insufficient_credits' }>;

export interface VastMarketStore {
  createQuote(input: VastQuoteRecord): Promise<VastQuoteRecord>;
  getQuote(buyerSubjectId: string, quoteId: string): Promise<VastQuoteRecord | null>;
  markQuoteStale(buyerSubjectId: string, quoteId: string): Promise<void>;
  findOrderByRequest(buyerSubjectId: string, clientRequestId: string): Promise<VastExternalOrderRecord | null>;
  getOrder(buyerSubjectId: string, orderId: string): Promise<VastExternalOrderRecord | null>;
  listOrders(buyerSubjectId: string, limit: number): Promise<VastExternalOrderRecord[]>;
  reserve(input: Readonly<{
    id: string; orderNumber: string; buyerSubjectId: string; userId: string; quoteId: string;
    clientRequestId: string; payloadDigest: string; providerRequestKey: string;
    reconciliationDeadlineAt: Date; now: Date;
  }>): Promise<VastReserveResult>;
  markPendingReconciliation(orderId: string, failureCode: string, now: Date): Promise<VastExternalOrderRecord>;
  markProvisioning(orderId: string, providerContractId: string, now: Date): Promise<VastExternalOrderRecord>;
  failAndRelease(orderId: string, failureCode: string, now: Date): Promise<VastExternalOrderRecord>;
  providerBindings(): Promise<ReadonlyArray<Readonly<{
    orderId: string; providerRequestKey: string; providerContractId: string | null; status: VastExternalOrderStatus;
  }>>>;
}

type QuoteRow = QueryResultRow & {
  id: string; buyer_subject_id: string; provider_offer_id: string; configuration: VastLaunchConfiguration;
  provider_snapshot: Record<string, unknown>; provider_cost_micros_per_hour: string; credit_micros_per_hour: string;
  duration_hours: number; total_credit_micros: string; pricing_policy_version: string;
  status: VastQuoteRecord['status']; quoted_at: Date; expires_at: Date;
};
type OrderRow = QueryResultRow & {
  id: string; order_number: string; buyer_subject_id: string; created_by_user_id: string; quote_id: string;
  client_request_id: string; payload_digest: string; provider_offer_id: string; provider_request_key: string;
  provider_contract_id: string | null; configuration: VastLaunchConfiguration; status: VastExternalOrderStatus;
  total_credit_micros: string; failure_code: string | null; reconciliation_deadline_at: Date;
  provisioning_at: Date | null; failed_at: Date | null; created_at: Date; updated_at: Date;
};

const quoteColumns = `id,buyer_subject_id,provider_offer_id::text,configuration,provider_snapshot,
  provider_cost_micros_per_hour::text,credit_micros_per_hour::text,duration_hours,total_credit_micros::text,
  pricing_policy_version,status,quoted_at,expires_at`;
const orderColumns = `id,order_number,buyer_subject_id,created_by_user_id,quote_id,client_request_id,payload_digest,
  provider_offer_id::text,provider_request_key::text,provider_contract_id::text,configuration,status,
  total_credit_micros::text,failure_code,reconciliation_deadline_at,provisioning_at,failed_at,created_at,updated_at`;

export class PostgresVastMarketStore implements VastMarketStore {
  constructor(private readonly database: Database) {}

  async createQuote(input: VastQuoteRecord) {
    const result = await this.database.query<QuoteRow>(`INSERT INTO vast_external_quotes(id,buyer_subject_id,
      provider_source,provider_offer_id,configuration,provider_snapshot,provider_cost_micros_per_hour,
      credit_micros_per_hour,duration_hours,total_credit_micros,pricing_policy_version,status,quoted_at,expires_at)
      VALUES($1,$2,'vast_ai',$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${quoteColumns}`,
    [input.id,input.buyerSubjectId,input.offer.offerId,JSON.stringify(input.configuration),JSON.stringify({
      gpuName: input.offer.gpuName, gpuCount: input.offer.gpuCount, gpuMemoryMb: input.offer.gpuMemoryMb,
      region: input.offer.region, reliability: input.offer.reliability, updatedAt: input.offer.updatedAt.toISOString(),
    }),input.offer.providerCostMicrosPerHour.toString(),input.creditMicrosPerHour.toString(),input.durationHours,
      input.totalCreditMicros.toString(),input.pricingPolicyVersion,input.status,input.quotedAt,input.expiresAt]);
    return mapQuote(result.rows[0]!);
  }

  async getQuote(buyerSubjectId: string, quoteId: string) {
    const result = await this.database.query<QuoteRow>(`SELECT ${quoteColumns} FROM vast_external_quotes
      WHERE id=$1 AND buyer_subject_id=$2`, [quoteId,buyerSubjectId]);
    return result.rows[0] ? mapQuote(result.rows[0]) : null;
  }

  async markQuoteStale(buyerSubjectId: string, quoteId: string) {
    await this.database.query(`UPDATE vast_external_quotes SET status='stale'
      WHERE id=$1 AND buyer_subject_id=$2 AND status='active'`, [quoteId,buyerSubjectId]);
  }

  async findOrderByRequest(buyerSubjectId: string, clientRequestId: string) {
    const result = await this.database.query<OrderRow>(`SELECT ${orderColumns} FROM vast_external_orders
      WHERE buyer_subject_id=$1 AND client_request_id=$2`, [buyerSubjectId,clientRequestId]);
    return result.rows[0] ? mapOrder(result.rows[0]) : null;
  }

  async getOrder(buyerSubjectId: string, orderId: string) {
    const result = await this.database.query<OrderRow>(`SELECT ${orderColumns} FROM vast_external_orders
      WHERE buyer_subject_id=$1 AND id=$2`, [buyerSubjectId,orderId]);
    return result.rows[0] ? mapOrder(result.rows[0]) : null;
  }

  async listOrders(buyerSubjectId: string, limit: number) {
    const result = await this.database.query<OrderRow>(`SELECT ${orderColumns} FROM vast_external_orders
      WHERE buyer_subject_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`, [buyerSubjectId,limit]);
    return result.rows.map(mapOrder);
  }

  async reserve(input: Readonly<{ id: string; orderNumber: string; buyerSubjectId: string; userId: string;
    quoteId: string; clientRequestId: string; payloadDigest: string; providerRequestKey: string;
    reconciliationDeadlineAt: Date; now: Date }>): Promise<VastReserveResult> {
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`vast-order:${input.buyerSubjectId}:${input.clientRequestId}`]);
      const existing = await client.query<OrderRow>(`SELECT ${orderColumns} FROM vast_external_orders
        WHERE buyer_subject_id=$1 AND client_request_id=$2 FOR UPDATE`, [input.buyerSubjectId,input.clientRequestId]);
      if (existing.rows[0]) return existing.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', order: mapOrder(existing.rows[0]) } : { status: 'conflict' };
      const quotes = await client.query<QuoteRow>(`SELECT ${quoteColumns} FROM vast_external_quotes
        WHERE id=$1 AND buyer_subject_id=$2 FOR UPDATE`, [input.quoteId,input.buyerSubjectId]);
      const quote = quotes.rows[0];
      if (!quote || quote.status !== 'active' || new Date(quote.expires_at) <= input.now) {
        if (quote?.status === 'active') await client.query(`UPDATE vast_external_quotes SET status='expired' WHERE id=$1`, [quote.id]);
        return { status: 'quote_unavailable' };
      }
      const accounts = await ensureBuyerAccounts(client,input.buyerSubjectId);
      const balance = await client.query<{ amount: string }>(`SELECT COALESCE(sum(e.amount_micros)
        FILTER(WHERE t.status='posted'),0)::text AS amount FROM kai_credit_entries e
        JOIN kai_credit_transactions t ON t.id=e.transaction_id WHERE e.account_id=$1`, [accounts.available]);
      const total = BigInt(quote.total_credit_micros);
      if (BigInt(balance.rows[0]?.amount ?? '0') < total) return { status: 'insufficient_credits' };
      const transactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,
        payload_digest,reference_type,reference_id,description,status) VALUES($1,$2,'VAST_ORDER_RESERVE',$3,$4,
        'order_reservation',$5,'Vast.ai 算力订单预留卡时','pending')`,
      [transactionId,`subject:${input.buyerSubjectId}`,`vast-order-reserve:${input.id}`,input.payloadDigest,input.id]);
      await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
        ($1,$2,$3,$4,'Vast.ai 算力订单预留'),($5,$2,$6,$7,'Vast.ai 算力订单预留')`,
      [randomUUID(),transactionId,accounts.available,(-total).toString(),randomUUID(),accounts.reserved,total.toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`, [transactionId,input.now]);
      const inserted = await client.query<OrderRow>(`INSERT INTO vast_external_orders(id,order_number,buyer_subject_id,
        created_by_user_id,quote_id,client_request_id,payload_digest,provider_source,provider_offer_id,
        provider_request_key,configuration,status,total_credit_micros,reservation_transaction_id,reconciliation_deadline_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'vast_ai',$8,$9,$10::jsonb,'reserved',$11,$12,$13) RETURNING ${orderColumns}`,
      [input.id,input.orderNumber,input.buyerSubjectId,input.userId,input.quoteId,input.clientRequestId,input.payloadDigest,
        quote.provider_offer_id,input.providerRequestKey,JSON.stringify(quote.configuration),total.toString(),transactionId,
        input.reconciliationDeadlineAt]);
      await client.query(`UPDATE vast_external_quotes SET status='consumed' WHERE id=$1`, [quote.id]);
      await client.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,payload)
        VALUES($1,'vast.order.reserved','VAST_ORDER',$2,$3::jsonb)`,
      [randomUUID(),input.id,JSON.stringify({ orderId:input.id,providerSource:'vast_ai' })]);
      return { status: 'created', order: mapOrder(inserted.rows[0]!) };
    });
  }

  async markPendingReconciliation(orderId: string, failureCode: string, now: Date) {
    const result = await this.database.query<OrderRow>(`UPDATE vast_external_orders SET
      status='pending_reconciliation',failure_code=$2,updated_at=$3
      WHERE id=$1 AND status IN ('reserved','pending_reconciliation') RETURNING ${orderColumns}`,
    [orderId,failureCode,now]);
    if (!result.rows[0]) throw new Error('VAST_ORDER_NOT_RECONCILABLE');
    return mapOrder(result.rows[0]);
  }

  async markProvisioning(orderId: string, providerContractId: string, now: Date) {
    return this.database.transaction(async (client) => {
      const orders = await client.query<OrderRow & { capture_transaction_id: string | null }>(`SELECT ${orderColumns},
        capture_transaction_id::text FROM vast_external_orders WHERE id=$1 FOR UPDATE`, [orderId]);
      const order = orders.rows[0];
      if (!order) throw new Error('VAST_ORDER_NOT_FOUND');
      if (order.status === 'provisioning') {
        if (order.provider_contract_id !== providerContractId || !order.capture_transaction_id) {
          throw new Error('VAST_ORDER_PROVIDER_CONTRACT_CONFLICT');
        }
        return mapOrder(order);
      }
      if (!['reserved','pending_reconciliation'].includes(order.status) || order.provider_contract_id) {
        throw new Error('VAST_ORDER_PROVIDER_CONTRACT_CONFLICT');
      }
      const accounts = await ensureBuyerAccounts(client,order.buyer_subject_id);
      const captureTransactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,
        payload_digest,reference_type,reference_id,description,status) VALUES($1,$2,'VAST_ORDER_CAPTURE',$3,$4,
        'order_capture',$5,'Vast.ai 算力订单扣除卡时','pending')`,
      [captureTransactionId,`subject:${order.buyer_subject_id}`,`vast-order-capture:${order.id}`,order.payload_digest,order.id]);
      await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
        ($1,$2,$3,$4,'Vast.ai 算力订单扣除'),($5,$2,$6,$7,'Vast.ai 外部算力清算')`,
      [randomUUID(),captureTransactionId,accounts.reserved,(-BigInt(order.total_credit_micros)).toString(),randomUUID(),
        KAI_CREDIT_PLATFORM_ACCOUNTS.clearing,order.total_credit_micros]);
      await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,
        [captureTransactionId,now]);
      const result = await client.query<OrderRow>(`UPDATE vast_external_orders SET status='provisioning',
        provider_contract_id=$2,capture_transaction_id=$3,provisioning_at=$4,failure_code=NULL,updated_at=$4
        WHERE id=$1 RETURNING ${orderColumns}`, [order.id,providerContractId,captureTransactionId,now]);
      await client.query(`INSERT INTO outbox_events(id,topic,aggregate_type,aggregate_id,payload)
        VALUES($1,'vast.order.provisioning','VAST_ORDER',$2,$3::jsonb)`,
      [randomUUID(),order.id,JSON.stringify({ orderId:order.id,providerSource:'vast_ai',providerContractId })]);
      return mapOrder(result.rows[0]!);
    });
  }

  async failAndRelease(orderId: string, failureCode: string, now: Date) {
    return this.database.transaction(async (client) => {
      const orders = await client.query<OrderRow>(`SELECT ${orderColumns} FROM vast_external_orders WHERE id=$1 FOR UPDATE`, [orderId]);
      const order = orders.rows[0];
      if (!order) throw new Error('VAST_ORDER_NOT_FOUND');
      if (order.status === 'failed') return mapOrder(order);
      if (order.status === 'provisioning') throw new Error('VAST_ORDER_ALREADY_PROVISIONING');
      const accounts = await ensureBuyerAccounts(client,order.buyer_subject_id);
      const transactionId = randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,
        payload_digest,reference_type,reference_id,description,status) VALUES($1,$2,'VAST_ORDER_RELEASE',$3,$4,
        'order_release',$5,'Vast.ai 算力订单释放卡时','pending')`,
      [transactionId,`subject:${order.buyer_subject_id}`,`vast-order-release:${order.id}`,order.payload_digest,order.id]);
      await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
        ($1,$2,$3,$4,'Vast.ai 算力订单释放'),($5,$2,$6,$7,'Vast.ai 算力订单释放')`,
      [randomUUID(),transactionId,accounts.available,order.total_credit_micros,randomUUID(),accounts.reserved,
        (-BigInt(order.total_credit_micros)).toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`, [transactionId,now]);
      const result = await client.query<OrderRow>(`UPDATE vast_external_orders SET status='failed',failure_code=$2,
        release_transaction_id=$3,failed_at=$4,updated_at=$4 WHERE id=$1 RETURNING ${orderColumns}`,
      [order.id,failureCode,transactionId,now]);
      return mapOrder(result.rows[0]!);
    });
  }

  async providerBindings() {
    const result = await this.database.query<{ order_id: string; provider_request_key: string;
      provider_contract_id: string | null; status: VastExternalOrderStatus }>(`SELECT id AS order_id,
      provider_request_key::text,provider_contract_id::text,status FROM vast_external_orders`);
    return result.rows.map((row) => ({ orderId: row.order_id,providerRequestKey: row.provider_request_key,
      providerContractId: row.provider_contract_id,status: row.status }));
  }
}

async function ensureBuyerAccounts(client: PoolClient, subjectId: string) {
  const subject = await client.query<{ id: string }>(`SELECT id FROM trading_subjects
    WHERE id=$1 AND status='active' FOR UPDATE`, [subjectId]);
  if (!subject.rows[0]) throw new Error('ACTIVE_TRADING_SUBJECT_REQUIRED');
  for (const kind of ['available','reserved'] as const) {
    await client.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
      VALUES($1,'subject',$2,$3,$4,false)
      ON CONFLICT(subject_id,account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
    [randomUUID(),subjectId,`subject:${subjectId}:${kind}`,kind]);
  }
  const accounts = await client.query<{ id: string; account_kind: string }>(`SELECT id,account_kind
    FROM kai_credit_accounts WHERE subject_id=$1 AND account_kind IN ('available','reserved') ORDER BY id FOR UPDATE`, [subjectId]);
  const available = accounts.rows.find((row) => row.account_kind === 'available')?.id;
  const reserved = accounts.rows.find((row) => row.account_kind === 'reserved')?.id;
  if (!available || !reserved) throw new Error('KAI_CREDIT_ACCOUNTS_REQUIRED');
  return { available,reserved };
}

function mapQuote(row: QuoteRow): VastQuoteRecord {
  const snapshot = row.provider_snapshot;
  return {
    id: row.id,buyerSubjectId: row.buyer_subject_id,configuration: row.configuration,
    offer: { offerId: row.provider_offer_id,gpuName: String(snapshot.gpuName ?? ''),gpuCount: Number(snapshot.gpuCount),
      gpuMemoryMb: Number(snapshot.gpuMemoryMb),region: String(snapshot.region ?? ''),reliability: Number(snapshot.reliability),
      providerCostMicrosPerHour: BigInt(row.provider_cost_micros_per_hour),updatedAt: new Date(String(snapshot.updatedAt)) },
    creditMicrosPerHour: BigInt(row.credit_micros_per_hour),durationHours: row.duration_hours,
    totalCreditMicros: BigInt(row.total_credit_micros),pricingPolicyVersion: row.pricing_policy_version,
    status: row.status,quotedAt: new Date(row.quoted_at),expiresAt: new Date(row.expires_at),
  };
}

function mapOrder(row: OrderRow): VastExternalOrderRecord {
  return { id: row.id,orderNumber: row.order_number,buyerSubjectId: row.buyer_subject_id,
    createdByUserId: row.created_by_user_id,quoteId: row.quote_id,clientRequestId: row.client_request_id,
    payloadDigest: row.payload_digest,providerOfferId: row.provider_offer_id,
    providerRequestKey: row.provider_request_key,providerContractId: row.provider_contract_id,
    configuration: row.configuration,status: row.status,totalCreditMicros: BigInt(row.total_credit_micros),
    failureCode: row.failure_code,reconciliationDeadlineAt: new Date(row.reconciliation_deadline_at),
    provisioningAt: row.provisioning_at ? new Date(row.provisioning_at) : null,
    failedAt: row.failed_at ? new Date(row.failed_at) : null,createdAt: new Date(row.created_at),updatedAt: new Date(row.updated_at) };
}
