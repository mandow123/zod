import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { totalCreditMicros } from '../src/credit-orders/types.js';
import { PostgresCreditLedgerStore } from '../src/credits/store.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../src/credits/types.js';
import type { Database } from '../src/database.js';
import { PostgresCreditOrderStore } from '../src/credit-orders/store.js';
import { PostgresDeviceCommerceStore } from '../src/device-commerce/store.js';
import { formatCreditMicros, parseCreditMicros } from '../src/listings/types.js';
import { PostgresSettlementFeeStore } from '../src/settlement-fees/store.js';
import { PostgresTopupReversalStore } from '../src/topups/reversal-store.js';
import { creditMicrosForTopup } from '../src/topups/service.js';

function result<T>(value: Results<T>) {
  return { ...value, rowCount: value.rows.length || value.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) =>
      result(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) =>
      work({ query: async (text: string, values?: unknown[]) =>
        result(await transaction.query(text, values)) } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

async function migrate(pglite: PGlite) {
  const names = (await readdir(new URL('../migrations', import.meta.url))).filter((name) => name.endsWith('.sql')).sort();
  for (const name of names) {
    await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  }
}

async function migrateThrough(pglite: PGlite, last: string) {
  const names = (await readdir(new URL('../migrations', import.meta.url))).filter((name) => name.endsWith('.sql')).sort();
  for (const name of names) {
    await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    if (name === last) break;
  }
}

describe('0.01 KAI card-hour contract', () => {
  it('rejects a third decimal at every public calculation boundary', () => {
    expect(parseCreditMicros('1')).toBe(1_000_000n);
    expect(parseCreditMicros('1.00')).toBe(1_000_000n);
    expect(parseCreditMicros('1.001')).toBeNull();
    expect(totalCreditMicros(600_000n, 31_140_000n)).toBe(18_690_000n);
    expect(creditMicrosForTopup(100)).toBe(990_000n);
    expect(creditMicrosForTopup(10_000)).toBe(99_800_000n);
  });

  it('enforces cent-aligned new ledger entries and the exact Spark campaign in the database', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    await migrate(pglite);
    const database = adapter(pglite);
    const userId = randomUUID(); const subjectId = randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,'cent-user','整分用户')`, [userId]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)
      VALUES($1,'personal','整分用户',$2)`, [subjectId, userId]);
    const store = new PostgresCreditLedgerStore(database);
    const available = (await store.ensureSubjectAccounts(subjectId)).find((account) => account.kind === 'available')!.accountId;
    await expect(store.post({
      id: randomUUID(), idempotencyOwner: `subject:${subjectId}`, scope: 'CENT_REJECT_TEST',
      idempotencyKey: `cent-reject-${randomUUID()}`, payloadDigest: `sha256:${'a'.repeat(64)}`,
      referenceType: 'adjustment', description: '拒绝小于一分的卡时', entries: [
        { accountId: available, amountMicros: 10_001n, memo: '非法入账' },
        { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: -10_001n, memo: '非法发行' },
      ],
    })).rejects.toThrow('KAI_CREDIT_LEDGER_CENT_BALANCE_REQUIRED');

    const transactionId = randomUUID();
    await database.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
      reference_type,description,status) VALUES($1,'direct:cent-test','DIRECT_CENT_TEST',$2,'direct-cent-digest',
      'adjustment','数据库整分约束','pending')`, [transactionId, `direct-cent-${randomUUID()}`]);
    await expect(database.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
      VALUES($1,$2,$3,1,'非法一微卡时')`, [randomUUID(), transactionId, available]))
      .rejects.toThrow(/0\.01 KAI card-hour/u);

    const spark = await database.query<{ list: string; sale: string }>(`SELECT
      list_unit_credit_micros::text AS list,unit_credit_micros::text AS sale
      FROM physical_device_products WHERE id='02672000-0000-4000-8000-000000000200'`);
    expect(spark.rows[0]).toEqual({ list: '40668660000', sale: '32534930000' });
    await database.close();
  });

  it('reconciles legacy balance tails and keeps status-only updates operable', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    await migrateThrough(pglite, '0054_offer_card_hour_price.sql');
    const database = adapter(pglite);
    const userId = randomUUID(); const operatorId = randomUUID(); const approverId = randomUUID();
    const supplierUserId = randomUUID(); const subjectId = randomUUID(); const supplierSubjectId = randomUUID();
    const accountId = randomUUID(); const reservedAccountId = randomUUID(); const transactionId = randomUUID(); const topupId = randomUUID();
    const reversalTopupId = randomUUID(); const reversalId = randomUUID(); const orderId = randomUUID();
    const listingId = randomUUID(); const reservationId = randomUUID(); const reservationTransactionId = randomUUID();
    const deliveryId = randomUUID(); const deviceOrderId = randomUUID(); const feePeriodId = randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES
      ($1,'legacy-user','旧账用户','member'),($2,'legacy-operator','旧账经办','operator'),
      ($3,'legacy-approver','旧账复核','operator'),($4,'legacy-supplier','旧账供应方','supplier')`,
    [userId, operatorId, approverId, supplierUserId]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)
      VALUES($1,'personal','旧账用户',$2),($3,'organization','旧账供应方',$4)`,
    [subjectId, userId, supplierSubjectId, supplierUserId]);
    await database.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
      VALUES($1,'subject',$2,$3,'available',false),($4,'subject',$2,$5,'reserved',false)`,
    [accountId, subjectId, `subject:${subjectId}:available`, reservedAccountId, `subject:${subjectId}:reserved`]);
    await database.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
      reference_type,description,status) VALUES($1,'legacy:test','LEGACY_MINT',$2,'legacy-mint-digest',
      'adjustment','旧微卡时测试','pending')`, [transactionId, `legacy-mint-${randomUUID()}`]);
    await database.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
      ($1,$2,$3,123456789,'旧账户入账'),($4,$2,$5,-123456789,'旧发行抵销')`,
    [randomUUID(), transactionId, accountId, randomUUID(), KAI_CREDIT_PLATFORM_ACCOUNTS.issuance]);
    await database.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=now() WHERE id=$1`, [transactionId]);
    await database.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
      reference_type,reference_id,description,status) VALUES($1,'legacy:test','CREDIT_ORDER_RESERVE',$2,
      'legacy-reservation-digest','order_reservation',$3,'旧订单预留','pending')`,
    [reservationTransactionId, `legacy-reservation-${randomUUID()}`, orderId]);
    await database.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
      ($1,$2,$3,-31137725,'旧订单可用转出'),($4,$2,$5,31137725,'旧订单预留转入')`,
    [randomUUID(), reservationTransactionId, accountId, randomUUID(), reservedAccountId]);
    await database.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=now() WHERE id=$1`,
      [reservationTransactionId]);
    await database.query(`INSERT INTO kai_credit_topups(id,subject_id,created_by_user_id,client_request_id,payload_digest,
      provider,channel,provider_reference,amount_cents,credit_micros,conversion_cny_micros_per_credit,status,expires_at)
      VALUES($1,$2,$3,$4,'legacy-topup-digest','alipay','app',$5,124,1234567,1002000,'created',now()+interval '1 hour')`,
    [topupId, subjectId, userId, `legacy-topup-${randomUUID()}`, `LEGACY${randomUUID()}`]);
    await database.query(`INSERT INTO kai_credit_topups(id,subject_id,created_by_user_id,client_request_id,payload_digest,
      provider,channel,provider_reference,amount_cents,credit_micros,conversion_cny_micros_per_credit,status,expires_at,succeeded_at)
      VALUES($1,$2,$3,$4,'legacy-reversal-topup','alipay','app',$5,10000,99800399,1002000,'succeeded',
      now()+interval '1 hour',now())`,
    [reversalTopupId, subjectId, userId, `legacy-reversal-${randomUUID()}`, `LEGACY${randomUUID()}`]);
    await database.query(`INSERT INTO kai_credit_topup_reversals(id,topup_id,subject_id,provider,kind,
      provider_event_reference,evidence_digest,amount_cents,credit_micros,status,requested_by_operator_id,
      client_request_id,payload_digest,requested_at) VALUES($1,$2,$3,'alipay','refund',$4,$5,5000,49900199,
      'submitted',$6,$7,$8,now())`, [reversalId, reversalTopupId, subjectId, `legacy-event-${randomUUID()}`,
    `sha256:${'e'.repeat(64)}`, operatorId, `legacy-reversal-${randomUUID()}`, `sha256:${'f'.repeat(64)}`]);

    await database.query(`ALTER TABLE credit_market_listings
      DROP CONSTRAINT credit_market_listings_offer_id_fkey,
      DROP CONSTRAINT credit_market_listings_resource_id_fkey,
      DROP CONSTRAINT credit_market_listings_supplier_id_fkey,
      DROP CONSTRAINT credit_market_listings_resource_audit_id_fkey,
      DROP CONSTRAINT credit_market_listings_price_audit_id_fkey`);
    await database.query(`INSERT INTO credit_market_listings(id,offer_id,resource_id,supplier_id,client_request_id,
      payload_digest,resource_audit_id,price_audit_id,capacity_total,capacity_reserved,capacity_sold,capacity_unit,
      minimum_quantity,unit_credit_micros,reference_cny_micros,conversion_cny_micros_per_credit,status,starts_at,
      expires_at,audit_snapshot,published_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,10,1,0,'GPU时',1,31137725,
      31137725,1002000,'active',now()-interval '1 hour',now()+interval '1 day','{}'::jsonb,$9)`,
    [listingId, randomUUID(), randomUUID(), randomUUID(), `legacy-listing-${randomUUID()}`,
      `sha256:${'1'.repeat(64)}`, randomUUID(), randomUUID(), supplierUserId]);
    await database.query(`ALTER TABLE kai_credit_orders DISABLE TRIGGER USER`);
    await database.query(`INSERT INTO kai_credit_orders(id,order_number,buyer_subject_id,supplier_subject_id,
      created_by_user_id,listing_id,client_request_id,payload_digest,status,quantity,capacity_unit,
      unit_credit_micros,total_credit_micros,listing_snapshot,reservation_expires_at,confirmed_at,
      confirmed_by_user_id,delivery_started_at,delivery_ready_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'acceptance_pending',1,'GPU时',31137725,31137725,
      '{"fulfillmentMode":"legacy_delivery"}'::jsonb,
      now()+interval '1 hour',now(),$9,now(),now())`,
    [orderId, `KCL${randomUUID().replaceAll('-', '').slice(0, 20)}`, subjectId, supplierSubjectId, userId,
      listingId, `legacy-order-${randomUUID()}`, `sha256:${'a'.repeat(64)}`, supplierUserId]);
    await database.query(`ALTER TABLE kai_credit_orders ENABLE TRIGGER USER`);
    await database.query(`INSERT INTO kai_credit_order_reservations(id,order_id,listing_id,buyer_subject_id,
      quantity,credit_micros,reservation_transaction_id,status,expires_at,secured_at,secured_by_user_id)
      VALUES($1,$2,$3,$4,1,31137725,$5,'secured',now()+interval '1 hour',now(),$6)`,
    [reservationId, orderId, listingId, subjectId, reservationTransactionId, supplierUserId]);
    await database.query(`INSERT INTO kai_credit_order_deliveries(id,order_id,supplier_subject_id,started_by_user_id,
      started_at,ready_by_user_id,ready_at,status,delivery_payload_ciphertext,delivery_payload_digest,attempt_number)
      VALUES($1,$2,$3,$4,now(),$4,now(),'ready','legacy-delivery',$5,1)`,
    [deliveryId, orderId, supplierSubjectId, supplierUserId, `sha256:${'2'.repeat(64)}`]);
    const spark = await database.query<{ campaign_key: string; template_key: string }>(`SELECT campaign_key,template_key
      FROM physical_device_products WHERE id='02672000-0000-4000-8000-000000000200'`);
    await database.query(`ALTER TABLE physical_device_orders DISABLE TRIGGER USER`);
    await database.query(`INSERT INTO physical_device_orders(id,order_number,buyer_subject_id,supplier_subject_id,
      created_by_user_id,product_id,client_request_id,payload_digest,shipping_address_reference,status,quantity,
      unit_credit_micros,gross_credit_micros,reservation_transaction_id,reservation_expires_at,campaign_key,campaign_version)
      VALUES($1,$2,$3,$4,$5,'02672000-0000-4000-8000-000000000200',$6,$7,'legacy-address','reserved',1,
      31137725,31137725,$8,now()+interval '1 hour',$9,$10)`, [deviceOrderId,
    `KDO${randomUUID().replaceAll('-', '').slice(0, 20)}`, subjectId, supplierSubjectId, userId,
    `legacy-device-${randomUUID()}`, `sha256:${'b'.repeat(64)}`, transactionId,
    spark.rows[0]!.campaign_key, spark.rows[0]!.template_key]);
    await database.query(`ALTER TABLE physical_device_orders ENABLE TRIGGER USER`);
    await database.query(`UPDATE physical_device_products SET inventory_reserved=1
      WHERE id='02672000-0000-4000-8000-000000000200'`);
    await database.query(`INSERT INTO kai_credit_supplier_fee_periods(id,supplier_subject_id,fee_category,period_start,
      net_settled_credit_micros) VALUES($1,$2,'compute_trade','2026-08-01',31137725)`, [feePeriodId, supplierSubjectId]);

    await pglite.exec(await readFile(fileURLToPath(new URL('../migrations/0055_card_hour_cent_contract.sql', import.meta.url)), 'utf8'));

    const balance = await database.query<{ amount: string }>(`SELECT sum(e.amount_micros)::text AS amount
      FROM kai_credit_entries e JOIN kai_credit_transactions t ON t.id=e.transaction_id
      WHERE e.account_id=$1 AND t.status='posted'`, [accountId]);
    expect(balance.rows[0]?.amount).toBe('92310000');
    const audit = await database.query<{ status: string; adjusted: string }>(`SELECT status,
      adjusted_balance_micros::text AS adjusted FROM kai_credit_legacy_precision_audits WHERE account_id=$1`, [accountId]);
    expect(audit.rows[0]).toEqual({ status: 'reconciled', adjusted: '92310000' });
    const topup = await database.query<{ credit: string }>(`UPDATE kai_credit_topups SET status='failed' WHERE id=$1
      RETURNING credit_micros::text AS credit`, [topupId]);
    expect(topup.rows[0]?.credit).toBe('1230000');
    const migratedOrder = await database.query<{ unit: string; total: string }>(`SELECT unit_credit_micros::text AS unit,
      total_credit_micros::text AS total FROM kai_credit_orders WHERE id=$1`, [orderId]);
    expect(migratedOrder.rows[0]).toEqual({ unit: '31140000', total: '31140000' });
    expect(formatCreditMicros(BigInt(migratedOrder.rows[0]!.total))).toBe('31.14');
    const migratedDevice = await database.query<{ unit: string; gross: string }>(`SELECT unit_credit_micros::text AS unit,
      gross_credit_micros::text AS gross FROM physical_device_orders WHERE id=$1`, [deviceOrderId]);
    expect(migratedDevice.rows[0]).toEqual({ unit: '31140000', gross: '31140000' });
    const reservedBeforeRelease = await database.query<{ amount: string }>(`SELECT
      COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text AS amount
      FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id=a.id
      LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
      WHERE a.subject_id=$1 AND a.account_kind='reserved' GROUP BY a.id`, [subjectId]);
    expect(reservedBeforeRelease.rows[0]?.amount).toBe('62280000');
    const cancelled = await new PostgresDeviceCommerceStore(database).action({
      orderId: deviceOrderId, actorId: userId, actorSubjectId: subjectId, side: 'buyer', action: 'cancel',
      from: 'reserved', to: 'cancelled', clientRequestId: `legacy-device-cancel-${randomUUID()}`,
      payloadDigest: `sha256:${'c'.repeat(64)}`, now: new Date(),
    });
    expect(cancelled).toMatchObject({ status: 'updated', order: { status: 'cancelled', grossCreditMicros: 31_140_000n } });
    const reservedAfterRelease = await database.query<{ amount: string }>(`SELECT
      COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text AS amount
      FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id=a.id
      LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
      WHERE a.subject_id=$1 AND a.account_kind='reserved' GROUP BY a.id`, [subjectId]);
    expect(reservedAfterRelease.rows[0]?.amount).toBe('31140000');
    const captured = await new PostgresCreditOrderStore(database).accept({
      subjectId, userId, orderId, clientRequestId: `legacy-secured-capture-${randomUUID()}`,
      payloadDigest: `sha256:${'9'.repeat(64)}`, requestId: `legacy-secured-capture-request-${randomUUID()}`,
      ipHash: `sha256:${'8'.repeat(64)}`, now: new Date(), evidenceDigest: null,
    });
    expect(captured).toMatchObject({ status: 'accepted', order: { status: 'accepted', totalCreditMicros: 31_140_000n } });
    const reservedAfterCapture = await database.query<{ amount: string }>(`SELECT
      COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text AS amount
      FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id=a.id
      LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
      WHERE a.subject_id=$1 AND a.account_kind='reserved' GROUP BY a.id`, [subjectId]);
    expect(reservedAfterCapture.rows[0]?.amount).toBe('0');
    const supplierReceivable = await database.query<{ amount: string }>(`SELECT
      COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text AS amount
      FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id=a.id
      LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
      WHERE a.subject_id=$1 AND a.account_kind='supplier_receivable' GROUP BY a.id`, [supplierSubjectId]);
    expect(supplierReceivable.rows[0]?.amount).toBe('31140000');
    const listingCapacity = await database.query<{ reserved: string; sold: string }>(`SELECT
      capacity_reserved::text AS reserved,capacity_sold::text AS sold FROM credit_market_listings WHERE id=$1`, [listingId]);
    expect(listingCapacity.rows[0]).toEqual({ reserved: '0.000000', sold: '1.000000' });
    const negativeSubjectBalances = await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM (
      SELECT a.id FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id=a.id
      LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id AND t.status='posted'
      WHERE a.subject_id IN ($1,$2) GROUP BY a.id HAVING COALESCE(sum(e.amount_micros),0)<0
    ) negative`, [subjectId, supplierSubjectId]);
    expect(negativeSubjectBalances.rows[0]?.count).toBe('0');
    const workflowAudit = await database.query<{ normalized: string; actual: string }>(`SELECT
      a.normalized_micros::text AS normalized,o.total_credit_micros::text AS actual
      FROM kai_credit_legacy_value_audits a JOIN kai_credit_orders o ON o.id::text=a.record_id
      WHERE a.source_table='kai_credit_orders' AND a.column_name='total_credit_micros' AND o.id=$1`, [orderId]);
    expect(workflowAudit.rows[0]).toEqual({ normalized: '31140000', actual: '31140000' });
    const reconciliation = await database.query<{ total: string; count: string }>(`SELECT
      COALESCE(sum(e.amount_micros),0)::text AS total,count(*)::text AS count
      FROM kai_credit_transactions t JOIN kai_credit_entries e ON e.transaction_id=t.id
      WHERE t.scope='legacy_reserved_reconciliation' AND t.reference_id=$1`, [subjectId]);
    expect(reconciliation.rows[0]).toEqual({ total: '0', count: '2' });
    const period = await database.query<{ amount: string }>(`SELECT net_settled_credit_micros::text AS amount
      FROM kai_credit_supplier_fee_periods WHERE id=$1`, [feePeriodId]);
    expect(period.rows[0]?.amount).toBe('31140000');
    const recovered = await new PostgresTopupReversalStore(database).recoverCredits({
      reversalId, operatorId: approverId, now: new Date(),
    });
    expect(recovered).toMatchObject({ status: 'updated', reversal: { creditMicros: 49_900_000n } });
    const visibleEntries = await new PostgresCreditLedgerStore(database).listEntries(subjectId, 20);
    expect(visibleEntries.some((entry) => entry.amountMicros === -49_900_000n)).toBe(true);
    expect(visibleEntries.some((entry) => entry.amountMicros === 31_140_000n)).toBe(true);
    await database.close();
  });

  it('migrates a legacy settled fee workflow and performs a real cent-safe reversal', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    await migrateThrough(pglite, '0054_offer_card_hour_price.sql');
    const database = adapter(pglite);
    const buyerUserId = randomUUID(); const supplierUserId = randomUUID();
    const buyerSubjectId = randomUUID(); const supplierSubjectId = randomUUID();
    const orderId = randomUUID(); const scheduleId = randomUUID(); const periodId = randomUUID();
    const assessmentId = randomUUID(); const settlementTransactionId = randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES
      ($1,'legacy-reversal-buyer','迁移退款买方','member'),
      ($2,'legacy-reversal-supplier','迁移退款供应方','supplier')`, [buyerUserId, supplierUserId]);
    await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id) VALUES
      ($1,'personal','迁移退款买方',$2),($3,'organization','迁移退款供应方',$4)`,
    [buyerSubjectId, buyerUserId, supplierSubjectId, supplierUserId]);
    const ledger = new PostgresCreditLedgerStore(database);
    const buyerAccounts = await ledger.ensureSubjectAccounts(buyerSubjectId);
    const supplierAccounts = await ledger.ensureSubjectAccounts(supplierSubjectId);
    const buyerAvailable = buyerAccounts.find((account) => account.kind === 'available')!.accountId;
    const supplierReceivable = supplierAccounts.find((account) => account.kind === 'supplier_receivable')!.accountId;
    const supplierEarnings = randomUUID();
    await database.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
      VALUES($1,'subject',$2,$3,'supplier_earnings_available',false)`,
    [supplierEarnings, supplierSubjectId, `subject:${supplierSubjectId}:supplier_earnings_available`]);

    const legacyGross = 31_137_725n; const legacyFee = 311_377n; const legacyNet = legacyGross - legacyFee;
    const fundingTransactionId = randomUUID();
    await database.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
      reference_type,reference_id,description,status) VALUES
      ($1,'migration-test','LEGACY_CAPTURE_FUND',$2,'legacy-capture-fund','adjustment',$3,'旧结算应收准备','pending')`,
    [fundingTransactionId, `legacy-capture-fund-${randomUUID()}`, orderId]);
    await database.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
      ($1,$2,$3,$4,'旧应收准备'),($5,$2,$6,$7,'旧应收清算')`,
    [randomUUID(), fundingTransactionId, supplierReceivable, legacyGross.toString(), randomUUID(),
      KAI_CREDIT_PLATFORM_ACCOUNTS.clearing, (-legacyGross).toString()]);
    await database.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=now() WHERE id=$1`, [fundingTransactionId]);
    await database.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
      reference_type,reference_id,description,status) VALUES
      ($1,'migration-test','CREDIT_SUPPLIER_SETTLEMENT_WITH_FEE',$2,'legacy-settlement-fee','settlement',$3,
      '旧结算与手续费','pending')`, [settlementTransactionId, `legacy-settlement-${randomUUID()}`, orderId]);
    await database.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
      ($1,$2,$3,$4,'旧结算应收转出'),($5,$2,$6,$7,'旧结算净收益'),($8,$2,$9,$10,'旧结算手续费')`,
    [randomUUID(), settlementTransactionId, supplierReceivable, (-legacyGross).toString(), randomUUID(),
      supplierEarnings, legacyNet.toString(), randomUUID(), KAI_CREDIT_PLATFORM_ACCOUNTS.revenue, legacyFee.toString()]);
    await database.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=now() WHERE id=$1`, [settlementTransactionId]);

    await database.query(`ALTER TABLE kai_credit_orders DISABLE TRIGGER USER`);
    await database.query(`ALTER TABLE kai_credit_orders DROP CONSTRAINT kai_credit_orders_listing_id_fkey`);
    await database.query(`INSERT INTO kai_credit_orders(id,order_number,buyer_subject_id,supplier_subject_id,
      created_by_user_id,listing_id,client_request_id,payload_digest,status,quantity,capacity_unit,
      unit_credit_micros,total_credit_micros,listing_snapshot,reservation_expires_at,confirmed_at,
      confirmed_by_user_id,delivery_started_at,delivery_ready_at,accepted_at,accepted_by_user_id,accepted_actor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'accepted',1,'GPU时',$9,$9,'{}'::jsonb,now()+interval '1 hour',
      now()-interval '3 hours',$10,now()-interval '2 hours',now()-interval '1 hour',now(),$5,'buyer')`,
    [orderId, `KCL${randomUUID().replaceAll('-', '').slice(0, 20)}`, buyerSubjectId, supplierSubjectId,
      buyerUserId, randomUUID(), `legacy-reversal-order-${randomUUID()}`, `sha256:${'d'.repeat(64)}`,
      legacyGross.toString(), supplierUserId]);
    await database.query(`ALTER TABLE kai_credit_orders ENABLE TRIGGER USER`);
    await database.query(`INSERT INTO kai_credit_fee_schedules(id,version,fee_category,status,currency,timezone,
      rounding_model,created_by_user_id)
      VALUES($1,'legacy-cent-v1','compute_trade','draft','KAI_CREDIT','Asia/Shanghai','cumulative_ceiling_v1',$2)`,
    [scheduleId, supplierUserId]);
    await database.query(`INSERT INTO kai_credit_fee_tiers(id,schedule_id,ordinal,lower_bound_micros,upper_bound_micros,rate_bps)
      VALUES($1,$2,0,0,NULL,100)`, [randomUUID(), scheduleId]);
    await database.query(`INSERT INTO kai_credit_fee_schedule_approvals(schedule_id,requested_by_user_id,
      approved_by_user_id,approval_request_id,approval_payload_digest,approved_at)
      VALUES($1,$2,$3,'legacy-cent-approval-request','legacy-cent-approval-digest','2026-08-01')`,
    [scheduleId, supplierUserId, buyerUserId]);
    await database.query(`UPDATE kai_credit_fee_schedules SET status='active',effective_from='2026-08-01',
      activated_by_user_id=$2,activated_at='2026-08-01' WHERE id=$1`, [scheduleId, buyerUserId]);
    await database.query(`INSERT INTO kai_credit_order_fee_policies(order_id,policy_state,schedule_id,schedule_version,locked_at)
      VALUES($1,'schedule_locked',$2,'legacy-cent-v1','2026-08-01')`, [orderId, scheduleId]);
    await database.query(`INSERT INTO kai_credit_supplier_fee_periods(id,supplier_subject_id,fee_category,period_start,
      net_settled_credit_micros) VALUES($1,$2,'compute_trade','2026-08-01',$3)`,
    [periodId, supplierSubjectId, legacyGross.toString()]);
    await database.query(`INSERT INTO kai_credit_fee_assessments(id,supplier_subject_id,order_id,schedule_id,
      schedule_version,period_id,period_start,kind,source_kind,source_id,idempotency_owner,idempotency_key,
      payload_digest,gross_credit_micros,service_fee_credit_micros,net_credit_micros,cumulative_before_micros,
      cumulative_after_micros,ledger_transaction_id,assessed_at)
      VALUES($1,$2,$3,$4,'legacy-cent-v1',$5,'2026-08-01','settlement','compute_settlement',
      'legacy-cent-settlement','migration:test','legacy-cent-assessment','legacy-assessment-digest',$6,$7,$8,0,$6,$9,'2026-08-20')`,
    [assessmentId, supplierSubjectId, orderId, scheduleId, periodId, legacyGross.toString(), legacyFee.toString(),
      legacyNet.toString(), settlementTransactionId]);
    await database.query(`INSERT INTO kai_credit_fee_assessment_segments(id,assessment_id,ordinal,tier_ordinal,
      lower_bound_micros,upper_bound_micros,settled_credit_micros,rate_bps,exact_fee_numerator,
      service_fee_credit_micros) VALUES($1,$2,0,0,0,NULL,$3,100,$4,$5)`,
    [randomUUID(), assessmentId, legacyGross.toString(), (legacyGross * 100n).toString(), legacyFee.toString()]);

    await pglite.exec(await readFile(fileURLToPath(new URL('../migrations/0055_card_hour_cent_contract.sql', import.meta.url)), 'utf8'));
    const migrated = await database.query<{ gross: string; fee: string; net: string; period: string }>(`SELECT
      a.gross_credit_micros::text AS gross,a.service_fee_credit_micros::text AS fee,
      a.net_credit_micros::text AS net,p.net_settled_credit_micros::text AS period
      FROM kai_credit_fee_assessments a JOIN kai_credit_supplier_fee_periods p ON p.id=a.period_id WHERE a.id=$1`,
    [assessmentId]);
    expect(migrated.rows[0]).toEqual({ gross: '31140000', fee: '310000', net: '30830000', period: '31140000' });
    const reversed = await new PostgresSettlementFeeStore(database).reverseSettlement({
      id: randomUUID(), supplierSubjectId, orderId, originalAssessmentId: assessmentId,
      sourceId: 'legacy-cent-refund-0001', grossCreditMicros: 31_140_000n,
      idempotencyOwner: `subject:${supplierSubjectId}`, idempotencyKey: 'legacy-cent-reversal-0001',
      payloadDigest: `sha256:${'e'.repeat(64)}`, assessedAt: new Date('2026-09-03T00:00:00.000+08:00'),
    });
    expect(reversed).toMatchObject({ status: 'created', plan: {
      grossCreditMicros: 31_140_000n, serviceFeeCreditMicros: 310_000n, netCreditMicros: 30_830_000n,
    } });
    const finalBalances = await database.query<{ account_kind: string; amount: string }>(`SELECT a.account_kind,
      COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text AS amount
      FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id=a.id
      LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
      WHERE a.id IN ($1,$2) GROUP BY a.id,a.account_kind`, [supplierEarnings, buyerAvailable]);
    expect(Object.fromEntries(finalBalances.rows.map((row) => [row.account_kind, row.amount])))
      .toMatchObject({ supplier_earnings_available: '0', available: '31140000' });
    const reversalLedger = await database.query<{ total: string; count: string }>(`SELECT sum(e.amount_micros)::text AS total,
      count(*)::text AS count FROM kai_credit_fee_assessments a JOIN kai_credit_entries e
      ON e.transaction_id=a.ledger_transaction_id WHERE a.kind='reversal' AND a.original_assessment_id=$1`, [assessmentId]);
    expect(reversalLedger.rows[0]).toEqual({ total: '0', count: '3' });
    await database.close();
  });
});
