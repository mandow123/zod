import { randomUUID } from 'node:crypto';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationManifest } from '../src/schema.js';

let postgres: PGlite;

async function executeTransaction(work: (transaction: Transaction) => Promise<void>) {
  return postgres.transaction(work);
}

async function createSubject() {
  const userId = randomUUID();
  const subjectId = randomUUID();
  const availableAccountId = randomUUID();
  const reservedAccountId = randomUUID();
  const refundHoldAccountId = randomUUID();
  await postgres.query(`INSERT INTO users(id,phone_ciphertext,display_name) VALUES($1,$2,'七相测试用户')`,
    [userId, `qixiang-${userId}`]);
  await postgres.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)
    VALUES($1,'personal','七相测试主体',$2)`, [subjectId, userId]);
  await postgres.query(`INSERT INTO subject_memberships(subject_id,user_id,role) VALUES($1,$2,'owner')`,
    [subjectId, userId]);
  await postgres.query(`INSERT INTO kai_credit_accounts(
      id,owner_kind,subject_id,code,account_kind,allow_negative)
    VALUES($1,'subject',$4,$5,'available',false),($2,'subject',$4,$6,'reserved',false),
      ($3,'subject',$4,$7,'refund_hold',false)`, [
    availableAccountId, reservedAccountId, refundHoldAccountId, subjectId,
    `subject:${subjectId}:available`, `subject:${subjectId}:reserved`, `subject:${subjectId}:refund-hold`,
  ]);
  return { userId, subjectId, availableAccountId, reservedAccountId, refundHoldAccountId };
}

function providerReference() {
  return `QX${randomUUID().replaceAll('-', '').slice(0, 30).toUpperCase()}`;
}

async function createTopup(subject: Readonly<{ userId: string; subjectId: string }>, amountCents = 1002,
expiresAt = new Date(Date.now() + 30 * 60_000)) {
  const id = randomUUID();
  const reference = providerReference();
  const cardHourCents = Math.floor(amountCents * 1000 / 1002);
  await postgres.query(`INSERT INTO kai_credit_topups(
      id,subject_id,created_by_user_id,client_request_id,payload_digest,provider,channel,
      provider_reference,amount_cents,currency,credit_micros,conversion_cny_micros_per_credit,
      status,expires_at,payment_rail,card_hour_cents,conversion_numerator,conversion_denominator)
    VALUES($1,$2,$3,$4,$5,'qixiang','app',$6,$7,'CNY',$8,1002000,'created',
      $10,'qixiang_alipay',$9,1000,1002)`, [
    id, subject.subjectId, subject.userId, `qixiang-request-${randomUUID()}`,
    `sha256:${'a'.repeat(64)}`, reference, amountCents, cardHourCents * 10_000, cardHourCents, expiresAt,
  ]);
  return { id, reference, amountCents, creditMicros: BigInt(cardHourCents * 10_000) };
}

async function makePending(topup: Readonly<{ id: string; reference: string }>) {
  const providerPaymentId = `TRADE${topup.reference}`;
  await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
  await postgres.query(`UPDATE kai_credit_topups SET status='pending',provider_payment_id=$2,
    checkout_cipher_version=1,checkout_key_id='qixiang-checkout-2026a',checkout_nonce=$3,
    checkout_ciphertext=$4,checkout_auth_tag=$5 WHERE id=$1`, [
    topup.id, providerPaymentId, Buffer.alloc(12, 1), Buffer.alloc(32, 2), Buffer.alloc(16, 3),
  ]);
  return providerPaymentId;
}

async function postLedger(transaction: Transaction, input: Readonly<{
  transactionId: string;
  debitAccountId: string;
  creditAccountId: string;
  amountMicros: bigint;
  scope: string;
  owner?: string;
  idempotencyKey?: string;
  payloadDigest?: string;
  referenceId?: string;
  referenceType?: string;
  entryMode?: 'normal' | 'missing' | 'extra';
}>) {
    await transaction.query(`INSERT INTO kai_credit_transactions(
      id,idempotency_owner,scope,idempotency_key,payload_digest,reference_type,reference_id,description,status)
    VALUES($1::uuid,$5,$2,$3,$4,$7,$6,'七相账本专项','pending')`, [
    input.transactionId, input.scope, input.idempotencyKey ?? `qixiang-${randomUUID()}`,
    input.payloadDigest ?? 'b'.repeat(64), input.owner ?? 'qixiang:test', input.referenceId ?? input.transactionId,
    input.referenceType ?? 'topup',
  ]);
  if (input.entryMode === 'missing') {
    await transaction.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
      VALUES($1,$2,$3,$4,'七相缺失对手腿')`, [randomUUID(), input.transactionId, input.debitAccountId, -input.amountMicros]);
  } else {
    await transaction.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
      VALUES($1,$3,$4,$6,'七相借方'),($2,$3,$5,$7,'七相贷方')`, [
      randomUUID(), randomUUID(), input.transactionId, input.debitAccountId, input.creditAccountId,
      -input.amountMicros, input.amountMicros,
    ]);
    if (input.entryMode === 'extra') await transaction.query(`INSERT INTO kai_credit_entries(
      id,transaction_id,account_id,amount_micros,memo)VALUES
      ($1,$2,'00000000-0000-4000-8000-000000000102',-10000,'七相非法额外腿'),
      ($3,$2,'00000000-0000-4000-8000-000000000103',10000,'七相非法额外腿')`, [
      randomUUID(), input.transactionId, randomUUID(),
    ]);
  }
  await transaction.query(`UPDATE kai_credit_transactions SET status='posted' WHERE id=$1`, [input.transactionId]);
}

async function reserveLot(input: Readonly<{
  lotId: string;
  subjectId: string;
  createdByUserId: string;
  availableAccountId: string;
  reservedAccountId: string;
  ledgerMicros: bigint;
  lotMicros: bigint;
  orderKind?: 'credit_order' | 'vast_order';
  supplierSubjectId?: string;
}>) {
  const transactionId = randomUUID();
  const allocationId = randomUUID();
  const orderId = randomUUID();
  const key = `vast-reserve-${randomUUID()}`;
  const digest = '8'.repeat(64);
  const orderKind = input.orderKind ?? 'vast_order';
  const scope = orderKind === 'credit_order' ? 'CREDIT_ORDER_RESERVE' : 'VAST_ORDER_RESERVE';
  await executeTransaction(async (transaction) => {
    await postLedger(transaction, {
      transactionId, debitAccountId: input.availableAccountId, creditAccountId: input.reservedAccountId,
      amountMicros: input.ledgerMicros, scope, owner: `subject:${input.subjectId}`,
      idempotencyKey: key, payloadDigest: digest, referenceType: 'order_reservation', referenceId: orderId,
    });
    if (orderKind === 'vast_order') {
      const quoteId = randomUUID();
      await transaction.query(`INSERT INTO vast_external_quotes(
        id,buyer_subject_id,provider_source,provider_offer_id,configuration,provider_snapshot,
        provider_cost_micros_per_hour,credit_micros_per_hour,duration_hours,total_credit_micros,
        pricing_policy_version,status,quoted_at,expires_at)
        VALUES($1,$2,'vast_ai',1,'{}','{}',1,$3,1,$3,'test-v1','consumed',now(),now()+interval '5 minutes')`, [
        quoteId, input.subjectId, input.ledgerMicros,
      ]);
      await transaction.query(`INSERT INTO vast_external_orders(
        id,order_number,buyer_subject_id,created_by_user_id,quote_id,client_request_id,payload_digest,
        provider_source,provider_offer_id,provider_request_key,configuration,status,total_credit_micros,
        reservation_transaction_id,reconciliation_deadline_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'vast_ai',1,$8,'{}','reserved',$9,$10,now()+interval '5 minutes')`, [
        orderId, `VST${randomUUID().replaceAll('-', '').slice(0, 20)}`, input.subjectId, input.createdByUserId,
        quoteId, `vast-order-${randomUUID()}`, '7'.repeat(64), randomUUID(), input.ledgerMicros, transactionId,
      ]);
    } else {
      if (!input.supplierSubjectId) throw new Error('TEST_SUPPLIER_REQUIRED');
      await transaction.query(`ALTER TABLE kai_credit_orders DISABLE TRIGGER USER`);
      await transaction.query(`INSERT INTO kai_credit_orders(id,order_number,buyer_subject_id,supplier_subject_id,
        created_by_user_id,listing_id,client_request_id,payload_digest,status,quantity,capacity_unit,
        unit_credit_micros,total_credit_micros,listing_snapshot,reservation_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',1,'GPU时',$9,$9,'{}',now()+interval '5 minutes')`, [
        orderId, `KCT${randomUUID().replaceAll('-', '').slice(0, 20)}`, input.subjectId, input.supplierSubjectId,
        input.createdByUserId, randomUUID(), `credit-order-${randomUUID()}`, '6'.repeat(64), input.ledgerMicros,
      ]);
      await transaction.query(`ALTER TABLE kai_credit_orders ENABLE TRIGGER USER`);
    }
    await transaction.query(`INSERT INTO kai_credit_lot_allocations(
      id,lot_id,reference_type,reference_id,allocation_key,allocated_micros,reserved_micros,
      consumed_micros,released_micros,restored_micros)
      VALUES($1,$2,$6,$3,$4,$5,$5,0,0,0)`, [
      allocationId, input.lotId, orderId, `allocation-${randomUUID()}`, input.lotMicros, orderKind,
    ]);
    await transaction.query(`UPDATE kai_credit_lots SET available_micros=available_micros-$2,
      reserved_micros=reserved_micros+$2 WHERE id=$1`, [input.lotId, input.lotMicros]);
    await transaction.query(`INSERT INTO kai_credit_lot_movements(
      id,lot_id,allocation_id,ledger_transaction_id,kind,amount_micros,from_bucket,to_bucket,
      idempotency_owner,scope,idempotency_key,payload_digest)
      VALUES($1,$2,$3,$4,'reserve',$5,'available','reserved',$6,$9,$7,$8)`, [
      randomUUID(), input.lotId, allocationId, transactionId, input.lotMicros,
      `subject:${input.subjectId}`, key, digest, scope,
    ]);
  });
  return { transactionId, allocationId, orderId };
}

