import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { isCreditCentAligned } from './precision.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS, type CreditAccountBalance, type SubjectCreditAccountKind } from './types.js';

type AccountRow = QueryResultRow & { id: string; account_kind: 'available' | 'reserved' };
type LotRow = QueryResultRow & { id: string; available_micros: string; expires_at: Date };
type AllocationRow = QueryResultRow & {
  id: string;
  lot_id: string;
  allocated_micros: string;
  reserved_micros: string;
  consumed_micros: string;
  released_micros: string;
  restored_micros: string;
  expires_at: Date;
};
type TransactionRow = QueryResultRow & {
  id: string;
  idempotency_owner: string;
  scope: string;
  idempotency_key: string;
  payload_digest: string;
  reference_type: string;
  reference_id: string | null;
  status: 'pending' | 'posted';
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const idempotencyKey = /^[A-Za-z0-9:_-]{16,120}$/u;
const lowerDigest = /^(?:[0-9a-f]{64}|[0-9a-f]{128})$/u;

export type CreditLotSnapshot = Readonly<{
  ledgerAvailableMicros: bigint;
  allLotAvailableMicros: bigint;
  unexpiredLotAvailableMicros: bigint;
  expiredPendingSweepMicros: bigint;
  unrestrictedAvailableMicros: bigint;
  nearestExpiry: Date | null;
}>;

export type ReserveExpiringFefoInput = Readonly<{
  subjectId: string;
  referenceType: 'credit_order' | 'vast_order';
  referenceId: string;
  scope: 'CREDIT_ORDER_RESERVE' | 'VAST_ORDER_RESERVE';
  amountMicros: bigint;
  serviceEndsAt: Date;
  now: Date;
  transactionId: string;
  idempotencyOwner: string;
  idempotencyKey: string;
  payloadDigest: string;
}>;

export type CreditLotReservation = Readonly<{
  status: 'created' | 'replayed';
  transactionId: string;
  expiringReservedMicros: bigint;
  unrestrictedReservedMicros: bigint;
  allocations: ReadonlyArray<Readonly<{
    lotId: string;
    allocationId: string;
    amountMicros: bigint;
    expiresAt: Date;
  }>>;
}>;

export type ReserveExpiringFefoResult = CreditLotReservation | Readonly<{
  status: 'insufficient_credits' | 'expiry_coverage_insufficient' | 'conflict';
}>;

type ResolutionScope = 'CREDIT_ORDER_CAPTURE' | 'CREDIT_ORDER_RELEASE' | 'CREDIT_ORDER_MUTUAL_REFUND'
  | 'CREDIT_ORDER_ADJUDICATED_REFUND' | 'COMPUTE_PROVISION_FAILURE_RELEASE'
  | 'COMPUTE_METERED_CAPTURE' | 'COMPUTE_ISSUE_DECISION' | 'VAST_ORDER_CAPTURE' | 'VAST_ORDER_RELEASE';
type RestoreScope = 'CREDIT_ORDER_POST_ACCEPT_REFUND' | 'CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND'
  | 'CREDIT_SETTLEMENT_REFUND_WITH_FEE_REVERSAL';
type LedgerReferenceType = 'order_capture' | 'order_release' | 'refund';

export type LotCounterpartEntry = Readonly<{ accountId: string; amountMicros: bigint; memo: string }>;
export type ResolveReservationInput = Readonly<{
  subjectId: string;
  referenceType: 'credit_order' | 'vast_order';
  referenceId: string;
  reservationTransactionId: string;
  totalReservedMicros: bigint;
  capturedMicros: bigint;
  now: Date;
  transactionId: string;
  scope: ResolutionScope;
  ledgerReferenceType: LedgerReferenceType;
  idempotencyOwner: string;
  idempotencyKey: string;
  payloadDigest: string;
  counterpartEntries: ReadonlyArray<LotCounterpartEntry>;
}>;
export type ReservationResolution = Readonly<{
  status: 'created' | 'replayed';
  transactionId: string;
  lotConsumedMicros: bigint;
  unrestrictedConsumedMicros: bigint;
  lotReleasedAvailableMicros: bigint;
  lotReleasedExpiredMicros: bigint;
  unrestrictedReleasedMicros: bigint;
}>;
export type ResolveReservationResult = ReservationResolution | Readonly<{ status: 'conflict' }>;

export type RestoreConsumedInput = Readonly<{
  subjectId: string;
  referenceType: 'credit_order';
  referenceId: string;
  captureTransactionId: string;
  capturedMicros: bigint;
  previouslyRefundedMicros: bigint;
  refundMicros: bigint;
  now: Date;
  transactionId: string;
  scope: RestoreScope;
  ledgerReferenceType: 'refund';
  idempotencyOwner: string;
  idempotencyKey: string;
  payloadDigest: string;
  counterpartEntries: ReadonlyArray<LotCounterpartEntry>;
}>;
export type ConsumedRestoration = Readonly<{
  status: 'created' | 'replayed';
  transactionId: string;
  unrestrictedRestoredMicros: bigint;
  lotRestoredAvailableMicros: bigint;
  lotRestoredExpiredMicros: bigint;
}>;
export type RestoreConsumedResult = ConsumedRestoration | Readonly<{ status: 'conflict' | 'refund_exceeds_consumed' }>;

/** Shared lot primitive. It always joins the caller's database transaction. */
export class CreditLotAllocator {
  async snapshot(client: PoolClient, subjectId: string, now: Date): Promise<CreditLotSnapshot> {
    this.date(now, 'QIXIANG_LOT_SNAPSHOT_TIME_INVALID');
    const accounts = await this.lockBuyerAccounts(client, subjectId);
    const lots = await this.lockLots(client, subjectId);
    const ledger = await client.query<{ amount: string }>(
      `SELECT COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text amount
       FROM kai_credit_accounts a
       LEFT JOIN kai_credit_entries e ON e.account_id=a.id
       LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
       WHERE a.id=$1 GROUP BY a.id`, [accounts.available],
    );
    const ledgerAvailableMicros = BigInt(ledger.rows[0]?.amount ?? '0');
    let allLotAvailableMicros = 0n;
    let unexpiredLotAvailableMicros = 0n;
    let expiredPendingSweepMicros = 0n;
    let nearestExpiry: Date | null = null;
    for (const lot of lots) {
      const available = BigInt(lot.available_micros);
      const expiresAt = new Date(lot.expires_at);
      if (available < 0n || Number.isNaN(expiresAt.getTime())) this.invariant();
      allLotAvailableMicros += available;
      if (available === 0n) continue;
      if (expiresAt.getTime() > now.getTime()) {
        unexpiredLotAvailableMicros += available;
        if (!nearestExpiry || expiresAt < nearestExpiry) nearestExpiry = expiresAt;
      } else {
        expiredPendingSweepMicros += available;
      }
    }
    const unrestrictedAvailableMicros = ledgerAvailableMicros - allLotAvailableMicros;
    if ([ledgerAvailableMicros, allLotAvailableMicros, unexpiredLotAvailableMicros,
      expiredPendingSweepMicros, unrestrictedAvailableMicros].some((value) => value < 0n)
      || unexpiredLotAvailableMicros + expiredPendingSweepMicros !== allLotAvailableMicros) this.invariant();
    return { ledgerAvailableMicros, allLotAvailableMicros, unexpiredLotAvailableMicros,
      expiredPendingSweepMicros, unrestrictedAvailableMicros, nearestExpiry };
  }

  async reserveExpiringFefo(client: PoolClient,
    input: ReserveExpiringFefoInput): Promise<ReserveExpiringFefoResult> {
    this.reserveInput(input);
    const accounts = await this.lockBuyerAccounts(client, input.subjectId);
    if (!await this.supportsLots(client)) {
      const existing = await client.query<TransactionRow>(
        `SELECT id,idempotency_owner,scope,idempotency_key,payload_digest,reference_type,reference_id,status
         FROM kai_credit_transactions WHERE idempotency_owner=$1 AND scope=$2 AND idempotency_key=$3 FOR UPDATE`,
        [input.idempotencyOwner,input.scope,input.idempotencyKey]);
      if (existing.rows[0]) {
        const row=existing.rows[0];
        if(row.id!==input.transactionId||row.payload_digest!==input.payloadDigest||row.status!=='posted'
          ||row.reference_type!=='order_reservation'||row.reference_id!==input.referenceId
          ||!await this.entriesMatch(client,row.id,[{accountId:accounts.available,amountMicros:-input.amountMicros},
            {accountId:accounts.reserved,amountMicros:input.amountMicros}]))return{status:'conflict'};
        return{status:'replayed',transactionId:row.id,expiringReservedMicros:0n,
          unrestrictedReservedMicros:input.amountMicros,allocations:[]};
      }
      if(await this.transactionIdExists(client,input.transactionId))return{status:'conflict'};
      const balance=await client.query<{amount:string}>(`SELECT COALESCE(sum(e.amount_micros)
        FILTER(WHERE t.status='posted'),0)::text amount FROM kai_credit_accounts a
        LEFT JOIN kai_credit_entries e ON e.account_id=a.id LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
        WHERE a.id=$1 GROUP BY a.id`,[accounts.available]);
      if(BigInt(balance.rows[0]?.amount??'0')<input.amountMicros)return{status:'insufficient_credits'};
      await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
        reference_type,reference_id,description,status)VALUES($1,$2,$3,$4,$5,'order_reservation',$6,$7,'pending')`,
      [input.transactionId,input.idempotencyOwner,input.scope,input.idempotencyKey,input.payloadDigest,input.referenceId,
        `卡时预留 ${input.referenceId}`]);
      await this.insertEntries(client,input.transactionId,[{accountId:accounts.available,amountMicros:-input.amountMicros,memo:'卡时预留'},
        {accountId:accounts.reserved,amountMicros:input.amountMicros,memo:'卡时预留'}]);
      await this.post(client,input.transactionId,input.now);
      return{status:'created',transactionId:input.transactionId,expiringReservedMicros:0n,
        unrestrictedReservedMicros:input.amountMicros,allocations:[]};
    }
    const lots = await this.lockLots(client, input.subjectId);
    const ledger = await client.query<{ amount: string }>(
      `SELECT COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text amount
       FROM kai_credit_accounts a
       LEFT JOIN kai_credit_entries e ON e.account_id=a.id
       LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
       WHERE a.id=$1 GROUP BY a.id`, [accounts.available],
    );
    const ledgerAvailable = BigInt(ledger.rows[0]?.amount ?? '0');
    const allLotAvailable = lots.reduce((sum, lot) => sum + BigInt(lot.available_micros), 0n);
    const unrestricted = ledgerAvailable - allLotAvailable;
    if (ledgerAvailable < 0n || allLotAvailable < 0n || unrestricted < 0n
      || lots.some((lot) => BigInt(lot.available_micros) < 0n)) this.invariant();

    const expectedScope = input.referenceType === 'credit_order'
      ? 'CREDIT_ORDER_RESERVE' : 'VAST_ORDER_RESERVE';
    if (input.scope !== expectedScope || input.idempotencyOwner !== `subject:${input.subjectId}`) {
      return { status: 'conflict' };
    }
    const existing = await client.query<TransactionRow>(
      `SELECT id,idempotency_owner,scope,idempotency_key,payload_digest,reference_type,reference_id,status
       FROM kai_credit_transactions
       WHERE idempotency_owner=$1 AND scope=$2 AND idempotency_key=$3 FOR UPDATE`,
      [input.idempotencyOwner, input.scope, input.idempotencyKey],
    );
    if (existing.rows[0]) return this.replay(client, accounts, input, existing.rows[0]);
    const transactionIdConflict = await client.query<{ id: string }>(
      `SELECT id FROM kai_credit_transactions WHERE id=$1 FOR UPDATE`, [input.transactionId],
    );
    if (transactionIdConflict.rows[0]) return { status: 'conflict' };

    if (ledgerAvailable < input.amountMicros) return { status: 'insufficient_credits' };
    const eligible = lots.filter((lot) => new Date(lot.expires_at).getTime() >= input.serviceEndsAt.getTime());
    const eligibleTotal = eligible.reduce((sum, lot) => sum + BigInt(lot.available_micros), 0n);
    if (eligibleTotal + unrestricted < input.amountMicros) return { status: 'expiry_coverage_insufficient' };

    await client.query(
      `INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
        reference_type,reference_id,description,status)
       VALUES($1,$2,$3,$4,$5,'order_reservation',$6,$7,'pending')`,
      [input.transactionId, input.idempotencyOwner, input.scope, input.idempotencyKey,
        input.payloadDigest, input.referenceId, `七相到期卡时预留 ${input.referenceId}`],
    );
    await client.query(
      `INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
       ($1,$2,$3,$4,'卡时预留'),($5,$2,$6,$7,'卡时预留')`,
      [randomUUID(), input.transactionId, accounts.available, (-input.amountMicros).toString(),
        randomUUID(), accounts.reserved, input.amountMicros.toString()],
    );

    let remaining = input.amountMicros;
    const allocations: Array<{ lotId: string; allocationId: string; amountMicros: bigint; expiresAt: Date }> = [];
    for (const lot of eligible) {
      if (remaining === 0n) break;
      const lotAvailable = BigInt(lot.available_micros);
      const amount = lotAvailable < remaining ? lotAvailable : remaining;
      if (amount === 0n) continue;
      const allocationId = randomUUID();
      await client.query(
        `INSERT INTO kai_credit_lot_allocations(id,lot_id,reference_type,reference_id,allocation_key,
          allocated_micros,reserved_micros,consumed_micros,released_micros,restored_micros)
         VALUES($1,$2,$3,$4,$5,$6,$6,0,0,0)`,
        [allocationId, lot.id, input.referenceType, input.referenceId, input.transactionId, amount.toString()],
      );
      await client.query(
        `UPDATE kai_credit_lots SET available_micros=available_micros-$2,reserved_micros=reserved_micros+$2
         WHERE id=$1`, [lot.id, amount.toString()],
      );
      await client.query(
        `INSERT INTO kai_credit_lot_movements(id,lot_id,allocation_id,ledger_transaction_id,kind,
          amount_micros,from_bucket,to_bucket,idempotency_owner,scope,idempotency_key,payload_digest,occurred_at)
         VALUES($1,$2,$3,$4,'reserve',$5,'available','reserved',$6,$7,$8,$9,$10)`,
        [randomUUID(), lot.id, allocationId, input.transactionId, amount.toString(), input.idempotencyOwner,
          input.scope, input.idempotencyKey, input.payloadDigest, input.now],
      );
      allocations.push({ lotId: lot.id, allocationId, amountMicros: amount,
        expiresAt: new Date(lot.expires_at) });
      remaining -= amount;
    }
    await client.query(
      `UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1 AND status='pending'`,
      [input.transactionId, input.now],
    );
    const expiringReservedMicros = input.amountMicros - remaining;
    return { status: 'created', transactionId: input.transactionId, expiringReservedMicros,
      unrestrictedReservedMicros: remaining, allocations };
  }

  async resolveReservation(client: PoolClient, input: ResolveReservationInput): Promise<ResolveReservationResult> {
    this.resolveInput(input);
    await this.lockReference(client, input.referenceType, input.referenceId, input.subjectId);
    const existing = await this.findTransaction(client, input.idempotencyOwner, input.scope, input.idempotencyKey);
    const reservation = await this.lockTransaction(client, input.reservationTransactionId);
    const accounts = await this.lockEconomicAccounts(client, input.subjectId, input.counterpartEntries,
      input.capturedMicros < input.totalReservedMicros);
    if (!await this.supportsLots(client)) {
      const expectedReservationScope = input.referenceType === 'credit_order' ? 'CREDIT_ORDER_RESERVE' : 'VAST_ORDER_RESERVE';
      const legacyReservation = input.referenceType === 'credit_order'
        ? await client.query<{ id: string }>(`SELECT id FROM kai_credit_order_reservations WHERE order_id=$1
            AND reservation_transaction_id=$2 AND credit_micros=$3 FOR UPDATE`,
          [input.referenceId, input.reservationTransactionId, input.totalReservedMicros.toString()])
        : { rows: [{ id: input.referenceId }] };
      if (!reservation || reservation.status !== 'posted' || reservation.scope !== expectedReservationScope
        || reservation.reference_type !== 'order_reservation' || reservation.reference_id !== input.referenceId
        || !legacyReservation.rows[0]) throw new Error('QIXIANG_LOT_RESERVATION_AUTHORITY_INVALID');
      const unrestrictedReleasedMicros = input.totalReservedMicros - input.capturedMicros;
      if (existing) {
        const expected = [{ accountId: accounts.reserved, amountMicros: -input.totalReservedMicros },
          ...input.counterpartEntries,
          ...(unrestrictedReleasedMicros > 0n
            ? [{ accountId: accounts.available, amountMicros: unrestrictedReleasedMicros }] : [])];
        if (!this.transactionMatches(existing, input, input.ledgerReferenceType)
          || !await this.entriesMatch(client, existing.id, expected)) return { status: 'conflict' };
        return { status: 'replayed', transactionId: existing.id, lotConsumedMicros: 0n,
          unrestrictedConsumedMicros: input.capturedMicros, lotReleasedAvailableMicros: 0n,
          lotReleasedExpiredMicros: 0n, unrestrictedReleasedMicros };
      }
      if (await this.transactionIdExists(client, input.transactionId) || await this.hasPriorResolution(client, input.referenceId)) {
        return { status: 'conflict' };
      }
      await this.validateKnownCounterparts(client, input);
      await this.insertTransaction(client, input, input.ledgerReferenceType, input.counterpartEntries,
        accounts, input.totalReservedMicros, unrestrictedReleasedMicros, 0n);
      await this.post(client, input.transactionId, input.now);
      return { status: 'created', transactionId: input.transactionId, lotConsumedMicros: 0n,
        unrestrictedConsumedMicros: input.capturedMicros, lotReleasedAvailableMicros: 0n,
        lotReleasedExpiredMicros: 0n, unrestrictedReleasedMicros };
    }
    const lots = await this.lockLots(client, input.subjectId);
    const lockedAllocations = await this.lockAllocations(client, input.referenceType, input.referenceId);
    const allocations = this.sortAllocations(lockedAllocations, 'consume');
    if (allocations.some((allocation) => !lots.some((lot) => lot.id === allocation.lot_id))) this.invariant();
    const authoritativeTotal = await this.validateReservationTransaction(client, input, reservation, allocations,
      accounts);
    if (authoritativeTotal !== input.totalReservedMicros) return { status: 'conflict' };
    if (existing) return this.replayResolution(client, accounts, input, existing);
    if (await this.transactionIdExists(client, input.transactionId)) return { status: 'conflict' };
    if (await this.hasPriorResolution(client, input.referenceId)) return { status: 'conflict' };
    await this.validateKnownCounterparts(client, input);

    const lotReserved = allocations.reduce((sum, allocation) => sum + BigInt(allocation.reserved_micros), 0n);
    const unrestrictedReserved = input.totalReservedMicros - lotReserved;
    if (lotReserved < 0n || unrestrictedReserved < 0n
      || allocations.some((allocation) => BigInt(allocation.consumed_micros)
        + BigInt(allocation.released_micros) + BigInt(allocation.restored_micros)
        + BigInt(allocation.reserved_micros) !== BigInt(allocation.allocated_micros))) this.invariant();

    let captureRemaining = input.capturedMicros;
    let lotConsumedMicros = 0n;
    let lotReleasedAvailableMicros = 0n;
    let lotReleasedExpiredMicros = 0n;
    const changes: Array<{ allocation: AllocationRow; consume: bigint; release: bigint;
      releaseKind: 'release_available' | 'release_expired' }> = [];
    for (const allocation of allocations) {
      const reserved = BigInt(allocation.reserved_micros);
      const consume = reserved < captureRemaining ? reserved : captureRemaining;
      const release = reserved - consume;
      const expired = new Date(allocation.expires_at).getTime() <= input.now.getTime();
      changes.push({ allocation, consume, release,
        releaseKind: expired ? 'release_expired' : 'release_available' });
      captureRemaining -= consume;
      lotConsumedMicros += consume;
      if (expired) lotReleasedExpiredMicros += release;
      else lotReleasedAvailableMicros += release;
    }
    if (captureRemaining > unrestrictedReserved) this.invariant();
    const unrestrictedConsumedMicros = captureRemaining;
    const unrestrictedReleasedMicros = unrestrictedReserved - unrestrictedConsumedMicros;

    await this.insertTransaction(client, input, input.ledgerReferenceType, input.counterpartEntries,
      accounts, input.totalReservedMicros, unrestrictedReleasedMicros + lotReleasedAvailableMicros,
      lotReleasedExpiredMicros);
    for (const change of changes) {
      if (change.consume > 0n) {
        await this.moveAllocation(client, input, change.allocation, 'consume', change.consume,
          'reserved', 'consumed');
      }
      if (change.release > 0n) {
        await this.moveAllocation(client, input, change.allocation, change.releaseKind, change.release,
          'reserved', change.releaseKind === 'release_expired' ? 'expired' : 'available');
      }
      await client.query(`UPDATE kai_credit_lot_allocations SET reserved_micros=reserved_micros-$2-$3,
          consumed_micros=consumed_micros+$2,released_micros=released_micros+$3 WHERE id=$1`,
      [change.allocation.id, change.consume.toString(), change.release.toString()]);
      await client.query(`UPDATE kai_credit_lots SET reserved_micros=reserved_micros-$2-$3,
          consumed_micros=consumed_micros+$2,available_micros=available_micros+$4,
          expired_micros=expired_micros+$5 WHERE id=$1`,
      [change.allocation.lot_id, change.consume.toString(), change.release.toString(),
        change.releaseKind === 'release_available' ? change.release.toString() : '0',
        change.releaseKind === 'release_expired' ? change.release.toString() : '0']);
    }
    await this.post(client, input.transactionId, input.now);
    return { status: 'created', transactionId: input.transactionId, lotConsumedMicros,
      unrestrictedConsumedMicros, lotReleasedAvailableMicros, lotReleasedExpiredMicros,
      unrestrictedReleasedMicros };
  }

  async restoreConsumed(client: PoolClient, input: RestoreConsumedInput): Promise<RestoreConsumedResult> {
    this.restoreInput(input);
    await this.lockReference(client, input.referenceType, input.referenceId, input.subjectId);
    const existing = await this.findTransaction(client, input.idempotencyOwner, input.scope, input.idempotencyKey);
    const capture = await this.lockTransaction(client, input.captureTransactionId);
    const accounts = await this.lockEconomicAccounts(client, input.subjectId, input.counterpartEntries, true);
    const lots = await this.lockLots(client, input.subjectId);
    const allocations = this.sortAllocations(
      await this.lockAllocations(client, input.referenceType, input.referenceId), 'restore');
    if (allocations.some((allocation) => !lots.some((lot) => lot.id === allocation.lot_id))) this.invariant();
    const authority = await this.validateCaptureAndRefundHistory(client, input, capture, existing?.id);
    if (input.capturedMicros !== authority.capturedMicros
      || input.previouslyRefundedMicros !== authority.previouslyRefundedMicros) return { status: 'conflict' };
    if (existing) return this.replayRestoration(client, accounts, input, existing);
    if (await this.transactionIdExists(client, input.transactionId)) return { status: 'conflict' };
    await this.validateKnownCounterparts(client, input);

    const lotOriginalConsumed = allocations.reduce((sum, allocation) => sum
      + BigInt(allocation.consumed_micros) + BigInt(allocation.restored_micros), 0n);
    const lotPreviouslyRestored = allocations.reduce((sum, allocation) => sum + BigInt(allocation.restored_micros), 0n);
    const unrestrictedOriginalConsumed = input.capturedMicros - lotOriginalConsumed;
    const unrestrictedPreviouslyRestored = input.previouslyRefundedMicros - lotPreviouslyRestored;
    const remainingRefundable = input.capturedMicros - input.previouslyRefundedMicros;
    if (lotOriginalConsumed < 0n || unrestrictedOriginalConsumed < 0n || lotPreviouslyRestored < 0n
      || unrestrictedPreviouslyRestored < 0n || unrestrictedPreviouslyRestored > unrestrictedOriginalConsumed) this.invariant();
    if (input.refundMicros > remainingRefundable) return { status: 'refund_exceeds_consumed' };

    let remaining = input.refundMicros;
    const unrestrictedRemaining = unrestrictedOriginalConsumed - unrestrictedPreviouslyRestored;
    const unrestrictedRestoredMicros = remaining < unrestrictedRemaining ? remaining : unrestrictedRemaining;
    remaining -= unrestrictedRestoredMicros;
    let lotRestoredAvailableMicros = 0n;
    let lotRestoredExpiredMicros = 0n;
    const changes: Array<{ allocation: AllocationRow; amount: bigint;
      kind: 'restore_available' | 'restore_expired' }> = [];
    for (const allocation of allocations) {
      if (remaining === 0n) break;
      const consumed = BigInt(allocation.consumed_micros);
      const amount = consumed < remaining ? consumed : remaining;
      if (amount === 0n) continue;
      const expired = new Date(allocation.expires_at).getTime() <= input.now.getTime();
      const kind = expired ? 'restore_expired' : 'restore_available';
      changes.push({ allocation, amount, kind });
      if (expired) lotRestoredExpiredMicros += amount;
      else lotRestoredAvailableMicros += amount;
      remaining -= amount;
    }
    if (remaining !== 0n) this.invariant();

    await this.insertRestoreTransaction(client, input, accounts,
      unrestrictedRestoredMicros + lotRestoredAvailableMicros, lotRestoredExpiredMicros);
    for (const change of changes) {
      await this.moveAllocation(client, input, change.allocation, change.kind, change.amount,
        'consumed', change.kind === 'restore_expired' ? 'expired' : 'available');
      await client.query(`UPDATE kai_credit_lot_allocations SET consumed_micros=consumed_micros-$2,
          restored_micros=restored_micros+$2 WHERE id=$1`, [change.allocation.id, change.amount.toString()]);
      await client.query(`UPDATE kai_credit_lots SET consumed_micros=consumed_micros-$2,
          available_micros=available_micros+$3,expired_micros=expired_micros+$4 WHERE id=$1`,
      [change.allocation.lot_id, change.amount.toString(),
        change.kind === 'restore_available' ? change.amount.toString() : '0',
        change.kind === 'restore_expired' ? change.amount.toString() : '0']);
    }
    await this.post(client, input.transactionId, input.now);
    return { status: 'created', transactionId: input.transactionId, unrestrictedRestoredMicros,
      lotRestoredAvailableMicros, lotRestoredExpiredMicros };
  }

  private async lockEconomicAccounts(client: PoolClient, subjectId: string,
    counterpartEntries: ReadonlyArray<LotCounterpartEntry>, includeIssuance: boolean) {
    const buyer = await client.query<AccountRow>(`SELECT id,account_kind FROM kai_credit_accounts
      WHERE subject_id=$1 AND account_kind IN('available','reserved') AND status='active'`, [subjectId]);
    const available = buyer.rows.find((row) => row.account_kind === 'available')?.id;
    const reserved = buyer.rows.find((row) => row.account_kind === 'reserved')?.id;
    if (!available || !reserved || buyer.rows.length !== 2) throw new Error('QIXIANG_LOT_ACCOUNTS_UNAVAILABLE');
    const ids = [...new Set([available, reserved, ...counterpartEntries.map((entry) => entry.accountId),
      ...(includeIssuance ? [KAI_CREDIT_PLATFORM_ACCOUNTS.issuance] : [])])].sort();
    const subjectRows = await client.query<{ subject_id: string }>(`SELECT DISTINCT subject_id FROM kai_credit_accounts
      WHERE id=ANY($1::uuid[]) AND subject_id IS NOT NULL ORDER BY subject_id`, [ids]);
    const subjectIds = subjectRows.rows.map((row) => row.subject_id).sort();
    const subjects = subjectIds.length === 0 ? { rows: [] as Array<{ id: string }> }
      : await client.query<{ id: string }>(`SELECT id FROM trading_subjects WHERE id=ANY($1::uuid[])
          AND status IN('active','suspended') ORDER BY id FOR UPDATE`, [subjectIds]);
    if (subjects.rows.length !== subjectIds.length) throw new Error('QIXIANG_LOT_SUBJECT_UNAVAILABLE');
    const locked = await client.query<{ id: string; status: string }>(`SELECT id,status FROM kai_credit_accounts
      WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids]);
    if (locked.rows.length !== ids.length || locked.rows.some((row) => row.status !== 'active')) {
      throw new Error('QIXIANG_LOT_ACCOUNTS_UNAVAILABLE');
    }
    return { available, reserved, issuance: KAI_CREDIT_PLATFORM_ACCOUNTS.issuance };
  }

  private async lockAllocations(client: PoolClient, referenceType: 'credit_order' | 'vast_order', referenceId: string) {
    const result = await client.query<AllocationRow>(`SELECT a.id,a.lot_id,a.allocated_micros::text,
      a.reserved_micros::text,a.consumed_micros::text,a.released_micros::text,a.restored_micros::text,l.expires_at
      FROM kai_credit_lot_allocations a JOIN kai_credit_lots l ON l.id=a.lot_id
      WHERE a.reference_type=$1 AND a.reference_id=$2 ORDER BY a.lot_id,a.id FOR UPDATE OF a`,
    [referenceType, referenceId]);
    return result.rows;
  }

  private sortAllocations(rows: ReadonlyArray<AllocationRow>, mode: 'consume' | 'restore') {
    const direction = mode === 'consume' ? 1 : -1;
    return [...rows].sort((left, right) => direction * (
      new Date(left.expires_at).getTime() - new Date(right.expires_at).getTime()
      || left.lot_id.localeCompare(right.lot_id) || left.id.localeCompare(right.id)));
  }

  private async lockReference(client: PoolClient, referenceType: 'credit_order' | 'vast_order', referenceId: string,
    subjectId: string) {
    const table = referenceType === 'credit_order' ? 'kai_credit_orders' : 'vast_external_orders';
    const result = await client.query<{ buyer_subject_id: string }>(
      `SELECT buyer_subject_id FROM ${table} WHERE id=$1 FOR UPDATE`, [referenceId]);
    if (result.rows[0]?.buyer_subject_id !== subjectId) throw new Error('QIXIANG_LOT_REFERENCE_MISMATCH');
  }

  private async lockTransaction(client: PoolClient, transactionId: string) {
    const result = await client.query<TransactionRow>(`SELECT id,idempotency_owner,scope,idempotency_key,payload_digest,
      reference_type,reference_id,status FROM kai_credit_transactions WHERE id=$1 FOR UPDATE`, [transactionId]);
    return result.rows[0] ?? null;
  }

  private async validateReservationTransaction(client: PoolClient, input: ResolveReservationInput,
    transaction: TransactionRow | null, allocations: ReadonlyArray<AllocationRow>,
    accounts: { available: string; reserved: string }) {
    const expectedScope = input.referenceType === 'credit_order' ? 'CREDIT_ORDER_RESERVE' : 'VAST_ORDER_RESERVE';
    if (!transaction || transaction.status !== 'posted' || transaction.scope !== expectedScope
      || transaction.idempotency_owner !== `subject:${input.subjectId}`
      || transaction.reference_type !== 'order_reservation' || transaction.reference_id !== input.referenceId) {
      throw new Error('QIXIANG_LOT_RESERVATION_AUTHORITY_INVALID');
    }
    const entries = await client.query<{ account_id: string; amount_micros: string }>(
      `SELECT account_id,amount_micros::text FROM kai_credit_entries WHERE transaction_id=$1 ORDER BY account_id`,
      [transaction.id]);
    if (entries.rows.length !== 2) throw new Error('QIXIANG_LOT_RESERVATION_AUTHORITY_INVALID');
    const available = entries.rows.find((row) => row.account_id === accounts.available);
    const reserved = entries.rows.find((row) => row.account_id === accounts.reserved);
    if (!available || !reserved || BigInt(available.amount_micros) >= 0n
      || BigInt(reserved.amount_micros) !== -BigInt(available.amount_micros)) {
      throw new Error('QIXIANG_LOT_RESERVATION_AUTHORITY_INVALID');
    }
    const movements = await client.query<{ allocation_id: string; amount_micros: string;
      idempotency_owner: string; scope: string; idempotency_key: string; payload_digest: string }>(
      `SELECT allocation_id,amount_micros::text,idempotency_owner,scope,idempotency_key,payload_digest
       FROM kai_credit_lot_movements WHERE ledger_transaction_id=$1 AND kind='reserve' ORDER BY allocation_id`,
      [transaction.id]);
    const allocationAuthority = await client.query<{ id: string; allocation_key: string; allocated_micros: string }>(
      `SELECT id,allocation_key,allocated_micros::text FROM kai_credit_lot_allocations
       WHERE reference_type=$1 AND reference_id=$2 ORDER BY lot_id,id FOR UPDATE`,
      [input.referenceType, input.referenceId]);
    if (allocationAuthority.rows.some((allocation) => allocation.allocation_key !== transaction.id)) {
      throw new Error('QIXIANG_LOT_RESERVATION_AUTHORITY_INVALID');
    }
    if (movements.rows.length !== allocationAuthority.rows.length) {
      throw new Error('QIXIANG_LOT_RESERVATION_AUTHORITY_INVALID');
    }
    for (const allocation of allocationAuthority.rows) {
      const movement = movements.rows.find((row) => row.allocation_id === allocation.id);
      if (!movement || movement.amount_micros !== allocation.allocated_micros
        || movement.idempotency_owner !== transaction.idempotency_owner || movement.scope !== transaction.scope
        || movement.idempotency_key !== transaction.idempotency_key
        || movement.payload_digest !== transaction.payload_digest) {
        throw new Error('QIXIANG_LOT_RESERVATION_AUTHORITY_INVALID');
      }
    }
    return -BigInt(available.amount_micros);
  }

  private async hasPriorResolution(client: PoolClient, referenceId: string) {
    const result = await client.query<{ id: string }>(`SELECT id FROM kai_credit_transactions
      WHERE reference_id=$1 AND status='posted' AND scope IN('CREDIT_ORDER_CAPTURE','CREDIT_ORDER_RELEASE',
        'CREDIT_ORDER_MUTUAL_REFUND','CREDIT_ORDER_ADJUDICATED_REFUND','COMPUTE_PROVISION_FAILURE_RELEASE',
        'COMPUTE_METERED_CAPTURE','COMPUTE_ISSUE_DECISION','VAST_ORDER_CAPTURE','VAST_ORDER_RELEASE')
      ORDER BY id FOR UPDATE`, [referenceId]);
    return result.rows.length > 0;
  }

  private async validateCaptureAndRefundHistory(client: PoolClient, input: RestoreConsumedInput,
    capture: TransactionRow | null, excludeRefundTransactionId?: string) {
    if (!capture || capture.status !== 'posted' || capture.idempotency_owner !== `subject:${input.subjectId}`
      || !['CREDIT_ORDER_CAPTURE', 'COMPUTE_METERED_CAPTURE', 'COMPUTE_ISSUE_DECISION'].includes(capture.scope)
      || capture.reference_type !== 'order_capture' || capture.reference_id !== input.referenceId) {
      throw new Error('QIXIANG_LOT_CAPTURE_AUTHORITY_INVALID');
    }
    const order = await client.query<{ supplier_subject_id: string }>(
      `SELECT supplier_subject_id FROM kai_credit_orders WHERE id=$1`, [input.referenceId]);
    const captured = await client.query<{ amount: string }>(`SELECT COALESCE(sum(e.amount_micros),0)::text amount
      FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
      WHERE e.transaction_id=$1 AND a.subject_id=$2 AND a.account_kind='supplier_receivable'`,
    [capture.id, order.rows[0]?.supplier_subject_id]);
    const capturedMicros = BigInt(captured.rows[0]?.amount ?? '0');
    if (capturedMicros <= 0n) throw new Error('QIXIANG_LOT_CAPTURE_AUTHORITY_INVALID');
    const refunds = await client.query<{ id: string }>(`SELECT id FROM kai_credit_transactions
      WHERE reference_id=$1 AND reference_type='refund' AND status='posted'
        AND scope IN('CREDIT_ORDER_POST_ACCEPT_REFUND','CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND',
          'CREDIT_SETTLEMENT_REFUND_WITH_FEE_REVERSAL')
        AND($2::uuid IS NULL OR id<>$2::uuid)
      ORDER BY id FOR UPDATE`, [input.referenceId, excludeRefundTransactionId ?? null]);
    let previouslyRefundedMicros = 0n;
    for (const refund of refunds.rows) {
      const restored = await client.query<{ amount: string }>(`SELECT COALESCE(sum(e.amount_micros),0)::text amount
        FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
        WHERE e.transaction_id=$1 AND ((a.subject_id=$2 AND a.account_kind='available')
          OR(a.owner_kind='platform' AND a.account_kind='platform_issuance')) AND e.amount_micros>0`,
      [refund.id, input.subjectId]);
      previouslyRefundedMicros += BigInt(restored.rows[0]?.amount ?? '0');
    }
    if (previouslyRefundedMicros > capturedMicros) this.invariant();
    return { capturedMicros, previouslyRefundedMicros };
  }

  private async validateKnownCounterparts(client: PoolClient,
    input: ResolveReservationInput | RestoreConsumedInput) {
    const order = await client.query<{ supplier_subject_id: string }>(
      `SELECT supplier_subject_id FROM kai_credit_orders WHERE id=$1`, [input.referenceId]);
    if (input.referenceType === 'vast_order') {
      const accounts = await client.query<{ account_kind: string; owner_kind: string }>(
        `SELECT account_kind,owner_kind FROM kai_credit_accounts WHERE id=ANY($1::uuid[])`,
        [input.counterpartEntries.map((entry) => entry.accountId)]);
      if (input.scope === 'VAST_ORDER_CAPTURE'
        && (accounts.rows.length !== 1 || accounts.rows[0]?.owner_kind !== 'platform'
          || accounts.rows[0]?.account_kind !== 'platform_clearing')) this.invariant();
      if (input.scope === 'VAST_ORDER_RELEASE' && input.counterpartEntries.length !== 0) this.invariant();
      return;
    }
    const rows = await client.query<{ id: string; account_kind: string; owner_kind: string; subject_id: string | null }>(
      `SELECT id,account_kind,owner_kind,subject_id FROM kai_credit_accounts WHERE id=ANY($1::uuid[])`,
      [input.counterpartEntries.map((entry) => entry.accountId)]);
    if (rows.rows.length !== input.counterpartEntries.length) this.invariant();
    if ('refundMicros' in input) {
      if (rows.rows.some((row) => !((row.subject_id === order.rows[0]?.supplier_subject_id
          && ['supplier_receivable', 'supplier_earnings_available'].includes(row.account_kind))
        || (row.owner_kind === 'platform' && row.account_kind === 'platform_revenue')))) this.invariant();
    } else if (input.capturedMicros === 0n) {
      if (input.counterpartEntries.length !== 0) this.invariant();
    } else if (rows.rows.some((row) => row.subject_id !== order.rows[0]?.supplier_subject_id
      || row.account_kind !== 'supplier_receivable')) this.invariant();
  }

  private findTransaction(client: PoolClient, owner: string, scope: string, key: string) {
    return client.query<TransactionRow>(`SELECT id,idempotency_owner,scope,idempotency_key,payload_digest,
      reference_type,reference_id,status FROM kai_credit_transactions
      WHERE idempotency_owner=$1 AND scope=$2 AND idempotency_key=$3 FOR UPDATE`, [owner, scope, key])
      .then((result) => result.rows[0] ?? null);
  }

  private transactionIdExists(client: PoolClient, transactionId: string) {
    return client.query<{ id: string }>(`SELECT id FROM kai_credit_transactions WHERE id=$1 FOR UPDATE`, [transactionId])
      .then((result) => Boolean(result.rows[0]));
  }

  private async insertTransaction(client: PoolClient, input: ResolveReservationInput,
    referenceType: LedgerReferenceType, counterpartEntries: ReadonlyArray<LotCounterpartEntry>,
    accounts: { available: string; reserved: string; issuance: string }, totalReserved: bigint,
    availableRelease: bigint, expiredRelease: bigint) {
    await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
      reference_type,reference_id,description,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
    [input.transactionId, input.idempotencyOwner, input.scope, input.idempotencyKey, input.payloadDigest,
      referenceType, input.referenceId, `七相预留结算 ${input.referenceId}`]);
    const entries: LotCounterpartEntry[] = [
      { accountId: accounts.reserved, amountMicros: -totalReserved, memo: '预留卡时结算' },
      ...counterpartEntries,
      ...(availableRelease > 0n
        ? [{ accountId: accounts.available, amountMicros: availableRelease, memo: '未使用卡时释放' }] : []),
      ...(expiredRelease > 0n
        ? [{ accountId: accounts.issuance, amountMicros: expiredRelease, memo: '到期卡时核销' }] : []),
    ];
    await this.insertEntries(client, input.transactionId, entries);
  }

  private async insertRestoreTransaction(client: PoolClient, input: RestoreConsumedInput,
    accounts: { available: string; reserved: string; issuance: string }, availableRestore: bigint,
    expiredRestore: bigint) {
    await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
      reference_type,reference_id,description,status) VALUES($1,$2,$3,$4,$5,'refund',$6,$7,'pending')`,
    [input.transactionId, input.idempotencyOwner, input.scope, input.idempotencyKey, input.payloadDigest,
      input.referenceId, `七相消费恢复 ${input.referenceId}`]);
    const entries: LotCounterpartEntry[] = [
      ...input.counterpartEntries,
      ...(availableRestore > 0n
        ? [{ accountId: accounts.available, amountMicros: availableRestore, memo: '服务退款卡时恢复' }] : []),
      ...(expiredRestore > 0n
        ? [{ accountId: accounts.issuance, amountMicros: expiredRestore, memo: '到期退款卡时核销' }] : []),
    ];
    await this.insertEntries(client, input.transactionId, entries);
  }

  private async insertEntries(client: PoolClient, transactionId: string,
    entries: ReadonlyArray<LotCounterpartEntry>) {
    if (entries.length < 2 || entries.some((entry) => entry.amountMicros === 0n)) this.invariant();
    for (const entry of entries) await client.query(
      `INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES($1,$2,$3,$4,$5)`,
      [randomUUID(), transactionId, entry.accountId, entry.amountMicros.toString(), entry.memo],
    );
  }

  private async moveAllocation(client: PoolClient,
    input: Pick<ResolveReservationInput, 'transactionId' | 'idempotencyOwner' | 'scope' | 'idempotencyKey'
      | 'payloadDigest' | 'now'> | Pick<RestoreConsumedInput, 'transactionId' | 'idempotencyOwner' | 'scope'
      | 'idempotencyKey' | 'payloadDigest' | 'now'>,
    allocation: AllocationRow, kind: 'consume' | 'release_available' | 'release_expired'
      | 'restore_available' | 'restore_expired', amount: bigint, from: 'reserved' | 'consumed',
    to: 'consumed' | 'available' | 'expired') {
    await client.query(`INSERT INTO kai_credit_lot_movements(id,lot_id,allocation_id,ledger_transaction_id,kind,
      amount_micros,from_bucket,to_bucket,idempotency_owner,scope,idempotency_key,payload_digest,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [randomUUID(), allocation.lot_id, allocation.id, input.transactionId, kind, amount.toString(), from, to,
      input.idempotencyOwner, input.scope, input.idempotencyKey, input.payloadDigest, input.now]);
  }

  private post(client: PoolClient, transactionId: string, now: Date) {
    return client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2
      WHERE id=$1 AND status='pending'`, [transactionId, now]).then((result) => {
      if (result.rowCount !== 1) this.invariant();
    });
  }

  private async replayResolution(client: PoolClient,
    accounts: { available: string; reserved: string; issuance: string }, input: ResolveReservationInput,
    tx: TransactionRow): Promise<ResolveReservationResult> {
    if (!this.transactionMatches(tx, input, input.ledgerReferenceType)) return { status: 'conflict' };
    const movements = await client.query<{ kind: string; amount: string }>(`SELECT kind,
      sum(amount_micros)::text amount FROM kai_credit_lot_movements WHERE ledger_transaction_id=$1
      GROUP BY kind`, [tx.id]);
    const sum = (kind: string) => BigInt(movements.rows.find((row) => row.kind === kind)?.amount ?? '0');
    const lotConsumedMicros = sum('consume');
    const lotReleasedAvailableMicros = sum('release_available');
    const lotReleasedExpiredMicros = sum('release_expired');
    const unrestrictedConsumedMicros = input.capturedMicros - lotConsumedMicros;
    const unrestrictedReleasedMicros = input.totalReservedMicros - input.capturedMicros
      - lotReleasedAvailableMicros - lotReleasedExpiredMicros;
    if ([lotConsumedMicros, lotReleasedAvailableMicros, lotReleasedExpiredMicros,
      unrestrictedConsumedMicros, unrestrictedReleasedMicros].some((value) => value < 0n)) return { status: 'conflict' };
    const expected = [
      { accountId: accounts.reserved, amountMicros: -input.totalReservedMicros },
      ...input.counterpartEntries,
      ...(unrestrictedReleasedMicros + lotReleasedAvailableMicros > 0n ? [{ accountId: accounts.available,
        amountMicros: unrestrictedReleasedMicros + lotReleasedAvailableMicros }] : []),
      ...(lotReleasedExpiredMicros > 0n
        ? [{ accountId: accounts.issuance, amountMicros: lotReleasedExpiredMicros }] : []),
    ];
    if (!await this.entriesMatch(client, tx.id, expected)) return { status: 'conflict' };
    return { status: 'replayed', transactionId: tx.id, lotConsumedMicros, unrestrictedConsumedMicros,
      lotReleasedAvailableMicros, lotReleasedExpiredMicros, unrestrictedReleasedMicros };
  }

  private async replayRestoration(client: PoolClient,
    accounts: { available: string; reserved: string; issuance: string }, input: RestoreConsumedInput,
    tx: TransactionRow): Promise<RestoreConsumedResult> {
    if (!this.transactionMatches(tx, input, 'refund')) return { status: 'conflict' };
    const movements = await client.query<{ kind: string; amount: string }>(`SELECT kind,
      sum(amount_micros)::text amount FROM kai_credit_lot_movements WHERE ledger_transaction_id=$1
      GROUP BY kind`, [tx.id]);
    const lotRestoredAvailableMicros = BigInt(movements.rows.find((row) => row.kind === 'restore_available')?.amount ?? '0');
    const lotRestoredExpiredMicros = BigInt(movements.rows.find((row) => row.kind === 'restore_expired')?.amount ?? '0');
    const unrestrictedRestoredMicros = input.refundMicros - lotRestoredAvailableMicros - lotRestoredExpiredMicros;
    if (unrestrictedRestoredMicros < 0n) return { status: 'conflict' };
    const expected = [
      ...input.counterpartEntries,
      ...(unrestrictedRestoredMicros + lotRestoredAvailableMicros > 0n ? [{ accountId: accounts.available,
        amountMicros: unrestrictedRestoredMicros + lotRestoredAvailableMicros }] : []),
      ...(lotRestoredExpiredMicros > 0n
        ? [{ accountId: accounts.issuance, amountMicros: lotRestoredExpiredMicros }] : []),
    ];
    if (!await this.entriesMatch(client, tx.id, expected)) return { status: 'conflict' };
    return { status: 'replayed', transactionId: tx.id, unrestrictedRestoredMicros,
      lotRestoredAvailableMicros, lotRestoredExpiredMicros };
  }

  private transactionMatches(tx: TransactionRow,
    input: Pick<ResolveReservationInput, 'transactionId' | 'idempotencyOwner' | 'scope' | 'idempotencyKey'
      | 'payloadDigest' | 'referenceId'> | Pick<RestoreConsumedInput, 'transactionId' | 'idempotencyOwner'
      | 'scope' | 'idempotencyKey' | 'payloadDigest' | 'referenceId'>, referenceType: LedgerReferenceType) {
    return tx.id === input.transactionId && tx.status === 'posted' && tx.idempotency_owner === input.idempotencyOwner
      && tx.scope === input.scope && tx.idempotency_key === input.idempotencyKey
      && tx.payload_digest === input.payloadDigest && tx.reference_type === referenceType
      && tx.reference_id === input.referenceId;
  }

  private async entriesMatch(client: PoolClient, transactionId: string,
    expected: ReadonlyArray<Readonly<{ accountId: string; amountMicros: bigint }>>) {
    const actual = await client.query<{ account_id: string; amount_micros: string }>(`SELECT account_id,
      amount_micros::text FROM kai_credit_entries WHERE transaction_id=$1 ORDER BY account_id,amount_micros`,
    [transactionId]);
    const normalize = (rows: ReadonlyArray<Readonly<{ accountId: string; amountMicros: bigint }>>) => rows
      .map((row) => `${row.accountId}:${row.amountMicros}`).sort();
    return JSON.stringify(actual.rows.map((row) => `${row.account_id}:${row.amount_micros}`).sort())
      === JSON.stringify(normalize(expected));
  }

  private resolveInput(input: ResolveReservationInput) {
    this.commonEconomicInput(input);
    if (!uuid.test(input.reservationTransactionId) || input.totalReservedMicros <= 0n || input.capturedMicros < 0n
      || input.capturedMicros > input.totalReservedMicros || !isCreditCentAligned(input.totalReservedMicros)
      || !isCreditCentAligned(input.capturedMicros)) throw new Error('QIXIANG_LOT_RESOLUTION_AMOUNT_INVALID');
    if (input.counterpartEntries.some((entry) => entry.amountMicros <= 0n || !isCreditCentAligned(entry.amountMicros))
      || input.counterpartEntries.reduce((sum, entry) => sum + entry.amountMicros, 0n) !== input.capturedMicros) {
      throw new Error('QIXIANG_LOT_COUNTERPART_INVALID');
    }
    const scopeReference: Record<ResolutionScope, LedgerReferenceType> = {
      CREDIT_ORDER_CAPTURE: 'order_capture', CREDIT_ORDER_RELEASE: 'order_release',
      CREDIT_ORDER_MUTUAL_REFUND: 'refund', CREDIT_ORDER_ADJUDICATED_REFUND: 'refund',
      COMPUTE_PROVISION_FAILURE_RELEASE: 'order_release', COMPUTE_METERED_CAPTURE: 'order_capture',
      COMPUTE_ISSUE_DECISION: input.capturedMicros === 0n ? 'refund' : 'order_capture',
      VAST_ORDER_CAPTURE: 'order_capture', VAST_ORDER_RELEASE: 'order_release',
    };
    if (scopeReference[input.scope] !== input.ledgerReferenceType
      || (input.referenceType === 'vast_order' && !input.scope.startsWith('VAST_'))
      || (input.referenceType === 'credit_order' && input.scope.startsWith('VAST_'))) {
      throw new Error('QIXIANG_LOT_RESOLUTION_SCOPE_INVALID');
    }
  }

  private restoreInput(input: RestoreConsumedInput) {
    this.commonEconomicInput(input);
    if (!uuid.test(input.captureTransactionId) || input.referenceType !== 'credit_order' || input.ledgerReferenceType !== 'refund'
      || input.capturedMicros <= 0n || input.previouslyRefundedMicros < 0n || input.refundMicros <= 0n
      || ![input.capturedMicros, input.previouslyRefundedMicros, input.refundMicros].every(isCreditCentAligned)) {
      throw new Error('QIXIANG_LOT_RESTORE_AMOUNT_INVALID');
    }
    if (input.counterpartEntries.some((entry) => entry.amountMicros >= 0n || !isCreditCentAligned(entry.amountMicros))
      || input.counterpartEntries.reduce((sum, entry) => sum + entry.amountMicros, 0n) !== -input.refundMicros) {
      throw new Error('QIXIANG_LOT_COUNTERPART_INVALID');
    }
  }

  private commonEconomicInput(input: Pick<ResolveReservationInput, 'subjectId' | 'referenceId' | 'transactionId'
    | 'idempotencyOwner' | 'idempotencyKey' | 'payloadDigest' | 'now' | 'counterpartEntries'>) {
    if (!uuid.test(input.subjectId) || !uuid.test(input.referenceId) || !uuid.test(input.transactionId)
      || input.idempotencyOwner !== `subject:${input.subjectId}` || !idempotencyKey.test(input.idempotencyKey)
      || !lowerDigest.test(input.payloadDigest) || input.counterpartEntries.some((entry) => !uuid.test(entry.accountId))) {
      throw new Error('QIXIANG_LOT_IDEMPOTENCY_INVALID');
    }
    this.date(input.now, 'QIXIANG_LOT_RESOLUTION_TIME_INVALID');
  }

  private async replay(client: PoolClient, accounts: { available: string; reserved: string },
    input: ReserveExpiringFefoInput, tx: TransactionRow): Promise<ReserveExpiringFefoResult> {
    if (tx.id !== input.transactionId || tx.payload_digest !== input.payloadDigest || tx.status !== 'posted'
      || tx.idempotency_owner !== input.idempotencyOwner || tx.scope !== input.scope
      || tx.idempotency_key !== input.idempotencyKey || tx.reference_type !== 'order_reservation'
      || tx.reference_id !== input.referenceId) return { status: 'conflict' };
    const entries = await client.query<{ account_id: string; amount_micros: string }>(
      `SELECT account_id,amount_micros::text FROM kai_credit_entries WHERE transaction_id=$1 ORDER BY account_id`,
      [tx.id],
    );
    if (entries.rows.length !== 2
      || !entries.rows.some((row) => row.account_id === accounts.available
        && BigInt(row.amount_micros) === -input.amountMicros)
      || !entries.rows.some((row) => row.account_id === accounts.reserved
        && BigInt(row.amount_micros) === input.amountMicros)) return { status: 'conflict' };
    const existing = await client.query<{ lot_id: string; allocation_id: string; allocated_micros: string;
      expires_at: Date; allocation_key: string; amount_micros: string; ledger_transaction_id: string }>(
      `SELECT a.lot_id,a.id allocation_id,a.allocated_micros::text,l.expires_at,a.allocation_key,
        m.amount_micros::text,m.ledger_transaction_id
       FROM kai_credit_lot_allocations a
       JOIN kai_credit_lots l ON l.id=a.lot_id
       JOIN kai_credit_lot_movements m ON m.allocation_id=a.id AND m.kind='reserve'
       WHERE m.ledger_transaction_id=$1 ORDER BY l.expires_at,l.id`, [tx.id],
    );
    if (existing.rows.some((row) => row.ledger_transaction_id !== tx.id
      || row.allocation_key !== tx.id || row.amount_micros !== row.allocated_micros
      || new Date(row.expires_at).getTime() < input.serviceEndsAt.getTime())) return { status: 'conflict' };
    const allocations = existing.rows.map((row) => ({ lotId: row.lot_id, allocationId: row.allocation_id,
      amountMicros: BigInt(row.allocated_micros), expiresAt: new Date(row.expires_at) }));
    const expiringReservedMicros = allocations.reduce((sum, row) => sum + row.amountMicros, 0n);
    if (expiringReservedMicros > input.amountMicros) return { status: 'conflict' };
    return { status: 'replayed', transactionId: tx.id, expiringReservedMicros,
      unrestrictedReservedMicros: input.amountMicros - expiringReservedMicros, allocations };
  }

  private async lockBuyerAccounts(client: PoolClient, subjectId: string) {
    const accounts = await client.query<AccountRow>(
      `SELECT id,account_kind FROM kai_credit_accounts
       WHERE subject_id=$1 AND account_kind IN('available','reserved') AND status='active'
       ORDER BY id FOR UPDATE`, [subjectId],
    );
    const available = accounts.rows.find((row) => row.account_kind === 'available')?.id;
    const reserved = accounts.rows.find((row) => row.account_kind === 'reserved')?.id;
    if (!available || !reserved || accounts.rows.length !== 2) throw new Error('QIXIANG_LOT_ACCOUNTS_UNAVAILABLE');
    return { available, reserved };
  }

  private async lockLots(client: PoolClient, subjectId: string) {
    const lots = await client.query<LotRow>(
      `SELECT id,available_micros::text,expires_at FROM kai_credit_lots
       WHERE subject_id=$1 ORDER BY expires_at,id FOR UPDATE`, [subjectId],
    );
    return lots.rows;
  }

  private async supportsLots(client: PoolClient) {
    const result = await client.query<{ lots: string | null }>(`SELECT to_regclass('kai_credit_lots')::text lots`);
    return result.rows[0]?.lots !== null;
  }

  private reserveInput(input: ReserveExpiringFefoInput) {
    if (!uuid.test(input.subjectId) || !uuid.test(input.referenceId) || !uuid.test(input.transactionId)) {
      throw new Error('QIXIANG_LOT_REFERENCE_INVALID');
    }
    if (input.amountMicros <= 0n || !isCreditCentAligned(input.amountMicros)) {
      throw new Error('QIXIANG_LOT_RESERVE_AMOUNT_INVALID');
    }
    if (!idempotencyKey.test(input.idempotencyKey) || !lowerDigest.test(input.payloadDigest)) {
      throw new Error('QIXIANG_LOT_IDEMPOTENCY_INVALID');
    }
    this.date(input.now, 'QIXIANG_LOT_RESERVE_TIME_INVALID');
    this.date(input.serviceEndsAt, 'QIXIANG_LOT_SERVICE_END_INVALID');
    if (input.serviceEndsAt < input.now) throw new Error('QIXIANG_LOT_SERVICE_END_INVALID');
  }

  private date(value: Date, code: string) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(code);
  }

  private invariant(): never {
    throw new Error('QIXIANG_LOT_BALANCE_INVARIANT');
  }
}

export type CreditBalanceSnapshot = Readonly<{
  accounts: ReadonlyArray<CreditAccountBalance>;
  lots: CreditLotSnapshot;
}>;

export interface CreditBalanceSnapshotReader {
  snapshot(subjectId: string, now: Date): Promise<CreditBalanceSnapshot>;
}

export class PostgresCreditBalanceSnapshotReader implements CreditBalanceSnapshotReader {
  private readonly allocator = new CreditLotAllocator();
  constructor(private readonly database: Database,
    private readonly afterSnapshotLocked: (() => Promise<void>) | undefined = undefined) {}
  snapshot(subjectId: string, now: Date) {
    return this.database.transaction(async (client) => {
      const subject = await client.query<{ id: string }>(
        `SELECT id FROM trading_subjects WHERE id=$1 AND status='active' FOR UPDATE`, [subjectId],
      );
      if (!subject.rows[0]) throw new Error('ACTIVE_TRADING_SUBJECT_REQUIRED');
      for (const kind of ['available', 'reserved', 'supplier_receivable'] as const) {
        await client.query(
          `INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
           VALUES($1,'subject',$2,$3,$4,false)
           ON CONFLICT(subject_id,account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,
          [randomUUID(), subjectId, `subject:${subjectId}:${kind}`, kind],
        );
      }
      const locked = await client.query<{ id: string; account_kind: SubjectCreditAccountKind }>(
        `SELECT id,account_kind FROM kai_credit_accounts WHERE subject_id=$1 AND status='active'
         ORDER BY CASE WHEN account_kind IN('available','reserved') THEN 0 ELSE 1 END,id FOR UPDATE`,
        [subjectId],
      );
      if (!locked.rows.some((row) => row.account_kind === 'available')
        || !locked.rows.some((row) => row.account_kind === 'reserved')) {
        throw new Error('QIXIANG_LOT_ACCOUNTS_UNAVAILABLE');
      }
      const lots = await this.allocator.snapshot(client, subjectId, now);
      await this.afterSnapshotLocked?.();
      const balances = await client.query<AccountRow & { amount_micros: string }>(
        `SELECT a.id,a.account_kind,
          COALESCE(sum(e.amount_micros) FILTER(WHERE t.status='posted'),0)::text amount_micros
         FROM kai_credit_accounts a
         LEFT JOIN kai_credit_entries e ON e.account_id=a.id
         LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
         WHERE a.subject_id=$1 GROUP BY a.id,a.account_kind ORDER BY a.account_kind`, [subjectId],
      );
      const accounts = balances.rows.map((row) => ({ accountId: row.id,
        kind: row.account_kind as SubjectCreditAccountKind, amountMicros: BigInt(row.amount_micros) }));
      const available = accounts.find((account) => account.kind === 'available')?.amountMicros;
      if (available === undefined || available !== lots.ledgerAvailableMicros) this.invariant();
      return { accounts, lots };
    });
  }

  private invariant(): never { throw new Error('QIXIANG_LOT_BALANCE_INVARIANT'); }
}
