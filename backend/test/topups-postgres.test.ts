import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AccountStore } from '../src/account/store.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import type { CheckoutRequest, PaymentProvider } from '../src/payment/providers.js';
import type { SubjectAccess } from '../src/subjects/types.js';
import { creditMicrosForTopup, CreditTopupService } from '../src/topups/service.js';
import { PostgresCreditTopupStore } from '../src/topups/store.js';
import type { VerifiedTopupEvent } from '../src/topups/types.js';
import { PostgresTopupRecoveryStore, TopupRecoveryWorker } from '../src/topups/recovery.js';
import { PostgresTopupReversalStore } from '../src/topups/reversal-store.js';
import { PostgresCreditLedgerStore } from '../src/credits/store.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../src/credits/types.js';

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

async function fixture() {
  const pglite = new PGlite();
  for (const name of [
    '0001_cloudpay_ledger.sql', '0016_trading_subjects.sql',
    '0022_kai_credit_double_entry_ledger.sql', '0023_kai_credit_topups.sql',
    '0050_topup_reversals.sql',
  ]) await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  const database = adapter(pglite);
  const userId = randomUUID(); const subjectId = randomUUID(); const otherUserId = randomUUID(); const otherSubjectId = randomUUID();
  await database.query(`INSERT INTO users(id, phone_ciphertext, display_name) VALUES
    ($1, 'topup-owner', '充值用户'), ($2, 'other-topup-owner', '其他用户')`, [userId, otherUserId]);
  await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES
    ($1, 'personal', '充值用户', $2), ($3, 'personal', '其他用户', $4)`, [subjectId, userId, otherSubjectId, otherUserId]);
  await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES
    ($1, $2, 'owner'), ($3, $4, 'owner')`, [subjectId, userId, otherSubjectId, otherUserId]);
  return { database, userId, subjectId, otherSubjectId };
}

function verified(input: Partial<VerifiedTopupEvent> & Pick<VerifiedTopupEvent, 'providerReference'>): VerifiedTopupEvent {
  return {
    provider: 'alipay', eventId: `event-${randomUUID()}`, providerTransactionId: `trade-${randomUUID()}`,
    status: 'succeeded', amountCents: 10_000, currency: 'CNY', payloadDigest: `sha256:${'a'.repeat(64)}`,
    normalizedPayload: { source: 'test' }, ...input,
  };
}

async function prepare(store: PostgresCreditTopupStore, subjectId: string, userId: string, input: Readonly<{
  amountCents?: number; providerReference?: string; expiresAt?: Date;
}> = {}) {
  const amountCents = input.amountCents ?? 10_000;
  const result = await store.prepare({
    id: randomUUID(), subjectId, userId, provider: 'alipay', providerReference: input.providerReference ?? `KCT-${randomUUID()}`,
    channel: 'app', amountCents, creditMicros: creditMicrosForTopup(amountCents), conversionCnyMicrosPerCredit: 1_002_000n,
    clientRequestId: `topup-request-${randomUUID()}`, payloadDigest: `sha256:${'b'.repeat(64)}`,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 60_000),
  });
  if (result.status === 'conflict') throw new Error('unexpected conflict');
  return result.topup;
}

async function available(database: Database, subjectId: string) {
  const result = await database.query<{ amount: string }>(`SELECT COALESCE(sum(e.amount_micros), 0)::text AS amount
    FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id = a.id
    LEFT JOIN kai_credit_transactions t ON t.id = e.transaction_id AND t.status = 'posted'
    WHERE a.subject_id = $1 AND a.account_kind = 'available'`, [subjectId]);
  return BigInt(result.rows[0]?.amount ?? '0');
}