async function requestFullRefund(input: Readonly<{
  lotId: string;
  topup: { id: string; reference: string; amountCents: number; creditMicros: bigint };
  subject: { subjectId: string; availableAccountId: string; refundHoldAccountId: string };
  requesterId: string;
}>) {
  const refundId = randomUUID(); const holdTransactionId = randomUUID();
  const paymentId = `TRADE${input.topup.reference}`;
  const key = `qixiang-refund-hold-${randomUUID()}`; const digest = 'd'.repeat(64);
  await executeTransaction(async (transaction) => {
    await postLedger(transaction, {
      transactionId: holdTransactionId, debitAccountId: input.subject.availableAccountId,
      creditAccountId: input.subject.refundHoldAccountId, amountMicros: input.topup.creditMicros,
      scope: 'QIXIANG_REFUND_HOLD', owner: `operator:${input.requesterId}`, idempotencyKey: key,
      payloadDigest: digest, referenceType: 'refund', referenceId: refundId,
    });
    await transaction.query(`UPDATE kai_credit_lots SET available_micros=0,refund_pending_micros=$2 WHERE id=$1`,
      [input.lotId, input.topup.creditMicros]);
    await transaction.query(`INSERT INTO kai_credit_lot_movements(
      id,lot_id,ledger_transaction_id,kind,amount_micros,from_bucket,to_bucket,
      idempotency_owner,scope,idempotency_key,payload_digest)
      VALUES($1,$2,$3,'refund_hold',$4,'available','refund_pending',$5,'QIXIANG_REFUND_HOLD',$6,$7)`, [
      randomUUID(), input.lotId, holdTransactionId, input.topup.creditMicros,
      `operator:${input.requesterId}`, key, digest,
    ]);
    await transaction.query(`INSERT INTO qixiang_refund_requests(
      id,topup_id,subject_id,provider_reference,provider_payment_id,provider_transaction_id,
      amount_cents,credit_micros,status,reason_code,request_evidence_digest,requested_by_operator_id,
      hold_transaction_id,client_request_id,payload_digest,requested_at)
      VALUES($1,$2,$3,$4,$5,$5,$6,$7,'requested','customer_request',$8,$9,$10,$11,$12,now())`, [
      refundId, input.topup.id, input.subject.subjectId, input.topup.reference, paymentId,
      input.topup.amountCents, input.topup.creditMicros, 'e'.repeat(64), input.requesterId,
      holdTransactionId, `refund-request-${randomUUID()}`, 'f'.repeat(64),
    ]);
  });
  return { refundId, holdTransactionId };
}

