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
});
