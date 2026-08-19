import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';

export type AdminP0Cursor = Readonly<{
  createdAt: Date;
  id: string;
}>;

export type AdminP0StorePageInput = Readonly<{
  limit: number;
  cursor: AdminP0Cursor | null;
}>;

export type AdminP0Overview = Readonly<{
  computeOrders: Readonly<{ total: number; active: number }>;
  deviceOrders: Readonly<{ total: number; active: number }>;
  payouts: Readonly<{ total: number; pending: number }>;
  topups: Readonly<{ total: number; attentionRequired: number }>;
}>;

export type AdminP0ComputeCreditOrder = Readonly<{
  id: string;
  orderNumber: string;
  status: string;
  quantity: string;
  capacityUnit: string;
  totalCreditMicros: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AdminP0DeviceOrder = Readonly<{
  id: string;
  orderNumber: string;
  status: string;
  quantity: number;
  grossCreditMicros: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AdminP0Payout = Readonly<{
  id: string;
  payoutNumber: string;
  status: string;
  creditMicros: string;
  paymentAmountCents: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AdminP0Topup = Readonly<{
  id: string;
  provider: string;
  status: string;
  amountCents: string;
  currency: string;
  creditMicros: string;
  reversedAmountCents: string;
  reversedCreditMicros: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export interface AdminP0Store {
  overview(): Promise<AdminP0Overview>;
  listComputeCreditOrders(input: AdminP0StorePageInput): Promise<readonly AdminP0ComputeCreditOrder[]>;
  listDeviceOrders(input: AdminP0StorePageInput): Promise<readonly AdminP0DeviceOrder[]>;
  listPayouts(input: AdminP0StorePageInput): Promise<readonly AdminP0Payout[]>;
  listTopups(input: AdminP0StorePageInput): Promise<readonly AdminP0Topup[]>;
}

type OverviewRow = QueryResultRow & {
  compute_total: string;
  compute_active: string;
  device_total: string;
  device_active: string;
  payout_total: string;
  payout_pending: string;
  topup_total: string;
  topup_attention: string;
};

type ComputeOrderRow = QueryResultRow & {
  id: string;
  order_number: string;
  status: string;
  quantity: string;
  capacity_unit: string;
  total_credit_micros: string;
  created_at: Date;
  updated_at: Date;
};

type DeviceOrderRow = QueryResultRow & {
  id: string;
  order_number: string;
  status: string;
  quantity: number;
  gross_credit_micros: string;
  created_at: Date;
  updated_at: Date;
};

type PayoutRow = QueryResultRow & {
  id: string;
  payout_number: string;
  status: string;
  credit_micros: string;
  payment_amount_cents: string;
  created_at: Date;
  updated_at: Date;
};

type TopupRow = QueryResultRow & {
  id: string;
  provider: string;
  status: string;
  amount_cents: string;
  currency: string;
  credit_micros: string;
  reversed_amount_cents: string;
  reversed_credit_micros: string;
  created_at: Date;
  updated_at: Date;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function requirePageInput(input: AdminP0StorePageInput): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 101) {
    throw new Error('ADMIN_P0_STORE_LIMIT_INVALID');
  }
  if (input.cursor === null) return;
  if (!(input.cursor.createdAt instanceof Date) || !Number.isFinite(input.cursor.createdAt.getTime())
    || !UUID_PATTERN.test(input.cursor.id)) {
    throw new Error('ADMIN_P0_STORE_CURSOR_INVALID');
  }
}

function count(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error('ADMIN_P0_COUNT_INVALID');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('ADMIN_P0_COUNT_OUT_OF_RANGE');
  return parsed;
}

function pageQuery(projection: string, table: string, input: AdminP0StorePageInput) {
  requirePageInput(input);
  if (input.cursor === null) {
    return {
      text: `SELECT ${projection} FROM ${table} ORDER BY created_at DESC, id DESC LIMIT $1`,
      values: [input.limit] as unknown[],
    };
  }
  return {
    text: `SELECT ${projection} FROM ${table}
      WHERE created_at < $1 OR (created_at = $1 AND id < $2::uuid)
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    values: [input.cursor.createdAt, input.cursor.id, input.limit] as unknown[],
  };
}

function date(value: Date): Date {
  return new Date(value);
}

export class PostgresAdminP0Store implements AdminP0Store {
  constructor(private readonly database: Database) {}

  async overview(): Promise<AdminP0Overview> {
    const result = await this.database.query<OverviewRow>(`
      SELECT
        (SELECT count(*)::text FROM kai_credit_orders) AS compute_total,
        (SELECT count(*)::text FROM kai_credit_orders
          WHERE status IN ('reserved','confirmed','provisioning','ready','in_service','acceptance_pending',
            'release_pending','refund_pending','disputed')) AS compute_active,
        (SELECT count(*)::text FROM physical_device_orders) AS device_total,
        (SELECT count(*)::text FROM physical_device_orders
          WHERE status IN ('reserved','confirmed','shipping')) AS device_active,
        (SELECT count(*)::text FROM kai_credit_payout_requests) AS payout_total,
        (SELECT count(*)::text FROM kai_credit_payout_requests
          WHERE status IN ('submitted','reviewing','paying')) AS payout_pending,
        (SELECT count(*)::text FROM kai_credit_topups) AS topup_total,
        (SELECT count(*)::text FROM kai_credit_topups
          WHERE status IN ('pending','manual_review')) AS topup_attention`);
    const row = result.rows[0];
    if (!row) throw new Error('ADMIN_P0_OVERVIEW_UNAVAILABLE');
    return {
      computeOrders: { total: count(row.compute_total), active: count(row.compute_active) },
      deviceOrders: { total: count(row.device_total), active: count(row.device_active) },
      payouts: { total: count(row.payout_total), pending: count(row.payout_pending) },
      topups: { total: count(row.topup_total), attentionRequired: count(row.topup_attention) },
    };
  }

  async listComputeCreditOrders(input: AdminP0StorePageInput) {
    const query = pageQuery(
      'id, order_number, status, quantity::text, capacity_unit, total_credit_micros::text, created_at, updated_at',
      'kai_credit_orders',
      input,
    );
    const result = await this.database.query<ComputeOrderRow>(query.text, query.values);
    return result.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      status: row.status,
      quantity: row.quantity,
      capacityUnit: row.capacity_unit,
      totalCreditMicros: row.total_credit_micros,
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    }));
  }

  async listDeviceOrders(input: AdminP0StorePageInput) {
    const query = pageQuery(
      'id, order_number, status, quantity, gross_credit_micros::text, created_at, updated_at',
      'physical_device_orders',
      input,
    );
    const result = await this.database.query<DeviceOrderRow>(query.text, query.values);
    return result.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      status: row.status,
      quantity: row.quantity,
      grossCreditMicros: row.gross_credit_micros,
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    }));
  }

  async listPayouts(input: AdminP0StorePageInput) {
    const query = pageQuery(
      'id, payout_number, status, credit_micros::text, payment_amount_cents::text, created_at, updated_at',
      'kai_credit_payout_requests',
      input,
    );
    const result = await this.database.query<PayoutRow>(query.text, query.values);
    return result.rows.map((row) => ({
      id: row.id,
      payoutNumber: row.payout_number,
      status: row.status,
      creditMicros: row.credit_micros,
      paymentAmountCents: row.payment_amount_cents,
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    }));
  }

  async listTopups(input: AdminP0StorePageInput) {
    const query = pageQuery(
      `id, provider, status, amount_cents::text, currency, credit_micros::text,
        reversed_amount_cents::text, reversed_credit_micros::text, created_at, updated_at`,
      'kai_credit_topups',
      input,
    );
    const result = await this.database.query<TopupRow>(query.text, query.values);
    return result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      amountCents: row.amount_cents,
      currency: row.currency,
      creditMicros: row.credit_micros,
      reversedAmountCents: row.reversed_amount_cents,
      reversedCreditMicros: row.reversed_credit_micros,
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    }));
  }
}