async function succeedAndGrant(subject: Readonly<{
  subjectId: string;
  availableAccountId: string;
}>, topup: Readonly<{ id: string; reference: string; amountCents: number; creditMicros: bigint }>, succeededAt: Date,
options: Readonly<{ omit?: 'receipt' | 'claim' | 'event' | 'transaction' | 'entry' | 'lot' | 'movement'
  | 'extra_entry' | 'wrong_counterpart'; source?: 'callback' | 'query'; includePaidQuery?: boolean }> = {}) {
  const lotId = randomUUID();
  const ledgerTransactionId = randomUUID();
  const receiptId = randomUUID();
  const source = options.source ?? 'query';
  const callbackDigest = randomUUID().replaceAll('-', '').repeat(2);
  const receiptKey = source === 'query' ? `query:${randomUUID()}` : `callback:${callbackDigest}`;
  const providerPaymentId = `TRADE${topup.reference}`;
  const digest = 'c'.repeat(64);
  const transactionKey = `qixiang-topup:${topup.id}`;
  const transactionOwner = `subject:${subject.subjectId}`;
  await executeTransaction(async (transaction) => {
    if (options.omit !== 'receipt') {
      if (source === 'query') await transaction.query(`INSERT INTO qixiang_payment_receipts(
        id,topup_id,source,receipt_key,provider_reference,trade_no,api_trade_no,provider_code,
        provider_status,trade_status,payment_type,amount_cents,signature_verified,snapshot_matched,
        payload_digest,processing_result,received_at)
        VALUES($1,$2,'query',$3,$4,$5,'API-TRADE-1',1,1,NULL,'alipay',$6,false,true,$7,'accepted',$8)`, [
        receiptId, topup.id, receiptKey, topup.reference, providerPaymentId, topup.amountCents, digest, succeededAt,
      ]);
      else await transaction.query(`INSERT INTO qixiang_payment_receipts(
        id,topup_id,source,receipt_key,provider_reference,trade_no,api_trade_no,provider_code,
        provider_status,trade_status,payment_type,amount_cents,signature_verified,snapshot_matched,
        payload_digest,processing_result,received_at)
        VALUES($1,$2,'callback',$3,$4,$5,NULL,NULL,NULL,'TRADE_SUCCESS','alipay',$6,true,true,$7,'accepted',$8)`, [
        receiptId, topup.id, receiptKey, topup.reference, providerPaymentId, topup.amountCents, digest, succeededAt,
      ]);
    }
    if (source === 'callback' && options.includePaidQuery !== false) await transaction.query(`INSERT INTO qixiang_payment_receipts(
      id,topup_id,source,receipt_key,provider_reference,trade_no,api_trade_no,provider_code,
      provider_status,trade_status,payment_type,amount_cents,signature_verified,snapshot_matched,
      payload_digest,processing_result,received_at)
      VALUES($1,$2,'query',$3,$4,$5,'API-TRADE-AFTER-CALLBACK',1,1,NULL,'alipay',$6,false,true,$7,'accepted',$8)`, [
      randomUUID(), topup.id, `query:${randomUUID()}`, topup.reference, providerPaymentId,
      topup.amountCents, 'e'.repeat(64), succeededAt,
    ]);
    if (options.omit !== 'claim') await transaction.query(`INSERT INTO kai_credit_topup_provider_claims(
      provider,provider_transaction_id,topup_id,claimed_at)VALUES('qixiang',$1,$2,$3)`,
    [providerPaymentId, topup.id, succeededAt]);
    if (options.omit !== 'event') await transaction.query(`INSERT INTO kai_credit_topup_events(
      id,provider,provider_event_id,topup_id,provider_transaction_id,status,amount_cents,currency,
      payload_digest,normalized_payload,processing_result,processed_at)
      VALUES($1,'qixiang',$2,$3,$4,'succeeded',$5,'CNY',$6,$7::jsonb,'succeeded',$8)`, [
      randomUUID(), `qixiang:${source}:${receiptKey}`, topup.id, providerPaymentId, topup.amountCents, digest,
      JSON.stringify({ source, providerReference: topup.reference, providerTransactionId: providerPaymentId,
        paymentType: 'alipay', amountCents: topup.amountCents,
        confirmation: source === 'query' ? 'QUERY_PAID' : 'TRADE_SUCCESS' }), succeededAt,
    ]);
    if (options.omit !== 'transaction') await postLedger(transaction, {
      transactionId: ledgerTransactionId,
      debitAccountId: options.omit === 'wrong_counterpart'
        ? '00000000-0000-4000-8000-000000000102' : '00000000-0000-4000-8000-000000000101',
      creditAccountId: subject.availableAccountId,
      amountMicros: topup.creditMicros,
      scope: 'QIXIANG_TOPUP_CAPTURE',
      owner: transactionOwner,
      idempotencyKey: transactionKey,
      payloadDigest: digest,
      referenceId: topup.id,
      entryMode: options.omit === 'entry' ? 'missing' : options.omit === 'extra_entry' ? 'extra' : 'normal',
    });
    if (options.omit !== 'lot') await transaction.query(`INSERT INTO kai_credit_lots(
        id,subject_id,source_kind,source_topup_id,grant_transaction_id,granted_micros,
        available_micros,reserved_micros,refund_pending_micros,consumed_micros,expired_micros,
        refunded_micros,expires_at,created_at,updated_at)
      VALUES($1,$2,'qixiang_topup',$3,$4,$5,$5,0,0,0,0,0,
        $6::timestamptz+interval '364 days',$6,$6)`, [
      lotId, subject.subjectId, topup.id, ledgerTransactionId, topup.creditMicros, succeededAt,
    ]);
    if (options.omit !== 'lot' && options.omit !== 'movement') await transaction.query(`INSERT INTO kai_credit_lot_movements(
        id,lot_id,ledger_transaction_id,kind,amount_micros,from_bucket,to_bucket,
        idempotency_owner,scope,idempotency_key,payload_digest,occurred_at)
      VALUES($1,$2,$3,'grant',$4,NULL,'available',$5,'QIXIANG_TOPUP_CAPTURE',$6,$7,$8)`, [
      randomUUID(), lotId, ledgerTransactionId, topup.creditMicros, transactionOwner, transactionKey,
      digest, succeededAt,
    ]);
    await transaction.query(`UPDATE kai_credit_topups SET status='succeeded',provider_payment_id=$2,provider_transaction_id=$2,
      success_receipt_id=$3,succeeded_at=$4,entitlement_expires_at=$4::timestamptz+interval '364 days',
      success_confirmation_source=$5 WHERE id=$1`, [topup.id, providerPaymentId, receiptId, succeededAt, source]);
  });
  return { lotId, ledgerTransactionId, receiptId };
}

async function insertUnpaidReceipt(topup: Readonly<{ id: string; reference: string; amountCents: number }>, receivedAt: Date) {
  await postgres.query(`INSERT INTO qixiang_payment_receipts(
    id,topup_id,source,receipt_key,provider_reference,trade_no,api_trade_no,provider_code,
    provider_status,trade_status,payment_type,amount_cents,signature_verified,snapshot_matched,
    payload_digest,processing_result,received_at)
    VALUES($1,$2,'query',$3,$4,NULL,NULL,1,0,NULL,'alipay',$5,false,true,$6,'accepted',$7)`, [
    randomUUID(), topup.id, `query:${randomUUID()}`, topup.reference, topup.amountCents, '9'.repeat(64), receivedAt,
  ]);
}

beforeAll(async () => {
  postgres = new PGlite();
  for (const migration of await migrationManifest()) await postgres.exec(migration.sql);
}, 120_000);

afterAll(async () => {
  await postgres?.close();
});

