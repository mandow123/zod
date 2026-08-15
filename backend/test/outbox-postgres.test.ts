import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresRefundOutboxStore } from '../src/outbox/store.js';

function result<T>(value: Results<T>) {
  return { ...value, rowCount: value.rows.length || value.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite) {
  return {
    health: async () => true,
    query: async (text: string, values?: unknown[]) => result(await pglite.query(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => work({
      query: async (text: string, values?: unknown[]) => result(await transaction.query(text, values)),
    } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

describe('refund outbox recovery', () => {
  it('leases jobs, schedules reconciliation, and dead-letters repeated provider failures', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of [
      '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
      '0004_payment_references.sql', '0005_notification_installations.sql', '0006_refund_workflow.sql',
      '0007_refund_execution.sql',
    ]) {
      await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    }
    const database = adapter(pglite);
    const store = new PostgresRefundOutboxStore(database);
    const jobId = randomUUID();
    const refundId = randomUUID();
    const now = new Date('2026-08-11T15:00:00.000Z');
    await database.query(
      `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload, available_at, created_at)
       VALUES ($1, 'refund.execute', 'REFUND', $2, $3::jsonb, $4, $4)`,
      [jobId, refundId, JSON.stringify({ refundId }), now],
    );
    const claimed = await store.claim(now, new Date(now.getTime() - 300_000), 10);
    expect(claimed).toEqual([{
      id: jobId, topic: 'refund.execute', aggregateId: refundId, payload: { refundId }, attempts: 0, createdAt: now,
    }]);
    const reconcileAt = new Date(now.getTime() + 300_000);
    await store.reschedule(jobId, 'refund.reconcile', reconcileAt);
    expect(await store.claim(now, new Date(now.getTime() - 300_000), 10)).toEqual([]);
    expect((await store.claim(reconcileAt, new Date(reconcileAt.getTime() - 300_000), 10))[0]?.topic).toBe('refund.reconcile');

    let deadLettered = false;
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const failure = await store.fail(jobId, 'REFUND_PROVIDER_TEMPORARY_FAILURE', new Date(reconcileAt.getTime() + attempt * 1000), 12);
      deadLettered = failure.deadLettered;
      expect(failure.attempts).toBe(attempt);
    }
    expect(deadLettered).toBe(true);
    expect(await store.claim(new Date(reconcileAt.getTime() + 60_000), new Date(reconcileAt.getTime() - 300_000), 10)).toEqual([]);
    const persisted = await database.query<{ attempts: number; dead_lettered_at: Date | null; last_error: string }>(
      `SELECT attempts, dead_lettered_at, last_error FROM outbox_events WHERE id = $1`, [jobId],
    );
    expect(persisted.rows[0]?.attempts).toBe(12);
    expect(persisted.rows[0]?.dead_lettered_at).not.toBeNull();
    expect(persisted.rows[0]?.last_error).toBe('REFUND_PROVIDER_TEMPORARY_FAILURE');
    await database.close();
  });
});
