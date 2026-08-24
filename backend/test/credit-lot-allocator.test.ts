import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountPrincipal } from '../src/account/types.js';
import { CreditLotAllocator, PostgresCreditBalanceSnapshotReader } from '../src/credits/lot-allocator.js';
import { CreditLotExpiryWorker, PostgresCreditLotExpiryStore } from '../src/credits/lot-expiry-worker.js';
import { CreditLedgerService } from '../src/credits/service.js';
import { PostgresCreditLedgerStore } from '../src/credits/store.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../src/credits/types.js';
import type { Database } from '../src/database.js';
import type { RuntimeConfig } from '../src/config.js';
import { migrationManifest } from '../src/schema.js';
import type { SubjectAccess } from '../src/subjects/types.js';
import { PostgresQixiangTopupStore } from '../src/topups/qixiang-store.js';
import { PostgresSettlementFeeStore } from '../src/settlement-fees/store.js';
import { PostgresTopupReversalStore } from '../src/topups/reversal-store.js';
import { TopupReversalService } from '../src/topups/reversal-service.js';
import { PostgresQixiangRefundStore } from '../src/topups/qixiang-refund-store.js';

function result<T>(value: Results<T>) {
  return { ...value, rowCount: value.rows.length || value.affectedRows || 0,
    command: '', oid: 0, rowAsArray: false };
}
function adapter(pglite: PGlite): Database {
  return { health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) =>
      result(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(
      async (transaction: Transaction) => work({ query: async (text: string, values?: unknown[]) =>
        result(await transaction.query(text, values)) } as unknown as PoolClient)),
    close: () => pglite.close() } as unknown as Database;
}
const databases: PGlite[] = [];
afterEach(async () => { while (databases.length) await databases.pop()!.close(); });

async function fixture() {
  const pglite = new PGlite(); databases.push(pglite);
  for (const migration of await migrationManifest()) await pglite.exec(migration.sql);
  const database = adapter(pglite); const ledger = new PostgresCreditLedgerStore(database);
  const userId = randomUUID(); const subjectId = randomUUID();
  const otherUserId = randomUUID(); const otherSubjectId = randomUUID();
  await database.query(`INSERT INTO users(id,email_ciphertext,display_name)VALUES
    ($1,'lot-owner','七相卡时用户'),($2,'lot-other','其他七相用户')`, [userId, otherUserId]);
  await database.query(`INSERT INTO trading_subjects(id,kind,display_name,owner_user_id)VALUES
    ($1,'personal','七相卡时主体',$2),($3,'personal','其他七相主体',$4)`,
  [subjectId, userId, otherSubjectId, otherUserId]);
  const accounts = await ledger.ensureSubjectAccounts(subjectId);
  await ledger.ensureSubjectAccounts(otherSubjectId);
  return { pglite, database, ledger, userId, subjectId, otherUserId, otherSubjectId, accounts };
}

async function grantQixiangLot(f: Awaited<ReturnType<typeof fixture>>, subjectId: string, userId: string,
  succeededAt: Date) {
  const store = new PostgresQixiangTopupStore(f.database);
  const providerReference = `QX${randomUUID().replaceAll('-', '').slice(0, 30).toUpperCase()}`;
  const prepared = await store.prepare({ id: randomUUID(), subjectId, userId,
    idempotencyKey: `lot-create-${randomUUID()}`, payloadDigest: 'a'.repeat(128), providerReference,
    amountCents: 1002, cardHourCents: 1000, creditMicros: 10_000_000n,
    checkoutExpiresAt: new Date(succeededAt.getTime() + 30 * 60_000),
    context: { requestId: `lot-create-${randomUUID()}`, ipHash: 'b'.repeat(64),
      now: new Date(succeededAt.getTime() - 1_000) } });
  if (prepared.status !== 'created') throw new Error('lot topup fixture failed');
  const attempt = (await store.claimQueries({ now: succeededAt,
    staleBefore: new Date(succeededAt.getTime() - 120_000), limit: 100 }))
    .find((candidate) => candidate.topup.id === prepared.topup.id);
  if (!attempt) throw new Error('lot query fixture failed');
  const trade = `TRADE${providerReference}`;
  const paid = await store.recordPaidQuery({ attemptId: attempt.attemptId, claimedAt: attempt.claimedAt,
    topupId: prepared.topup.id, providerTransactionId: trade, apiTradeNo: `API-${trade}`,
    queryPayloadDigest: 'c'.repeat(64), grantPayloadDigest: 'd'.repeat(64), now: succeededAt });
  if (paid.status !== 'succeeded') throw new Error('lot grant fixture failed');
  const lot = await f.database.query<{ id: string; expires_at: Date }>(
    `SELECT id,expires_at FROM kai_credit_lots WHERE source_topup_id=$1`, [prepared.topup.id]);
  return { id: lot.rows[0]!.id, topupId: prepared.topup.id, expiresAt: new Date(lot.rows[0]!.expires_at) };
}

async function addUnrestricted(f: Awaited<ReturnType<typeof fixture>>, amount: bigint) {
  const available = f.accounts.find((account) => account.kind === 'available')!.accountId;
  const posted = await f.ledger.post({ id: randomUUID(), idempotencyOwner: `subject:${f.subjectId}`,
    scope: 'LOT_ALLOCATOR_TEST_UNRESTRICTED', idempotencyKey: `lot-unrestricted-${randomUUID()}`,
    payloadDigest: 'e'.repeat(64), referenceType: 'adjustment', description: '非到期卡时测试入账',
    entries: [{ accountId: available, amountMicros: amount, memo: '非到期卡时' },
      { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: -amount, memo: '发行' }] });
  expect(posted.status).toBe('created');
}