describe('0063 qixiang topup persistence contract', () => {
  it.each([':bad-key1', '.bad-key1', '-bad-key1'])(
    'rejects a persisted noncanonical checkout key identifier: %s', async (keyId) => {
      const subject = await createSubject();
      const topup = await createTopup(subject);
      await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
      await expect(postgres.query(`UPDATE kai_credit_topups SET status='pending',provider_payment_id=$2,
        checkout_cipher_version=1,checkout_key_id=$3,checkout_nonce=$4,
        checkout_ciphertext=$5,checkout_auth_tag=$6 WHERE id=$1`, [
        topup.id, `TRADE${topup.reference}`, keyId, Buffer.alloc(12, 1), Buffer.alloc(32, 2), Buffer.alloc(16, 3),
      ])).rejects.toThrow();
    },
  );

  it('keeps the state machine, amount snapshot, identity and trade claims immutable', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject);
    await makePending(topup);
    await expect(postgres.query(`UPDATE kai_credit_topups SET status='succeeded',succeeded_at=now(),
      entitlement_expires_at=now()+interval '364 days',success_confirmation_source='query' WHERE id=$1`, [topup.id]))
      .rejects.toThrow(/invalid qixiang topup transition/u);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    const succeededAt = new Date('2026-08-21T05:00:00.000Z');
    await succeedAndGrant(subject, topup, succeededAt);
    const row = await postgres.query<{ version: number; provider_payment_id: string; provider_transaction_id: string }>(
      `SELECT version,provider_payment_id,provider_transaction_id FROM kai_credit_topups WHERE id=$1`, [topup.id]);
    expect(row.rows[0]).toEqual({
      version: 5, provider_payment_id: `TRADE${topup.reference}`, provider_transaction_id: `TRADE${topup.reference}`,
    });
    await expect(postgres.query(`UPDATE kai_credit_topups SET amount_cents=amount_cents+1 WHERE id=$1`, [topup.id]))
      .rejects.toThrow(/identity is immutable/u);
    await expect(postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]))
      .rejects.toThrow(/invalid qixiang topup transition/u);
    await expect(postgres.query(`DELETE FROM kai_credit_topups WHERE id=$1`, [topup.id]))
      .rejects.toThrow(/cannot be deleted/u);
  });

  it('keeps an ambiguous create in verifying without a checkout tuple and never fabricates pending', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying',next_reconcile_at=now()+interval '30 seconds'
      WHERE id=$1`, [topup.id]);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying',next_reconcile_at=now()+interval '60 seconds'
      WHERE id=$1`, [topup.id]);
    const row = await postgres.query<{ status: string; version: number; provider_payment_id: string | null;
      checkout_ciphertext: Uint8Array | null }>(`SELECT status,version,provider_payment_id,checkout_ciphertext
      FROM kai_credit_topups WHERE id=$1`, [topup.id]);
    expect(row.rows[0]).toEqual({
      status: 'verifying', version: 3, provider_payment_id: null, checkout_ciphertext: null,
    });
    await expect(postgres.query(`UPDATE kai_credit_topups SET status='pending' WHERE id=$1`, [topup.id]))
      .rejects.toThrow();
  });

  it('allows an authoritative paid query to close a create whose response was lost without inventing checkout', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    await succeedAndGrant(subject, topup, new Date('2026-08-21T04:05:00.000Z'));
    const row = await postgres.query<{ status: string; provider_payment_id: string;
      provider_transaction_id: string; checkout_ciphertext: Uint8Array | null }>(
      `SELECT status,provider_payment_id,provider_transaction_id,checkout_ciphertext
       FROM kai_credit_topups WHERE id=$1`, [topup.id]);
    expect(row.rows[0]).toEqual({
      status: 'succeeded', provider_payment_id: `TRADE${topup.reference}`,
      provider_transaction_id: `TRADE${topup.reference}`, checkout_ciphertext: null,
    });
  });

  it('commits only exact double-entry grants with one matching lot movement', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject);
    await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    const grant = await succeedAndGrant(subject, topup, new Date('2026-08-21T04:00:00.000Z'));
    const lot = await postgres.query<{ granted_micros: string; available_micros: string; movement_count: string }>(
      `SELECT l.granted_micros::text,l.available_micros::text,
        (SELECT count(*)::text FROM kai_credit_lot_movements m WHERE m.lot_id=l.id) movement_count
       FROM kai_credit_lots l WHERE l.id=$1`, [grant.lotId]);
    expect(lot.rows[0]).toEqual({
      granted_micros: topup.creditMicros.toString(), available_micros: topup.creditMicros.toString(), movement_count: '1',
    });
  });

  it('accepts callback attribution only after a separate exact paid active-query receipt', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject);
    await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    await succeedAndGrant(subject, topup, new Date('2026-08-21T04:10:00.000Z'), { source: 'callback' });
    expect((await postgres.query<{ source: string; api_trade_no: string | null; signature_verified: boolean }>(
      `SELECT source,api_trade_no,signature_verified FROM qixiang_payment_receipts
       WHERE id=(SELECT success_receipt_id FROM kai_credit_topups WHERE id=$1)`, [topup.id])).rows[0])
      .toEqual({ source: 'callback', api_trade_no: null, signature_verified: true });
    expect((await postgres.query<{ count: string }>(`SELECT count(*)::text count FROM qixiang_payment_receipts
      WHERE topup_id=$1 AND source='query' AND provider_code=1 AND provider_status=1`, [topup.id])).rows[0]?.count).toBe('1');
  });

  it('rolls back a callback-only economic closure without paid active-query confirmation', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject);
    await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    await expect(succeedAndGrant(subject, topup, new Date('2026-08-21T04:12:00.000Z'), {
      source: 'callback', includePaidQuery: false,
    })).rejects.toThrow(/QIXIANG_TOPUP_PAID_QUERY_CONFIRMATION_MISSING/u);
    expect((await postgres.query<{ status: string }>(`SELECT status FROM kai_credit_topups WHERE id=$1`, [topup.id]))
      .rows[0]?.status).toBe('verifying');
  });

  it('lets only one concurrent confirmation close and grant the same topup', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject);
    await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    const attempts = await Promise.allSettled([
      succeedAndGrant(subject, topup, new Date('2026-08-21T04:15:00.000Z')),
      succeedAndGrant(subject, topup, new Date('2026-08-21T04:15:00.000Z')),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const counts = await postgres.query<{ claims: string; lots: string; grants: string }>(`SELECT
      (SELECT count(*)::text FROM kai_credit_topup_provider_claims WHERE topup_id=$1) claims,
      (SELECT count(*)::text FROM kai_credit_lots WHERE source_topup_id=$1) lots,
      (SELECT count(*)::text FROM kai_credit_transactions WHERE scope='QIXIANG_TOPUP_CAPTURE' AND reference_id=$1::text) grants`,
    [topup.id]);
    expect(counts.rows[0]).toEqual({ claims: '1', lots: '1', grants: '1' });
  });

  it.each(['receipt', 'claim', 'event', 'transaction', 'entry', 'lot', 'movement', 'extra_entry', 'wrong_counterpart'] as const)(
    'rolls the whole success transaction back when the %s closure component is absent', async (omit) => {
      const subject = await createSubject();
      const topup = await createTopup(subject);
      await makePending(topup);
      await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
      await expect(succeedAndGrant(subject, topup, new Date('2026-08-21T04:20:00.000Z'), { omit })).rejects.toThrow();
      const result = await postgres.query<{ status: string; success_receipt_id: string | null }>(
        `SELECT status,success_receipt_id FROM kai_credit_topups WHERE id=$1`, [topup.id]);
      expect(result.rows[0]).toEqual({ status: 'verifying', success_receipt_id: null });
      expect((await postgres.query(`SELECT id FROM kai_credit_lots WHERE source_topup_id=$1`, [topup.id])).rows).toHaveLength(0);
    },
  );

  it('requires two exact unpaid queries at least 30 seconds apart after checkout expiry', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject, 1002, new Date(Date.now() - 60_000));
    await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    const first = new Date('2026-08-21T06:00:00.000Z');
    await insertUnpaidReceipt(topup, first);
    await expect(postgres.query(`UPDATE kai_credit_topups SET status='expired',unpaid_query_confirmations=1,
      first_unpaid_query_at=$2,last_unpaid_query_at=$2 WHERE id=$1`, [topup.id, first]))
      .rejects.toThrow(/QIXIANG_TOPUP_EXPIRY_EVIDENCE_MISSING/u);
    const last = new Date(first.getTime() + 31_000);
    await insertUnpaidReceipt(topup, last);
    await postgres.query(`UPDATE kai_credit_topups SET status='expired',unpaid_query_confirmations=2,
      first_unpaid_query_at=$2,last_unpaid_query_at=$3 WHERE id=$1`, [topup.id, first, last]);
    expect((await postgres.query<{ status: string }>(`SELECT status FROM kai_credit_topups WHERE id=$1`, [topup.id]))
      .rows[0]?.status).toBe('expired');
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
  });

  it('rejects direct lot bucket edits, wrong directions and allocation drift at commit', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject);
    await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    const { lotId } = await succeedAndGrant(subject, topup, new Date('2026-08-21T04:30:00.000Z'));
    await expect(executeTransaction(async (transaction) => {
      await transaction.query(`UPDATE kai_credit_lots SET available_micros=available_micros-10000,
        consumed_micros=consumed_micros+10000 WHERE id=$1`, [lotId]);
    })).rejects.toThrow(/QIXIANG_LOT_MOVEMENT_IMBALANCE/u);
    await expect(postgres.query(`INSERT INTO kai_credit_lot_movements(
      id,lot_id,ledger_transaction_id,kind,amount_micros,from_bucket,to_bucket,
      idempotency_owner,scope,idempotency_key,payload_digest)
      SELECT $1,$2,grant_transaction_id,'refund_hold',10000,'reserved','refund_pending',
        'qixiang:test','BAD_DIRECTION',$3,$4 FROM kai_credit_lots WHERE id=$2`, [
      randomUUID(), lotId, `bad-${randomUUID()}`, `sha256:${'d'.repeat(64)}`,
    ])).rejects.toThrow();
    for (const [kind, fromBucket] of [['release_expired', 'reserved'], ['restore_expired', 'consumed']] as const) {
      await expect(postgres.query(`INSERT INTO kai_credit_lot_movements(
        id,lot_id,allocation_id,ledger_transaction_id,kind,amount_micros,from_bucket,to_bucket,
        idempotency_owner,scope,idempotency_key,payload_digest)
        VALUES($1,$2,$3,(SELECT grant_transaction_id FROM kai_credit_lots WHERE id=$2),$4,10000,$5,'available',
          'qixiang:test','BAD_EXPIRED_DIRECTION',$6,$7)`, [
        randomUUID(), lotId, randomUUID(), kind, fromBucket, `bad-expired-${randomUUID()}`, 'd'.repeat(64),
      ])).rejects.toThrow();
    }
    const allocationId = randomUUID();
    await expect(executeTransaction(async (transaction) => {
      await transaction.query(`INSERT INTO kai_credit_lot_allocations(
        id,lot_id,reference_type,reference_id,allocation_key,allocated_micros,reserved_micros,
        consumed_micros,released_micros,restored_micros)
        VALUES($1,$2,'credit_order',$3,$4,10000,10000,0,0,0)`, [
        allocationId, lotId, randomUUID(), `allocation-${randomUUID()}`,
      ]);
      await transaction.query(`UPDATE kai_credit_lot_allocations SET reserved_micros=0,released_micros=10000 WHERE id=$1`,
        [allocationId]);
    })).rejects.toThrow(/QIXIANG_LOT_ALLOCATION_IMBALANCE/u);
  });

  it('allows a mixed legacy-plus-lot reservation only when lot movement M does not exceed ledger leg T', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject, 10_020);
    await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    const { lotId } = await succeedAndGrant(subject, topup, new Date('2026-08-21T05:20:00.000Z'));
    await executeTransaction(async (transaction) => postLedger(transaction, {
      transactionId: randomUUID(), debitAccountId: '00000000-0000-4000-8000-000000000101',
      creditAccountId: subject.availableAccountId, amountMicros: 10_000_000n, scope: 'LEGACY_TEST_GRANT',
      owner: `subject:${subject.subjectId}`, referenceId: subject.subjectId,
    }));
    await reserveLot({
      lotId, subjectId: subject.subjectId, createdByUserId: subject.userId, availableAccountId: subject.availableAccountId,
      reservedAccountId: subject.reservedAccountId, ledgerMicros: 20_000_000n, lotMicros: 10_000_000n,
    });
    const lot = await postgres.query<{ available: string; reserved: string }>(
      `SELECT available_micros::text available,reserved_micros::text reserved FROM kai_credit_lots WHERE id=$1`, [lotId]);
    expect(lot.rows[0]).toEqual({ available: '90000000', reserved: '10000000' });

    const secondSubject = await createSubject();
    const secondTopup = await createTopup(secondSubject, 10_020);
    await makePending(secondTopup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [secondTopup.id]);
    const second = await succeedAndGrant(secondSubject, secondTopup, new Date('2026-08-21T05:25:00.000Z'));
    await expect(reserveLot({
      lotId: second.lotId, subjectId: secondSubject.subjectId, createdByUserId: secondSubject.userId,
      availableAccountId: secondSubject.availableAccountId,
      reservedAccountId: secondSubject.reservedAccountId, ledgerMicros: 10_000_000n, lotMicros: 20_000_000n,
    })).rejects.toThrow();
  });

  it('rejects one lot transaction whose ledger legs name two buyer subjects', async () => {
    const first = await createSubject();
    const second = await createSubject();
    const topup = await createTopup(first, 2004);
    await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    const { lotId } = await succeedAndGrant(first, topup, new Date('2026-08-21T05:30:00.000Z'));
    const transactionId = randomUUID(); const allocationId = randomUUID(); const orderId = randomUUID();
    const key = `two-buyers-${randomUUID()}`; const digest = '4'.repeat(64); const amount = 10_000_000n;
    await expect(executeTransaction(async (transaction) => {
      await transaction.query(`INSERT INTO kai_credit_transactions(
        id,idempotency_owner,scope,idempotency_key,payload_digest,reference_type,reference_id,description,status)
        VALUES($1,$2,'VAST_ORDER_RESERVE',$3,$4,'order_reservation',$5,'双买家对抗','pending')`, [
        transactionId, `subject:${first.subjectId}`, key, digest, orderId,
      ]);
      await transaction.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
        ($1,$2,$3,$5,'第一买家扣减'),($4,$2,$6,$7,'第二买家增加')`, [
        randomUUID(), transactionId, first.availableAccountId, randomUUID(), -amount, second.reservedAccountId, amount,
      ]);
      await transaction.query(`INSERT INTO kai_credit_lot_allocations(
        id,lot_id,reference_type,reference_id,allocation_key,allocated_micros,reserved_micros,
        consumed_micros,released_micros,restored_micros)
        VALUES($1,$2,'vast_order',$3,$4,$5,$5,0,0,0)`, [
        allocationId, lotId, orderId, `allocation-${randomUUID()}`, amount,
      ]);
      await transaction.query(`UPDATE kai_credit_lots SET available_micros=available_micros-$2,
        reserved_micros=reserved_micros+$2 WHERE id=$1`, [lotId, amount]);
      await transaction.query(`INSERT INTO kai_credit_lot_movements(
        id,lot_id,allocation_id,ledger_transaction_id,kind,amount_micros,from_bucket,to_bucket,
        idempotency_owner,scope,idempotency_key,payload_digest)
        VALUES($1,$2,$3,$4,'reserve',$5,'available','reserved',$6,'VAST_ORDER_RESERVE',$7,$8)`, [
        randomUUID(), lotId, allocationId, transactionId, amount, `subject:${first.subjectId}`, key, digest,
      ]);
      await transaction.query(`UPDATE kai_credit_transactions SET status='posted' WHERE id=$1`, [transactionId]);
    })).rejects.toThrow(/QIXIANG_LOT_LEDGER_(?:DIRECTION|SECOND_BUYER)/u);
  });

  it('rejects a credit-order capture credited to a supplier other than the order snapshot supplier', async () => {
    const buyer = await createSubject();
    const correctSupplier = await createSubject();
    const wrongSupplier = await createSubject();
    const correctReceivable = randomUUID(); const wrongReceivable = randomUUID();
    await postgres.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
      VALUES($1,'subject',$2,$3,'supplier_receivable',false),
        ($4,'subject',$5,$6,'supplier_receivable',false)`, [
      correctReceivable, correctSupplier.subjectId, `subject:${correctSupplier.subjectId}:supplier-receivable`,
      wrongReceivable, wrongSupplier.subjectId, `subject:${wrongSupplier.subjectId}:supplier-receivable`,
    ]);
    const topup = await createTopup(buyer, 2004);
    await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    const { lotId } = await succeedAndGrant(buyer, topup, new Date('2026-08-21T05:35:00.000Z'));
    await postgres.query(`ALTER TABLE kai_credit_orders DROP CONSTRAINT kai_credit_orders_listing_id_fkey`);
    const reservation = await reserveLot({ lotId, subjectId: buyer.subjectId, createdByUserId: buyer.userId,
      availableAccountId: buyer.availableAccountId, reservedAccountId: buyer.reservedAccountId,
      ledgerMicros: 10_000_000n, lotMicros: 10_000_000n, orderKind: 'credit_order',
      supplierSubjectId: correctSupplier.subjectId });
    const transactionId = randomUUID(); const key = `wrong-supplier-${randomUUID()}`; const digest = '5'.repeat(64);
    await expect(executeTransaction(async (transaction) => {
      await postLedger(transaction, { transactionId, debitAccountId: buyer.reservedAccountId,
        creditAccountId: wrongReceivable, amountMicros: 10_000_000n, scope: 'CREDIT_ORDER_CAPTURE',
        owner: `subject:${buyer.subjectId}`, idempotencyKey: key, payloadDigest: digest,
        referenceType: 'order_capture', referenceId: reservation.orderId });
      await transaction.query(`UPDATE kai_credit_lots SET reserved_micros=reserved_micros-10000000,
        consumed_micros=consumed_micros+10000000 WHERE id=$1`, [lotId]);
      await transaction.query(`UPDATE kai_credit_lot_allocations SET reserved_micros=reserved_micros-10000000,
        consumed_micros=consumed_micros+10000000 WHERE id=$1`, [reservation.allocationId]);
      await transaction.query(`INSERT INTO kai_credit_lot_movements(
        id,lot_id,allocation_id,ledger_transaction_id,kind,amount_micros,from_bucket,to_bucket,
        idempotency_owner,scope,idempotency_key,payload_digest)
        VALUES($1,$2,$3,$4,'consume',10000000,'reserved','consumed',$5,'CREDIT_ORDER_CAPTURE',$6,$7)`, [
        randomUUID(), lotId, reservation.allocationId, transactionId, `subject:${buyer.subjectId}`, key, digest,
      ]);
    })).rejects.toThrow(/QIXIANG_LOT_LEDGER_CAPTURE_(?:COUNTERPART|EXTRA_ENTRY)/u);
  });

  it('rejects accepted callback/query snapshots that are not DB-self-consistent', async () => {
    const subject = await createSubject();
    const topup = await createTopup(subject);
    const trade = await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    await expect(postgres.query(`INSERT INTO qixiang_payment_receipts(
      id,topup_id,source,receipt_key,provider_reference,trade_no,provider_code,provider_status,
      trade_status,payment_type,amount_cents,signature_verified,snapshot_matched,payload_digest,processing_result)
      VALUES($1,NULL,'callback',$2,$3,$4,NULL,NULL,'TRADE_SUCCESS','alipay',$5,true,true,$6,'accepted')`, [
      randomUUID(), `callback:${'3'.repeat(64)}`, topup.reference, trade, topup.amountCents, '4'.repeat(64),
    ])).rejects.toThrow(/QIXIANG_RECEIPT_ACCEPTED_TOPUP_REQUIRED/u);
    const common = [randomUUID(), topup.id, `callback:${'4'.repeat(64)}`, topup.reference, trade,
      topup.amountCents, '5'.repeat(64)];
    await expect(postgres.query(`INSERT INTO qixiang_payment_receipts(
      id,topup_id,source,receipt_key,provider_reference,trade_no,provider_code,provider_status,
      trade_status,payment_type,amount_cents,signature_verified,snapshot_matched,payload_digest,processing_result)
      VALUES($1,$2,'callback',$3,$4,$5,1,NULL,'TRADE_SUCCESS','alipay',$6,true,true,$7,'accepted')`, common))
      .rejects.toThrow(/QIXIANG_CALLBACK_RECEIPT_INVALID/u);
    await expect(postgres.query(`INSERT INTO qixiang_payment_receipts(
      id,topup_id,source,receipt_key,provider_reference,trade_no,api_trade_no,provider_code,provider_status,
      payment_type,amount_cents,signature_verified,snapshot_matched,payload_digest,processing_result)
      VALUES($1,$2,'query',$3,$4,$5,NULL,1,1,'alipay',$6,false,true,$7,'accepted')`, [
      randomUUID(), topup.id, `query:${randomUUID()}`, topup.reference, trade, topup.amountCents, '6'.repeat(64),
    ])).rejects.toThrow(/QIXIANG_QUERY_RECEIPT_INVALID/u);
    await expect(postgres.query(`INSERT INTO qixiang_payment_receipts(
      id,topup_id,source,receipt_key,provider_reference,trade_no,api_trade_no,provider_code,provider_status,
      payment_type,amount_cents,signature_verified,snapshot_matched,payload_digest,processing_result)
      VALUES($1,$2,'query',$3,$4,$5,'API-2',1,1,'alipay',$6,false,true,$7,'accepted')`, [
      randomUUID(), topup.id, `query:${randomUUID()}`, topup.reference, trade, topup.amountCents + 1, '7'.repeat(64),
    ])).rejects.toThrow(/QIXIANG_RECEIPT_TOPUP_MISMATCH/u);
  });

  it('rejects posted inserts and third-party provider claim acquisition before success', async () => {
    await expect(postgres.query(`INSERT INTO kai_credit_transactions(
      id,idempotency_owner,scope,idempotency_key,payload_digest,reference_type,description,status,posted_at)
      VALUES($1,'qixiang:test','QIXIANG_BYPASS',$2,$3,'topup','bypass','posted',now())`, [
      randomUUID(), `qixiang-bypass-${randomUUID()}`, '3'.repeat(64),
    ])).rejects.toThrow(/must be inserted as pending/u);
    const subject = await createSubject();
    const topup = await createTopup(subject);
    const trade = await makePending(topup);
    await expect(executeTransaction(async (transaction) => {
      await transaction.query(`INSERT INTO kai_credit_topup_provider_claims(provider,provider_transaction_id,topup_id)
        VALUES('qixiang',$1,$2)`, [trade, topup.id]);
    })).rejects.toThrow(/QIXIANG_TOPUP_PREMATURE_ECONOMIC_WRITE/u);

    const completedSubject = await createSubject();
    const completedTopup = await createTopup(completedSubject);
    await makePending(completedTopup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [completedTopup.id]);
    const completed = await succeedAndGrant(completedSubject, completedTopup, new Date('2026-08-21T06:20:00.000Z'));
    await expect(executeTransaction(async (transaction) => {
      await transaction.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
        ($1,$2,'00000000-0000-4000-8000-000000000102',-10000,'非法晚插借方'),
        ($3,$2,'00000000-0000-4000-8000-000000000103',10000,'非法晚插贷方')`, [
        randomUUID(), completed.ledgerTransactionId, randomUUID(),
      ]);
    })).rejects.toThrow();
  });

  it('holds a full unused lot for refund and only confirms after dual control plus external evidence', async () => {
    const subject = await createSubject();
    const requester = randomUUID(); const approver = randomUUID();
    await postgres.query(`INSERT INTO users(id,phone_ciphertext,display_name,role)VALUES
      ($1,$3,'退款申请员','operator'),($2,$4,'退款复核员','operator')`, [
      requester, approver, `refund-op-${requester}`, `refund-op-${approver}`,
    ]);
    const topup = await createTopup(subject);
    await makePending(topup);
    await postgres.query(`UPDATE kai_credit_topups SET status='verifying' WHERE id=$1`, [topup.id]);
    const { lotId } = await succeedAndGrant(subject, topup, new Date('2026-08-21T05:40:00.000Z'));
    const { refundId, holdTransactionId } = await requestFullRefund({ lotId, topup, subject, requesterId: requester });
    const member = randomUUID();
    await postgres.query(`INSERT INTO users(id,phone_ciphertext,display_name,role)VALUES($1,$2,'普通成员','member')`, [
      member, `refund-member-${member}`,
    ]);
    await expect(postgres.query(`INSERT INTO qixiang_refund_actions(
      id,refund_id,actor_id,action,idempotency_owner,scope,idempotency_key,payload_digest)
      VALUES($1,$2,$3,'request',$4,'QIXIANG_REFUND_REQUEST',$5,$6)`, [
      randomUUID(), refundId, member, `operator:${member}`, `member-action-${randomUUID()}`, '7'.repeat(64),
    ])).rejects.toThrow(/active operator/u);
    await expect(postgres.query(`INSERT INTO qixiang_refund_actions(
      id,refund_id,actor_id,action,idempotency_owner,scope,idempotency_key,payload_digest,evidence_digest)
      VALUES($1,$2,$3,'request',$4,'QIXIANG_REFUND_REQUEST',$5,$6,'')`, [
      randomUUID(), refundId, requester, `operator:${requester}`, `empty-digest-${randomUUID()}`, '8'.repeat(64),
    ])).rejects.toThrow();
    expect((await postgres.query<{ available: string; held: string }>(`SELECT available_micros::text available,
      refund_pending_micros::text held FROM kai_credit_lots WHERE id=$1`, [lotId])).rows[0])
      .toEqual({ available: '0', held: topup.creditMicros.toString() });
    await postgres.query(`UPDATE users SET status='suspended' WHERE id=$1`, [requester]);
    await expect(postgres.query(`UPDATE qixiang_refund_requests SET status='approved',approved_by_operator_id=$2,
      approval_evidence_digest=$3,approved_at=now(),reversal_transaction_id=$4 WHERE id=$1`, [
      refundId, approver, '1'.repeat(64), holdTransactionId,
    ])).rejects.toThrow(/resolution transaction phase mismatch/u);
    expect((await postgres.query<{ status: string; version: number; reversal: string | null }>(
      `SELECT status,version,reversal_transaction_id reversal FROM qixiang_refund_requests WHERE id=$1`, [refundId]))
      .rows[0]).toEqual({ status: 'requested', version: 1, reversal: null });
    await postgres.query(`UPDATE qixiang_refund_requests SET status='approved',approved_by_operator_id=$2,
      approval_evidence_digest=$3,approved_at=now() WHERE id=$1`, [refundId, approver, '1'.repeat(64)]);
    await expect(postgres.query(`UPDATE qixiang_refund_requests SET status='provider_pending',provider_call_id=$2,
      provider_submitted_at=now(),approval_evidence_digest=$3 WHERE id=$1`, [
      refundId, `provider-call-${randomUUID()}`, 'A'.repeat(64),
    ])).rejects.toThrow();
    await postgres.query(`UPDATE qixiang_refund_requests SET status='provider_pending',provider_call_id=$2,
      provider_submitted_at=now() WHERE id=$1`, [refundId, `provider-call-${randomUUID()}`]);
    await postgres.query(`UPDATE qixiang_refund_requests SET status='pending_confirmation',provider_response_code=1,
      provider_response_digest=$2 WHERE id=$1`, [refundId, '4'.repeat(64)]);
    await expect(postgres.query(`UPDATE qixiang_refund_requests SET status='manual_review',provider_response_digest=$2
      WHERE id=$1`, [refundId, '5'.repeat(64)])).rejects.toThrow(/provider response history is immutable/u);
    await postgres.query(`UPDATE qixiang_refund_requests SET status='manual_review' WHERE id=$1`, [refundId]);
    await expect(postgres.query(`UPDATE qixiang_refund_requests SET status='rejected' WHERE id=$1`, [refundId]))
      .rejects.toThrow(/invalid qixiang refund transition/u);

    const reversalTransactionId = randomUUID(); const key = `refund-confirm-${randomUUID()}`; const digest = '2'.repeat(64);
    await executeTransaction(async (transaction) => {
      await postLedger(transaction, {
        transactionId: reversalTransactionId, debitAccountId: subject.refundHoldAccountId,
        creditAccountId: '00000000-0000-4000-8000-000000000101', amountMicros: topup.creditMicros,
        scope: 'QIXIANG_REFUND_CONFIRM', owner: `operator:${approver}`, idempotencyKey: key,
        payloadDigest: digest, referenceType: 'refund', referenceId: refundId,
      });
      await transaction.query(`UPDATE kai_credit_lots SET refund_pending_micros=0,refunded_micros=$2 WHERE id=$1`,
        [lotId, topup.creditMicros]);
      await transaction.query(`INSERT INTO kai_credit_lot_movements(
        id,lot_id,ledger_transaction_id,kind,amount_micros,from_bucket,to_bucket,
        idempotency_owner,scope,idempotency_key,payload_digest)
        VALUES($1,$2,$3,'refund_confirm',$4,'refund_pending','refunded',$5,'QIXIANG_REFUND_CONFIRM',$6,$7)`, [
        randomUUID(), lotId, reversalTransactionId, topup.creditMicros, `operator:${approver}`, key, digest,
      ]);
      await transaction.query(`UPDATE kai_credit_topups SET reversed_amount_cents=amount_cents,
        reversed_credit_micros=credit_micros WHERE id=$1`, [topup.id]);
      await transaction.query(`UPDATE qixiang_refund_requests SET status='confirmed',confirmed_by_operator_id=$2,
        confirmation_evidence_digest=$3,confirmed_at=now(),reversal_transaction_id=$4 WHERE id=$1`, [
        refundId, approver, '3'.repeat(64), reversalTransactionId,
      ]);
    });
    await expect(postgres.query(`UPDATE qixiang_refund_requests SET confirmation_evidence_digest=$2 WHERE id=$1`, [
      refundId, '6'.repeat(64),
    ])).rejects.toThrow(/confirmation history is immutable/u);
    expect((await postgres.query<{ status: string; refunded: string }>(`SELECT r.status,l.refunded_micros::text refunded
      FROM qixiang_refund_requests r JOIN kai_credit_lots l ON l.source_topup_id=r.topup_id WHERE r.id=$1`, [refundId]))
      .rows[0]).toEqual({ status: 'confirmed', refunded: topup.creditMicros.toString() });
  });

  it('makes receipts, evidence and refund actions append-only with dual control', async () => {
    const subject = await createSubject();
    const operatorA = randomUUID();
    const operatorB = randomUUID();
    await postgres.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES
      ($1,$3,'七相复核A','operator'),($2,$4,'七相复核B','operator')`, [
      operatorA, operatorB, `qixiang-op-${operatorA}`, `qixiang-op-${operatorB}`,
    ]);
    const topup = await createTopup(subject);
    await postgres.query(`INSERT INTO qixiang_payment_receipts(
      id,topup_id,source,receipt_key,provider_reference,trade_no,provider_code,provider_status,
      payment_type,amount_cents,signature_verified,snapshot_matched,payload_digest,processing_result)
      VALUES($1,$2,'query',$3,$4,NULL,1,0,'alipay',$5,false,true,$6,'accepted')`, [
      randomUUID(), topup.id, `query:${randomUUID()}`, topup.reference, topup.amountCents, 'e'.repeat(64),
    ]);
    await expect(postgres.query(`UPDATE qixiang_payment_receipts SET processing_result='manual_review'
      WHERE topup_id=$1`, [topup.id])).rejects.toThrow(/immutable/u);
    const evidenceId = randomUUID();
    await postgres.query(`INSERT INTO qixiang_provider_approval_evidence(
      id,kind,evidence_ref,evidence_digest,metadata,verified_by_operator_id,approved_by_operator_id,valid_from)
      VALUES($1,'merchant_key_rotation',$2,$3,$4,$5,$6,now())`, [
      evidenceId, `ticket:${randomUUID()}`, 'f'.repeat(64), JSON.stringify({
        merchantId: '4611', rotatedAt: '2026-08-21T05:00:00.000Z', credentialVersion: 'v2',
        newKeyFingerprint: '1'.repeat(64), oldKeyFingerprint: '2'.repeat(64),
      }), operatorA, operatorB,
    ]);
    await expect(postgres.query(`UPDATE qixiang_provider_approval_evidence SET metadata='{}' WHERE id=$1`, [evidenceId]))
      .rejects.toThrow(/identity is immutable/u);
    await expect(postgres.query(`DELETE FROM qixiang_provider_approval_evidence WHERE id=$1`, [evidenceId]))
      .rejects.toThrow(/immutable/u);
    await expect(postgres.query(`INSERT INTO qixiang_provider_approval_evidence(
      id,kind,evidence_ref,evidence_digest,metadata,verified_by_operator_id,approved_by_operator_id,valid_from)
      VALUES($1,'old_key_revocation',$2,$3,'{}',$4,$4,now())`, [
      randomUUID(), `ticket:${randomUUID()}`, '1'.repeat(64), operatorA,
    ])).rejects.toThrow();
    const member = randomUUID();
    await postgres.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES($1,$2,'普通成员','member')`, [
      member, `evidence-member-${member}`,
    ]);
    await expect(postgres.query(`INSERT INTO qixiang_provider_approval_evidence(
      id,kind,evidence_ref,evidence_digest,metadata,verified_by_operator_id,approved_by_operator_id,valid_from)
      VALUES($1,'old_key_revocation',$2,$3,$4,$5,$6,now())`, [
      randomUUID(), `ticket:${randomUUID()}`, '1'.repeat(64), JSON.stringify({ merchantId: '4611',
        revokedAt: '2026-08-21T05:00:00Z', providerCaseRef: 'CASE-MEMBER', oldKeyFingerprint: '2'.repeat(64) }),
      member, operatorB,
    ])).rejects.toThrow(/active operator/u);
  });

  it('accepts only the ten exact evidence metadata schemas and two distinct operators', async () => {
    const operatorA = randomUUID(); const operatorB = randomUUID();
    await postgres.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES
      ($1,$3,'七相证据复核A','operator'),($2,$4,'七相证据复核B','operator')`, [
      operatorA, operatorB, `qixiang-evidence-${operatorA}`, `qixiang-evidence-${operatorB}`,
    ]);
    await postgres.query(`UPDATE users SET status='suspended' WHERE id IN(
      SELECT verified_by_operator_id FROM qixiang_provider_approval_evidence WHERE kind='merchant_key_rotation'
      UNION SELECT approved_by_operator_id FROM qixiang_provider_approval_evidence WHERE kind='merchant_key_rotation')`);
    await postgres.query(`UPDATE qixiang_provider_approval_evidence SET status='revoked',revoked_at=now(),
      revocation_evidence_ref='audit://qixiang/revocation-test',revoked_by_operator_id=$1
      WHERE kind='merchant_key_rotation' AND status='approved'`, [operatorA]);
    const time = '2026-08-21T06:00:00.000Z';
    const digest = 'a'.repeat(64);
    const evidence: Array<readonly [string, Record<string, unknown>]> = [
      ['merchant_key_rotation', { merchantId: '4611', rotatedAt: time, credentialVersion: 'v2',
        newKeyFingerprint: '1'.repeat(64), oldKeyFingerprint: '2'.repeat(64) }],
      ['old_key_revocation', { merchantId: '4611', revokedAt: time, providerCaseRef: 'CASE-1', oldKeyFingerprint: digest }],
      ['merchant_entity_match', { merchantId: '4611', legalEntityName: '上海申比芯人工智能科技有限公司',
        unifiedSocialCreditCode: '91310112MAKJAYAJ7U', providerRegisteredName: '上海申比芯人工智能科技有限公司', verifiedAt: time }],
      ['domain_app_scene_approval', { merchantId: '4611', domain: 'cloudpay.kai.com',
        appPackage: 'com.kaicloud.marketplace', scene: 'android_h5_alipay', providerCaseRef: 'CASE-2', approvedAt: time }],
      ['service_category_approval', { merchantId: '4611', category: 'compute_card_hours', entitlementDays: 364,
        nonTransferable: true, nonCash: true, approvedAt: time }],
      ['refund_api_confirmation', { merchantId: '4611', enabledAt: time, supportsOutTradeNo: true,
        successCodes: [0, 1], confirmationRequired: true, providerCaseRef: 'CASE-3' }],
      ['real_fulfillment_acceptance', { merchantId: '4611', fulfillmentType: 'compute_card_hours', testedAt: time,
        acceptanceReportDigest: digest }],
      ['reconciliation_acceptance', { merchantId: '4611', callback: true, activeQuery: true, lateSuccess: true,
        testedAt: time, reportDigest: digest }],
      ['approved_max_amount', { merchantId: '4611', currency: 'CNY', minCents: 100, maxCents: 4_999_999,
        providerLimitRef: 'CASE-4', approvedAt: time }],
      ['lot_accounting_acceptance', { schemaVersion: 1,
        stores: ['credit-orders', 'credits', 'device-commerce', 'fulfillment', 'topups-reversal', 'vast-market'],
        testedAt: time, testReportDigest: digest }],
    ];
    for (const [kind, metadata] of evidence) await postgres.query(`INSERT INTO qixiang_provider_approval_evidence(
      id,kind,evidence_ref,evidence_digest,metadata,verified_by_operator_id,approved_by_operator_id,valid_from)
      VALUES($1,$2,$3,$4,$5,$6,$7,now())`, [
      randomUUID(), kind, `audit://${kind}/${randomUUID()}`, digest, JSON.stringify(metadata), operatorA, operatorB,
    ]);
    expect((await postgres.query<{ count: string }>(`SELECT count(*)::text count
      FROM qixiang_provider_approval_evidence WHERE status='approved'`)).rows[0]?.count).toBe('10');
    await expect(postgres.query(`INSERT INTO qixiang_provider_approval_evidence(
      id,kind,evidence_ref,evidence_digest,metadata,verified_by_operator_id,approved_by_operator_id,valid_from)
      VALUES($1,'lot_accounting_acceptance',$2,$3,$4,$5,$6,now())`, [
      randomUUID(), `audit://invalid/${randomUUID()}`, digest,
      JSON.stringify({ ...evidence.at(-1)?.[1], extra: true }), operatorA, operatorB,
    ])).rejects.toThrow();
    for (const [kind, metadata] of evidence) {
      const stringKey = ['merchantId','testedAt','approvedAt','enabledAt','rotatedAt','revokedAt','verifiedAt']
        .find((key) => typeof metadata[key] === 'string');
      if (!stringKey) throw new Error(`missing string fixture for ${kind}`);
      const invalid = { ...metadata, [stringKey]: 4611 };
      const validation = await postgres.query<{ valid: boolean }>(
        `SELECT validate_qixiang_evidence_metadata($1,$2::jsonb) valid`, [kind, JSON.stringify(invalid)]);
      expect(validation.rows[0]?.valid, `${kind}.${stringKey} accepted a JSON number`).toBe(false);
    }
    for (const timestamp of ['2026-99-21T06:00:00Z','2026-02-30T06:00:00Z','2026-08-21T99:00:00Z']) {
      expect((await postgres.query<{ valid: boolean }>(`SELECT qixiang_iso_utc($1) valid`, [timestamp])).rows[0]?.valid)
        .toBe(false);
    }
    for (const timestamp of ['2026-08-21T06:00:00Z','2026-08-21T06:00:00.123Z']) {
      expect((await postgres.query<{ valid: boolean }>(`SELECT qixiang_iso_utc($1) valid`, [timestamp])).rows[0]?.valid)
        .toBe(true);
    }
  });
});
