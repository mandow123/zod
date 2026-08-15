import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { ListingCursor } from '../market/cursor.js';
import type { DeviceInstallationRecord, NotificationCategory, NotificationRecord } from './types.js';

type NotificationRow = QueryResultRow & {
  id: string; user_id: string; category: NotificationCategory; title: string; body: string;
  data: Record<string, unknown>; read_at: Date | null; created_at: Date;
};

type DeviceRow = QueryResultRow & {
  id: string; user_id: string; device_id: string; platform: 'android' | 'ios'; push_enabled: boolean;
  locale: string; timezone: string; app_version: string; updated_at: Date;
};

function mapNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id, userId: row.user_id, category: row.category, title: row.title, body: row.body,
    data: row.data, readAt: row.read_at ? new Date(row.read_at) : null, createdAt: new Date(row.created_at),
  };
}

function mapDevice(row: DeviceRow): DeviceInstallationRecord {
  return {
    id: row.id, userId: row.user_id, deviceId: row.device_id, platform: row.platform,
    pushEnabled: row.push_enabled, locale: row.locale, timezone: row.timezone,
    appVersion: row.app_version, updatedAt: new Date(row.updated_at),
  };
}

export interface NotificationStore {
  list(input: Readonly<{
    userId: string; category?: NotificationCategory; unreadOnly: boolean; cursor: ListingCursor | null; limit: number;
  }>): Promise<NotificationRecord[]>;
  countUnread(userId: string): Promise<number>;
  markRead(userId: string, notificationId: string, readAt: Date): Promise<boolean>;
  markAllRead(userId: string, readAt: Date): Promise<number>;
  upsertInstallation(input: Readonly<{
    userId: string; deviceId: string; platform: 'android' | 'ios'; appVersion: string;
    pushTokenCiphertext: string; pushTokenLookupHash: string; locale: string; timezone: string;
  }>): Promise<DeviceInstallationRecord>;
  disableInstallation(userId: string, deviceId: string, platform: 'android' | 'ios', disabledAt: Date): Promise<boolean>;
  findInstallation(userId: string, deviceId: string, platform: 'android' | 'ios'): Promise<DeviceInstallationRecord | null>;
}

export class PostgresNotificationStore implements NotificationStore {
  constructor(private readonly database: Database) {}

  async list(input: {
    userId: string; category?: NotificationCategory; unreadOnly: boolean; cursor: ListingCursor | null; limit: number;
  }) {
    const values: unknown[] = [input.userId];
    const conditions = ['user_id = $1'];
    const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (input.category) conditions.push(`category = ${parameter(input.category)}`);
    if (input.unreadOnly) conditions.push('read_at IS NULL');
    if (input.cursor) {
      const createdAt = parameter(input.cursor.createdAt);
      const id = parameter(input.cursor.id);
      conditions.push(`(created_at < ${createdAt} OR (created_at = ${createdAt} AND id < ${id}))`);
    }
    const limit = parameter(input.limit);
    const result = await this.database.query<NotificationRow>(
      `SELECT id, user_id, category, title, body, data, read_at, created_at
       FROM notifications WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
      values,
    );
    return result.rows.map(mapNotification);
  }

  async countUnread(userId: string) {
    const result = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async markRead(userId: string, notificationId: string, readAt: Date) {
    const result = await this.database.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, $3) WHERE id = $1 AND user_id = $2 RETURNING id`,
      [notificationId, userId, readAt],
    );
    return Boolean(result.rowCount);
  }

  async markAllRead(userId: string, readAt: Date) {
    const result = await this.database.query(
      `UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL RETURNING id`,
      [userId, readAt],
    );
    return result.rowCount ?? 0;
  }

  async upsertInstallation(input: {
    userId: string; deviceId: string; platform: 'android' | 'ios'; appVersion: string;
    pushTokenCiphertext: string; pushTokenLookupHash: string; locale: string; timezone: string;
  }) {
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.pushTokenLookupHash]);
      await client.query(
        `UPDATE device_installations SET push_enabled = false, push_token_ciphertext = NULL,
           push_token_lookup_hash = NULL, disabled_at = now()
         WHERE push_token_lookup_hash = $1 AND (device_id <> $2 OR platform <> $3)`,
        [input.pushTokenLookupHash, input.deviceId, input.platform],
      );
      const result = await client.query<DeviceRow>(
        `INSERT INTO device_installations(id, user_id, device_id, platform, push_token_ciphertext,
           push_token_lookup_hash, push_enabled, locale, timezone, app_version, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, now())
         ON CONFLICT (device_id, platform) DO UPDATE SET user_id = EXCLUDED.user_id,
           push_token_ciphertext = EXCLUDED.push_token_ciphertext,
           push_token_lookup_hash = EXCLUDED.push_token_lookup_hash, push_enabled = true,
           locale = EXCLUDED.locale, timezone = EXCLUDED.timezone, app_version = EXCLUDED.app_version,
           last_seen_at = now(), push_failure_count = 0, last_push_error = NULL, disabled_at = NULL
         RETURNING id, user_id, device_id, platform, push_enabled, locale, timezone, app_version, updated_at`,
        [randomUUID(), input.userId, input.deviceId, input.platform, input.pushTokenCiphertext,
          input.pushTokenLookupHash, input.locale, input.timezone, input.appVersion],
      );
      return mapDevice(result.rows[0]!);
    });
  }

  async disableInstallation(userId: string, deviceId: string, platform: 'android' | 'ios', disabledAt: Date) {
    const result = await this.database.query(
      `UPDATE device_installations SET push_enabled = false, push_token_ciphertext = NULL,
         push_token_lookup_hash = NULL, disabled_at = $4
       WHERE user_id = $1 AND device_id = $2 AND platform = $3 RETURNING id`,
      [userId, deviceId, platform, disabledAt],
    );
    return Boolean(result.rowCount);
  }

  async findInstallation(userId: string, deviceId: string, platform: 'android' | 'ios') {
    const result = await this.database.query<DeviceRow>(
      `SELECT id, user_id, device_id, platform, push_enabled, locale, timezone, app_version, updated_at
       FROM device_installations WHERE user_id = $1 AND device_id = $2 AND platform = $3`,
      [userId, deviceId, platform],
    );
    return result.rows[0] ? mapDevice(result.rows[0]) : null;
  }
}
