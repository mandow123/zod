import type { RuntimeConfig } from '../config.js';
import { encryptPii, lookupHash, secretHash } from '../account/crypto.js';
import type { AccountStore } from '../account/store.js';
import type { AccountPrincipal, DeviceDescriptor } from '../account/types.js';
import { AppError } from '../errors.js';
import { CursorService } from '../market/cursor.js';
import type { NotificationStore } from './store.js';
import type { NotificationCategory } from './types.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function canonicalLocale(value: string) {
  try {
    return Intl.getCanonicalLocales(value)[0] ?? 'zh-CN';
  } catch {
    throw new AppError('DEVICE_LOCALE_INVALID', 400, '设备语言设置无效。');
  }
}

function canonicalTimezone(value: string) {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format();
    return value;
  } catch {
    throw new AppError('DEVICE_TIMEZONE_INVALID', 400, '设备时区设置无效。');
  }
}

export class NotificationService {
  private readonly cursor: CursorService;
  private readonly piiKey: string;
  private readonly auditPepper: string;
  private readonly pushAvailable: boolean;

  constructor(
    private readonly store: NotificationStore,
    private readonly accountStore: AccountStore,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.cursor = new CursorService(required(config.CURSOR_SECRET, 'CURSOR_SECRET'));
    this.piiKey = required(config.PII_ENCRYPTION_KEY, 'PII_ENCRYPTION_KEY');
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
    this.pushAvailable = config.readiness.capabilities.push.available;
  }

  async list(principal: AccountPrincipal, input: {
    category?: NotificationCategory; unreadOnly?: boolean; cursor?: string; limit?: number;
  }) {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const rows = await this.store.list({
      userId: principal.userId,
      ...(input.category ? { category: input.category } : {}),
      unreadOnly: input.unreadOnly ?? false,
      cursor: this.cursor.decode(input.cursor), limit,
    });
    const last = rows.at(-1);
    return {
      notifications: rows.map((row) => ({
        id: row.id, category: row.category, title: row.title, body: row.body, data: row.data,
        read: Boolean(row.readAt), readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
      })),
      unreadCount: await this.store.countUnread(principal.userId),
      nextCursor: rows.length === limit && last
        ? this.cursor.encode({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    };
  }

  async unreadCount(principal: AccountPrincipal) {
    return this.store.countUnread(principal.userId);
  }

  async markRead(principal: AccountPrincipal, notificationId: string) {
    const found = await this.store.markRead(principal.userId, notificationId, this.now());
    if (!found) throw new AppError('NOTIFICATION_NOT_FOUND', 404, '消息不存在。');
    return { read: true };
  }

  async markAllRead(principal: AccountPrincipal) {
    return { updated: await this.store.markAllRead(principal.userId, this.now()) };
  }

  async registerPush(
    principal: AccountPrincipal,
    authenticatedDevice: DeviceDescriptor,
    input: { pushToken: string; locale: string; timezone: string },
    context: RequestContext,
  ) {
    if (!this.pushAvailable) throw new AppError('PUSH_PROVIDER_UNAVAILABLE', 503, '消息推送服务暂时不可用，应用内消息不受影响。');
    const pushToken = input.pushToken.trim();
    if (pushToken.length < 20 || pushToken.length > 4096 || /\s/u.test(pushToken)) {
      throw new AppError('PUSH_TOKEN_INVALID', 400, '设备推送凭证格式无效。');
    }
    const installation = await this.store.upsertInstallation({
      userId: principal.userId,
      deviceId: authenticatedDevice.deviceId,
      platform: authenticatedDevice.platform,
      appVersion: authenticatedDevice.appVersion,
      pushTokenCiphertext: encryptPii(pushToken, this.piiKey),
      pushTokenLookupHash: lookupHash(pushToken, this.auditPepper),
      locale: canonicalLocale(input.locale),
      timezone: canonicalTimezone(input.timezone),
    });
    await this.audit(principal, 'PUSH_REGISTERED', installation.id, context, { platform: installation.platform });
    return {
      id: installation.id, deviceId: installation.deviceId, platform: installation.platform,
      pushEnabled: installation.pushEnabled, locale: installation.locale, timezone: installation.timezone,
      appVersion: installation.appVersion, updatedAt: installation.updatedAt.toISOString(),
    };
  }

  async disablePush(
    principal: AccountPrincipal, authenticatedDevice: DeviceDescriptor, context: RequestContext,
  ) {
    const disabled = await this.store.disableInstallation(
      principal.userId, authenticatedDevice.deviceId, authenticatedDevice.platform, this.now(),
    );
    if (disabled) await this.audit(principal, 'PUSH_DISABLED', authenticatedDevice.deviceId, context, { platform: authenticatedDevice.platform });
    return { disabled };
  }

  async pushStatus(principal: AccountPrincipal, authenticatedDevice: DeviceDescriptor) {
    const installation = await this.store.findInstallation(
      principal.userId, authenticatedDevice.deviceId, authenticatedDevice.platform,
    );
    return {
      providerAvailable: this.pushAvailable,
      pushEnabled: Boolean(installation?.pushEnabled),
      installation: installation ? {
        id: installation.id, deviceId: installation.deviceId, platform: installation.platform,
        locale: installation.locale, timezone: installation.timezone,
        appVersion: installation.appVersion, updatedAt: installation.updatedAt.toISOString(),
      } : null,
    };
  }

  private async audit(
    principal: AccountPrincipal, action: string, entityId: string, context: RequestContext, metadata: Record<string, unknown>,
  ) {
    await this.accountStore.recordAudit({
      actorId: principal.userId, actorKind: 'user', action, entityType: 'DEVICE_INSTALLATION', entityId,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      payloadDigest: secretHash(JSON.stringify(metadata), this.auditPepper), metadata,
    });
  }
}