async function addCreditOrderReference(f: Awaited<ReturnType<typeof fixture>>, orderId: string,
  totalMicros: bigint) {
  const resourceId = randomUUID(); const offerId = randomUUID(); const listingId = randomUUID();
  const resourceAuditId = randomUUID(); const priceAuditId = randomUUID();
  await f.database.query(`UPDATE users SET role='operator' WHERE id=ANY($1::uuid[])`,
  [[f.userId, f.otherUserId]]);
  const fees = new PostgresSettlementFeeStore(f.database); const scheduleId = randomUUID();
  await fees.createDraftSchedule({ id: scheduleId, version: `lot-${randomUUID()}`, operatorId: f.userId,
    now: new Date(), requestId: `lot-fee-draft-${randomUUID()}`, payloadDigest: `sha256:${'1'.repeat(64)}`,
    tiers: [{ ordinal: 0, lowerBoundMicros: 0n, upperBoundMicros: null, rateBps: 100 }] });
  await fees.activateSchedule({ scheduleId, operatorId: f.otherUserId, now: new Date(),
    requestId: `lot-fee-active-${randomUUID()}`, payloadDigest: `sha256:${'2'.repeat(64)}` });
  await f.database.query(`INSERT INTO supplier_profiles(id,created_by_user_id,subject_id,legal_name,credit_code,
    contact_name,status)VALUES($1,$2,$1,'七相测试供应商','91310101QIXIANG001','测试','approved')`,
  [f.otherSubjectId, f.otherUserId]);
  await f.database.query(`INSERT INTO compute_assets(id,supplier_id,management_mode,lifecycle_status,
    asset_identity_kind,asset_fingerprint)VALUES($1,$2,'self_managed','active','legacy_resource_id',$3)`,
  [resourceId, f.otherSubjectId, `legacy-resource:${resourceId}`]);
  await f.database.query(`INSERT INTO compute_resources(id,supplier_id,asset_id,kind,product_code,region,specifications,
    capacity_total,capacity_unit,status,verification_digest,verified_at)VALUES($1,$2,$1,'gpu','LOT-TEST','华东',
    '{}',100,'GPU时','verified',$3,now())`, [resourceId, f.otherSubjectId, `sha256:${'7'.repeat(64)}`]);
  await f.database.query(`INSERT INTO offer_templates(id,supplier_id,resource_id,client_request_id,payload_digest,
    submission_version,title,service_mode,native_unit,minimum_quantity,suggested_price_cny_micros,status,
    approved_reference_cny_micros,approved_unit_credit_micros,conversion_cny_micros_per_credit,
    audit_valid_until,submitted_at,approved_at)VALUES($1,$2,$3,$4,$5,1,'七相测试订单','dedicated','GPU时',1,
    1000000,'approved',1000000,1000000,1002000,now()+interval '30 days',now(),now())`,
  [offerId, f.otherSubjectId, resourceId, `lot-offer-${randomUUID()}`, '8'.repeat(64)]);
  for (const audit of [{ id: resourceAuditId, kind: 'resource', reviewer: f.userId },
    { id: priceAuditId, kind: 'price', reviewer: f.otherUserId }]) {
    await f.database.query(`INSERT INTO offer_audit_versions(id,offer_id,submission_version,kind,status,reviewer_id,
      decision_reason,evidence_summary,evidence_digest,decision_digest,approved_reference_cny_micros,
      conversion_cny_micros_per_credit,approved_unit_credit_micros,valid_until,decided_at)
      VALUES($1,$2,1,$3,'approved',$4,'通过','七相lot测试',$5,$6,
        CASE WHEN $3='price' THEN 1000000 ELSE NULL END,CASE WHEN $3='price' THEN 1002000 ELSE NULL END,
        CASE WHEN $3='price' THEN 1000000 ELSE NULL END,now()+interval '30 days',now())`,
    [audit.id, offerId, audit.kind, audit.reviewer, `sha256:${'b'.repeat(64)}`, `${audit.kind}-lot-decision`]);
  }
  await f.database.query(`INSERT INTO credit_market_listings(id,offer_id,resource_id,supplier_id,client_request_id,
    payload_digest,resource_audit_id,price_audit_id,capacity_total,capacity_unit,minimum_quantity,unit_credit_micros,reference_cny_micros,
    conversion_cny_micros_per_credit,starts_at,expires_at,audit_snapshot,published_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,100,'GPU时',1,1000000,1000000,1002000,now()-interval '1 day',
      now()+interval '30 days','{}',$9)`,
  [listingId, offerId, resourceId, f.otherSubjectId, `lot-listing-${randomUUID()}`, '9'.repeat(64),
    resourceAuditId, priceAuditId, f.otherUserId]);
  await f.database.query(`INSERT INTO kai_credit_orders(id,order_number,buyer_subject_id,supplier_subject_id,
    created_by_user_id,listing_id,client_request_id,payload_digest,status,quantity,capacity_unit,
    unit_credit_micros,total_credit_micros,listing_snapshot,reservation_expires_at,confirmed_at,confirmed_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'acceptance_pending',$9,'GPU时',1000000,$10,'{}',
      now()+interval '1 day',now(),$5)`,
  [orderId, `LOT-ORDER-${randomUUID().replaceAll('-', '').slice(0, 18)}`, f.subjectId, f.otherSubjectId,
    f.userId, listingId, `lot-order-${randomUUID()}`, 'a'.repeat(64), (totalMicros / 1_000_000n).toString(),
    totalMicros.toString()]);
  return { supplierSubjectId: f.otherSubjectId };
}

