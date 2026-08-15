import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptPii } from '../src/account/crypto.js';
import type { AccountStore } from '../src/account/store.js';
import type { AccountPrincipal, DeviceDescriptor } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import { NotificationService } from '../src/notifications/service.js';
import type { NotificationStore } from '../src/notifications/store.js';
import type { DeviceInstallationRecord, NotificationRecord } from '../src/notifications/types.js';

const piiKey = Buffer.alloc(32, 6).toString('base64');
const environment = {
  NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://api.cloudpay.kai.com', DATABASE_URL: 'postgresql://test/cloudpay',
  ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32),
  AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'e'.repeat(32), PII_ENCRYPTION_KEY: piiKey,
  PUSH_PROVIDER: 'expo', PUSH_CREDENTIALS_JSON: `{"accessToken":"${'p'.repeat(40)}"}`,
} as const;
const principal: AccountPrincipal = { userId: randomUUID(), sessionId: randomUUID(), role: 'member' };
const device: DeviceDescriptor = { deviceId: 'device-installation-001', platform: 'android', appVersion: '1.0.0' };

class MemoryNotificationStore implements NotificationStore {
  notifications: NotificationRecord[] = [];
  installationInput: Parameters<NotificationStore['upsertInstallation']>[0] | null = null;
  installation: DeviceInstallationRecord | null = null;

  async list(input: Parameters<NotificationStore['list']>[0]) {
    return this.notifications
      .filter((row) => row.userId === input.userId)
      .filter((row) => !input.category || row.category === input.category)
      .filter((row) => !input.unreadOnly || !row.readAt)
      .slice(0, input.limit);
  }
  async countUnread(userId: string) { return this.notifications.filter((row) => row.userId === userId && !row.readAt).length; }
  async markRead(userId: string, notificationId: string, readAt: Date) {
    const index = this.notifications.findIndex((row) => row.id === notificationId && row.userId === userId);
    if (index < 0) return false;
    this.notifications[index] = { ...this.notifications[index]!, readAt: this.notifications[index]!.readAt ?? readAt };
    return true;
  }
  async markAllRead(userId: string, readAt: Date) {
    let count = 0;
    this.notifications = this.notifications.map((row) => {
      if (row.userId !== userId || row.readAt) return row;
      count += 1;
      return { ...row, readAt };
    });
    return count;
  }
  async upsertInstallation(input: Parameters<NotificationStore['upsertInstallation']>[0]) {
    this.installationInput = input;
    this.installation = {
      id: randomUUID(), userId: input.userId, deviceId: input.deviceId, platform: input.platform,
      pushEnabled: true, locale: input.locale, timezone: input.timezone, appVersion: input.appVersion, updatedAt: new Date(),
    };
    return this.installation;
  }
  async disableInstallation(userId: string, deviceId: string) {
    if (!this.installation || this.installation.userId !== userId || this.installation.deviceId !== deviceId) return false;
    this.installation = { ...this.installation, pushEnabled: false };
    return true;
  }
  async findInstallation(userId: string, deviceId: string) {
    return this.installation?.userId === userId && this.installation.deviceId === deviceId ? this.installation : null;
  }
}

function harness() {
  const store = new MemoryNotificationStore();
  const audits: string[] = [];
  const accounts = { recordAudit: async (input: { action: string }) => { audits.push(input.action); } } as unknown as AccountStore;
  const service = new NotificationService(store, accounts, loadConfig(environment), () => new Date('2026-08-11T15:00:00.000Z'));
  return { store, audits, service };
}

describe('notification center', () => {
  it('returns only the current user messages, tracks unread state, and rejects forged cursors', async () => {
    const { store, service } = harness();
    store.notifications = [
      { id: randomUUID(), userId: principal.userId, category: 'payment', title: '支付成功', body: '订单已付款', data: {}, readAt: null, createdAt: new Date() },
      { id: randomUUID(), userId: randomUUID(), category: 'account', title: '其他用户', body: '不可见', data: {}, readAt: null, createdAt: new Date() },
    ];
    const result = await service.list(principal, { unreadOnly: true });
    expect(result.notifications).toHaveLength(1);
    expect(result.unreadCount).toBe(1);
    await service.markRead(principal, result.notifications[0]!.id);
    expect(await service.unreadCount(principal)).toBe(0);
    await expect(service.list(principal, { cursor: 'forged.cursor' })).rejects.toMatchObject({ code: 'PAGINATION_CURSOR_INVALID' });
  });

  it('encrypts push tokens, binds registration to the authenticated device, and supports opt-out', async () => {
    const { store, audits, service } = harness();
    const pushToken = 'ExponentPushToken[secure-device-token-123456789]';
    const installation = await service.registerPush(principal, device, {
      pushToken, locale: 'zh-cn', timezone: 'Asia/Shanghai',
    }, { requestId: 'push-1', ip: '203.0.113.20' });
    expect(installation.deviceId).toBe(device.deviceId);
    expect(installation.locale).toBe('zh-CN');
    expect(store.installationInput?.pushTokenCiphertext).not.toContain(pushToken);
    expect(decryptPii(store.installationInput!.pushTokenCiphertext, piiKey)).toBe(pushToken);
    expect(store.installationInput?.pushTokenLookupHash).not.toContain(pushToken);
    expect(await service.disablePush(principal, device, { requestId: 'push-2', ip: '203.0.113.20' })).toEqual({ disabled: true });
    expect(audits).toEqual(['PUSH_REGISTERED', 'PUSH_DISABLED']);
    expect(await service.pushStatus(principal, device)).toMatchObject({ providerAvailable: true, pushEnabled: false });
  });

  it('does not pretend push registration succeeded when no delivery provider is configured', async () => {
    const store = new MemoryNotificationStore();
    const service = new NotificationService(store, {} as AccountStore, loadConfig({ ...environment, PUSH_PROVIDER: undefined, PUSH_CREDENTIALS_JSON: undefined }));
    await expect(service.registerPush(principal, device, {
      pushToken: 'ExponentPushToken[secure-device-token-123456789]', locale: 'zh-CN', timezone: 'Asia/Shanghai',
    }, { requestId: 'push-off', ip: '127.0.0.1' })).rejects.toMatchObject({ code: 'PUSH_PROVIDER_UNAVAILABLE' });
    expect(store.installationInput).toBeNull();
  });
});
