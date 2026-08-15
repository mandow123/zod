import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPii } from '../src/account/crypto.js';
import { loadConfig } from '../src/config.js';
import type { PushProvider } from '../src/notifications/push-provider.js';
import type {
  PushNotificationTarget, PushOutboxJob, PushOutboxStore, ReceiptResult, TicketResult,
} from '../src/notifications/push-store.js';
import { PushProcessor } from '../src/notifications/push-worker.js';

const piiKey = Buffer.alloc(32, 5).toString('base64');
const config = loadConfig({
  NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://cloudpay.kai.com', DATABASE_URL: 'postgresql://test/cloudpay',
  ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32),
  AUDIT_PEPPER: 'd'.repeat(32), CURSOR_SECRET: 'e'.repeat(32), PII_ENCRYPTION_KEY: piiKey,
  PUSH_PROVIDER: 'expo', PUSH_CREDENTIALS_JSON: `{"accessToken":"${'p'.repeat(40)}"}`,
});

class MemoryPushStore implements PushOutboxStore {
  target: PushNotificationTarget | null = null;
  tickets: readonly TicketResult[] = [];
  receipts: readonly ReceiptResult[] = [];
  completed: string[] = [];

  async claim() { return []; }
  async loadNotification() { return this.target; }
  async recordTickets(_job: PushOutboxJob, results: readonly TicketResult[]) { this.tickets = results; }
  async recordReceipts(_job: PushOutboxJob, results: readonly ReceiptResult[]) { this.receipts = results; }
  async complete(jobId: string) { this.completed.push(jobId); }
  async fail() { return { deadLettered: false, attempts: 1 }; }
}

describe('push delivery processor', () => {
  it('sends only decrypted server-owned tokens and disables a device from the receipt result', async () => {
    const notificationId = randomUUID();
    const installationId = randomUUID();
    const token = 'ExponentPushToken[secure-device-token-123456789]';
    const store = new MemoryPushStore();
    store.target = {
      notificationId, title: '交付已完成', body: '订单可以验收', data: { orderId: randomUUID() },
      installations: [{ id: installationId, tokenCiphertext: encryptPii(token, piiKey) }],
    };
    const sent: string[] = [];
    const provider: PushProvider = {
      async send(messages) {
        sent.push(...messages.map((message) => message.to));
        return [{ status: 'ok', id: 'expo-ticket-1' }];
      },
      async receipts() {
        return { 'expo-ticket-1': { status: 'error', details: { error: 'DeviceNotRegistered' } } };
      },
    };
    const now = () => new Date('2026-08-12T01:00:00.000Z');
    const processor = new PushProcessor(store, provider, config, now);
    await processor.process({
      id: randomUUID(), topic: 'notification.created', aggregateId: notificationId,
      payload: { notificationId }, attempts: 0, createdAt: now(),
    });
    expect(sent).toEqual([token]);
    expect(store.tickets).toEqual([{ installationId, status: 'accepted', ticketId: 'expo-ticket-1' }]);

    await processor.process({
      id: randomUUID(), topic: 'push.receipt', aggregateId: notificationId,
      payload: { notificationId, receipts: [{ installationId, ticketId: 'expo-ticket-1' }] },
      attempts: 0, createdAt: now(),
    });
    expect(store.receipts).toEqual([{
      installationId, ticketId: 'expo-ticket-1', status: 'invalid_device', errorCode: 'DeviceNotRegistered',
    }]);
  });

  it('keeps in-app delivery complete when no device has enabled push', async () => {
    const store = new MemoryPushStore();
    const notificationId = randomUUID();
    store.target = { notificationId, title: '账户消息', body: '已更新', data: {}, installations: [] };
    const provider: PushProvider = {
      async send() { throw new Error('should not send'); },
      async receipts() { throw new Error('should not query'); },
    };
    const processor = new PushProcessor(store, provider, config);
    const jobId = randomUUID();
    await processor.process({
      id: jobId, topic: 'notification.created', aggregateId: notificationId,
      payload: { notificationId }, attempts: 0, createdAt: new Date(),
    });
    expect(store.completed).toEqual([jobId]);
  });
});
