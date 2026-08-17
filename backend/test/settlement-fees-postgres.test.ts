import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { encryptPii, secretHash } from '../src/account/crypto.js';
import { PostgresCreditOrderStore } from '../src/credit-orders/store.js';
import { PostgresCreditLedgerStore } from '../src/credits/store.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../src/credits/types.js';
import type { Database } from '../src/database.js';
import { PostgresSettlementFeeStore } from '../src/settlement-fees/store.js';
import type { FeeTier } from '../src/settlement-fees/types.js';

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => {
      const client = { query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)) } as unknown as PoolClient;
      return work(client);
    }),
    close: () => pglite.close(),
  } as unknown as Database;
}

const C = 1_000_000n;
const fixtureTiers: readonly FeeTier[] = [
  { ordinal: 0, lowerBoundMicros: 0n, upperBoundMicros: 50n * C, rateBps: 100 },
  { ordinal: 1, lowerBoundMicros: 50n * C, upperBoundMicros: null, rateBps: 80 },
];

async function fixture() {
  const pglite = new PGlite();
  for (const name of [
    '0001_cloudpay_ledger.sql', '0015_credit_listing_audits.sql', '0016_trading_subjects.sql',
    '0022_kai_credit_double_entry_ledger.sql', '0024_kai_credit_order_reservations.sql',
    '0025_kai_credit_order_confirmation.sql', '0026_kai_credit_order_delivery_capture.sql',
    '0027_kai_credit_order_delivery_issues.sql', '0028_kai_credit_order_delivery_versions.sql',
    '0029_kai_credit_order_mutual_refunds.sql', '0030_kai_credit_supplier_settlements.sql',
    '0031_kai_credit_order_dispute_adjudication.sql', '0032_kai_credit_post_acceptance_refunds.sql',
    '0033_kai_credit_post_acceptance_adjudication.sql', '0034_kai_credit_partial_aftercare_remedies.sql',
    '0039_compute_node_readiness.sql', '0042_kai_credit_settlement_fees.sql',
    '0046_kai_credit_supplier_payouts.sql', '0049_supplier_earnings_accounts.sql',
  ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  const database = adapter(pglite);
  const buyerUserId = randomUUID(); const supplierUserId = randomUUID();
  const operatorOne = randomUUID(); const operatorTwo = randomUUID();
  const buyerSubjectId = randomUUID(); const supplierSubjectId = randomUUID();
  const resourceId = randomUUID(); const offerId = randomUUID(); const listingId = randomUUID();
  const resourceAuditId = randomUUID(); const priceAuditId = randomUUID();
  await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
    ($1,'buyer','买方','member'),($2,'supplier','提供方','supplier'),
    ($3,'operator-one','运营甲','operator'),($4,'operator-two','运营乙','operator')`,
  [buyerUserId, supplierUserId, operatorOne, operatorTwo]);
  await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES
    ($1,'personal','买方',$2),($3,'personal','提供方',$4)`,
  [buyerSubjectId, buyerUserId, supplierSubjectId, supplierUserId]);
  await database.query(`INSERT INTO subject_memberships(subject_id,user_id,role) VALUES
    ($1,$2,'owner'),($3,$4,'owner')`, [buyerSubjectId, buyerUserId, supplierSubjectId, supplierUserId]);
  await database.query(`INSERT INTO supplier_profiles(id,created_by_user_id,subject_id,legal_name,credit_code,contact_name,status)
    VALUES ($1,$2,$1,'凯云算力有限公司','91310101MA1FEE001','凯','approved')`, [supplierSubjectId, supplierUserId]);
  await database.query(`INSERT INTO compute_resources(id,supplier_id,kind,product_code,region,specifications,
      capacity_total,capacity_unit,status,verification_digest,verified_at)
    VALUES ($1,$2,'gpu','H100-SXM-80G','华东-上海','{"memory":"80GB"}',100,'GPU时','verified',$3,now())`,
  [resourceId, supplierSubjectId, `sha256:${'a'.repeat(64)}`]);
  const nodeId = randomUUID();
  await database.query(`INSERT INTO compute_nodes(id,supplier_id,node_public_key,node_key_fingerprint,
      inventory_digest,status,last_heartbeat_at,heartbeat_boot_id,heartbeat_sequence,heartbeat_payload_digest,heartbeat_signature)
    VALUES ($1,$2,$3,$4,$5,'ready',now(),$6,1,$7,$8)`,
  [nodeId, supplierSubjectId, `ed25519:${'A'.repeat(44)}`, `sha256:${'b'.repeat(64)}`,
    `sha256:${'c'.repeat(64)}`, randomUUID(), `sha256:${'d'.repeat(64)}`, `ed25519:${'B'.repeat(88)}`]);
  await database.query(`INSERT INTO compute_resource_bindings(id,resource_id,node_id,status,
      resource_verification_digest,policy_digest,attested_policy_digest,inventory_digest,gpu_set_digest,confirmed_at)
    VALUES ($1,$2,$3,'ready',$4,$5,$5,$6,$7,now())`,
  [randomUUID(), resourceId, nodeId, `sha256:${'a'.repeat(64)}`, `sha256:${'e'.repeat(64)}`,
    `sha256:${'c'.repeat(64)}`, `sha256:${'f'.repeat(64)}`]);
  const validUntil = new Date(Date.now() + 30 * 86_400_000);
  await database.query(`INSERT INTO offer_templates(id,supplier_id,resource_id,client_request_id,payload_digest,
      submission_version,title,service_mode,native_unit,minimum_quantity,suggested_price_cny_micros,status,
      approved_reference_cny_micros,approved_unit_credit_micros,conversion_cny_micros_per_credit,
      audit_valid_until,submitted_at,approved_at)
    VALUES ($1,$2,$3,'fee-offer-request-0001','fee-offer-digest-0001',1,'独享 H100','dedicated','GPU时',1,
      31200000,'approved',31200000,31140000,1002000,$4,now(),now())`,
  [offerId, supplierSubjectId, resourceId, validUntil]);
  for (const audit of [{ id: resourceAuditId, kind: 'resource', reviewer: operatorOne },
    { id: priceAuditId, kind: 'price', reviewer: operatorTwo }]) {
    await database.query(`INSERT INTO offer_audit_versions(id,offer_id,submission_version,kind,status,reviewer_id,
        decision_reason,evidence_summary,evidence_digest,decision_digest,approved_reference_cny_micros,
        conversion_cny_micros_per_credit,approved_unit_credit_micros,valid_until,decided_at)
      VALUES ($1,$2,1,$3,'approved',$4,'通过','材料一致',$5,$6,
        CASE WHEN $3='price' THEN 31200000 END,CASE WHEN $3='price' THEN 1002000 END,
        CASE WHEN $3='price' THEN 31140000 END,$7,now())`,
    [audit.id, offerId, audit.kind, audit.reviewer, `sha256:${audit.kind === 'price' ? 'b'.repeat(64) : 'c'.repeat(64)}`,
      `${audit.kind}-decision`, validUntil]);
  }
  await database.query(`INSERT INTO credit_market_listings(id,offer_id,resource_id,supplier_id,client_request_id,
      payload_digest,resource_audit_id,price_audit_id,capacity_total,capacity_unit,minimum_quantity,
      unit_credit_micros,reference_cny_micros,conversion_cny_micros_per_credit,starts_at,expires_at,audit_snapshot,published_by)
    VALUES ($1,$2,$3,$4,'fee-listing-request-01','fee-listing-digest',$5,$6,100,'GPU时',1,
      31140000,31200000,1002000,now()-interval '1 minute',now()+interval '7 days',$7::jsonb,$8)`,
  [listingId, offerId, resourceId, supplierSubjectId, resourceAuditId, priceAuditId,
    JSON.stringify({ resourceAuditId, priceAuditId, validUntil: validUntil.toISOString() }), supplierUserId]);
  const ledger = new PostgresCreditLedgerStore(database);
  const buyerAccounts = await ledger.ensureSubjectAccounts(buyerSubjectId);
  const buyerAvailable = buyerAccounts.find((account) => account.kind === 'available')!.accountId;
  await ledger.post({
    id: randomUUID(), idempotencyOwner: 'platform:test', scope: 'TEST_FUND_FEE_BUYER',
    idempotencyKey: `fee-fund-${randomUUID()}`, payloadDigest: `sha256:${'9'.repeat(64)}`,
    referenceType: 'adjustment', description: '费用测试充值', entries: [
      { accountId: buyerAvailable, amountMicros: 500n * C, memo: '测试充值' },
      { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: -500n * C, memo: '测试发行' },
    ],
  });
  return { database, buyerUserId, supplierUserId, operatorOne, operatorTwo, buyerSubjectId, supplierSubjectId,
    listingId, orders: new PostgresCreditOrderStore(database), fees: new PostgresSettlementFeeStore(database) };
}

async function createAcceptedOrder(
  f: Awaited<ReturnType<typeof fixture>>,
  suffix: string,
  quantity = '2.500000',
  quantityScaled = 2_500_000n,
) {
  const now = new Date();
  const created = await f.orders.createReservation({
    id: randomUUID(), orderNumber: `KC20260814${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
    buyerSubjectId: f.buyerSubjectId, userId: f.buyerUserId, listingId: f.listingId,
    quantity, quantityScaled, clientRequestId: `fee-order-${suffix}-000001`,
    payloadDigest: `sha256:${suffix.padEnd(64, '0').slice(0, 64)}`, expiresAt: new Date(now.getTime() + 1_800_000),
    now, requestId: `fee-request-${suffix}`, ipHash: `sha256:${'8'.repeat(64)}`,
    computeFulfillmentAvailable: true,
  });
  if (created.status !== 'created') throw new Error(`order not created: ${created.status}`);
  const action = (name: string, subjectId: string, userId: string) => ({
    subjectId, userId, orderId: created.order.id, clientRequestId: `fee-${name}-${suffix}-000001`,
    payloadDigest: `sha256:${name.padEnd(64, '1').slice(0, 64)}`, requestId: `fee-${name}-${suffix}`,
    ipHash: `sha256:${'7'.repeat(64)}`, now: new Date(),
  });
  await f.orders.confirm(action('confirm', f.supplierSubjectId, f.supplierUserId));
  await f.orders.startDelivery(action('delivery-start', f.supplierSubjectId, f.supplierUserId));
  const details = JSON.stringify({ endpoint: '10.0.0.8', token: randomUUID() });
  await f.orders.markDeliveryReady({
    ...action('delivery-ready', f.supplierSubjectId, f.supplierUserId),
    deliveryPayloadCiphertext: encryptPii(details, Buffer.alloc(32, 7).toString('base64')),
    deliveryPayloadDigest: secretHash(details, 'd'.repeat(32)),
  });
  await f.orders.accept({ ...action('accept', f.buyerSubjectId, f.buyerUserId), evidenceDigest: null });
  return (await f.orders.getForSubject(f.supplierSubjectId, created.order.id))!;
}

async function activateFixtureSchedule(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  await f.fees.createDraftSchedule({ id, version: 'fee-test-v1', tiers: fixtureTiers,
    operatorId: f.operatorOne, now: new Date('2026-08-01T00:00:00.000+08:00'),
    requestId: 'fee-schedule-draft-request', payloadDigest: `sha256:${'1'.repeat(64)}` });
  return f.fees.activateSchedule({ scheduleId: id, operatorId: f.operatorTwo,
    now: new Date('2026-08-01T00:01:00.000+08:00'), requestId: 'fee-schedule-activate-request',
    payloadDigest: `sha256:${'2'.repeat(64)}` });
}

async function replaceGrandfatherWithLockedPolicy(database: Database, orderId: string,
  schedule: Awaited<ReturnType<typeof activateFixtureSchedule>>) {
  await database.query(`DROP TRIGGER kai_credit_order_fee_policies_immutable ON kai_credit_order_fee_policies`);
  await database.query(`DELETE FROM kai_credit_order_fee_policies WHERE order_id = $1`, [orderId]);
  const order = await database.query<{ confirmed_at: Date }>(`SELECT confirmed_at FROM kai_credit_orders WHERE id = $1`, [orderId]);
  await database.query(`INSERT INTO kai_credit_order_fee_policies(order_id,policy_state,schedule_id,schedule_version,locked_at)
    VALUES ($1,'schedule_locked',$2,$3,$4)`, [orderId, schedule.id, schedule.version, order.rows[0]!.confirmed_at]);
  await database.query(`CREATE TRIGGER kai_credit_order_fee_policies_immutable BEFORE UPDATE OR DELETE
    ON kai_credit_order_fee_policies FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation()`);
}

async function balances(database: Database, subjectId: string) {
  const result = await database.query<{ account_kind: string; amount: string }>(`SELECT a.account_kind,
      COALESCE(sum(e.amount_micros) FILTER (WHERE t.status='posted'),0)::text AS amount
    FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id=a.id
    LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
    WHERE a.subject_id=$1 GROUP BY a.id,a.account_kind`, [subjectId]);
  return Object.fromEntries(result.rows.map((row) => [row.account_kind, BigInt(row.amount)]));
}

describe('KAI credit settlement fee store', () => {
  it('keeps every schedule inactive until explicit activation and permits correcting/deleting drafts', async () => {
    const f = await fixture();
    expect(await f.fees.activeSchedule(new Date())).toBeNull();
    const draftId = randomUUID();
    await f.fees.createDraftSchedule({ id: draftId, version: 'deletable-v1', tiers: fixtureTiers,
      operatorId: f.operatorOne, now: new Date(), requestId: 'draft-delete-request',
      payloadDigest: `sha256:${'3'.repeat(64)}` });
    await f.database.query(`UPDATE kai_credit_fee_tiers SET rate_bps=90 WHERE schedule_id=$1 AND ordinal=0`, [draftId]);
    await f.database.query(`DELETE FROM kai_credit_fee_schedules WHERE id=$1`, [draftId]);
    expect((await f.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM kai_credit_fee_tiers
      WHERE schedule_id=$1`, [draftId])).rows[0]?.count).toBe('0');
    await f.database.close();
  });

  it('grandfathers old orders and fails closed without a locked schedule', async () => {
    const f = await fixture(); const order = await createAcceptedOrder(f, 'grandfather');
    const before = await balances(f.database, f.supplierSubjectId);
    await expect(f.fees.assessSettlement({
      id: randomUUID(), supplierSubjectId: f.supplierSubjectId, orderId: order.id,
      sourceKind: 'compute_settlement', sourceId: 'grandfather-settlement-01',
      grossCreditMicros: order.totalCreditMicros, idempotencyOwner: `subject:${f.supplierSubjectId}`,
      idempotencyKey: 'grandfather-fee-attempt-01', payloadDigest: `sha256:${'4'.repeat(64)}`,
      assessedAt: new Date('2026-08-20T00:00:00.000+08:00'),
    })).rejects.toThrow('FEE_ORDER_POLICY_NOT_LOCKED');
    expect(await balances(f.database, f.supplierSubjectId)).toEqual(before);
    expect((await f.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM kai_credit_fee_assessments`))
      .rows[0]?.count).toBe('0');
    const settled = await f.orders.settleSupplier({
      subjectId: f.supplierSubjectId, userId: f.supplierUserId, orderId: order.id,
      clientRequestId: 'grandfather-live-settle-01', payloadDigest: `sha256:${'a'.repeat(64)}`,
      requestId: 'grandfather-live-settle-request', ipHash: `sha256:${'b'.repeat(64)}`,
      now: new Date(order.acceptedAt!.getTime() + 8 * 86_400_000),
    });
    expect(settled.status).toBe('settled');
    const legacy = await f.database.query<{ gross: string; fee: string; net: string }>(`SELECT
        credit_micros::text AS gross, service_fee_credit_micros::text AS fee,
        net_credit_micros::text AS net FROM kai_credit_supplier_settlements WHERE order_id=$1`, [order.id]);
    expect(legacy.rows[0]).toEqual({ gross: order.totalCreditMicros.toString(), fee: '0', net: order.totalCreditMicros.toString() });
    await f.database.close();
  });

  it('posts one atomic three-leg settlement, an original-period three-leg reversal, and an immutable supplier bill', async () => {
    const f = await fixture(); const schedule = await activateFixtureSchedule(f);
    const order = await createAcceptedOrder(f, 'settle');
    await replaceGrandfatherWithLockedPolicy(f.database, order.id, schedule);
    const assessed = await f.fees.assessSettlement({
      id: randomUUID(), supplierSubjectId: f.supplierSubjectId, orderId: order.id,
      sourceKind: 'compute_settlement', sourceId: 'compute-settlement-0001', grossCreditMicros: order.totalCreditMicros,
      idempotencyOwner: `subject:${f.supplierSubjectId}`, idempotencyKey: 'compute-fee-assess-0001',
      payloadDigest: `sha256:${'5'.repeat(64)}`, assessedAt: new Date('2026-08-20T00:00:00.000+08:00'),
    });
    expect(assessed.status).toBe('created');
    if (assessed.status !== 'created') throw new Error('assessment missing');
    expect(assessed.plan.segments).toHaveLength(2);
    const transaction = await f.database.query<{ status: string; entries: string; total: string }>(`SELECT t.status,
        count(e.id)::text AS entries,sum(e.amount_micros)::text AS total
      FROM kai_credit_fee_assessments a JOIN kai_credit_transactions t ON t.id=a.ledger_transaction_id
      JOIN kai_credit_entries e ON e.transaction_id=t.id WHERE a.id=$1 GROUP BY t.id`, [assessed.assessmentId]);
    expect(transaction.rows[0]).toEqual({ status: 'posted', entries: '3', total: '0' });
    expect((await balances(f.database, f.supplierSubjectId)).supplier_earnings_available)
      .toBe(assessed.plan.netCreditMicros);
    const persisted = await f.database.query<{
      schedule_id: string; schedule_version: string; period_id: string; period_start: string;
      gross: string; fee: string; net: string; before: string; after: string; ledger_transaction_id: string;
    }>(`SELECT schedule_id,schedule_version,period_id,period_start::text,gross_credit_micros::text AS gross,
        service_fee_credit_micros::text AS fee,net_credit_micros::text AS net,
        cumulative_before_micros::text AS before,cumulative_after_micros::text AS after,ledger_transaction_id
      FROM kai_credit_fee_assessments WHERE id=$1`, [assessed.assessmentId]);
    const row = persisted.rows[0]!;
    await expect(f.database.query(`INSERT INTO kai_credit_fee_assessments(id,supplier_subject_id,order_id,
        schedule_id,schedule_version,period_id,period_start,kind,source_kind,source_id,idempotency_owner,
        idempotency_key,payload_digest,gross_credit_micros,service_fee_credit_micros,net_credit_micros,
        cumulative_before_micros,cumulative_after_micros,ledger_transaction_id,assessed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'settlement','compute_settlement','attack-wrong-supplier-01',
        'attack:fee','attack-wrong-supplier-key',$8,$9,$10,$11,$12,$13,$14,now())`,
    [randomUUID(), f.buyerSubjectId, order.id, row.schedule_id, row.schedule_version, row.period_id,
      row.period_start, `sha256:${'c'.repeat(64)}`, row.gross, row.fee, row.net, row.before, row.after,
      row.ledger_transaction_id])).rejects.toThrow('fee assessment relation mismatch');
    const replay = await f.fees.assessSettlement({
      id: randomUUID(), supplierSubjectId: f.supplierSubjectId, orderId: order.id,
      sourceKind: 'compute_settlement', sourceId: 'compute-settlement-0001', grossCreditMicros: order.totalCreditMicros,
      idempotencyOwner: `subject:${f.supplierSubjectId}`, idempotencyKey: 'compute-fee-assess-0001',
      payloadDigest: `sha256:${'5'.repeat(64)}`, assessedAt: new Date('2026-08-20T00:00:00.000+08:00'),
    });
    expect(replay.status).toBe('replayed');
    const reversed = await f.fees.reverseSettlement({
      id: randomUUID(), supplierSubjectId: f.supplierSubjectId, orderId: order.id,
      originalAssessmentId: assessed.assessmentId, sourceId: 'compute-refund-0000001',
      grossCreditMicros: order.totalCreditMicros, idempotencyOwner: `subject:${f.supplierSubjectId}`,
      idempotencyKey: 'compute-fee-reverse-0001', payloadDigest: `sha256:${'6'.repeat(64)}`,
      assessedAt: new Date('2026-09-03T00:00:00.000+08:00'),
    });
    expect(reversed.status).toBe('created');
    if (reversed.status !== 'created') throw new Error('reversal missing');
    expect(reversed.plan.serviceFeeCreditMicros).toBe(assessed.plan.serviceFeeCreditMicros);
    const reversalTransaction = await f.database.query<{ entries: string; total: string }>(`SELECT count(e.id)::text AS entries,
        sum(e.amount_micros)::text AS total FROM kai_credit_fee_assessments a
      JOIN kai_credit_entries e ON e.transaction_id=a.ledger_transaction_id WHERE a.id=$1`, [reversed.assessmentId]);
    expect(reversalTransaction.rows[0]).toEqual({ entries: '3', total: '0' });
    expect((await balances(f.database, f.supplierSubjectId)).supplier_earnings_available).toBe(0n);
    const originalSegment = await f.database.query<{ id: string }>(`SELECT id FROM kai_credit_fee_assessment_segments
      WHERE assessment_id=$1 ORDER BY ordinal LIMIT 1`, [assessed.assessmentId]);
    await expect(f.database.query(`INSERT INTO kai_credit_fee_reversal_allocations(
      reversal_assessment_id,original_segment_id,reversed_credit_micros,reversed_fee_credit_micros)
      VALUES ($1,$2,1,1)`, [reversed.assessmentId, originalSegment.rows[0]!.id]))
      .rejects.toThrow('fee reversal allocation exceeds original segment');
    const period = await f.database.query<{ period_start: string; net: string }>(`SELECT period_start::text,
      net_settled_credit_micros::text AS net FROM kai_credit_supplier_fee_periods`);
    expect(period.rows[0]).toEqual({ period_start: '2026-08-01', net: '0' });
    const bills = await f.fees.listSupplierBills(f.supplierSubjectId, 10);
    expect(bills).toHaveLength(2);
    expect(bills.map((bill) => ({ kind: bill.kind, version: bill.feeScheduleVersion, period: bill.period })))
      .toEqual([{ kind: 'reversal', version: 'fee-test-v1', period: '2026-08' },
        { kind: 'settlement', version: 'fee-test-v1', period: '2026-08' }]);
    await expect(f.fees.reverseSettlement({
      id: randomUUID(), supplierSubjectId: f.supplierSubjectId, orderId: order.id,
      originalAssessmentId: assessed.assessmentId, sourceId: 'compute-refund-over-001',
      grossCreditMicros: 1n, idempotencyOwner: `subject:${f.supplierSubjectId}`,
      idempotencyKey: 'compute-fee-reverse-over', payloadDigest: `sha256:${'7'.repeat(64)}`,
      assessedAt: new Date('2026-09-04T00:00:00.000+08:00'),
    })).rejects.toThrow('FEE_REVERSAL_PERIOD_VOLUME_INVALID');
    await f.database.close();
  }, 30_000);

  it('posts and reverses a legal two-leg settlement when the rounded service fee is zero', async () => {
    const f = await fixture(); const schedule = await activateFixtureSchedule(f);
    // This focused fixture intentionally stops at the legacy fee schema. The
    // full-migration device and cent-contract suites exercise the 0055 trigger;
    // here we isolate the store's two-leg posting and reversal behavior.
    await f.database.query(`ALTER TABLE kai_credit_fee_assessments
      DROP CONSTRAINT kai_credit_fee_assessments_check3`);
    await f.database.query(`ALTER TABLE kai_credit_fee_assessments ADD CONSTRAINT
      kai_credit_fee_assessments_ledger_required CHECK (ledger_transaction_id IS NOT NULL)`);
    await f.database.query(`ALTER TABLE kai_credit_fee_assessments
      DISABLE TRIGGER kai_credit_fee_assessments_validate`);
    await f.database.query(`UPDATE credit_market_listings SET unit_credit_micros=10000,
      reference_cny_micros=10020 WHERE id=$1`, [f.listingId]);
    const order = await createAcceptedOrder(f, 'zero-fee', '1.000000', 1_000_000n);
    expect(order.totalCreditMicros).toBe(10_000n);
    await replaceGrandfatherWithLockedPolicy(f.database, order.id, schedule);
    const assessed = await f.fees.assessSettlement({
      id: randomUUID(), supplierSubjectId: f.supplierSubjectId, orderId: order.id,
      sourceKind: 'compute_settlement', sourceId: 'zero-fee-settlement-01',
      grossCreditMicros: order.totalCreditMicros, idempotencyOwner: `subject:${f.supplierSubjectId}`,
      idempotencyKey: 'zero-fee-assess-0001', payloadDigest: `sha256:${'a'.repeat(64)}`,
      assessedAt: new Date('2026-08-20T00:00:00.000+08:00'),
    });
    expect(assessed.status).toBe('created');
    if (assessed.status !== 'created') throw new Error('zero-fee assessment missing');
    expect(assessed.plan).toMatchObject({
      grossCreditMicros: 10_000n, serviceFeeCreditMicros: 0n, netCreditMicros: 10_000n,
    });
    const assessedLedger = await f.database.query<{ entries: string; total: string }>(`SELECT
        count(e.id)::text AS entries,sum(e.amount_micros)::text AS total
      FROM kai_credit_entries e WHERE e.transaction_id=$1`, [assessed.plan.ledgerTransactionId]);
    expect(assessedLedger.rows[0]).toEqual({ entries: '2', total: '0' });

    const reversed = await f.fees.reverseSettlement({
      id: randomUUID(), supplierSubjectId: f.supplierSubjectId, orderId: order.id,
      originalAssessmentId: assessed.assessmentId, sourceId: 'zero-fee-refund-0001',
      grossCreditMicros: order.totalCreditMicros, idempotencyOwner: `subject:${f.supplierSubjectId}`,
      idempotencyKey: 'zero-fee-reverse-001', payloadDigest: `sha256:${'b'.repeat(64)}`,
      assessedAt: new Date('2026-08-21T00:00:00.000+08:00'),
    });
    expect(reversed.status).toBe('created');
    if (reversed.status !== 'created') throw new Error('zero-fee reversal missing');
    expect(reversed.plan).toMatchObject({
      grossCreditMicros: 10_000n, serviceFeeCreditMicros: 0n, netCreditMicros: 10_000n,
    });
    const reversedLedger = await f.database.query<{ entries: string; total: string }>(`SELECT
        count(e.id)::text AS entries,sum(e.amount_micros)::text AS total
      FROM kai_credit_entries e WHERE e.transaction_id=$1`, [reversed.plan.ledgerTransactionId]);
    expect(reversedLedger.rows[0]).toEqual({ entries: '2', total: '0' });
    expect((await balances(f.database, f.supplierSubjectId)).supplier_earnings_available).toBe(0n);
    expect((await f.database.query<{ net: string }>(`SELECT net_settled_credit_micros::text AS net
      FROM kai_credit_supplier_fee_periods WHERE supplier_subject_id=$1`, [f.supplierSubjectId])).rows[0]?.net).toBe('0');
    await f.database.close();
  }, 30_000);

  it('serializes competing same-supplier month assessments without losing cumulative volume', async () => {
    const f = await fixture(); const schedule = await activateFixtureSchedule(f);
    const first = await createAcceptedOrder(f, 'parallel-one');
    const second = await createAcceptedOrder(f, 'parallel-two');
    await replaceGrandfatherWithLockedPolicy(f.database, first.id, schedule);
    await replaceGrandfatherWithLockedPolicy(f.database, second.id, schedule);
    const inputs = [first, second].map((order, index) => ({
      id: randomUUID(), supplierSubjectId: f.supplierSubjectId, orderId: order.id,
      sourceKind: 'compute_settlement' as const, sourceId: `parallel-settlement-000${index}`,
      grossCreditMicros: order.totalCreditMicros, idempotencyOwner: `subject:${f.supplierSubjectId}`,
      idempotencyKey: `parallel-fee-assess-000${index}`, payloadDigest: `sha256:${String(index).repeat(64)}`,
      assessedAt: new Date('2026-08-21T00:00:00.000+08:00'),
    }));
    const results = await Promise.all(inputs.map((input) => f.fees.assessSettlement(input)));
    expect(results.every((result) => result.status === 'created')).toBe(true);
    const created = results.flatMap((result) => result.status === 'created' ? [result] : []);
    expect(new Set(created.map((result) => result.plan.cumulativeBeforeMicros)).size).toBe(2);
    const period = await f.database.query<{ net: string }>(`SELECT net_settled_credit_micros::text AS net
      FROM kai_credit_supplier_fee_periods`);
    expect(BigInt(period.rows[0]!.net)).toBe(first.totalCreditMicros + second.totalCreditMicros);
    await f.database.close();
  }, 30_000);
});
