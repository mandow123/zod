import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresCreditLedgerStore } from '../src/credits/store.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../src/credits/types.js';
import type { Database } from '../src/database.js';
import { PostgresCreditPayoutStore } from '../src/payouts/store.js';

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
    }), close: () => pglite.close(),
  } as unknown as Database;
}
async function fixture() {
  const pglite = new PGlite();
  for (const name of ['0001_cloudpay_ledger.sql', '0016_trading_subjects.sql',
    '0022_kai_credit_double_entry_ledger.sql', '0046_kai_credit_supplier_payouts.sql',
    '0049_supplier_earnings_accounts.sql']) {
    await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  }
  const database = adapter(pglite); const userId = randomUUID(); const operatorId = randomUUID(); const subjectId = randomUUID();
  await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
    ($1,'payout-supplier','供应方','supplier'),($2,'payout-operator','运营','operator')`, [userId, operatorId]);
  await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES
    ($1,'personal','供应方',$2)`, [subjectId, userId]);
  await database.query(`INSERT INTO subject_memberships(subject_id,user_id,role) VALUES ($1,$2,'owner')`, [subjectId, userId]);
  const ledger = new PostgresCreditLedgerStore(database); const accounts = await ledger.ensureSubjectAccounts(subjectId);
  const available = accounts.find((account) => account.kind === 'available')!.accountId;
  await ledger.post({ id: randomUUID(), idempotencyOwner: `subject:${subjectId}`, scope: 'TEST_PAYOUT_SEED',
    idempotencyKey: `payout-seed-${randomUUID()}`, payloadDigest: `sha256:${'a'.repeat(64)}`, referenceType: 'topup',
    description: '测试入账', entries: [
      { accountId: available, amountMicros: 100_000_000n, memo: '测试入账' },
      { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: -100_000_000n, memo: '测试发行' },
    ] });
  const store = new PostgresCreditPayoutStore(database);
  return { database, store, ledger, userId, operatorId, subjectId };
}
function createInput(subjectId: string, userId: string, amount = 10_000_000n) {
  return { id: randomUUID(), payoutNumber: `KPO${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    subjectId, userId, clientRequestId: `payout-request-${randomUUID()}`, payloadDigest: `sha256:${'b'.repeat(64)}`,
    creditMicros: amount, conversionCnyMicrosPerCredit: 1_002_000n,
    cnyMicros: (amount * 1_002_000n + 500_000n) / 1_000_000n,
    paymentAmountCents: (((amount * 1_002_000n + 500_000n) / 1_000_000n) + 5_000n) / 10_000n,
    now: new Date('2026-08-15T08:00:00Z') };
}
async function seedSupplierEarnings(database: Database, ledger: PostgresCreditLedgerStore, subjectId: string,
  amount = 100_000_000n) {
  const result = await database.query<{ id: string }>(`SELECT id FROM kai_credit_accounts
    WHERE subject_id = $1 AND account_kind = 'supplier_earnings_available'`, [subjectId]);
  const supplierEarnings = result.rows[0]?.id;
  if (!supplierEarnings) throw new Error('missing supplier earnings account');
  await ledger.post({ id: randomUUID(), idempotencyOwner: `subject:${subjectId}`, scope: 'TEST_SUPPLIER_SETTLEMENT_SEED',
    idempotencyKey: `supplier-earnings-seed-${randomUUID()}`, payloadDigest: `sha256:${'7'.repeat(64)}`,
    referenceType: 'settlement', description: '测试供应收益结算', entries: [
      { accountId: supplierEarnings, amountMicros: amount, memo: '供应收益入账' },
      { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: -amount, memo: '测试结算对手' },
    ] });
}
function action(payoutId: string, actorId: string, input: Partial<Parameters<PostgresCreditPayoutStore['transition']>[0]>) {
  return { payoutId, actorId, clientRequestId: `payout-action-${randomUUID()}`,
    payloadDigest: `sha256:${randomUUID().replaceAll('-', '').padEnd(64, 'c').slice(0, 64)}`,
    now: new Date('2026-08-15T09:00:00Z'), ...input } as Parameters<PostgresCreditPayoutStore['transition']>[0];
}

describe('supplier KAI credit payouts', () => {
  it('fails closed before recipient activation, then freezes and completes with one company payment flow', { timeout: 30_000 }, async () => {
    const { database, store, ledger, userId, operatorId, subjectId } = await fixture();
    const request = createInput(subjectId, userId);
    expect(await store.create(request)).toEqual({ status: 'profile_pending' });
    await store.activateProfile({ subjectId, operatorId, legalEntityDigest: `sha256:${'d'.repeat(64)}`,
      recipientReference: 'bank-recipient-token-001', now: request.now });
    expect(await store.create(request)).toEqual({ status: 'insufficient_earnings' });
    await seedSupplierEarnings(database, ledger, subjectId);
    const created = await store.create(request); expect(created.status).toBe('created');
    if (!('payout' in created)) throw new Error('missing payout');
    expect(created.payout).toMatchObject({ status: 'submitted', creditMicros: 10_000_000n,
      cnyMicros: 10_020_000n, paymentAmountCents: 1002n, supplierEarningsBeforeMicros: 100_000_000n,
      supplierEarningsAfterMicros: 90_000_000n, frozenBeforeMicros: 0n, frozenAfterMicros: 10_000_000n });
    expect(await store.create({ ...request, id: randomUUID() })).toMatchObject({ status: 'replayed', payout: { id: created.payout.id } });
    expect(await store.create({ ...request, id: randomUUID(), payloadDigest: `sha256:${'e'.repeat(64)}` })).toEqual({ status: 'conflict' });
    const review = action(created.payout.id, operatorId, { action: 'review', from: 'submitted', to: 'reviewing' });
    expect(await store.transition(review)).toMatchObject({ status: 'updated', payout: { status: 'reviewing' } });
    const pay = action(created.payout.id, operatorId, { action: 'pay', from: 'reviewing', to: 'paying' });
    expect(await store.transition(pay)).toMatchObject({ status: 'updated', payout: { status: 'paying' } });
    expect(await store.transition(action(created.payout.id, operatorId, { action: 'succeed', from: 'paying', to: 'succeeded',
      companyPaymentReference: 'COMPANY-FLOW-WRONG-AMOUNT', companyPaymentFlowDigest: `sha256:${'9'.repeat(64)}`,
      companyPaymentAmountCents: 1001n }))).toEqual({ status: 'invalid_state' });
    const success = action(created.payout.id, operatorId, { action: 'succeed', from: 'paying', to: 'succeeded',
      companyPaymentReference: 'COMPANY-FLOW-20260815-001', companyPaymentFlowDigest: `sha256:${'f'.repeat(64)}`,
      companyPaymentAmountCents: 1002n });
    const completed = await store.transition(success);
    expect(completed).toMatchObject({ status: 'updated', payout: { status: 'succeeded',
      companyPaymentReference: 'COMPANY-FLOW-20260815-001', resolutionSupplierEarningsBeforeMicros: 90_000_000n,
      resolutionSupplierEarningsAfterMicros: 90_000_000n, resolutionFrozenBeforeMicros: 10_000_000n,
      resolutionFrozenAfterMicros: 0n } });
    expect(await store.transition(success)).toMatchObject({ status: 'replayed', payout: { status: 'succeeded' } });
    const balances = await ledger.ensureSubjectAccounts(subjectId);
    expect(balances.find((account) => account.kind === 'available')?.amountMicros).toBe(100_000_000n);
    expect(balances.find((account) => account.kind === 'supplier_earnings_available')?.amountMicros).toBe(90_000_000n);
    expect(balances.find((account) => account.kind === 'payout_frozen')?.amountMicros).toBe(0n);
    const issuance = await database.query<{ amount: string }>(`SELECT COALESCE(sum(e.amount_micros),0)::text amount
      FROM kai_credit_entries e JOIN kai_credit_transactions t ON t.id=e.transaction_id
      WHERE e.account_id=$1 AND t.status='posted'`, [KAI_CREDIT_PLATFORM_ACCOUNTS.issuance]);
    expect(BigInt(issuance.rows[0]!.amount)).toBe(-190_000_000n);
    await database.close();
  });

  it('returns frozen credits after cancellation or failed payment and prevents competing overdraw', { timeout: 30_000 }, async () => {
    const { database, store, ledger, userId, operatorId, subjectId } = await fixture();
    await store.activateProfile({ subjectId, operatorId, legalEntityDigest: `sha256:${'d'.repeat(64)}`,
      recipientReference: 'bank-recipient-token-002', now: new Date() });
    expect(await store.create(createInput(subjectId, userId))).toEqual({ status: 'insufficient_earnings' });
    await seedSupplierEarnings(database, ledger, subjectId);
    const firstInput = createInput(subjectId, userId, 70_000_000n);
    const [first, second] = await Promise.all([
      store.create(firstInput), store.create(createInput(subjectId, userId, 70_000_000n)),
    ]);
    expect([first.status, second.status].sort()).toEqual(['created', 'insufficient_earnings']);
    const created = first.status === 'created' && 'payout' in first ? first : second;
    if (!('payout' in created)) throw new Error('missing payout');
    expect(await store.transition(action(created.payout.id, userId,
      { action: 'cancel', from: 'submitted', to: 'cancelled', reason: '供应方取消', failureCode: 'SUPPLIER_CANCELLED' })))
      .toMatchObject({ status: 'updated', payout: { status: 'cancelled' } });
    const rejectCreated = await store.create(createInput(subjectId, userId, 10_000_000n));
    if (!('payout' in rejectCreated)) throw new Error('missing reject payout');
    await store.transition(action(rejectCreated.payout.id, operatorId, { action: 'review', from: 'submitted', to: 'reviewing' }));
    expect(await store.transition(action(rejectCreated.payout.id, operatorId,
      { action: 'reject', from: 'reviewing', to: 'rejected', reason: '收款资料复核未通过', failureCode: 'OPERATOR_REJECTED' })))
      .toMatchObject({ status: 'updated', payout: { status: 'rejected' } });
    const failCreated = await store.create(createInput(subjectId, userId, 20_000_000n));
    if (!('payout' in failCreated)) throw new Error('missing fail payout');
    await store.transition(action(failCreated.payout.id, operatorId, { action: 'review', from: 'submitted', to: 'reviewing' }));
    await store.transition(action(failCreated.payout.id, operatorId, { action: 'pay', from: 'reviewing', to: 'paying' }));
    expect(await store.transition(action(failCreated.payout.id, operatorId,
      { action: 'fail', from: 'paying', to: 'failed', reason: '银行退票', failureCode: 'BANK_RETURNED' })))
      .toMatchObject({ status: 'updated', payout: { status: 'failed' } });
    const balances = await ledger.ensureSubjectAccounts(subjectId);
    expect(balances.find((account) => account.kind === 'available')?.amountMicros).toBe(100_000_000n);
    expect(balances.find((account) => account.kind === 'supplier_earnings_available')?.amountMicros).toBe(100_000_000n);
    expect(balances.find((account) => account.kind === 'payout_frozen')?.amountMicros).toBe(0n);
    await database.close();
  });
});
