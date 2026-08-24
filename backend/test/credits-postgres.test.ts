import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AccountPrincipal } from '../src/account/types.js';
import { CreditLedgerService } from '../src/credits/service.js';
import { PostgresCreditLedgerStore, type PostCreditTransactionInput } from '../src/credits/store.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../src/credits/types.js';
import type { Database } from '../src/database.js';
import type { SubjectAccess } from '../src/subjects/types.js';

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

async function migrate(pglite: PGlite) {
  for (const name of ['0001_cloudpay_ledger.sql', '0016_trading_subjects.sql', '0022_kai_credit_double_entry_ledger.sql']) {
    await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  }
}

function transaction(input: Partial<PostCreditTransactionInput> & Pick<PostCreditTransactionInput, 'entries'>): PostCreditTransactionInput {
  return {
    id: randomUUID(), idempotencyOwner: 'platform:operations', scope: 'TEST_LEDGER',
    idempotencyKey: `credit-test-${randomUUID()}`, payloadDigest: `sha256:${'a'.repeat(64)}`,
    referenceType: 'adjustment', description: '测试卡时入账', ...input,
  };
}

describe('KAI credit double-entry ledger', () => {
  it('derives balances from immutable balanced entries and isolates the selected subject', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite);
    const userId = randomUUID(); const otherUserId = randomUUID(); const subjectId = randomUUID(); const otherSubjectId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
       ($1, 'credit-owner', '卡时用户', 'member'), ($2, 'other-owner', '其他用户', 'member')`, [userId, otherUserId],
    );
    await database.query(
      `INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES
       ($1, 'personal', '卡时用户', $2), ($3, 'personal', '其他用户', $4)`, [subjectId, userId, otherSubjectId, otherUserId],
    );
    await database.query(
      `INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [subjectId, userId, otherSubjectId, otherUserId],
    );
    const store = new PostgresCreditLedgerStore(database);
    const subjectAccounts = await store.ensureSubjectAccounts(subjectId);
    const otherAccounts = await store.ensureSubjectAccounts(otherSubjectId);
    expect(subjectAccounts).toHaveLength(3);
    expect(otherAccounts).toHaveLength(3);
    expect(new Set([...subjectAccounts, ...otherAccounts].map((account) => account.accountId)).size).toBe(6);
    const availableId = subjectAccounts.find((account) => account.kind === 'available')!.accountId;
    const reservedId = subjectAccounts.find((account) => account.kind === 'reserved')!.accountId;

    const subjects = {
      current: async () => ({ subjectId, userId, kind: 'personal', displayName: '卡时用户', subjectStatus: 'active', role: 'owner', permissions: ['credits.read'] }),
    } as unknown as SubjectAccess;
    const service = new CreditLedgerService(store, subjects, { snapshot: async (selectedSubjectId) => {
      const result = await database.query<{ amount: string }>(`SELECT COALESCE(sum(e.amount_micros)
        FILTER(WHERE t.status='posted'),0)::text amount FROM kai_credit_accounts a
        LEFT JOIN kai_credit_entries e ON e.account_id=a.id LEFT JOIN kai_credit_transactions t
        ON t.id=e.transaction_id WHERE a.subject_id=$1 AND a.account_kind='available' GROUP BY a.id`,
      [selectedSubjectId]);
      const amount = BigInt(result.rows[0]?.amount ?? '0');
      return { accounts: await store.ensureSubjectAccounts(selectedSubjectId), lots: {
        ledgerAvailableMicros: amount, allLotAvailableMicros: 0n,
        unexpiredLotAvailableMicros: 0n, expiredPendingSweepMicros: 0n,
        unrestrictedAvailableMicros: amount, nearestExpiry: null } };
    } });
    const principal: AccountPrincipal = { userId, sessionId: 'credit-session', role: 'member' };
    expect(await service.balance(principal)).toMatchObject({ available: '0.00', reserved: '0.00', total: '0.00' });

    const mint = transaction({
      idempotencyKey: 'credit-topup-test-000001', payloadDigest: `sha256:${'1'.repeat(64)}`, referenceType: 'topup',
      entries: [
        { accountId: availableId, amountMicros: 10_000_000n, memo: '充值到账' },
        { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: -10_000_000n, memo: '卡时发行' },
      ],
    });
    expect(await service.post(mint)).toMatchObject({ status: 'created' });
    expect(await service.post({ ...mint, id: randomUUID() })).toMatchObject({ status: 'replayed', transactionId: mint.id });
    expect(await service.post({ ...mint, id: randomUUID(), payloadDigest: `sha256:${'2'.repeat(64)}` })).toMatchObject({ status: 'conflict' });
    expect(await service.balance(principal)).toMatchObject({ available: '10.00', reserved: '0.00', total: '10.00' });

    const reserve = transaction({ entries: [
      { accountId: availableId, amountMicros: -4_000_000n, memo: '订单预留' },
      { accountId: reservedId, amountMicros: 4_000_000n, memo: '订单预留' },
    ] });
    expect(await service.post(reserve)).toMatchObject({ status: 'created' });
    expect(await service.balance(principal)).toMatchObject({ available: '6.00', reserved: '4.00', total: '10.00' });
    expect((await store.ensureSubjectAccounts(otherSubjectId)).every((account) => account.amountMicros === 0n)).toBe(true);

    await expect(service.post(transaction({ entries: [
      { accountId: availableId, amountMicros: -7_000_000n, memo: '超额预留' },
      { accountId: reservedId, amountMicros: 7_000_000n, memo: '超额预留' },
    ] }))).rejects.toThrow(/cannot become negative/u);
    expect(await service.balance(principal)).toMatchObject({ available: '6.00', reserved: '4.00' });

    await expect(service.post(transaction({ entries: [
      { accountId: availableId, amountMicros: 1_000_000n, memo: '不平分录' },
      { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.clearing, amountMicros: -900_000n, memo: '不平分录' },
    ] }))).rejects.toThrow('KAI_CREDIT_TRANSACTION_UNBALANCED');

    const entry = await database.query<{ id: string }>(
      `SELECT id FROM kai_credit_entries WHERE transaction_id = $1 ORDER BY id LIMIT 1`, [mint.id],
    );
    await expect(database.query(`UPDATE kai_credit_entries SET amount_micros = 1 WHERE id = $1`, [entry.rows[0]!.id]))
      .rejects.toThrow(/immutable/u);
    await expect(database.query(`DELETE FROM kai_credit_entries WHERE id = $1`, [entry.rows[0]!.id]))
      .rejects.toThrow(/immutable/u);
    await expect(database.query(`UPDATE kai_credit_transactions SET description = '篡改' WHERE id = $1`, [mint.id]))
      .rejects.toThrow(/immutable/u);
    await expect(database.query(
      `INSERT INTO kai_credit_transactions(id, idempotency_owner, scope, idempotency_key, payload_digest,
        reference_type, description, status, posted_at)
       VALUES ($1, 'direct:test', 'DIRECT_TEST', 'direct-posted-test-0001', 'digest-direct-posted',
        'adjustment', '跳过过账', 'posted', now())`, [randomUUID()],
    )).rejects.toThrow(/inserted as pending/u);
    await database.close();
  });

  it('allows only one competing reservation when the available balance cannot cover both', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite); const store = new PostgresCreditLedgerStore(database);
    const userId = randomUUID(); const subjectId = randomUUID();
    await database.query(`INSERT INTO users(id, phone_ciphertext, display_name) VALUES ($1, 'concurrent-owner', '并发用户')`, [userId]);
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '并发用户', $2)`, [subjectId, userId]);
    const accounts = await store.ensureSubjectAccounts(subjectId);
    const availableId = accounts.find((account) => account.kind === 'available')!.accountId;
    const reservedId = accounts.find((account) => account.kind === 'reserved')!.accountId;
    await store.post(transaction({ entries: [
      { accountId: availableId, amountMicros: 5_000_000n, memo: '测试入账' },
      { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: -5_000_000n, memo: '测试发行' },
    ] }));
    const attempts = await Promise.allSettled([1, 2].map(() => store.post(transaction({ entries: [
      { accountId: availableId, amountMicros: -4_000_000n, memo: '并发预留' },
      { accountId: reservedId, amountMicros: 4_000_000n, memo: '并发预留' },
    ] }))));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const balances = await store.ensureSubjectAccounts(subjectId);
    expect(balances.find((account) => account.kind === 'available')?.amountMicros).toBe(1_000_000n);
    expect(balances.find((account) => account.kind === 'reserved')?.amountMicros).toBe(4_000_000n);
    await database.close();
  });
});