describe('verified RMB to KAI credit topups', () => {
  it('mints once only after exact verified receipt and keeps every subject isolated', { timeout: 30_000 }, async () => {
    const { database, userId, subjectId, otherSubjectId } = await fixture(); const store = new PostgresCreditTopupStore(database);
    const topup = await prepare(store, subjectId, userId);
    expect(await available(database, subjectId)).toBe(0n);
    const event = verified({ providerReference: topup.providerReference, providerTransactionId: 'ALI-RECEIPT-001' });
    expect(await store.applyVerifiedEvent(event, new Date())).toBe('succeeded');
    expect(await available(database, subjectId)).toBe(99_800_399n);
    expect(await available(database, otherSubjectId)).toBe(0n);
    expect(await store.applyVerifiedEvent(event, new Date())).toBe('duplicate');
    expect(await store.applyVerifiedEvent({ ...event, eventId: 'ALI-SECOND-NOTIFY-001' }, new Date())).toBe('duplicate');
    expect(await available(database, subjectId)).toBe(99_800_399n);
    const issuance = await database.query<{ amount: string }>(`SELECT COALESCE(sum(e.amount_micros), 0)::text AS amount
      FROM kai_credit_entries e JOIN kai_credit_transactions t ON t.id = e.transaction_id
      WHERE e.account_id = '00000000-0000-4000-8000-000000000101' AND t.status = 'posted'`);
    expect(BigInt(issuance.rows[0]!.amount)).toBe(-99_800_399n);
    await database.close();
  });

  it('never credits mismatched amounts, unknown orders, or a reused provider receipt', { timeout: 30_000 }, async () => {
    const { database, userId, subjectId } = await fixture(); const store = new PostgresCreditTopupStore(database);
    const mismatch = await prepare(store, subjectId, userId, { amountCents: 5000 });
    expect(await store.applyVerifiedEvent(verified({ providerReference: mismatch.providerReference, amountCents: 4999 }), new Date())).toBe('amount_mismatch');
    expect((await store.get(subjectId, mismatch.id))?.status).toBe('manual_review');
    expect(await store.applyVerifiedEvent(verified({ providerReference: mismatch.providerReference, amountCents: 5000 }), new Date())).toBe('manual_review');
    expect(await store.applyVerifiedEvent(verified({ providerReference: 'KCT-UNKNOWN' }), new Date())).toBe('unknown_reference');
    const first = await prepare(store, subjectId, userId, { amountCents: 1000 });
    const second = await prepare(store, subjectId, userId, { amountCents: 1000 });
    expect(await store.applyVerifiedEvent(verified({ providerReference: first.providerReference, providerTransactionId: 'ALI-REUSED-RECEIPT', amountCents: 1000 }), new Date())).toBe('succeeded');
    expect(await store.applyVerifiedEvent(verified({ providerReference: second.providerReference, providerTransactionId: 'ALI-REUSED-RECEIPT', amountCents: 1000 }), new Date())).toBe('provider_transaction_conflict');
    expect((await store.get(subjectId, second.id))?.status).toBe('manual_review');
    expect(await available(database, subjectId)).toBe(9_980_039n);
    await database.close();
  });

  it('accepts a verified late callback because the channel has already received the money', { timeout: 30_000 }, async () => {
    const { database, userId, subjectId } = await fixture(); const store = new PostgresCreditTopupStore(database);
    const topup = await prepare(store, subjectId, userId, { expiresAt: new Date(Date.now() - 60_000), amountCents: 100 });
    expect(await store.applyVerifiedEvent(verified({ providerReference: topup.providerReference, amountCents: 100 }), new Date())).toBe('succeeded');
    expect(await available(database, subjectId)).toBe(998_003n);
    await database.close();
  });

  it('reuses one provider checkout and safely retries an interrupted checkout creation', { timeout: 30_000 }, async () => {
    const { database, userId, subjectId } = await fixture(); const store = new PostgresCreditTopupStore(database);
    const calls: CheckoutRequest[] = []; let failFirst = true;
    const provider: PaymentProvider = {
      name: 'alipay',
      createCheckout: async (input) => {
        calls.push(input);
        if (failFirst) { failFirst = false; throw new Error('temporary provider failure'); }
        return { providerPaymentId: 'ALI-CHECKOUT-1', checkoutPayload: 'signed-app-order' };
      },
    };
    const subjects = { current: async () => ({ subjectId }) } as unknown as SubjectAccess;
    const audits: string[] = [];
    const accounts = { recordAudit: async (input: { action: string }) => { audits.push(input.action); } } as unknown as AccountStore;
    const config = loadConfig({
      NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), PUBLIC_ORIGIN: 'https://cloudpay.kai.com',
      TOPUP_ALIPAY_NOTIFY_URL: 'https://cloudpay.kai.com/mobile/v1/credits/topups/alipay/notify',
    });
    const service = new CreditTopupService(store, accounts, subjects, new Map([['alipay', provider]]), config);
    const principal: AccountPrincipal = { userId, sessionId: randomUUID(), role: 'member' };
    const request = { amountCents: 10_000, provider: 'alipay' as const, channel: 'app' as const, idempotencyKey: 'topup-safe-retry-000001' };
    await expect(service.create(principal, request, { requestId: 'request-1', ip: '203.0.113.8' })).rejects.toThrow('temporary provider failure');
    const recovered = await service.create(principal, request, { requestId: 'request-2', ip: '203.0.113.8' });
    const replayed = await service.create(principal, request, { requestId: 'request-3', ip: '203.0.113.8' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ amountCents: 10_000, channel: 'app', notifyUrl: config.TOPUP_ALIPAY_NOTIFY_URL });
    expect(recovered.topup).toMatchObject({ status: 'pending', amountCny: '100.00', creditAmount: '99.800399' });
    expect(recovered.topup).toMatchObject({ checkoutPayload: 'signed-app-order' });
    expect(replayed).toMatchObject({ replayed: true, topup: { status: 'pending' } });
    expect((await service.get(principal, recovered.topup.id))).toMatchObject({ checkoutPayload: 'signed-app-order' });
    expect(audits).toEqual(['KAI_CREDIT_TOPUP_CREATED']);
    await database.close();
  });

  it('actively reconciles an interrupted payment and mints through the same verified entry point', { timeout: 30_000 }, async () => {
    const { database, userId, subjectId } = await fixture(); const store = new PostgresCreditTopupStore(database);
    const topup = await prepare(store, subjectId, userId, { amountCents: 2500 });
    await store.saveCheckout(topup.id, { providerPaymentId: 'ALI-PREPAY-RECOVERY', checkoutPayload: 'signed-checkout' });
    const provider: PaymentProvider = {
      name: 'alipay', createCheckout: async () => ({ providerPaymentId: '', checkoutPayload: '' }),
      queryPayment: async () => ({
        status: 'settled', event: verified({
          providerReference: topup.providerReference, providerTransactionId: 'ALI-RECOVERED-RECEIPT', amountCents: 2500,
        }),
      }),
    };
    const errors: unknown[] = [];
    const worker = new TopupRecoveryWorker(
      new PostgresTopupRecoveryStore(database), store, new Map([['alipay', provider]]),
      { info: () => undefined, error: (fields) => { errors.push(fields); } }, 60_000, () => new Date(Date.now() + 60_000),
    );
    await worker.tick();
    expect(errors).toEqual([]);
    expect((await store.get(subjectId, topup.id))?.status).toBe('succeeded');
    expect(await available(database, subjectId)).toBe(24_950_099n);
    await database.close();
  });

  it('recovers credits through dual control without claiming an external cash refund', { timeout: 30_000 }, async () => {
    const { database, userId, subjectId } = await fixture();
    const firstOperator = randomUUID(); const secondOperator = randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES
      ($1,'topup-reversal-operator-1','冲正申请员','operator'),($2,'topup-reversal-operator-2','冲正复核员','operator')`,
    [firstOperator, secondOperator]);
    const topups = new PostgresCreditTopupStore(database); const reversals = new PostgresTopupReversalStore(database);
    const topup = await prepare(topups, subjectId, userId);
    expect(await topups.applyVerifiedEvent(verified({ providerReference: topup.providerReference,
      providerTransactionId: 'ALI-REVERSAL-RECEIPT-001' }), new Date())).toBe('succeeded');
    const requested = await reversals.create({ id: randomUUID(), topupId: topup.id, operatorId: firstOperator,
      kind: 'refund', amountCents: 10_000, providerEventReference: 'ALI-REFUND-EVIDENCE-001',
      evidenceDigest: `sha256:${'c'.repeat(64)}`, clientRequestId: 'topup-reversal-request-0001',
      payloadDigest: `sha256:${'d'.repeat(64)}`, now: new Date() });
    expect(requested).toMatchObject({ status: 'created', reversal: { status: 'submitted', creditMicros: 99_800_399n } });
    if (!('reversal' in requested)) throw new Error('missing reversal');
    expect(await reversals.recoverCredits({ reversalId: requested.reversal.id, operatorId: firstOperator, now: new Date() }))
      .toEqual({ status: 'same_operator' });
    expect(await reversals.recoverCredits({ reversalId: requested.reversal.id, operatorId: secondOperator, now: new Date() }))
      .toMatchObject({ status: 'updated', reversal: { status: 'credit_recovered_external_unverified' } });
    expect(await reversals.recoverCredits({ reversalId: requested.reversal.id, operatorId: secondOperator, now: new Date() }))
      .toMatchObject({ status: 'replayed' });
    expect(await available(database, subjectId)).toBe(0n);
    const updated = await database.query<{ reversed_amount_cents: string; reversed_credit_micros: string }>(
      `SELECT reversed_amount_cents::text,reversed_credit_micros::text FROM kai_credit_topups WHERE id=$1`, [topup.id]);
    expect(updated.rows[0]).toEqual({ reversed_amount_cents: '10000', reversed_credit_micros: '99800399' });
    await database.close();
  });

  it('does not over-allocate reversal requests or debit credits already in use', { timeout: 30_000 }, async () => {
    const { database, userId, subjectId } = await fixture(); const operatorA = randomUUID(); const operatorB = randomUUID();
    await database.query(`INSERT INTO users(id,phone_ciphertext,display_name,role) VALUES
      ($1,'topup-reversal-a','冲正A','operator'),($2,'topup-reversal-b','冲正B','operator')`, [operatorA, operatorB]);
    const topups = new PostgresCreditTopupStore(database); const reversals = new PostgresTopupReversalStore(database);
    const topup = await prepare(topups, subjectId, userId, { amountCents: 1000 });
    await topups.applyVerifiedEvent(verified({ providerReference: topup.providerReference, amountCents: 1000 }), new Date());
    const one = await reversals.create({ id: randomUUID(), topupId: topup.id, operatorId: operatorA, kind: 'chargeback',
      amountCents: 700, providerEventReference: 'ALI-CHARGEBACK-0001', evidenceDigest: `sha256:${'e'.repeat(64)}`,
      clientRequestId: 'topup-reversal-limit-0001', payloadDigest: `sha256:${'f'.repeat(64)}`, now: new Date() });
    expect(one.status).toBe('created');
    expect((await reversals.create({ id: randomUUID(), topupId: topup.id, operatorId: operatorA, kind: 'chargeback',
      amountCents: 400, providerEventReference: 'ALI-CHARGEBACK-0002', evidenceDigest: `sha256:${'1'.repeat(64)}`,
      clientRequestId: 'topup-reversal-limit-0002', payloadDigest: `sha256:${'2'.repeat(64)}`, now: new Date() })).status)
      .toBe('amount_exceeds_remaining');
    const ledger = new PostgresCreditLedgerStore(database); const accounts = await ledger.ensureSubjectAccounts(subjectId);
    await ledger.post({ id: randomUUID(), idempotencyOwner: `subject:${subjectId}`, scope: 'TOPUP_TEST_SPEND',
      idempotencyKey: `topup-test-spend-${randomUUID()}`, payloadDigest: `sha256:${'3'.repeat(64)}`,
      referenceType: 'adjustment', description: '测试消费', entries: [
        { accountId: accounts.find((item) => item.kind === 'available')!.accountId, amountMicros: -5_000_000n, memo: '测试消费' },
        { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.clearing, amountMicros: 5_000_000n, memo: '测试清算' },
      ] });
    if (!('reversal' in one)) throw new Error('missing reversal');
    expect(await reversals.recoverCredits({ reversalId: one.reversal.id, operatorId: operatorB, now: new Date() }))
      .toEqual({ status: 'insufficient_credits' });
    await database.close();
  });
});