describe('shared Qixiang credit-lot allocator', () => {
  it('reports unexpired, expired-pending-sweep and unrestricted balances without double counting',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const allocator = new CreditLotAllocator();
      const oldSuccess = new Date('2026-01-01T00:00:00.000Z');
      const futureSuccess = new Date('2026-08-01T00:00:00.000Z');
      await grantQixiangLot(f, f.subjectId, f.userId, oldSuccess);
      const firstFuture = await grantQixiangLot(f, f.subjectId, f.userId, futureSuccess);
      await grantQixiangLot(f, f.subjectId, f.userId, futureSuccess);
      await grantQixiangLot(f, f.otherSubjectId, f.otherUserId, futureSuccess);
      await addUnrestricted(f, 5_000_000n);
      const now = new Date('2027-01-15T00:00:00.000Z');
      const snapshot = await f.database.transaction((client) => allocator.snapshot(client, f.subjectId, now));
      expect(snapshot).toEqual({ ledgerAvailableMicros: 35_000_000n, allLotAvailableMicros: 30_000_000n,
        unexpiredLotAvailableMicros: 20_000_000n, expiredPendingSweepMicros: 10_000_000n,
        unrestrictedAvailableMicros: 5_000_000n, nearestExpiry: firstFuture.expiresAt });

      const subjects = { current: async () => ({ subjectId: f.subjectId, userId: f.userId,
        kind: 'personal', displayName: '七相卡时主体', subjectStatus: 'active', role: 'owner',
        permissions: ['credits.read'] }) } as unknown as SubjectAccess;
      const service = new CreditLedgerService(f.ledger, subjects,
        new PostgresCreditBalanceSnapshotReader(f.database), () => now);
      const principal: AccountPrincipal = { userId: f.userId, sessionId: 'lot-session', role: 'member' };
      const wire = await service.balance(principal);
      expect(wire).toMatchObject({ available: '35.00', unrestrictedAvailable: '5.00',
        purchasedExpiring: '20.00', nearestExpiry: firstFuture.expiresAt.toISOString(), total: '35.00' });
    });

  it('returns one atomic old-or-new balance snapshot when a Qixiang grant races the read',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const now = new Date('2026-08-21T08:00:00.000Z');
      const subjects = { current: async () => ({ subjectId: f.subjectId, userId: f.userId,
        kind: 'personal', displayName: '七相卡时主体', subjectStatus: 'active', role: 'owner',
        permissions: ['credits.read'] }) } as unknown as SubjectAccess;
      let locked!: () => void; let release!: () => void;
      const locksHeld = new Promise<void>((resolve) => { locked = resolve; });
      const continueRead = new Promise<void>((resolve) => { release = resolve; });
      const reader = new PostgresCreditBalanceSnapshotReader(f.database, async () => {
        locked(); await continueRead;
      });
      const service = new CreditLedgerService(f.ledger, subjects, reader, () => now);
      const principal: AccountPrincipal = { userId: f.userId, sessionId: 'lot-race', role: 'member' };
      const balancePromise = service.balance(principal); await locksHeld;
      let grantFinished = false;
      const grantPromise = grantQixiangLot(f, f.subjectId, f.userId, new Date(now.getTime() + 1_000))
        .then((value) => { grantFinished = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(grantFinished).toBe(false);
      release();
      const oldSnapshot = await balancePromise;
      expect(oldSnapshot).toMatchObject({ available: '0.00', reserved: '0.00', total: '0.00',
        unrestrictedAvailable: '0.00', purchasedExpiring: '0.00', nearestExpiry: null });
      await grantPromise;
      const current = await new CreditLedgerService(f.ledger, subjects,
        new PostgresCreditBalanceSnapshotReader(f.database), () => new Date(now.getTime() + 2_000))
        .balance(principal);
      expect(current).toMatchObject({ available: '10.00', reserved: '0.00', total: '10.00',
        unrestrictedAvailable: '0.00', purchasedExpiring: '10.00' });
      expect(BigInt(current.available.replace('.', ''))).toBe(
        BigInt(current.unrestrictedAvailable.replace('.', '')) + BigInt(current.purchasedExpiring.replace('.', '')));
    });

  it('atomically reserves FEFO lots then unrestricted value, supports exact replay, and leaves insufficiency zero-write',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const allocator = new CreditLotAllocator();
      const oldSuccess = new Date('2026-01-01T00:00:00.000Z');
      const futureSuccess = new Date('2026-08-01T00:00:00.000Z');
      await grantQixiangLot(f, f.subjectId, f.userId, oldSuccess);
      const futureLots = [await grantQixiangLot(f, f.subjectId, f.userId, futureSuccess),
        await grantQixiangLot(f, f.subjectId, f.userId, futureSuccess)].sort((left, right) =>
        left.id.localeCompare(right.id));
      await addUnrestricted(f, 5_000_000n);
      const now = new Date('2027-01-15T00:00:00.000Z'); const referenceId = randomUUID();
      await addCreditOrderReference(f, referenceId, 22_000_000n);
      const input = { subjectId: f.subjectId, referenceType: 'credit_order' as const,
        referenceId, scope: 'CREDIT_ORDER_RESERVE' as const, amountMicros: 22_000_000n,
        serviceEndsAt: futureLots[0]!.expiresAt, now, transactionId: randomUUID(),
        idempotencyOwner: `subject:${f.subjectId}`, idempotencyKey: `lot-reserve-${randomUUID()}`,
        payloadDigest: 'f'.repeat(128) };
      const created = await f.database.transaction((client) => allocator.reserveExpiringFefo(client, input));
      expect(created).toMatchObject({ status: 'created', transactionId: input.transactionId,
        expiringReservedMicros: 20_000_000n, unrestrictedReservedMicros: 2_000_000n });
      if (!('allocations' in created)) throw new Error('reservation fixture failed');
      expect(created.allocations.map((allocation) => allocation.lotId)).toEqual(futureLots.map((lot) => lot.id));
      expect(created.allocations.map((allocation) => allocation.amountMicros)).toEqual([10_000_000n, 10_000_000n]);
      expect(await f.database.transaction((client) => allocator.reserveExpiringFefo(client, input)))
        .toMatchObject({ status: 'replayed', expiringReservedMicros: 20_000_000n,
          unrestrictedReservedMicros: 2_000_000n });
      expect(await f.database.transaction((client) => allocator.reserveExpiringFefo(client,
        { ...input, payloadDigest: '0'.repeat(128) }))).toEqual({ status: 'conflict' });

      const before = (await f.database.query<{ transactions: string; entries: string; allocations: string;
        movements: string }>(`SELECT
        (SELECT count(*)::text FROM kai_credit_transactions)transactions,
        (SELECT count(*)::text FROM kai_credit_entries)entries,
        (SELECT count(*)::text FROM kai_credit_lot_allocations)allocations,
        (SELECT count(*)::text FROM kai_credit_lot_movements)movements`)).rows[0]!;
      const insufficient = await f.database.transaction((client) => allocator.reserveExpiringFefo(client, {
        ...input, referenceId: randomUUID(), transactionId: randomUUID(),
        idempotencyKey: `lot-insufficient-${randomUUID()}`, payloadDigest: '1'.repeat(128), amountMicros: 4_000_000n,
      }));
      expect(insufficient).toEqual({ status: 'expiry_coverage_insufficient' });
      const after = (await f.database.query<typeof before>(`SELECT
        (SELECT count(*)::text FROM kai_credit_transactions)transactions,
        (SELECT count(*)::text FROM kai_credit_entries)entries,
        (SELECT count(*)::text FROM kai_credit_lot_allocations)allocations,
        (SELECT count(*)::text FROM kai_credit_lot_movements)movements`)).rows[0]!;
      expect(after).toEqual(before);
      const snapshot = await f.database.transaction((client) => allocator.snapshot(client, f.subjectId, now));
      expect(snapshot).toMatchObject({ ledgerAvailableMicros: 13_000_000n, allLotAvailableMicros: 10_000_000n,
        unexpiredLotAvailableMicros: 0n, expiredPendingSweepMicros: 10_000_000n,
        unrestrictedAvailableMicros: 3_000_000n, nearestExpiry: null });
    });

  it('refuses to append allocations to a pre-posted transaction and fails closed on a broken ledger/lot invariant',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const allocator = new CreditLotAllocator(); await addUnrestricted(f, 5_000_000n);
      const available = f.accounts.find((account) => account.kind === 'available')!.accountId;
      const reserved = f.accounts.find((account) => account.kind === 'reserved')!.accountId;
      const transactionId = randomUUID(); const referenceId = randomUUID();
      await addCreditOrderReference(f, referenceId, 1_000_000n);
      await f.ledger.post({ id: transactionId, idempotencyOwner: `subject:${f.subjectId}`,
        scope: 'CREDIT_ORDER_RESERVE', idempotencyKey: `pre-posted-${randomUUID()}`,
        payloadDigest: '2'.repeat(128), referenceType: 'order_reservation', referenceId,
        description: '旧过账预留', entries: [{ accountId: available, amountMicros: -1_000_000n, memo: '预留' },
          { accountId: reserved, amountMicros: 1_000_000n, memo: '预留' }] });
      const attempted = await f.database.transaction((client) => allocator.reserveExpiringFefo(client, {
        subjectId: f.subjectId, referenceType: 'credit_order', referenceId, scope: 'CREDIT_ORDER_RESERVE',
        amountMicros: 1_000_000n, serviceEndsAt: new Date('2027-01-15T00:00:00.000Z'),
        now: new Date('2027-01-15T00:00:00.000Z'), transactionId,
        idempotencyOwner: `subject:${f.subjectId}`, idempotencyKey: `different-${randomUUID()}`,
        payloadDigest: '3'.repeat(128),
      }));
      expect(attempted).toEqual({ status: 'conflict' });
      expect((await f.database.query<{ count: string }>(
        `SELECT count(*)::text count FROM kai_credit_lot_allocations`)).rows[0]?.count).toBe('0');

      const responses = [
        { rows: [{ id: randomUUID(), account_kind: 'available' },
          { id: randomUUID(), account_kind: 'reserved' }] },
        { rows: [{ id: randomUUID(), available_micros: '10000000', expires_at: new Date('2028-01-01T00:00:00Z') }] },
        { rows: [{ amount: '5000000' }] },
      ];
      const fake = { query: async () => ({ ...responses.shift()!, rowCount: 1 }) } as unknown as PoolClient;
      await expect(allocator.snapshot(fake, f.subjectId, new Date('2027-01-01T00:00:00Z')))
        .rejects.toThrow('QIXIANG_LOT_BALANCE_INVARIANT');
    });

  it('keeps reserve entry points limited to the audited compute-order stores', async () => {
    const root = new URL('../src/', import.meta.url);
    async function sources(directory: URL): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(entries.map(async (entry) => entry.isDirectory()
        ? sources(new URL(`${entry.name}/`, directory))
        : entry.name.endsWith('.ts') ? [fileURLToPath(new URL(entry.name, directory))] : []));
      return nested.flat();
    }
    const callers: string[] = [];
    for (const path of await sources(root)) {
      if (path.endsWith('/credits/lot-allocator.ts')) continue;
      if ((await readFile(path, 'utf8')).includes('.reserveExpiringFefo(')) callers.push(path);
    }
    expect(callers.map((path) => path.slice(path.lastIndexOf('/src/'))).sort()).toEqual([
      '/src/credit-orders/store.ts', '/src/vast-market/store.ts',
    ]);
  });

  it('sweeps an expired available lot exactly once and posts the matching ledger write',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const lot = await grantQixiangLot(f, f.subjectId, f.userId,
        new Date('2026-01-01T00:00:00.000Z'));
      const store = new PostgresCreditLotExpiryStore(f.database);
      const now = new Date('2027-01-01T00:00:00.000Z');
      expect(await store.sweep(now, 100)).toBe(1);
      expect(await store.sweep(now, 100)).toBe(0);
      const state = await f.database.query<{ available_micros: string; expired_micros: string }>(
        `SELECT available_micros::text,expired_micros::text FROM kai_credit_lots WHERE id=$1`, [lot.id]);
      expect(state.rows[0]).toEqual({ available_micros: '0', expired_micros: '10000000' });
      const snapshot = await new PostgresCreditBalanceSnapshotReader(f.database).snapshot(f.subjectId, now);
      expect(snapshot.lots).toMatchObject({ allLotAvailableMicros: 0n, expiredPendingSweepMicros: 0n });
      expect(snapshot.accounts.find((account) => account.kind === 'available')?.amountMicros).toBe(0n);
    });

  it('blocks new paid grants after three expiry sweeper failures and recovers after a successful heartbeat',async()=>{
    const sweep=vi.fn().mockRejectedValueOnce(new Error('failure-1')).mockRejectedValueOnce(new Error('failure-2'))
      .mockRejectedValueOnce(new Error('failure-3')).mockResolvedValue(0);
    const logger={info:vi.fn(),error:vi.fn()};const now=new Date('2026-08-02T00:00:00.000Z');
    const worker=new CreditLotExpiryWorker({sweep} as unknown as PostgresCreditLotExpiryStore,logger,60_000,()=>now);
    expect(worker.health().ready).toBe(true);
    await worker.runOnce();await worker.runOnce();expect(worker.health().ready).toBe(true);
    await worker.runOnce();expect(worker.health()).toMatchObject({ready:false,consecutiveFailures:3});
    await worker.runOnce();expect(worker.health()).toMatchObject({ready:true,consecutiveFailures:0,
      lastSuccessAt:now.toISOString()});
  });

  it('runs Qixiang full-refund dual control from hold through provider confirmation and final card-hour burn',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); await f.database.query(`UPDATE users SET role='operator' WHERE id=ANY($1::uuid[])`,
        [[f.userId, f.otherUserId]]);
      const granted = await grantQixiangLot(f, f.subjectId, f.userId, new Date('2026-08-01T00:00:00.000Z'));
      const refunds = new PostgresQixiangRefundStore(f.database); const refundId = randomUUID();
      const requested = await refunds.request({ id: refundId, topupId: granted.topupId, operatorId: f.userId,
        reasonCode: 'customer_request', evidenceDigest: '1'.repeat(64), idempotencyKey: 'qixiang-refund-request-001',
        payloadDigest: '2'.repeat(64), now: new Date('2026-08-02T00:00:00.000Z') });
      expect(requested).toMatchObject({ status: 'created', refund: { status: 'requested' } });
      expect(await refunds.approve({ refundId, operatorId: f.userId, evidenceDigest: '3'.repeat(64),
        idempotencyKey: 'qixiang-refund-same-operator', payloadDigest: '4'.repeat(64),
        now: new Date('2026-08-02T00:01:00.000Z') })).toEqual({ status: 'same_operator' });
      expect(await refunds.approve({ refundId, operatorId: f.otherUserId, evidenceDigest: '5'.repeat(64),
        idempotencyKey: 'qixiang-refund-approve-001', payloadDigest: '6'.repeat(64),
        now: new Date('2026-08-02T00:02:00.000Z') })).toMatchObject({ status: 'updated', refund: { status: 'approved' } });
      const providerCallId = randomUUID();
      expect(await refunds.beginSubmit({ refundId, operatorId: f.otherUserId, providerCallId,
        idempotencyKey: 'qixiang-refund-submit-0001', payloadDigest: '7'.repeat(64),
        now: new Date('2026-08-02T00:03:00.000Z') })).toMatchObject({ refund: { status: 'provider_pending' } });
      expect(await refunds.manualTakeover({ refundId, operatorId: f.otherUserId,evidenceDigest:'8'.repeat(64),
        idempotencyKey:'qixiang-refund-takeover-early',payloadDigest:'9'.repeat(64),
        staleBefore:new Date('2026-08-02T00:02:59.000Z'),now:new Date('2026-08-02T00:04:00.000Z') }))
        .toEqual({status:'invalid_state'});
      expect(await refunds.manualTakeover({ refundId, operatorId: f.otherUserId,evidenceDigest:'a'.repeat(64),
        idempotencyKey:'qixiang-refund-takeover-001',payloadDigest:'b'.repeat(64),
        staleBefore:new Date('2026-08-02T00:03:00.000Z'),now:new Date('2026-08-02T00:05:00.000Z') }))
        .toMatchObject({status:'updated',refund:{status:'manual_review'}});
      expect(await refunds.confirm({ refundId, operatorId: f.otherUserId, evidenceDigest: '9'.repeat(64),
        idempotencyKey: 'qixiang-refund-confirm-001', payloadDigest: 'a'.repeat(64),
        now: new Date('2026-08-02T00:06:00.000Z') })).toMatchObject({ refund: { status: 'confirmed' } });
      const lot = await f.database.query<{ refund_pending_micros: string; refunded_micros: string }>(
        `SELECT refund_pending_micros::text,refunded_micros::text FROM kai_credit_lots WHERE id=$1`, [granted.id]);
      expect(lot.rows[0]).toEqual({ refund_pending_micros: '0', refunded_micros: '10000000' });
      const topup = await f.database.query<{ reversed_amount_cents: string; reversed_credit_micros: string }>(
        `SELECT reversed_amount_cents::text,reversed_credit_micros::text FROM kai_credit_topups WHERE id=$1`,[granted.topupId]);
      expect(topup.rows[0]).toEqual({ reversed_amount_cents: '1002', reversed_credit_micros: '10000000' });
    });

  it('atomically resolves a mixed reservation and restores consumed lots in reverse order',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const allocator = new CreditLotAllocator();
      const succeededAt = new Date('2026-08-01T00:00:00.000Z');
      const lots = [await grantQixiangLot(f, f.subjectId, f.userId, succeededAt),
        await grantQixiangLot(f, f.subjectId, f.userId, succeededAt)].sort((left, right) =>
        left.id.localeCompare(right.id));
      await addUnrestricted(f, 5_000_000n);
      const now = new Date('2027-01-01T00:00:00.000Z'); const referenceId = randomUUID();
      await addCreditOrderReference(f, referenceId, 22_000_000n);
      const reservation = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        scope: 'CREDIT_ORDER_RESERVE' as const, amountMicros: 22_000_000n,
        serviceEndsAt: lots[0]!.expiresAt, now, transactionId: randomUUID(),
        idempotencyOwner: `subject:${f.subjectId}`, idempotencyKey: `lot-mixed-reserve-${randomUUID()}`,
        payloadDigest: '4'.repeat(128) };
      expect(await f.database.transaction((client) => allocator.reserveExpiringFefo(client, reservation)))
        .toMatchObject({ status: 'created', expiringReservedMicros: 20_000_000n,
          unrestrictedReservedMicros: 2_000_000n });
      const supplierReceivable = (await f.ledger.ensureSubjectAccounts(f.otherSubjectId))
        .find((account) => account.kind === 'supplier_receivable')!.accountId;
      const resolve = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        reservationTransactionId: reservation.transactionId,
        totalReservedMicros: 22_000_000n, capturedMicros: 22_000_000n, now,
        transactionId: randomUUID(), scope: 'CREDIT_ORDER_CAPTURE' as const,
        ledgerReferenceType: 'order_capture' as const, idempotencyOwner: `subject:${f.subjectId}`,
        idempotencyKey: `lot-mixed-capture-${randomUUID()}`, payloadDigest: '5'.repeat(128),
        counterpartEntries: [{ accountId: supplierReceivable, amountMicros: 22_000_000n, memo: '提供方待结算' }] };
      expect(await f.database.transaction((client) => allocator.resolveReservation(client, resolve)))
        .toEqual({ status: 'created', transactionId: resolve.transactionId, lotConsumedMicros: 20_000_000n,
          unrestrictedConsumedMicros: 2_000_000n, lotReleasedAvailableMicros: 0n,
          lotReleasedExpiredMicros: 0n, unrestrictedReleasedMicros: 0n });
      expect(await f.database.transaction((client) => allocator.resolveReservation(client, resolve)))
        .toMatchObject({ status: 'replayed', transactionId: resolve.transactionId });

      const restore = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        captureTransactionId: resolve.transactionId,
        capturedMicros: 22_000_000n, previouslyRefundedMicros: 0n, refundMicros: 7_000_000n, now,
        transactionId: randomUUID(), scope: 'CREDIT_ORDER_POST_ACCEPT_REFUND' as const,
        ledgerReferenceType: 'refund' as const, idempotencyOwner: `subject:${f.subjectId}`,
        idempotencyKey: `lot-mixed-restore-${randomUUID()}`, payloadDigest: '6'.repeat(128),
        counterpartEntries: [{ accountId: supplierReceivable, amountMicros: -7_000_000n, memo: '提供方退款' }] };
      expect(await f.database.transaction((client) => allocator.restoreConsumed(client, restore)))
        .toEqual({ status: 'created', transactionId: restore.transactionId, unrestrictedRestoredMicros: 2_000_000n,
          lotRestoredAvailableMicros: 5_000_000n, lotRestoredExpiredMicros: 0n });
      expect(await f.database.transaction((client) => allocator.restoreConsumed(client, restore)))
        .toMatchObject({ status: 'replayed', transactionId: restore.transactionId });
      const state = await f.database.query<{ available: string; reserved: string; consumed: string;
        restored: string }>(`SELECT sum(l.available_micros)::text available,sum(l.reserved_micros)::text reserved,
          sum(l.consumed_micros)::text consumed,sum(a.restored_micros)::text restored FROM kai_credit_lots l
          JOIN kai_credit_lot_allocations a ON a.lot_id=l.id WHERE a.reference_id=$1`, [referenceId]);
      expect(state.rows[0]).toEqual({ available: '5000000', reserved: '0', consumed: '15000000', restored: '5000000' });
    });

  it('consumes by expiry despite opposite UUID order and restores latest consumption to expired at the exact boundary',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const allocator = new CreditLotAllocator();
      const sequence: Array<{ id: string; expiresAt: Date }> = [];
      let invertedAt = -1;
      for (let day = 1; day <= 12 && invertedAt < 0; day += 1) {
        sequence.push(await grantQixiangLot(f, f.subjectId, f.userId,
          new Date(`2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`)));
        if (sequence.length > 1 && sequence.at(-1)!.id.localeCompare(sequence.at(-2)!.id) < 0) {
          invertedAt = sequence.length - 2;
        }
      }
      expect(invertedAt).toBeGreaterThanOrEqual(0);
      const early = sequence[invertedAt]!; const selectedLate = sequence[invertedAt + 1]!;
      expect(selectedLate.id.localeCompare(early.id)).toBeLessThan(0);
      const referenceId = randomUUID(); await addCreditOrderReference(f, referenceId, 15_000_000n);
      const reserve = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        scope: 'CREDIT_ORDER_RESERVE' as const, amountMicros: 15_000_000n, serviceEndsAt: early.expiresAt,
        now: new Date('2027-01-01T00:00:00.000Z'), transactionId: randomUUID(),
        idempotencyOwner: `subject:${f.subjectId}`, idempotencyKey: `lot-ordering-reserve-${randomUUID()}`,
        payloadDigest: '1'.repeat(128) };
      expect(await f.database.transaction((client) => allocator.reserveExpiringFefo(client, reserve)))
        .toMatchObject({ status: 'created', expiringReservedMicros: 15_000_000n });
      const supplierReceivable = (await f.ledger.ensureSubjectAccounts(f.otherSubjectId))
        .find((account) => account.kind === 'supplier_receivable')!.accountId;
      const resolve = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        reservationTransactionId: reserve.transactionId, totalReservedMicros: 15_000_000n,
        capturedMicros: 15_000_000n, now: reserve.now, transactionId: randomUUID(),
        scope: 'CREDIT_ORDER_CAPTURE' as const, ledgerReferenceType: 'order_capture' as const,
        idempotencyOwner: `subject:${f.subjectId}`, idempotencyKey: `lot-ordering-capture-${randomUUID()}`,
        payloadDigest: '2'.repeat(128),
        counterpartEntries: [{ accountId: supplierReceivable, amountMicros: 15_000_000n, memo: '提供方待结算' }] };
      expect(await f.database.transaction((client) => allocator.resolveReservation(client, resolve)))
        .toMatchObject({ status: 'created', lotConsumedMicros: 15_000_000n });
      const consumed = await f.database.query<{ lot_id: string; consumed_micros: string }>(
        `SELECT lot_id,consumed_micros::text FROM kai_credit_lot_allocations WHERE reference_id=$1`, [referenceId]);
      expect(consumed.rows.find((row) => row.lot_id === early.id)?.consumed_micros).toBe('10000000');
      expect(consumed.rows.find((row) => row.lot_id === selectedLate.id)?.consumed_micros).toBe('5000000');

      const restore = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        captureTransactionId: resolve.transactionId, capturedMicros: 15_000_000n, previouslyRefundedMicros: 0n,
        refundMicros: 5_000_000n, now: selectedLate.expiresAt, transactionId: randomUUID(),
        scope: 'CREDIT_ORDER_POST_ACCEPT_REFUND' as const, ledgerReferenceType: 'refund' as const,
        idempotencyOwner: `subject:${f.subjectId}`, idempotencyKey: `lot-ordering-restore-${randomUUID()}`,
        payloadDigest: '3'.repeat(128),
        counterpartEntries: [{ accountId: supplierReceivable, amountMicros: -5_000_000n, memo: '提供方退款' }] };
      expect(await f.database.transaction((client) => allocator.restoreConsumed(client, restore)))
        .toEqual({ status: 'created', transactionId: restore.transactionId, unrestrictedRestoredMicros: 0n,
          lotRestoredAvailableMicros: 0n, lotRestoredExpiredMicros: 5_000_000n });
      const restored = await f.database.query<{ lot_id: string; restored_micros: string }>(
        `SELECT lot_id,restored_micros::text FROM kai_credit_lot_allocations WHERE reference_id=$1`, [referenceId]);
      expect(restored.rows.find((row) => row.lot_id === selectedLate.id)?.restored_micros).toBe('5000000');
      expect(restored.rows.find((row) => row.lot_id === early.id)?.restored_micros).toBe('0');
    });

  it('binds resolution to the original reserve transaction and rejects tampered totals or idempotency payloads',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const allocator = new CreditLotAllocator(); await addUnrestricted(f, 5_000_000n);
      const referenceId = randomUUID(); await addCreditOrderReference(f, referenceId, 5_000_000n);
      const reserve = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        scope: 'CREDIT_ORDER_RESERVE' as const, amountMicros: 5_000_000n,
        serviceEndsAt: new Date('2027-01-02T00:00:00.000Z'), now: new Date('2027-01-01T00:00:00.000Z'),
        transactionId: randomUUID(), idempotencyOwner: `subject:${f.subjectId}`,
        idempotencyKey: `lot-authority-reserve-${randomUUID()}`, payloadDigest: '4'.repeat(128) };
      await f.database.transaction((client) => allocator.reserveExpiringFefo(client, reserve));
      const base = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        reservationTransactionId: reserve.transactionId, totalReservedMicros: 5_000_000n, capturedMicros: 0n,
        now: reserve.now, transactionId: randomUUID(), scope: 'CREDIT_ORDER_RELEASE' as const,
        ledgerReferenceType: 'order_release' as const, idempotencyOwner: `subject:${f.subjectId}`,
        idempotencyKey: `lot-authority-release-${randomUUID()}`, payloadDigest: '5'.repeat(128), counterpartEntries: [] };
      expect(await f.database.transaction((client) => allocator.resolveReservation(client,
        { ...base, totalReservedMicros: 4_000_000n }))).toEqual({ status: 'conflict' });
      await expect(f.database.transaction((client) => allocator.resolveReservation(client,
        { ...base, reservationTransactionId: randomUUID() })))
        .rejects.toThrow('QIXIANG_LOT_RESERVATION_AUTHORITY_INVALID');
      expect(await f.database.transaction((client) => allocator.resolveReservation(client, base)))
        .toMatchObject({ status: 'created', unrestrictedReleasedMicros: 5_000_000n });
      expect(await f.database.transaction((client) => allocator.resolveReservation(client,
        { ...base, payloadDigest: '6'.repeat(128) }))).toEqual({ status: 'conflict' });
    });

  it('derives cumulative unrestricted refunds from posted history and rejects stale or conflicting retries',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const allocator = new CreditLotAllocator(); await addUnrestricted(f, 10_000_000n);
      const referenceId = randomUUID(); await addCreditOrderReference(f, referenceId, 10_000_000n);
      const reserve = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        scope: 'CREDIT_ORDER_RESERVE' as const, amountMicros: 10_000_000n,
        serviceEndsAt: new Date('2027-01-02T00:00:00.000Z'), now: new Date('2027-01-01T00:00:00.000Z'),
        transactionId: randomUUID(), idempotencyOwner: `subject:${f.subjectId}`,
        idempotencyKey: `lot-refund-reserve-${randomUUID()}`, payloadDigest: '7'.repeat(128) };
      await f.database.transaction((client) => allocator.reserveExpiringFefo(client, reserve));
      const supplierReceivable = (await f.ledger.ensureSubjectAccounts(f.otherSubjectId))
        .find((account) => account.kind === 'supplier_receivable')!.accountId;
      const capture = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        reservationTransactionId: reserve.transactionId, totalReservedMicros: 10_000_000n,
        capturedMicros: 10_000_000n, now: reserve.now, transactionId: randomUUID(),
        scope: 'CREDIT_ORDER_CAPTURE' as const, ledgerReferenceType: 'order_capture' as const,
        idempotencyOwner: `subject:${f.subjectId}`, idempotencyKey: `lot-refund-capture-${randomUUID()}`,
        payloadDigest: '8'.repeat(128),
        counterpartEntries: [{ accountId: supplierReceivable, amountMicros: 10_000_000n, memo: '提供方待结算' }] };
      await f.database.transaction((client) => allocator.resolveReservation(client, capture));
      const first = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        captureTransactionId: capture.transactionId, capturedMicros: 10_000_000n, previouslyRefundedMicros: 0n,
        refundMicros: 3_000_000n, now: reserve.now, transactionId: randomUUID(),
        scope: 'CREDIT_ORDER_POST_ACCEPT_REFUND' as const, ledgerReferenceType: 'refund' as const,
        idempotencyOwner: `subject:${f.subjectId}`, idempotencyKey: `lot-refund-first-${randomUUID()}`,
        payloadDigest: '9'.repeat(128),
        counterpartEntries: [{ accountId: supplierReceivable, amountMicros: -3_000_000n, memo: '提供方退款' }] };
      expect(await f.database.transaction((client) => allocator.restoreConsumed(client, first)))
        .toMatchObject({ status: 'created', unrestrictedRestoredMicros: 3_000_000n });
      expect(await f.database.transaction((client) => allocator.restoreConsumed(client,
        { ...first, payloadDigest: 'a'.repeat(128) }))).toEqual({ status: 'conflict' });
      const second = { ...first, previouslyRefundedMicros: 0n, refundMicros: 2_000_000n,
        transactionId: randomUUID(), idempotencyKey: `lot-refund-stale-${randomUUID()}`,
        payloadDigest: 'b'.repeat(128),
        counterpartEntries: [{ accountId: supplierReceivable, amountMicros: -2_000_000n, memo: '提供方退款' }] };
      expect(await f.database.transaction((client) => allocator.restoreConsumed(client, second)))
        .toEqual({ status: 'conflict' });
      expect(await f.database.transaction((client) => allocator.restoreConsumed(client,
        { ...second, previouslyRefundedMicros: 3_000_000n })))
        .toMatchObject({ status: 'created', unrestrictedRestoredMicros: 2_000_000n });
      const transactions = await f.database.query<{ count: string }>(`SELECT count(*)::text count
        FROM kai_credit_transactions WHERE reference_id=$1 AND scope LIKE 'CREDIT_ORDER_POST_ACCEPT_%'`, [referenceId]);
      expect(transactions.rows[0]?.count).toBe('2');
    });

  it('rejects unrestricted-only known-scope wrong counterparts and missing reservation authority',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const allocator = new CreditLotAllocator(); await addUnrestricted(f, 5_000_000n);
      const referenceId = randomUUID(); await addCreditOrderReference(f, referenceId, 5_000_000n);
      const reserve = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        scope: 'CREDIT_ORDER_RESERVE' as const, amountMicros: 5_000_000n,
        serviceEndsAt: new Date('2027-01-02T00:00:00.000Z'), now: new Date('2027-01-01T00:00:00.000Z'),
        transactionId: randomUUID(), idempotencyOwner: `subject:${f.subjectId}`,
        idempotencyKey: `lot-known-reserve-${randomUUID()}`, payloadDigest: 'c'.repeat(128) };
      await f.database.transaction((client) => allocator.reserveExpiringFefo(client, reserve));
      const available = f.accounts.find((account) => account.kind === 'available')!.accountId;
      const reserved = f.accounts.find((account) => account.kind === 'reserved')!.accountId;
      await expect(f.ledger.post({ id: randomUUID(), idempotencyOwner: `subject:${f.subjectId}`,
        scope: 'CREDIT_ORDER_CAPTURE', idempotencyKey: `lot-known-bad-capture-${randomUUID()}`,
        payloadDigest: 'd'.repeat(64), referenceType: 'order_capture', referenceId,
        description: '错误对手方', entries: [
          { accountId: reserved, amountMicros: -5_000_000n, memo: '扣预留' },
          { accountId: available, amountMicros: 5_000_000n, memo: '错误回自己' },
        ] })).rejects.toThrow('QIXIANG_LOT_LEDGER_CAPTURE_COUNTERPART');
      const resolve = { subjectId: f.subjectId, referenceType: 'credit_order' as const, referenceId,
        reservationTransactionId: randomUUID(), totalReservedMicros: 5_000_000n, capturedMicros: 0n,
        now: reserve.now, transactionId: randomUUID(), scope: 'CREDIT_ORDER_RELEASE' as const,
        ledgerReferenceType: 'order_release' as const, idempotencyOwner: `subject:${f.subjectId}`,
        idempotencyKey: `lot-known-missing-reserve-${randomUUID()}`, payloadDigest: 'e'.repeat(128),
        counterpartEntries: [] };
      await expect(f.database.transaction((client) => allocator.resolveReservation(client, resolve)))
        .rejects.toThrow('QIXIANG_LOT_RESERVATION_AUTHORITY_INVALID');
    });

  it('allows unknown-scope debits only inside unrestricted available and rejects invasion of lot backing',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); await grantQixiangLot(f, f.subjectId, f.userId,
        new Date('2026-08-21T08:00:00.000Z')); await addUnrestricted(f, 5_000_000n);
      const available = f.accounts.find((account) => account.kind === 'available')!.accountId;
      expect(await f.ledger.post({ id: randomUUID(), idempotencyOwner: `subject:${f.subjectId}`,
        scope: 'UNKNOWN_UNRESTRICTED_DEBIT', idempotencyKey: `unknown-safe-${randomUUID()}`,
        payloadDigest: '7'.repeat(64), referenceType: 'adjustment', description: '仅扣非到期余额',
        entries: [{ accountId: available, amountMicros: -5_000_000n, memo: '安全扣减' },
          { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: 5_000_000n, memo: '安全扣减' }] }))
        .toMatchObject({ status: 'created' });
      await expect(f.ledger.post({ id: randomUUID(), idempotencyOwner: `subject:${f.subjectId}`,
        scope: 'UNKNOWN_LOT_INVASION', idempotencyKey: `unknown-reject-${randomUUID()}`,
        payloadDigest: '8'.repeat(64), referenceType: 'adjustment', description: '非法侵入到期余额',
        entries: [{ accountId: available, amountMicros: -10_000n, memo: '非法扣减' },
          { accountId: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance, amountMicros: 10_000n, memo: '非法扣减' }] }))
        .rejects.toThrow('QIXIANG_LOT_LEDGER_BUCKET_IMBALANCE');
    });

  it('rejects a Qixiang topup from the legacy reversal path before any economic or evidence write',
    { timeout: 30_000 }, async () => {
      const f = await fixture(); const succeeded = await grantQixiangLot(f, f.subjectId, f.userId,
        new Date('2026-08-21T08:00:00.000Z'));
      const topup = await f.database.query<{ id: string }>(
        `SELECT source_topup_id id FROM kai_credit_lots WHERE id=$1`, [succeeded.id]);
      const before = (await f.database.query<{ reversals: string; idempotency: string; audit: string;
        outbox: string; transactions: string; entries: string; lots: string; movements: string }>(`SELECT
        (SELECT count(*)::text FROM kai_credit_topup_reversals)reversals,
        (SELECT count(*)::text FROM idempotency_records)idempotency,
        (SELECT count(*)::text FROM audit_events)audit,
        (SELECT count(*)::text FROM outbox_events)outbox,
        (SELECT count(*)::text FROM kai_credit_transactions)transactions,
        (SELECT count(*)::text FROM kai_credit_entries)entries,
        (SELECT count(*)::text FROM kai_credit_lots)lots,
        (SELECT count(*)::text FROM kai_credit_lot_movements)movements`)).rows[0]!;
      const service = new TopupReversalService(new PostgresTopupReversalStore(f.database),
        { AUDIT_PEPPER: 'qixiang-reversal-test-pepper' } as RuntimeConfig,
        () => new Date('2026-08-21T08:01:00.000Z'));
      await expect(service.request({ userId: randomUUID(), sessionId: 'operator-session', role: 'operator' },
        topup.rows[0]!.id, { kind: 'refund', amountCents: 1002,
          providerEventReference: 'QIXIANG-LEGACY-REFUND-BLOCKED', evidenceDigest: 'a'.repeat(64),
          idempotencyKey: `qixiang-reversal-${randomUUID()}` }))
        .rejects.toMatchObject({ code: 'QIXIANG_REFUND_WORKFLOW_REQUIRED', statusCode: 409,
          message: '该充值必须使用七相退款双审流程。' });
      const after = (await f.database.query<typeof before>(`SELECT
        (SELECT count(*)::text FROM kai_credit_topup_reversals)reversals,
        (SELECT count(*)::text FROM idempotency_records)idempotency,
        (SELECT count(*)::text FROM audit_events)audit,
        (SELECT count(*)::text FROM outbox_events)outbox,
        (SELECT count(*)::text FROM kai_credit_transactions)transactions,
        (SELECT count(*)::text FROM kai_credit_entries)entries,
        (SELECT count(*)::text FROM kai_credit_lots)lots,
        (SELECT count(*)::text FROM kai_credit_lot_movements)movements`)).rows[0]!;
      expect(after).toEqual(before);
    });
});
