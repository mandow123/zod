import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresNotificationStore } from '../src/notifications/store.js';

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

describe('PostgreSQL notification ownership', () => {
  it('isolates inboxes and atomically reassigns a push token to its current device', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    for (const name of [
      '0001_cloudpay_ledger.sql', '0002_refresh_rotation.sql', '0003_market_reservations.sql',
      '0004_payment_references.sql', '0005_notification_installations.sql',
    ]) {
      await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
    }
    const database = adapter(pglite);
    const store = new PostgresNotificationStore(database);
    const firstUser = randomUUID();
    const secondUser = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name) VALUES ($1, 'cipher-1', '用户一'), ($2, 'cipher-2', '用户二')`,
      [firstUser, secondUser],
    );
    const firstMessage = randomUUID();
    await database.query(
      `INSERT INTO notifications(id, user_id, category, title, body) VALUES
       ($1, $2, 'payment', '支付成功', '订单已付款'), ($3, $4, 'account', '账户消息', '仅用户二可见')`,
      [firstMessage, firstUser, randomUUID(), secondUser],
    );
    expect(await store.countUnread(firstUser)).toBe(1);
    expect(await store.list({ userId: firstUser, unreadOnly: false, cursor: null, limit: 20 })).toHaveLength(1);
    expect(await store.markRead(secondUser, firstMessage, new Date())).toBe(false);
    expect(await store.markRead(firstUser, firstMessage, new Date())).toBe(true);
    expect(await store.countUnread(firstUser)).toBe(0);

    const tokenHash = 'shared-push-token-hash';
    const first = await store.upsertInstallation({
      userId: firstUser, deviceId: 'android-device-one', platform: 'android', appVersion: '1.0.0',
      pushTokenCiphertext: 'cipher-token-one', pushTokenLookupHash: tokenHash, locale: 'zh-CN', timezone: 'Asia/Shanghai',
    });
    const second = await store.upsertInstallation({
      userId: secondUser, deviceId: 'android-device-two', platform: 'android', appVersion: '1.0.0',
      pushTokenCiphertext: 'cipher-token-two', pushTokenLookupHash: tokenHash, locale: 'zh-CN', timezone: 'Asia/Shanghai',
    });
    expect(first.pushEnabled).toBe(true);
    expect(second.pushEnabled).toBe(true);
    const installations = await database.query<{ device_id: string; user_id: string; push_enabled: boolean; push_token_ciphertext: string | null }>(
      `SELECT device_id, user_id, push_enabled, push_token_ciphertext FROM device_installations ORDER BY device_id`,
    );
    expect(installations.rows).toEqual([
      { device_id: 'android-device-one', user_id: firstUser, push_enabled: false, push_token_ciphertext: null },
      { device_id: 'android-device-two', user_id: secondUser, push_enabled: true, push_token_ciphertext: 'cipher-token-two' },
    ]);
    expect(await store.disableInstallation(firstUser, 'android-device-two', 'android', new Date())).toBe(false);
    expect(await store.disableInstallation(secondUser, 'android-device-two', 'android', new Date())).toBe(true);
    await database.close();
  });
});
