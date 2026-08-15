import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../src/credits/types.js';
import { PostgresCreditLedgerStore } from '../src/credits/store.js';
import type { Database } from '../src/database.js';
import { CreditOrderExpiryWorker } from '../src/credit-orders/expiry-worker.js';
import { CreditSupplierSettlementWorker } from '../src/credit-orders/settlement-worker.js';
import { PostgresCreditOrderStore } from '../src/credit-orders/store.js';
import { encryptPii, secretHash } from '../src/account/crypto.js';

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

async function fixture(capacity = '10') {
  const pglite = new PGlite();
  for (const name of [
    '0001_cloudpay_ledger.sql', '0015_credit_listing_audits.sql', '0016_trading_subjects.sql',
    '0022_kai_credit_double_entry_ledger.sql', '0024_kai_credit_order_reservations.sql',
    '0025_kai_credit_order_confirmation.sql', '0026_kai_credit_order_delivery_capture.sql',
    '0027_kai_credit_order_delivery_issues.sql', '0028_kai_credit_order_delivery_versions.sql',
    '0029_kai_credit_order_mutual_refunds.sql', '0030_kai_credit_supplier_settlements.sql',
    '0031_kai_credit_order_dispute_adjudication.sql',
    '0032_kai_credit_post_acceptance_refunds.sql',
    '0033_kai_credit_post_acceptance_adjudication.sql',
    '0034_kai_credit_partial_aftercare_remedies.sql',
    '0039_compute_node_readiness.sql',
    '0046_kai_credit_supplier_payouts.sql',
    '0049_supplier_earnings_accounts.sql',
  ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  const database = adapter(pglite);
  const buyerUserId = randomUUID(); const supplierUserId = randomUUID(); const otherUserId = randomUUID();
  const reviewerOne = randomUUID(); const reviewerTwo = randomUUID();
  const buyerSubjectId = randomUUID(); const supplierSubjectId = randomUUID(); const otherSubjectId = randomUUID();
  const resourceId = randomUUID(); const offerId = randomUUID(); const resourceAuditId = randomUUID(); const priceAuditId = randomUUID();
  const listingId = randomUUID();
  await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
    ($1, 'buyer', '买方', 'member'), ($2, 'supplier', '提供方', 'supplier'), ($3, 'other', '其他用户', 'member'),
    ($4, 'reviewer-one', '资源审核员', 'operator'), ($5, 'reviewer-two', '价格审核员', 'operator')`,
  [buyerUserId, supplierUserId, otherUserId, reviewerOne, reviewerTwo]);
  await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES
    ($1, 'personal', '买方', $2), ($3, 'personal', '提供方', $4), ($5, 'personal', '其他用户', $6)`,
  [buyerSubjectId, buyerUserId, supplierSubjectId, supplierUserId, otherSubjectId, otherUserId]);
  await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES
    ($1, $2, 'owner'), ($3, $4, 'owner'), ($5, $6, 'owner')`,
  [buyerSubjectId, buyerUserId, supplierSubjectId, supplierUserId, otherSubjectId, otherUserId]);
  await database.query(`INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
    VALUES ($1, $2, $1, '凯云算力有限公司', '91310101MA1ORDER01', '凯', 'approved')`, [supplierSubjectId, supplierUserId]);
  await database.query(`INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications,
    capacity_total, capacity_unit, status, verification_digest, verified_at)
    VALUES ($1, $2, 'gpu', 'H100-SXM-80G', '华东-上海', '{"memory":"80GB"}', $3, 'GPU时', 'verified', $4, now())`,
  [resourceId, supplierSubjectId, capacity, `sha256:${'a'.repeat(64)}`]);
  const nodeId = randomUUID(); const bindingId = randomUUID(); const bootId = randomUUID();
  await database.query(`INSERT INTO compute_nodes(id, supplier_id, node_public_key, node_key_fingerprint,
      inventory_digest, status, last_heartbeat_at, heartbeat_boot_id, heartbeat_sequence,
      heartbeat_payload_digest, heartbeat_signature)
    VALUES ($1,$2,$3,$4,$5,'ready',now(),$6,1,$7,$8)`,
  [nodeId, supplierSubjectId, `ed25519:${'A'.repeat(44)}`, `sha256:${'b'.repeat(64)}`,
    `sha256:${'c'.repeat(64)}`, bootId, `sha256:${'d'.repeat(64)}`, `ed25519:${'B'.repeat(88)}`]);
  await database.query(`INSERT INTO compute_resource_bindings(id, resource_id, node_id, status,
      resource_verification_digest, policy_digest, attested_policy_digest, inventory_digest, gpu_set_digest, confirmed_at)
    VALUES ($1,$2,$3,'ready',$4,$5,$5,$6,$7,now())`,
  [bindingId, resourceId, nodeId, `sha256:${'a'.repeat(64)}`, `sha256:${'e'.repeat(64)}`,
    `sha256:${'c'.repeat(64)}`, `sha256:${'f'.repeat(64)}`]);
  const validUntil = new Date(Date.now() + 30 * 86_400_000);
  await database.query(`INSERT INTO offer_templates(id, supplier_id, resource_id, client_request_id, payload_digest,
      submission_version, title, service_mode, native_unit, minimum_quantity, suggested_price_cny_micros,
      status, approved_reference_cny_micros, approved_unit_credit_micros, conversion_cny_micros_per_credit,
      audit_valid_until, submitted_at, approved_at)
    VALUES ($1, $2, $3, 'order-offer-request-0001', 'order-offer-digest', 1, '独享 H100 80GB', 'dedicated',
      'GPU时', 1, 31200000, 'approved', 31200000, 31137725, 1002000, $4, now(), now())`,
  [offerId, supplierSubjectId, resourceId, validUntil]);
  for (const audit of [
    { id: resourceAuditId, kind: 'resource', reviewer: reviewerOne },
    { id: priceAuditId, kind: 'price', reviewer: reviewerTwo },
  ]) await database.query(`INSERT INTO offer_audit_versions(id, offer_id, submission_version, kind, status,
      reviewer_id, decision_reason, evidence_summary, evidence_digest, decision_digest,
      approved_reference_cny_micros, conversion_cny_micros_per_credit, approved_unit_credit_micros, valid_until, decided_at)
    VALUES ($1, $2, 1, $3, 'approved', $4, '通过', '材料与实测一致', $5, $6,
      CASE WHEN $3 = 'price' THEN 31200000 ELSE NULL END,
      CASE WHEN $3 = 'price' THEN 1002000 ELSE NULL END,
      CASE WHEN $3 = 'price' THEN 31137725 ELSE NULL END, $7, now())`,
  [audit.id, offerId, audit.kind, audit.reviewer, `sha256:${audit.kind === 'price' ? 'b'.repeat(64) : 'c'.repeat(64)}`, `${audit.kind}-decision`, validUntil]);
  await database.query(`INSERT INTO credit_market_listings(id, offer_id, resource_id, supplier_id,
      client_request_id, payload_digest, resource_audit_id, price_audit_id, capacity_total, capacity_unit,
      minimum_quantity, unit_credit_micros, reference_cny_micros, conversion_cny_micros_per_credit,
      starts_at, expires_at, audit_snapshot, published_by)
    VALUES ($1, $2, $3, $4, 'order-listing-request-01', 'order-listing-digest', $5, $6, $7, 'GPU时',
      1, 31137725, 31200000, 1002000, now() - interval '1 minute', now() + interval '7 days', $8::jsonb, $9)`,
  [listingId, offerId, resourceId, supplierSubjectId, resourceAuditId, priceAuditId, capacity,
    JSON.stringify({ resourceAuditId, priceAuditId, validUntil: validUntil.toISOString() }), supplierUserId]);
  return {
    database, buyerUserId, supplierUserId, operatorUserId: reviewerOne,
    buyerSubjectId, supplierSubjectId, otherSubjectId, resourceId, nodeId, bindingId, listingId,
    store: new PostgresCreditOrderStore(database),
  };
}

async function fund(database: Database, subjectId: string, micros: bigint) {
  const ledger = new PostgresCreditLedgerStore(database);
  const accounts = await ledger.ensureSubjectAccounts(subjectId);
  const available = accounts.find((account) => account.kind === 'available')!.accountId;
  await ledger.post({
    id: randomUUID(), idempotencyOwner: 'platform:test', scope: 'TEST_FUND_BUYER',
    idempotencyKey: `fund-buyer-${randomUUID()}`, payloadDigest: `sha256:${'f'.repeat(64)}`,
    referenceType: 'adjustment', description: '测试卡时入账', entries: [
      { accountId: available, amountMicros: micros, memo: '测试入账' },
      { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: -micros, memo: '测试发行' },
    ],
  });
}

async function balances(database: Database, subjectId: string) {
  const rows = await database.query<{ account_kind: string; amount: string }>(`SELECT a.account_kind,
      COALESCE(sum(e.amount_micros) FILTER (WHERE t.status = 'posted'), 0)::text AS amount
    FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id = a.id
    LEFT JOIN kai_credit_transactions t ON t.id = e.transaction_id
    WHERE a.subject_id = $1 GROUP BY a.id, a.account_kind`, [subjectId]);
  return Object.fromEntries(rows.rows.map((row) => [row.account_kind, BigInt(row.amount)]));
}

function orderInput(f: Awaited<ReturnType<typeof fixture>>, input: Readonly<{
  quantity?: string; quantityScaled?: bigint; key?: string; buyerSubjectId?: string; userId?: string; expiresAt?: Date;
}> = {}) {
  const quantity = input.quantity ?? '2.500000';
  return {
    id: randomUUID(), orderNumber: `KC20260812${randomUUID().slice(0, 12).replaceAll('-', '').toUpperCase()}`,
    buyerSubjectId: input.buyerSubjectId ?? f.buyerSubjectId, userId: input.userId ?? f.buyerUserId,
    listingId: f.listingId, quantity, quantityScaled: input.quantityScaled ?? 2_500_000n,
    clientRequestId: input.key ?? `credit-order-${randomUUID()}`, payloadDigest: `sha512:${quantity}:${f.listingId}`,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 60_000), now: new Date(),
    requestId: `request-${randomUUID()}`, ipHash: `sha512:${'i'.repeat(64)}`,
    computeFulfillmentAvailable: true,
  };
}

function actionInput(f: Awaited<ReturnType<typeof fixture>>, orderId: string, input: Readonly<{
  subjectId?: string; userId?: string; key?: string;
  action?: 'confirm' | 'cancel' | 'start_delivery' | 'delivery_ready' | 'accept' | 'report_delivery_issue' | 'start_rework' | 'approve_refund' | 'settle' | 'escalate_dispute' | 'request_post_acceptance_refund' | 'approve_post_acceptance_refund' | 'contest_post_acceptance_refund' | 'escalate_post_acceptance_refund'; now?: Date;
}> = {}) {
  const action = input.action ?? 'confirm';
  const providerAction = ['confirm', 'start_delivery', 'delivery_ready', 'start_rework', 'approve_refund', 'settle',
    'approve_post_acceptance_refund', 'contest_post_acceptance_refund'].includes(action);
  const subjectId = input.subjectId ?? (providerAction ? f.supplierSubjectId : f.buyerSubjectId);
  return {
    subjectId, userId: input.userId ?? (providerAction ? f.supplierUserId : f.buyerUserId), orderId,
    clientRequestId: input.key ?? `${action}-order-${randomUUID()}`,
    payloadDigest: `sha512:${action}:${subjectId}:${orderId}`,
    requestId: `request-${randomUUID()}`, ipHash: `sha512:${'j'.repeat(64)}`, now: input.now ?? new Date(),
  };
}

async function createAcceptedOrder(f: Awaited<ReturnType<typeof fixture>>, acceptedAt = new Date()) {
  const created = await f.store.createReservation(orderInput(f));
  if (created.status !== 'created') throw new Error('order missing');
  await f.store.confirm(actionInput(f, created.order.id));
  await f.store.startDelivery(actionInput(f, created.order.id, { action: 'start_delivery' }));
  const details = JSON.stringify({ endpoint: '10.0.0.8', token: randomUUID() });
  await f.store.markDeliveryReady({
    ...actionInput(f, created.order.id, { action: 'delivery_ready' }),
    deliveryPayloadCiphertext: encryptPii(details, Buffer.alloc(32, 7).toString('base64')),
    deliveryPayloadDigest: secretHash(details, 'd'.repeat(32)),
  });
  await f.store.accept({
    ...actionInput(f, created.order.id, { action: 'accept', now: acceptedAt }), evidenceDigest: null,
  });
  return created.order.id;
}

async function createRefundDispute(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.store.createReservation(orderInput(f));
  if (created.status !== 'created') throw new Error('order missing');
  await f.store.confirm(actionInput(f, created.order.id));
  await f.store.startDelivery(actionInput(f, created.order.id, { action: 'start_delivery' }));
  const delivery = JSON.stringify({ endpoint: '10.0.0.8', token: randomUUID() });
  const key = Buffer.alloc(32, 7).toString('base64');
  await f.store.markDeliveryReady({
    ...actionInput(f, created.order.id, { action: 'delivery_ready' }),
    deliveryPayloadCiphertext: encryptPii(delivery, key),
    deliveryPayloadDigest: secretHash(delivery, 'd'.repeat(32)),
  });
  const issueDescription = JSON.stringify({ requestedResolution: 'refund', description: '交付资源与约定不一致。' });
  await f.store.reportDeliveryIssue({
    ...actionInput(f, created.order.id, { action: 'report_delivery_issue' }),
    requestedResolution: 'refund', descriptionCiphertext: encryptPii(issueDescription, key),
    descriptionDigest: secretHash('交付资源与约定不一致。', 'd'.repeat(32)),
  });
  return created.order.id;
}

describe('KAI credit order reservations', () => {
  it('mutates no order, balance, or capacity while compute fulfillment is unavailable', { timeout: 30_000 }, async () => {
    const f = await fixture(); await fund(f.database, f.buyerSubjectId, 200_000_000n);
    const input = { ...orderInput(f, { key: 'compute-runtime-gate-0001' }), computeFulfillmentAvailable: false };
    const baselineBalances = await balances(f.database, f.buyerSubjectId);

    expect(await f.store.createReservation(input)).toEqual({ status: 'commerce_unavailable' });
    expect(await f.store.createReservation(input)).toEqual({ status: 'commerce_unavailable' });
    expect(await balances(f.database, f.buyerSubjectId)).toEqual(baselineBalances);
    expect((await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_orders
      WHERE client_request_id=$1`, [input.clientRequestId])).rows[0]?.count).toBe('0');
    expect((await f.database.query<{ capacity_reserved: string }>(`SELECT capacity_reserved::text
      FROM credit_market_listings WHERE id=$1`, [f.listingId])).rows[0]?.capacity_reserved).toBe('0.000000');

    const recovered = await f.store.createReservation({ ...input, computeFulfillmentAvailable: true });
    expect(recovered.status).toBe('created'); await f.database.close();
  });

  it('freezes no credits or capacity when the bound node is stale, future-dated, or policy-drifted', { timeout: 30_000 }, async () => {
    const f = await fixture(); await fund(f.database, f.buyerSubjectId, 200_000_000n);
    const baselineBalances = await balances(f.database, f.buyerSubjectId);

    const assertRejectedWithoutHolds = async (key: string) => {
      expect(await f.store.createReservation(orderInput(f, { key }))).toEqual({ status: 'listing_unavailable' });
      expect(await balances(f.database, f.buyerSubjectId)).toEqual(baselineBalances);
      const listing = await f.database.query<{ capacity_reserved: string }>(
        `SELECT capacity_reserved::text FROM credit_market_listings WHERE id = $1`, [f.listingId],
      );
      expect(listing.rows[0]?.capacity_reserved).toBe('0.000000');
      const orders = await f.database.query<{ count: string }>(
        `SELECT count(*)::text FROM kai_credit_orders WHERE listing_id = $1`, [f.listingId],
      );
      expect(orders.rows[0]?.count).toBe('0');
    };

    await f.database.query(`UPDATE compute_nodes SET last_heartbeat_at = now() - interval '3 minutes' WHERE id = $1`, [f.nodeId]);
    await assertRejectedWithoutHolds('credit-order-stale-node-001');

    await f.database.query(`UPDATE compute_nodes SET last_heartbeat_at = now() + interval '31 seconds' WHERE id = $1`, [f.nodeId]);
    await assertRejectedWithoutHolds('credit-order-future-node-001');

    await f.database.query(`UPDATE compute_nodes SET last_heartbeat_at = now() WHERE id = $1`, [f.nodeId]);
    await f.database.query(`UPDATE compute_resource_bindings SET attested_policy_digest = $2 WHERE id = $1`,
      [f.bindingId, `sha256:${'9'.repeat(64)}`]);
    await assertRejectedWithoutHolds('credit-order-policy-drift-001');

    await f.database.close();
  });

  it('atomically reserves exact credits and inventory, then replays without a second hold', { timeout: 30_000 }, async () => {
    const f = await fixture(); await fund(f.database, f.buyerSubjectId, 200_000_000n);
    const input = orderInput(f, { key: 'credit-order-idempotent-001' });
    const created = await f.store.createReservation(input);
    expect(created).toMatchObject({ status: 'created', order: { quantity: '2.500000', totalCreditMicros: 77_844_313n } });
    const replayed = await f.store.createReservation({ ...input, id: randomUUID(), orderNumber: 'KC20260812REPLAYED000001' });
    expect(replayed).toMatchObject({ status: 'replayed', order: { id: created.status === 'created' ? created.order.id : '' } });
    expect(await f.store.createReservation({ ...input, id: randomUUID(), quantity: '3.000000', quantityScaled: 3_000_000n,
      payloadDigest: 'sha512:different-order-payload' })).toEqual({ status: 'conflict' });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 122_155_687n, reserved: 77_844_313n });
    const listing = await f.database.query<{ capacity_reserved: string }>(`SELECT capacity_reserved::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]?.capacity_reserved).toBe('2.500000');
    expect(await f.store.listForSubject(f.buyerSubjectId, 20)).toHaveLength(1);
    expect(await f.store.listForSubject(f.supplierSubjectId, 20)).toHaveLength(1);
    expect(await f.store.listForSubject(f.otherSubjectId, 20)).toHaveLength(0);
    expect(await f.store.listForSubject(f.buyerSubjectId, 20, 'buyer')).toHaveLength(1);
    expect(await f.store.listForSubject(f.buyerSubjectId, 20, 'provider')).toHaveLength(0);
    expect(await f.store.listForSubject(f.supplierSubjectId, 20, 'provider')).toHaveLength(1);
    expect(await f.store.listForSubject(f.supplierSubjectId, 20, 'buyer')).toHaveLength(0);
    if (created.status !== 'created') throw new Error('order missing');
    expect(await f.store.listForSubject(f.buyerSubjectId, 20, 'buyer', {
      createdAt: created.order.createdAt, id: created.order.id,
    })).toHaveLength(0);
    const notices = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM notifications WHERE user_id = $1 AND title = '有新订单待确认'`, [f.supplierUserId]);
    expect(notices.rows[0]?.count).toBe('1');
    const notice = await f.database.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM notifications WHERE user_id = $1 AND title = '有新订单待确认' LIMIT 1`,
      [f.supplierUserId],
    );
    expect(notice.rows[0]?.data).toMatchObject({
      route: 'provider_order', orderId: created.order.id, subjectId: f.supplierSubjectId,
    });
    const audits = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM audit_events
      WHERE action = 'KAI_CREDIT_ORDER_RESERVED' AND entity_id = $1`, [created.status === 'created' ? created.order.id : '']);
    expect(audits.rows[0]?.count).toBe('1');
    await f.database.close();
  });

  it('leaves no order, credit hold, or inventory hold on insufficient balance and self-purchase', { timeout: 30_000 }, async () => {
    const f = await fixture(); await fund(f.database, f.buyerSubjectId, 10_000_000n);
    expect(await f.store.createReservation(orderInput(f))).toEqual({ status: 'insufficient_credits' });
    expect(await f.store.createReservation(orderInput(f, {
      buyerSubjectId: f.supplierSubjectId, userId: f.supplierUserId, key: 'credit-order-self-buy-001',
    }))).toEqual({ status: 'self_purchase' });
    expect(await f.store.listForSubject(f.buyerSubjectId, 20)).toHaveLength(0);
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 10_000_000n, reserved: 0n });
    const listing = await f.database.query<{ capacity_reserved: string }>(`SELECT capacity_reserved::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]?.capacity_reserved).toBe('0.000000');
    await f.database.close();
  });

  it('allows only one competing reservation when balance and capacity cannot cover both', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    const attempts = await Promise.all([
      f.store.createReservation(orderInput(f, { key: 'credit-order-race-one-01' })),
      f.store.createReservation(orderInput(f, { key: 'credit-order-race-two-02' })),
    ]);
    expect(attempts.filter((result) => result.status === 'created')).toHaveLength(1);
    expect(attempts.filter((result) => ['listing_unavailable', 'insufficient_credits'].includes(result.status))).toHaveLength(1);
    expect(await f.store.listForSubject(f.buyerSubjectId, 20)).toHaveLength(1);
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 22_155_687n, reserved: 77_844_313n });
    const listing = await f.database.query<{ capacity_reserved: string }>(`SELECT capacity_reserved::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]?.capacity_reserved).toBe('2.500000');
    await f.database.close();
  });

  it('reserves a 200-unit demo inventory as 199 plus 1 and rejects unit 201', { timeout: 30_000 }, async () => {
    const f = await fixture('200'); await fund(f.database, f.buyerSubjectId, 10_000_000_000n);
    expect((await f.store.createReservation(orderInput(f, {
      quantity: '199.000000', quantityScaled: 199_000_000n, key: 'spark-demo-order-199-units',
    }))).status).toBe('created');
    expect((await f.store.createReservation(orderInput(f, {
      quantity: '1.000000', quantityScaled: 1_000_000n, key: 'spark-demo-order-last-unit',
    }))).status).toBe('created');
    expect((await f.store.createReservation(orderInput(f, {
      quantity: '1.000000', quantityScaled: 1_000_000n, key: 'spark-demo-order-unit-201',
    }))).status).toBe('listing_unavailable');
    const listing = await f.database.query<{ capacity_reserved: string; status: string }>(
      `SELECT capacity_reserved::text,status FROM credit_market_listings WHERE id=$1`, [f.listingId],
    );
    expect(listing.rows[0]).toEqual({ capacity_reserved: '200.000000', status: 'sold_out' });
    await f.database.close();
  });

  it('lets only one buyer reserve the final unit of demo inventory', { timeout: 30_000 }, async () => {
    const f = await fixture('200');
    await fund(f.database, f.buyerSubjectId, 10_000_000_000n);
    await fund(f.database, f.otherSubjectId, 100_000_000n);
    expect((await f.store.createReservation(orderInput(f, {
      quantity: '199.000000', quantityScaled: 199_000_000n, key: 'spark-demo-race-prime-199',
    }))).status).toBe('created');
    const attempts = await Promise.all([
      f.store.createReservation(orderInput(f, {
        quantity: '1.000000', quantityScaled: 1_000_000n, key: 'spark-demo-last-race-one',
      })),
      f.store.createReservation(orderInput(f, {
        buyerSubjectId: f.otherSubjectId, userId: f.supplierUserId,
        quantity: '1.000000', quantityScaled: 1_000_000n, key: 'spark-demo-last-race-two',
      })),
    ]);
    expect(attempts.filter((item) => item.status === 'created')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'listing_unavailable')).toHaveLength(1);
    const listing = await f.database.query<{ capacity_reserved: string; status: string }>(
      `SELECT capacity_reserved::text,status FROM credit_market_listings WHERE id=$1`, [f.listingId],
    );
    expect(listing.rows[0]).toEqual({ capacity_reserved: '200.000000', status: 'sold_out' });
    await f.database.close();
  });

  it('returns credits and capacity exactly once when a provider confirmation times out', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    const now = new Date();
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-expiry-0001', expiresAt: new Date(now.getTime() - 1000) }));
    expect(created.status).toBe('created');
    const errors: unknown[] = [];
    const worker = new CreditOrderExpiryWorker(f.store, {
      info: () => undefined, error: (fields) => errors.push(fields),
    }, 60_000, () => now);
    await worker.tick();
    expect(errors).toEqual([]);
    expect(await f.store.expireReservations(now, 50)).toBe(0);
    if (created.status !== 'created') throw new Error('order missing');
    expect(await f.store.getForSubject(f.buyerSubjectId, created.order.id)).toMatchObject({ status: 'expired' });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 100_000_000n, reserved: 0n });
    const listing = await f.database.query<{ capacity_reserved: string; status: string }>(`SELECT capacity_reserved::text, status FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]).toEqual({ capacity_reserved: '0.000000', status: 'active' });
    const releaseTransactions = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_ORDER_RELEASE' AND reference_id = $1`, [created.order.id]);
    expect(releaseTransactions.rows[0]?.count).toBe('1');
    await f.database.close();
  });

  it('lets the provider confirm once and keeps credits secured beyond the temporary deadline', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-confirm-0001' }));
    if (created.status !== 'created') throw new Error('order missing');
    const input = actionInput(f, created.order.id, { key: 'provider-confirm-order-001' });
    expect(await f.store.confirm(input)).toMatchObject({ status: 'confirmed', order: { status: 'confirmed' } });
    expect(await f.store.confirm(input)).toMatchObject({ status: 'replayed', order: { status: 'confirmed' } });
    expect(await f.store.cancel(actionInput(f, created.order.id, { action: 'cancel', key: 'buyer-cancel-after-confirm' })))
      .toEqual({ status: 'invalid_state' });
    expect(await f.store.expireReservations(new Date(Date.now() + 86_400_000), 50)).toBe(0);
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 22_155_687n, reserved: 77_844_313n });
    const reservation = await f.database.query<{ status: string; secured_by_user_id: string | null }>(`SELECT status, secured_by_user_id
      FROM kai_credit_order_reservations WHERE order_id = $1`, [created.order.id]);
    expect(reservation.rows[0]).toEqual({ status: 'secured', secured_by_user_id: f.supplierUserId });
    const listing = await f.database.query<{ capacity_reserved: string }>(`SELECT capacity_reserved::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]?.capacity_reserved).toBe('2.500000');
    const notices = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM notifications
      WHERE user_id = $1 AND title = '提供方已确认订单'`, [f.buyerUserId]);
    expect(notices.rows[0]?.count).toBe('1');
    await f.database.close();
  });

  it('lets the buyer cancel before confirmation and releases credits and capacity once', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-cancel-00001' }));
    if (created.status !== 'created') throw new Error('order missing');
    const input = actionInput(f, created.order.id, { action: 'cancel', key: 'buyer-cancel-order-00001' });
    expect(await f.store.cancel(input)).toMatchObject({ status: 'cancelled', order: { status: 'cancelled' } });
    expect(await f.store.cancel(input)).toMatchObject({ status: 'replayed', order: { status: 'cancelled' } });
    expect(await f.store.confirm(actionInput(f, created.order.id, { key: 'provider-confirm-cancelled' }))).toEqual({ status: 'invalid_state' });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 100_000_000n, reserved: 0n });
    const listing = await f.database.query<{ capacity_reserved: string; status: string }>(`SELECT capacity_reserved::text, status
      FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]).toEqual({ capacity_reserved: '0.000000', status: 'active' });
    const releases = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_ORDER_RELEASE' AND reference_id = $1`, [created.order.id]);
    expect(releases.rows[0]?.count).toBe('1');
    await f.database.close();
  });

  it('resolves a simultaneous provider confirmation and buyer cancellation to exactly one outcome', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-action-race01' }));
    if (created.status !== 'created') throw new Error('order missing');
    const [confirmation, cancellation] = await Promise.all([
      f.store.confirm(actionInput(f, created.order.id, { key: 'provider-confirm-race-001' })),
      f.store.cancel(actionInput(f, created.order.id, { action: 'cancel', key: 'buyer-cancel-race-0001' })),
    ]);
    const final = await f.store.getForSubject(f.buyerSubjectId, created.order.id);
    expect(['confirmed', 'cancelled']).toContain(final?.status);
    expect([confirmation.status, cancellation.status]).toEqual(expect.arrayContaining([
      final?.status === 'confirmed' ? 'confirmed' : 'cancelled', 'invalid_state',
    ]));
    const balance = await balances(f.database, f.buyerSubjectId);
    const listing = await f.database.query<{ capacity_reserved: string }>(`SELECT capacity_reserved::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    if (final?.status === 'confirmed') {
      expect(balance).toMatchObject({ available: 22_155_687n, reserved: 77_844_313n });
      expect(listing.rows[0]?.capacity_reserved).toBe('2.500000');
    } else {
      expect(balance).toMatchObject({ available: 100_000_000n, reserved: 0n });
      expect(listing.rows[0]?.capacity_reserved).toBe('0.000000');
    }
    await f.database.close();
  });

  it('serializes one action idempotency key across different orders before either action executes', { timeout: 30_000 }, async () => {
    const f = await fixture('10'); await fund(f.database, f.buyerSubjectId, 200_000_000n);
    const first = await f.store.createReservation(orderInput(f, { key: 'credit-order-cross-action01' }));
    const second = await f.store.createReservation(orderInput(f, { key: 'credit-order-cross-action02' }));
    if (first.status !== 'created' || second.status !== 'created') throw new Error('orders missing');
    const key = 'provider-confirm-cross-order';
    const [left, right] = await Promise.all([
      f.store.confirm(actionInput(f, first.order.id, { key })),
      f.store.confirm(actionInput(f, second.order.id, { key })),
    ]);
    expect([left.status, right.status].sort()).toEqual(['confirmed', 'conflict']);
    const actions = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_order_action_requests
      WHERE subject_id = $1 AND action = 'confirm' AND client_request_id = $2`, [f.supplierSubjectId, key]);
    expect(actions.rows[0]?.count).toBe('1');
    await f.database.close();
  });

  it('captures secured credits only after buyer acceptance and moves inventory from reserved to sold', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-delivery-001' }));
    if (created.status !== 'created') throw new Error('order missing');
    await f.store.confirm(actionInput(f, created.order.id, { key: 'provider-confirm-delivery' }));
    const started = actionInput(f, created.order.id, { key: 'provider-start-delivery01' });
    expect(await f.store.startDelivery(started)).toMatchObject({ status: 'provisioning', order: { status: 'provisioning' } });
    expect(await f.store.startDelivery(started)).toMatchObject({ status: 'replayed', order: { status: 'provisioning' } });
    const deliverySecret = `root-password-${randomUUID()}`;
    const deliveryCanonical = JSON.stringify({ endpoint: '10.0.0.8', username: 'root', password: deliverySecret });
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const detailsDigest = secretHash(deliveryCanonical, 'd'.repeat(32));
    const ready = {
      ...actionInput(f, created.order.id, { key: 'provider-ready-delivery01' }),
      deliveryPayloadCiphertext: encryptPii(deliveryCanonical, encryptionKey), deliveryPayloadDigest: detailsDigest,
    };
    expect(await f.store.markDeliveryReady(ready)).toMatchObject({
      status: 'acceptance_pending', order: { status: 'acceptance_pending' },
    });
    expect(await f.store.markDeliveryReady(ready)).toMatchObject({
      status: 'replayed', order: { status: 'acceptance_pending' },
    });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 22_155_687n, reserved: 77_844_313n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 0n });
    const accepted = {
      ...actionInput(f, created.order.id, { action: 'accept', key: 'buyer-accept-delivery-001' }),
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
    };
    expect(await f.store.accept(accepted)).toMatchObject({ status: 'accepted', order: { status: 'accepted' } });
    expect(await f.store.accept(accepted)).toMatchObject({ status: 'replayed', order: { status: 'accepted' } });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 22_155_687n, reserved: 0n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 77_844_313n });
    const listing = await f.database.query<{ capacity_reserved: string; capacity_sold: string }>(`SELECT
      capacity_reserved::text, capacity_sold::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]).toEqual({ capacity_reserved: '0.000000', capacity_sold: '2.500000' });
    const capture = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_ORDER_CAPTURE' AND reference_id = $1`, [created.order.id]);
    expect(capture.rows[0]?.count).toBe('1');
    const reservation = await f.database.query<{ status: string }>(`SELECT status FROM kai_credit_order_reservations WHERE order_id = $1`, [created.order.id]);
    expect(reservation.rows[0]?.status).toBe('captured');
    const storedText = await f.database.query<{ content: string }>(`SELECT
      COALESCE((SELECT string_agg(delivery_payload_ciphertext, '') FROM kai_credit_order_deliveries WHERE order_id = $1), '')
      || COALESCE((SELECT string_agg(title || body || data::text, '') FROM notifications), '')
      || COALESCE((SELECT string_agg(payload::text, '') FROM kai_credit_order_events WHERE order_id = $1), '')
      || COALESCE((SELECT string_agg(metadata::text, '') FROM audit_events WHERE entity_id = $1::text), '') AS content`,
    [created.order.id]);
    expect(storedText.rows[0]?.content).not.toContain(deliverySecret);
    expect(storedText.rows[0]?.content).not.toContain('10.0.0.8');
    await expect(f.database.query(`UPDATE kai_credit_order_deliveries SET delivery_payload_ciphertext = 'changed'
      WHERE order_id = $1`, [created.order.id])).rejects.toThrow(/immutable/u);
    await f.database.close();
  });

  it('does not capture before delivery is ready and permits only order participants to read delivery data', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-early-accept01' }));
    if (created.status !== 'created') throw new Error('order missing');
    expect(await f.store.accept({
      ...actionInput(f, created.order.id, { action: 'accept', key: 'buyer-early-accept-0001' }), evidenceDigest: null,
    })).toEqual({ status: 'invalid_state' });
    expect(await f.store.deliveryForSubject(f.otherSubjectId, created.order.id)).toBeNull();
    expect((await f.store.deliveryForSubject(f.buyerSubjectId, created.order.id))?.attempts).toEqual([]);
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 0n });
    await f.database.close();
  });

  it('holds secured credits and capacity when the buyer reports a delivery issue', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-issue-create01' }));
    if (created.status !== 'created') throw new Error('order missing');
    await f.store.confirm(actionInput(f, created.order.id, { key: 'provider-confirm-issue01' }));
    await f.store.startDelivery(actionInput(f, created.order.id, { key: 'provider-start-issue0001' }));
    const issueText = `无法登录-${randomUUID()}`;
    const issueCiphertext = encryptPii(JSON.stringify({ requestedResolution: 'rework', description: issueText }),
      Buffer.alloc(32, 7).toString('base64'));
    await f.store.markDeliveryReady({
      ...actionInput(f, created.order.id, { key: 'provider-ready-issue0001' }),
      deliveryPayloadCiphertext: encryptPii('{"endpoint":"10.0.0.8"}', Buffer.alloc(32, 7).toString('base64')),
      deliveryPayloadDigest: secretHash('{"endpoint":"10.0.0.8"}', 'd'.repeat(32)),
    });
    const input = {
      ...actionInput(f, created.order.id, { action: 'report_delivery_issue', key: 'buyer-report-issue-0001' }),
      requestedResolution: 'rework' as const, descriptionCiphertext: issueCiphertext,
      descriptionDigest: secretHash(issueText, 'd'.repeat(32)),
    };
    expect(await f.store.reportDeliveryIssue(input)).toMatchObject({ status: 'disputed', order: { status: 'disputed' } });
    expect(await f.store.reportDeliveryIssue(input)).toMatchObject({ status: 'replayed', order: { status: 'disputed' } });
    expect(await f.store.accept({
      ...actionInput(f, created.order.id, { action: 'accept', key: 'buyer-accept-after-issue01' }), evidenceDigest: null,
    })).toEqual({ status: 'invalid_state' });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 22_155_687n, reserved: 77_844_313n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 0n });
    const listing = await f.database.query<{ capacity_reserved: string; capacity_sold: string }>(`SELECT
      capacity_reserved::text, capacity_sold::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]).toEqual({ capacity_reserved: '2.500000', capacity_sold: '0.000000' });
    expect((await f.store.deliveryIssueForSubject(f.buyerSubjectId, created.order.id))?.descriptionCiphertext).toBe(issueCiphertext);
    expect(await f.store.deliveryIssueForSubject(f.otherSubjectId, created.order.id)).toBeNull();
    const storedText = await f.database.query<{ content: string }>(`SELECT
      COALESCE((SELECT string_agg(description_ciphertext, '') FROM kai_credit_order_delivery_issues WHERE order_id = $1), '')
      || COALESCE((SELECT string_agg(title || body || data::text, '') FROM notifications), '')
      || COALESCE((SELECT string_agg(payload::text, '') FROM kai_credit_order_events WHERE order_id = $1), '')
      || COALESCE((SELECT string_agg(metadata::text, '') FROM audit_events WHERE entity_id = $1::text), '') AS content`,
    [created.order.id]);
    expect(storedText.rows[0]?.content).not.toContain(issueText);
    await expect(f.database.query(`UPDATE kai_credit_order_delivery_issues SET requested_resolution = 'refund'
      WHERE order_id = $1`, [created.order.id])).rejects.toThrow(/immutable/u);
    await f.database.close();
  });

  it('appends a new delivery attempt after rework and captures only the accepted attempt', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-rework-create' }));
    if (created.status !== 'created') throw new Error('order missing');
    await f.store.confirm(actionInput(f, created.order.id, { key: 'provider-confirm-rework1' }));
    await f.store.startDelivery(actionInput(f, created.order.id, { key: 'provider-start-rework001' }));
    const key = Buffer.alloc(32, 8).toString('base64');
    const firstPlaintext = JSON.stringify({ endpoint: '10.0.0.8', password: 'first-secret' });
    await f.store.markDeliveryReady({
      ...actionInput(f, created.order.id, { key: 'provider-ready-rework001' }),
      deliveryPayloadCiphertext: encryptPii(firstPlaintext, key),
      deliveryPayloadDigest: secretHash(firstPlaintext, 'd'.repeat(32)),
    });
    await f.store.reportDeliveryIssue({
      ...actionInput(f, created.order.id, { action: 'report_delivery_issue', key: 'buyer-rework-issue-0001' }),
      requestedResolution: 'rework', descriptionCiphertext: encryptPii('{"description":"无法连接"}', key),
      descriptionDigest: secretHash('无法连接', 'd'.repeat(32)),
    });
    const startRework = actionInput(f, created.order.id, { key: 'provider-start-rework002', action: 'start_rework' });
    expect(await f.store.startRework(startRework)).toMatchObject({ status: 'provisioning', order: { status: 'provisioning' } });
    expect(await f.store.startRework(startRework)).toMatchObject({ status: 'replayed', order: { status: 'provisioning' } });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ reserved: 77_844_313n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 0n });
    const secondPlaintext = JSON.stringify({ endpoint: '10.0.0.9', password: 'second-secret' });
    await f.store.markDeliveryReady({
      ...actionInput(f, created.order.id, { key: 'provider-ready-rework002' }),
      deliveryPayloadCiphertext: encryptPii(secondPlaintext, key),
      deliveryPayloadDigest: secretHash(secondPlaintext, 'd'.repeat(32)),
    });
    const history = await f.store.deliveryForSubject(f.buyerSubjectId, created.order.id);
    expect(history?.attempts.map((attempt) => ({ number: attempt.attemptNumber, status: attempt.status }))).toEqual([
      { number: 1, status: 'superseded' }, { number: 2, status: 'ready' },
    ]);
    expect(await f.store.reportDeliveryIssue({
      ...actionInput(f, created.order.id, { action: 'report_delivery_issue', key: 'buyer-rework-issue-0002' }),
      requestedResolution: 'rework', descriptionCiphertext: encryptPii('{"description":"仍不符合"}', key),
      descriptionDigest: secretHash('仍不符合', 'd'.repeat(32)),
    })).toMatchObject({ status: 'disputed' });
    expect((await f.store.deliveryIssueForSubject(f.buyerSubjectId, created.order.id))?.requestedResolution).toBe('rework');
    const thirdStart = actionInput(f, created.order.id, { key: 'provider-start-rework003', action: 'start_rework' });
    expect(await f.store.startRework(thirdStart)).toMatchObject({ status: 'provisioning' });
    const thirdPlaintext = JSON.stringify({ endpoint: '10.0.0.10', password: 'third-secret' });
    await f.store.markDeliveryReady({
      ...actionInput(f, created.order.id, { key: 'provider-ready-rework003' }),
      deliveryPayloadCiphertext: encryptPii(thirdPlaintext, key),
      deliveryPayloadDigest: secretHash(thirdPlaintext, 'd'.repeat(32)),
    });
    expect(await f.store.accept({
      ...actionInput(f, created.order.id, { action: 'accept', key: 'buyer-accept-rework-final' }), evidenceDigest: null,
    })).toMatchObject({ status: 'accepted' });
    const attempts = await f.database.query<{ id: string; attempt_number: number; status: string }>(`SELECT id,
      attempt_number, status FROM kai_credit_order_deliveries WHERE order_id = $1 ORDER BY attempt_number`, [created.order.id]);
    expect(attempts.rows.map((attempt) => ({ number: attempt.attempt_number, status: attempt.status }))).toEqual([
      { number: 1, status: 'superseded' }, { number: 2, status: 'superseded' }, { number: 3, status: 'completed' },
    ]);
    const acceptance = await f.database.query<{ delivery_attempt_id: string }>(`SELECT delivery_attempt_id
      FROM kai_credit_order_acceptances WHERE order_id = $1`, [created.order.id]);
    expect(acceptance.rows[0]?.delivery_attempt_id).toBe(attempts.rows[2]?.id);
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ reserved: 0n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 77_844_313n });
    const issues = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_order_delivery_issues WHERE order_id = $1`, [created.order.id]);
    expect(issues.rows[0]?.count).toBe('2');
    await f.database.close();
  });

  it('returns the exact secured credits and restores capacity when the provider approves a full refund', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-refund-create' }));
    if (created.status !== 'created') throw new Error('order missing');
    await f.store.confirm(actionInput(f, created.order.id, { key: 'provider-confirm-refund1' }));
    await f.store.startDelivery(actionInput(f, created.order.id, { key: 'provider-start-refund001' }));
    const encryptionKey = Buffer.alloc(32, 9).toString('base64');
    const delivery = JSON.stringify({ endpoint: '10.0.0.8', password: 'refund-secret' });
    await f.store.markDeliveryReady({
      ...actionInput(f, created.order.id, { key: 'provider-ready-refund001' }),
      deliveryPayloadCiphertext: encryptPii(delivery, encryptionKey),
      deliveryPayloadDigest: secretHash(delivery, 'd'.repeat(32)),
    });
    await f.store.reportDeliveryIssue({
      ...actionInput(f, created.order.id, { action: 'report_delivery_issue', key: 'buyer-refund-request001' }),
      requestedResolution: 'refund', descriptionCiphertext: encryptPii('{"description":"资源不可用"}', encryptionKey),
      descriptionDigest: secretHash('资源不可用', 'd'.repeat(32)),
    });
    const approve = actionInput(f, created.order.id, { action: 'approve_refund', key: 'provider-refund-approve01' });
    expect(await f.store.approveMutualRefund(approve)).toMatchObject({ status: 'refunded', order: { status: 'refunded' } });
    expect(await f.store.approveMutualRefund(approve)).toMatchObject({ status: 'replayed', order: { status: 'refunded' } });
    expect(await f.store.settleSupplier(actionInput(f, created.order.id, {
      action: 'settle', key: 'provider-settle-refunded01', now: new Date(Date.now() + 8 * 86_400_000),
    }))).toEqual({ status: 'invalid_state' });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 100_000_000n, reserved: 0n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 0n });
    const listing = await f.database.query<{ capacity_reserved: string; capacity_sold: string; status: string }>(`SELECT
      capacity_reserved::text, capacity_sold::text, status FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]).toEqual({ capacity_reserved: '0.000000', capacity_sold: '0.000000', status: 'active' });
    const transactions = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_ORDER_MUTUAL_REFUND' AND reference_id = $1`, [created.order.id]);
    expect(transactions.rows[0]?.count).toBe('1');
    const refund = await f.store.mutualRefundForSubject(f.buyerSubjectId, created.order.id);
    expect(refund).toMatchObject({ status: 'succeeded', creditMicros: 77_844_313n, order: { status: 'refunded' } });
    expect(await f.store.mutualRefundForSubject(f.otherSubjectId, created.order.id)).toBeNull();
    const attempts = await f.database.query<{ status: string }>(`SELECT status FROM kai_credit_order_deliveries WHERE order_id = $1`, [created.order.id]);
    expect(attempts.rows[0]?.status).toBe('refunded');
    await expect(f.database.query(`UPDATE kai_credit_order_mutual_refunds SET credit_micros = 1 WHERE order_id = $1`,
      [created.order.id])).rejects.toThrow(/immutable/u);
    await f.database.close();
  });

  it('rejects provider approval unless the latest open issue requests a refund', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-refund-invalid' }));
    if (created.status !== 'created') throw new Error('order missing');
    expect(await f.store.approveMutualRefund(actionInput(f, created.order.id, {
      action: 'approve_refund', key: 'provider-refund-invalid01',
    }))).toEqual({ status: 'invalid_state' });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 22_155_687n, reserved: 77_844_313n });
    await f.database.close();
  });

  it('resolves simultaneous acceptance and refund-request reporting to one order outcome', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const created = await f.store.createReservation(orderInput(f, { key: 'credit-order-refund-race01' }));
    if (created.status !== 'created') throw new Error('order missing');
    await f.store.confirm(actionInput(f, created.order.id, { key: 'provider-confirm-refundrace' }));
    await f.store.startDelivery(actionInput(f, created.order.id, { key: 'provider-start-refundrace1' }));
    await f.store.markDeliveryReady({
      ...actionInput(f, created.order.id, { key: 'provider-ready-refundrace1' }),
      deliveryPayloadCiphertext: encryptPii('{"endpoint":"10.0.0.8"}', Buffer.alloc(32, 9).toString('base64')),
      deliveryPayloadDigest: secretHash('{"endpoint":"10.0.0.8"}', 'd'.repeat(32)),
    });
    const [accepted, disputed] = await Promise.all([
      f.store.accept({
        ...actionInput(f, created.order.id, { action: 'accept', key: 'buyer-accept-refund-race1' }), evidenceDigest: null,
      }),
      f.store.reportDeliveryIssue({
        ...actionInput(f, created.order.id, { action: 'report_delivery_issue', key: 'buyer-issue-refund-race01' }),
        requestedResolution: 'refund', descriptionCiphertext: encryptPii('{"description":"不可用"}', Buffer.alloc(32, 9).toString('base64')),
        descriptionDigest: secretHash('不可用', 'd'.repeat(32)),
      }),
    ]);
    const final = await f.store.getForSubject(f.buyerSubjectId, created.order.id);
    expect(['accepted', 'disputed']).toContain(final?.status);
    expect([accepted.status, disputed.status]).toEqual(expect.arrayContaining([
      final?.status === 'accepted' ? 'accepted' : 'disputed', 'invalid_state',
    ]));
    if (final?.status === 'accepted') {
      expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ reserved: 0n });
      expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 77_844_313n });
    } else {
      expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ reserved: 77_844_313n });
      expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 0n });
    }
    await f.database.close();
  });

  it('settles the exact accepted credits after seven days and leaves one immutable receipt', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const acceptedAt = new Date('2026-08-01T00:00:00.000Z');
    const orderId = await createAcceptedOrder(f, acceptedAt);
    const dueAt = new Date('2026-08-08T00:00:00.000Z');
    const settlement = actionInput(f, orderId, {
      action: 'settle', key: 'provider-settlement-order01', now: dueAt,
    });
    expect(await f.store.settleSupplier({ ...settlement, now: new Date(dueAt.getTime() - 1) }))
      .toEqual({ status: 'not_due', availableAt: dueAt });
    expect(await f.store.settleSupplier({
      ...settlement, subjectId: f.otherSubjectId, clientRequestId: 'other-subject-settlement01',
    })).toEqual({ status: 'not_found' });
    await expect(f.database.query(`UPDATE kai_credit_orders SET status = 'closed' WHERE id = $1`, [orderId]))
      .rejects.toThrow(/requires supplier settlement/u);
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
      available: 0n, supplier_receivable: 77_844_313n,
    });
    expect(await f.store.settleSupplier(settlement)).toMatchObject({ status: 'settled', order: { status: 'closed' } });
    expect(await f.store.settleSupplier(settlement)).toMatchObject({ status: 'replayed', order: { status: 'closed' } });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
      supplier_earnings_available: 77_844_313n, supplier_receivable: 0n,
    });
    const transactions = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_SUPPLIER_SETTLEMENT' AND reference_id = $1`, [orderId]);
    expect(transactions.rows[0]?.count).toBe('1');
    expect(await f.store.supplierSettlementForSubject(f.supplierSubjectId, orderId)).toMatchObject({
      status: 'succeeded', creditMicros: 77_844_313n, triggeredBy: 'provider',
      acceptedAt, availableAt: dueAt, settledAt: dueAt, order: { status: 'closed' },
    });
    expect(await f.store.supplierSettlementForSubject(f.buyerSubjectId, orderId)).toMatchObject({ status: 'succeeded' });
    expect(await f.store.supplierSettlementForSubject(f.otherSubjectId, orderId)).toBeNull();
    await expect(f.database.query(`UPDATE kai_credit_supplier_settlements SET credit_micros = 1 WHERE order_id = $1`,
      [orderId])).rejects.toThrow(/immutable/u);
    await f.database.close();
  });

  it('automatically settles due orders exactly once while leaving newer and refunded orders untouched', { timeout: 30_000 }, async () => {
    const f = await fixture('10'); await fund(f.database, f.buyerSubjectId, 300_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const now = new Date('2026-08-12T00:00:00.000Z');
    const dueOrderId = await createAcceptedOrder(f, new Date('2026-08-05T00:00:00.000Z'));
    const newerOrderId = await createAcceptedOrder(f, new Date('2026-08-06T00:00:00.000Z'));
    const errors: unknown[] = [];
    const worker = new CreditSupplierSettlementWorker(f.store, {
      info: () => undefined, error: (fields) => errors.push(fields),
    }, 60_000, () => now);
    await worker.tick();
    await worker.tick();
    expect(errors).toEqual([]);
    expect(await f.store.getForSubject(f.supplierSubjectId, dueOrderId)).toMatchObject({ status: 'closed' });
    expect(await f.store.getForSubject(f.supplierSubjectId, newerOrderId)).toMatchObject({ status: 'accepted' });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
      supplier_earnings_available: 77_844_313n, supplier_receivable: 77_844_313n,
    });
    expect(await f.store.supplierSettlementForSubject(f.supplierSubjectId, dueOrderId)).toMatchObject({
      triggeredBy: 'system', settledAt: now,
    });
    expect(await f.store.supplierSettlementForSubject(f.supplierSubjectId, newerOrderId)).toBeNull();
    const transactions = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_SUPPLIER_SETTLEMENT'`);
    expect(transactions.rows[0]?.count).toBe('1');
    await f.database.close();
  });

  it('resolves simultaneous provider and system settlement to one ledger transaction', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const acceptedAt = new Date('2026-08-01T00:00:00.000Z');
    const orderId = await createAcceptedOrder(f, acceptedAt);
    const dueAt = new Date('2026-08-08T00:00:00.000Z');
    const [provider, automated] = await Promise.all([
      f.store.settleSupplier(actionInput(f, orderId, {
        action: 'settle', key: 'provider-settlement-race001', now: dueAt,
      })),
      f.store.settleDueSupplierOrders(dueAt, 50),
    ]);
    expect(['settled', 'replayed']).toContain(provider.status);
    expect([0, 1]).toContain(automated);
    expect(await f.store.getForSubject(f.supplierSubjectId, orderId)).toMatchObject({ status: 'closed' });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
      supplier_earnings_available: 77_844_313n, supplier_receivable: 0n,
    });
    const transactions = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_SUPPLIER_SETTLEMENT' AND reference_id = $1`, [orderId]);
    expect(transactions.rows[0]?.count).toBe('1');
    await f.database.close();
  });

  it('escalates a refund dispute and atomically applies an exact platform full-refund decision', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const orderId = await createRefundDispute(f);
    const escalation = actionInput(f, orderId, {
      action: 'escalate_dispute', key: 'buyer-escalate-dispute01',
    });
    expect(await f.store.escalateDispute(escalation)).toMatchObject({ status: 'escalated', order: { status: 'disputed' } });
    expect(await f.store.escalateDispute(escalation)).toMatchObject({ status: 'replayed', order: { status: 'disputed' } });
    expect(await f.store.approveMutualRefund(actionInput(f, orderId, {
      action: 'approve_refund', key: 'provider-refund-after-escalation',
    }))).toEqual({ status: 'invalid_state' });
    await expect(f.database.query(`UPDATE kai_credit_order_dispute_escalations SET status = 'resolved', resolved_at = now()
      WHERE order_id = $1`, [orderId])).rejects.toThrow(/requires decision record/u);
    const pending = await f.store.listPendingDisputeAdjudications(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      order: { id: orderId, totalCreditMicros: 77_844_313n }, requestedResolution: 'refund',
      deliveryAttemptNumber: 1,
    });
    expect(await f.store.disputeAdjudicationForSubject(f.otherSubjectId, orderId)).toBeNull();
    const now = new Date('2026-08-12T18:00:00.000Z');
    const decision = {
      operatorId: f.operatorUserId, orderId, clientRequestId: 'operator-decision-refund01',
      payloadDigest: 'sha512:operator-decision-refund-payload', outcome: 'full_refund' as const,
      reasonCiphertext: encryptPii('{"reason":"交付与审核挂牌不一致，应全额退款。"}', Buffer.alloc(32, 7).toString('base64')),
      reasonDigest: 'sha512:operator-refund-reason', decisionDigest: 'sha512:operator-refund-decision',
      requestId: 'operator-request-refund', ipHash: 'sha512:operator-ip', now,
    };
    const decided = await f.store.decideDispute(decision);
    expect(decided).toMatchObject({ status: 'decided', outcome: 'full_refund', order: { status: 'refunded' } });
    expect(await f.store.decideDispute(decision)).toMatchObject({ status: 'replayed', outcome: 'full_refund' });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 100_000_000n, reserved: 0n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 0n });
    const listing = await f.database.query<{ capacity_reserved: string; capacity_sold: string }>(`SELECT
      capacity_reserved::text, capacity_sold::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]).toEqual({ capacity_reserved: '0.000000', capacity_sold: '0.000000' });
    const transactions = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_ORDER_ADJUDICATED_REFUND' AND reference_id = $1`, [orderId]);
    expect(transactions.rows[0]?.count).toBe('1');
    expect(await f.store.disputeAdjudicationForSubject(f.buyerSubjectId, orderId)).toMatchObject({
      status: 'resolved', outcome: 'full_refund', creditMicros: 77_844_313n, decidedAt: now,
      order: { status: 'refunded' },
    });
    await expect(f.database.query(`UPDATE kai_credit_order_dispute_decisions SET credit_micros = 1 WHERE order_id = $1`,
      [orderId])).rejects.toThrow(/immutable/u);
    await f.database.close();
  });

  it('dismisses a platform refund claim back to acceptance without moving credits or capacity', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const orderId = await createRefundDispute(f);
    await f.store.escalateDispute(actionInput(f, orderId, {
      action: 'escalate_dispute', key: 'provider-escalate-dispute1', subjectId: f.supplierSubjectId,
      userId: f.supplierUserId,
    }));
    const now = new Date('2026-08-12T19:00:00.000Z');
    const decision = {
      operatorId: f.operatorUserId, orderId, clientRequestId: 'operator-decision-resume01',
      payloadDigest: 'sha512:operator-decision-resume-payload', outcome: 'resume_acceptance' as const,
      reasonCiphertext: encryptPii('{"reason":"交付内容符合订单快照，恢复买方验收。"}', Buffer.alloc(32, 7).toString('base64')),
      reasonDigest: 'sha512:operator-resume-reason', decisionDigest: 'sha512:operator-resume-decision',
      requestId: 'operator-request-resume', ipHash: 'sha512:operator-ip', now,
    };
    expect(await f.store.decideDispute(decision)).toMatchObject({
      status: 'decided', outcome: 'resume_acceptance', order: { status: 'acceptance_pending' },
    });
    await expect(f.database.query(`UPDATE kai_credit_orders SET status = 'disputed' WHERE id = $1`, [orderId]))
      .rejects.toThrow(/requires active delivery issue/u);
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 22_155_687n, reserved: 77_844_313n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 0n });
    const listing = await f.database.query<{ capacity_reserved: string; capacity_sold: string }>(`SELECT
      capacity_reserved::text, capacity_sold::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]).toEqual({ capacity_reserved: '2.500000', capacity_sold: '0.000000' });
    const refunds = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_ORDER_ADJUDICATED_REFUND' AND reference_id = $1`, [orderId]);
    expect(refunds.rows[0]?.count).toBe('0');
    expect(await f.store.accept({
      ...actionInput(f, orderId, { action: 'accept', key: 'buyer-accept-after-decision' }), evidenceDigest: null,
    })).toMatchObject({ status: 'accepted', order: { status: 'accepted' } });
    await f.database.close();
  });

  it('allows exactly one winner when provider approval and dispute escalation race', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    const orderId = await createRefundDispute(f);
    const [approved, escalated] = await Promise.all([
      f.store.approveMutualRefund(actionInput(f, orderId, {
        action: 'approve_refund', key: 'provider-refund-escalate-race',
      })),
      f.store.escalateDispute(actionInput(f, orderId, {
        action: 'escalate_dispute', key: 'buyer-escalate-refund-race',
      })),
    ]);
    const order = await f.store.getForSubject(f.buyerSubjectId, orderId);
    expect(['refunded', 'disputed']).toContain(order?.status);
    expect([approved.status, escalated.status]).toEqual(expect.arrayContaining([
      order?.status === 'refunded' ? 'refunded' : 'escalated', 'invalid_state',
    ]));
    const refundCount = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE reference_id = $1 AND scope IN ('CREDIT_ORDER_MUTUAL_REFUND', 'CREDIT_ORDER_ADJUDICATED_REFUND')`, [orderId]);
    expect(refundCount.rows[0]?.count).toBe(order?.status === 'refunded' ? '1' : '0');
    await f.database.close();
  });

  it('pauses settlement and returns accepted credits while keeping consumed capacity sold', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const acceptedAt = new Date('2026-08-01T00:00:00.000Z');
    const orderId = await createAcceptedOrder(f, acceptedAt);
    const requestedAt = new Date('2026-08-07T23:59:59.999Z');
    const description = '验收后持续运行时发现资源规格与订单不一致。';
    const request = {
      ...actionInput(f, orderId, {
        action: 'request_post_acceptance_refund', key: 'buyer-aftercare-request01', now: requestedAt,
      }),
      descriptionCiphertext: encryptPii(JSON.stringify({ description }), Buffer.alloc(32, 7).toString('base64')),
      descriptionDigest: secretHash(description, 'd'.repeat(32)), creditMicros: 77_844_313n,
    };
    expect(await f.store.requestPostAcceptanceRefund(request)).toMatchObject({
      status: 'aftercare_pending', order: { status: 'accepted' },
    });
    expect(await f.store.requestPostAcceptanceRefund(request)).toMatchObject({
      status: 'replayed', order: { status: 'accepted' },
    });
    const dueAt = new Date('2026-08-08T00:00:00.000Z');
    expect(await f.store.settleDueSupplierOrders(dueAt, 50)).toBe(0);
    expect(await f.store.settleSupplier(actionInput(f, orderId, {
      action: 'settle', key: 'provider-settle-aftercare01', now: dueAt,
    }))).toEqual({ status: 'invalid_state' });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
      available: 0n, supplier_receivable: 77_844_313n,
    });
    const approvedAt = new Date('2026-08-08T01:00:00.000Z');
    const approval = actionInput(f, orderId, {
      action: 'approve_post_acceptance_refund', key: 'provider-aftercare-approve1', now: approvedAt,
    });
    expect(await f.store.approvePostAcceptanceRefund(approval)).toMatchObject({
      status: 'refunded', order: { status: 'refunded' },
    });
    expect(await f.store.approvePostAcceptanceRefund(approval)).toMatchObject({
      status: 'replayed', order: { status: 'refunded' },
    });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 100_000_000n, reserved: 0n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
      available: 0n, supplier_receivable: 0n,
    });
    const listing = await f.database.query<{ capacity_reserved: string; capacity_sold: string }>(`SELECT
      capacity_reserved::text, capacity_sold::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]).toEqual({ capacity_reserved: '0.000000', capacity_sold: '2.500000' });
    const refunds = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_ORDER_POST_ACCEPT_REFUND' AND reference_id = $1`, [orderId]);
    expect(refunds.rows[0]?.count).toBe('1');
    expect(await f.store.postAcceptanceRefundForSubject(f.buyerSubjectId, orderId)).toMatchObject({
      status: 'succeeded', descriptionDigest: request.descriptionDigest, creditMicros: 77_844_313n,
      requestedAt, resolvedAt: approvedAt, order: { status: 'refunded' },
    });
    expect(await f.store.postAcceptanceRefundForSubject(f.otherSubjectId, orderId)).toBeNull();
    await expect(f.database.query(`UPDATE kai_credit_order_post_acceptance_refunds SET credit_micros = 1
      WHERE order_id = $1`, [orderId])).rejects.toThrow(/immutable/u);
    await f.database.close();
  });

  it('rejects post-acceptance refund requests at or after the exact seven-day boundary', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const acceptedAt = new Date('2026-08-01T00:00:00.000Z');
    const orderId = await createAcceptedOrder(f, acceptedAt);
    const description = '验收后发现资源规格与订单不一致。';
    expect(await f.store.requestPostAcceptanceRefund({
      ...actionInput(f, orderId, {
        action: 'request_post_acceptance_refund', key: 'buyer-aftercare-expired01',
        now: new Date('2026-08-08T00:00:00.000Z'),
      }),
      descriptionCiphertext: encryptPii(JSON.stringify({ description }), Buffer.alloc(32, 7).toString('base64')),
      descriptionDigest: secretHash(description, 'd'.repeat(32)), creditMicros: 77_844_313n,
    })).toEqual({ status: 'invalid_state' });
    expect(await f.store.postAcceptanceRefundForSubject(f.buyerSubjectId, orderId)).toBeNull();
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ supplier_receivable: 77_844_313n });
    await f.database.close();
  });

  it('returns an approved partial remedy and settles only the remaining credits', { timeout: 30_000 }, async () => {
    const f = await fixture('4'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const acceptedAt = new Date('2026-08-01T00:00:00.000Z');
    const orderId = await createAcceptedOrder(f, acceptedAt);
    const description = '服务中断约一小时，申请按受影响时长补偿部分卡时。';
    const requestedAt = new Date('2026-08-02T00:00:00.000Z');
    const creditMicros = 20_000_000n;
    expect(await f.store.requestPostAcceptanceRefund({
      ...actionInput(f, orderId, { action: 'request_post_acceptance_refund', key: 'buyer-partial-remedy-req01', now: requestedAt }),
      descriptionCiphertext: encryptPii(JSON.stringify({ description }), Buffer.alloc(32, 7).toString('base64')),
      descriptionDigest: secretHash(description, 'd'.repeat(32)), creditMicros,
    })).toMatchObject({ status: 'aftercare_pending', order: { status: 'accepted' } });
    const approvedAt = new Date('2026-08-02T01:00:00.000Z');
    expect(await f.store.approvePostAcceptanceRefund(actionInput(f, orderId, {
      action: 'approve_post_acceptance_refund', key: 'provider-partial-remedy01', now: approvedAt,
    }))).toMatchObject({ status: 'refunded', order: { status: 'accepted' } });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 42_155_687n, reserved: 0n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
      available: 0n, supplier_receivable: 57_844_313n,
    });
    expect(await f.store.postAcceptanceRefundForSubject(f.buyerSubjectId, orderId)).toMatchObject({
      status: 'succeeded', creditMicros, order: { status: 'accepted' },
    });
    expect(await f.store.settleDueSupplierOrders(new Date('2026-08-08T00:00:00.000Z'), 50)).toBe(1);
    expect(await f.store.getForSubject(f.buyerSubjectId, orderId)).toMatchObject({ status: 'closed' });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
      supplier_earnings_available: 57_844_313n, supplier_receivable: 0n,
    });
    const settlement = await f.store.supplierSettlementForSubject(f.supplierSubjectId, orderId);
    expect(settlement).toMatchObject({ creditMicros: 57_844_313n, status: 'succeeded' });
    await f.database.close();
  });

  it('lets the provider contest aftercare and lets the platform refund without restoring sold capacity', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const acceptedAt = new Date('2026-08-01T00:00:00.000Z');
    const orderId = await createAcceptedOrder(f, acceptedAt);
    const description = '验收后持续运行时发现资源规格与订单不一致。';
    const requestedAt = new Date('2026-08-02T00:00:00.000Z');
    await f.store.requestPostAcceptanceRefund({
      ...actionInput(f, orderId, { action: 'request_post_acceptance_refund', key: 'aftercare-contest-request1', now: requestedAt }),
      descriptionCiphertext: encryptPii(JSON.stringify({ description }), Buffer.alloc(32, 7).toString('base64')),
      descriptionDigest: secretHash(description, 'd'.repeat(32)), creditMicros: 77_844_313n,
    });
    const response = '资源交付与审核规格一致，附带运行记录，请平台核对。';
    const contestedAt = new Date('2026-08-02T01:00:00.000Z');
    const contest = {
      ...actionInput(f, orderId, { action: 'contest_post_acceptance_refund', key: 'provider-aftercare-contest1', now: contestedAt }),
      responseCiphertext: encryptPii(JSON.stringify({ response }), Buffer.alloc(32, 7).toString('base64')),
      responseDigest: secretHash(response, 'd'.repeat(32)),
    };
    expect(await f.store.contestPostAcceptanceRefund(contest)).toMatchObject({
      status: 'aftercare_escalated', order: { status: 'accepted' },
    });
    expect(await f.store.contestPostAcceptanceRefund(contest)).toMatchObject({ status: 'replayed' });
    expect(await f.store.settleDueSupplierOrders(new Date('2026-08-08T00:00:00.000Z'), 50)).toBe(0);
    const queue = await f.store.listPendingPostAcceptanceRefundAdjudications(50);
    expect(queue).toMatchObject([{
      order: { id: orderId }, escalatedBySide: 'provider', providerResponseDigest: contest.responseDigest,
    }]);
    const reason = '运行记录显示实际显存与审核挂牌不一致，支持买方全额退款。';
    const decidedAt = new Date('2026-08-08T01:00:00.000Z');
    const decision = {
      operatorId: f.operatorUserId, orderId, clientRequestId: 'operator-aftercare-decision1',
      payloadDigest: 'sha512:aftercare-decision-full-refund', outcome: 'approve_refund' as const,
      reasonCiphertext: encryptPii(JSON.stringify({ reason }), Buffer.alloc(32, 7).toString('base64')),
      reasonDigest: secretHash(reason, 'd'.repeat(32)), decisionDigest: 'sha512:aftercare-full-refund-decision',
      requestId: 'operator-aftercare-request', ipHash: `sha512:${'k'.repeat(64)}`, now: decidedAt,
    };
    expect(await f.store.decidePostAcceptanceRefund(decision)).toMatchObject({
      status: 'decided', outcome: 'full_refund', order: { status: 'refunded' },
    });
    expect(await f.store.decidePostAcceptanceRefund(decision)).toMatchObject({ status: 'replayed' });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 100_000_000n, reserved: 0n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ available: 0n, supplier_receivable: 0n });
    const listing = await f.database.query<{ capacity_reserved: string; capacity_sold: string }>(`SELECT
      capacity_reserved::text, capacity_sold::text FROM credit_market_listings WHERE id = $1`, [f.listingId]);
    expect(listing.rows[0]).toEqual({ capacity_reserved: '0.000000', capacity_sold: '2.500000' });
    expect(await f.store.postAcceptanceRefundForSubject(f.buyerSubjectId, orderId)).toMatchObject({
      status: 'succeeded', escalatedBySide: 'provider', outcome: 'full_refund',
      providerResponseDigest: contest.responseDigest, decisionReasonDigest: decision.reasonDigest,
    });
    const transactions = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM kai_credit_transactions
      WHERE scope = 'CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND' AND reference_id = $1`, [orderId]);
    expect(transactions.rows[0]?.count).toBe('1');
    await f.database.close();
  });

  it('enforces the buyer 24-hour wait and resumes settlement after platform rejection', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const acceptedAt = new Date('2026-08-01T00:00:00.000Z');
    const orderId = await createAcceptedOrder(f, acceptedAt);
    const description = '验收后持续运行时发现资源规格与订单不一致。';
    const requestedAt = new Date('2026-08-02T00:00:00.000Z');
    await f.store.requestPostAcceptanceRefund({
      ...actionInput(f, orderId, { action: 'request_post_acceptance_refund', key: 'aftercare-timeout-request1', now: requestedAt }),
      descriptionCiphertext: encryptPii(JSON.stringify({ description }), Buffer.alloc(32, 7).toString('base64')),
      descriptionDigest: secretHash(description, 'd'.repeat(32)), creditMicros: 77_844_313n,
    });
    expect(await f.store.escalatePostAcceptanceRefund(actionInput(f, orderId, {
      action: 'escalate_post_acceptance_refund', key: 'buyer-aftercare-too-early1',
      now: new Date('2026-08-02T23:59:59.999Z'),
    }))).toEqual({ status: 'invalid_state' });
    expect(await f.store.escalatePostAcceptanceRefund(actionInput(f, orderId, {
      action: 'escalate_post_acceptance_refund', key: 'buyer-aftercare-timeout01',
      now: new Date('2026-08-03T00:00:00.000Z'),
    }))).toMatchObject({ status: 'aftercare_escalated' });
    const reason = '现有证据不能证明资源与审核挂牌不一致，本次退款申请不予支持。';
    expect(await f.store.decidePostAcceptanceRefund({
      operatorId: f.operatorUserId, orderId, clientRequestId: 'operator-aftercare-reject01',
      payloadDigest: 'sha512:aftercare-decision-reject', outcome: 'reject_refund',
      reasonCiphertext: encryptPii(JSON.stringify({ reason }), Buffer.alloc(32, 7).toString('base64')),
      reasonDigest: secretHash(reason, 'd'.repeat(32)), decisionDigest: 'sha512:aftercare-reject-decision',
      requestId: 'operator-aftercare-reject', ipHash: `sha512:${'l'.repeat(64)}`,
      now: new Date('2026-08-04T00:00:00.000Z'),
    })).toMatchObject({ status: 'decided', outcome: 'reject_refund', order: { status: 'accepted' } });
    expect(await f.store.settleDueSupplierOrders(new Date('2026-08-08T00:00:00.000Z'), 50)).toBe(1);
    expect(await f.store.getForSubject(f.buyerSubjectId, orderId)).toMatchObject({ status: 'closed' });
    expect(await balances(f.database, f.buyerSubjectId)).toMatchObject({ available: 22_155_687n, reserved: 0n });
    expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
      supplier_earnings_available: 77_844_313n, supplier_receivable: 0n });
    expect(await f.store.postAcceptanceRefundForSubject(f.buyerSubjectId, orderId)).toMatchObject({
      status: 'rejected', escalatedBySide: 'buyer', outcome: 'reject_refund',
    });
    await f.database.close();
  });

  it('allows exactly one winner when aftercare request and settlement hit the deadline together', { timeout: 30_000 }, async () => {
    const f = await fixture('3'); await fund(f.database, f.buyerSubjectId, 100_000_000n);
    await new PostgresCreditLedgerStore(f.database).ensureSubjectAccounts(f.supplierSubjectId);
    const acceptedAt = new Date('2026-08-01T00:00:00.000Z');
    const orderId = await createAcceptedOrder(f, acceptedAt);
    const boundary = new Date('2026-08-08T00:00:00.000Z');
    const description = '验收后发现资源规格与订单不一致。';
    const [request, settlement] = await Promise.all([
      f.store.requestPostAcceptanceRefund({
        ...actionInput(f, orderId, {
          action: 'request_post_acceptance_refund', key: 'buyer-aftercare-race0001',
          now: new Date(boundary.getTime() - 1),
        }),
        descriptionCiphertext: encryptPii(JSON.stringify({ description }), Buffer.alloc(32, 7).toString('base64')),
        descriptionDigest: secretHash(description, 'd'.repeat(32)), creditMicros: 77_844_313n,
      }),
      f.store.settleSupplier(actionInput(f, orderId, {
        action: 'settle', key: 'provider-settle-aftercare-race', now: boundary,
      })),
    ]);
    const final = await f.store.getForSubject(f.buyerSubjectId, orderId);
    expect(['accepted', 'closed']).toContain(final?.status);
    if (final?.status === 'accepted') {
      expect(request.status).toBe('aftercare_pending');
      expect(settlement.status).toBe('invalid_state');
      expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({ available: 0n, supplier_receivable: 77_844_313n });
    } else {
      expect(request.status).toBe('invalid_state');
      expect(['settled', 'replayed']).toContain(settlement.status);
      expect(await balances(f.database, f.supplierSubjectId)).toMatchObject({
        supplier_earnings_available: 77_844_313n, supplier_receivable: 0n });
    }
    const recordCount = await f.database.query<{ count: string }>(`SELECT count(*)::text FROM
      kai_credit_order_post_acceptance_refunds WHERE order_id = $1`, [orderId]);
    expect(recordCount.rows[0]?.count).toBe(final?.status === 'accepted' ? '1' : '0');
    await f.database.close();
  });
});
