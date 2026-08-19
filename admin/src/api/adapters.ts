import type {
  ActivityItem,
  ComputeOrder,
  Dashboard,
  DeviceOrder,
  Me,
  Metric,
  Page,
  Payout,
  Topup,
} from './contracts';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`ADMIN_API_INVALID_${label}`);
  }
  return value as UnknownRecord;
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    : [];
}

function pick(source: UnknownRecord, keys: readonly string[], fallback = ''): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function adaptMe(payload: unknown): Me {
  const root = record(payload, 'ME');
  const admin = record(root.admin, 'ADMIN');
  const session = record(root.session, 'SESSION');
  const permissions = strings(admin.permissions ?? root.permissions);
  const roles = strings(admin.roles ?? root.roles);
  const csrfToken = string(root.csrfToken);
  if (!csrfToken || permissions.length === 0 || roles.length === 0) {
    throw new Error('ADMIN_API_INVALID_ME');
  }

  return {
    admin: {
      displayName: string(admin.displayName, '管理员'),
      email: nullableString(admin.email),
      roles,
      permissions,
      authzVersion: number(admin.authzVersion),
    },
    session: {
      createdAt: string(session.createdAt),
      idleExpiresAt: string(session.idleExpiresAt ?? session.expiresAt),
      absoluteExpiresAt: string(session.absoluteExpiresAt ?? session.expiresAt),
      reauthenticatedAt: nullableString(session.reauthenticatedAt),
    },
    csrfToken,
  };
}

function integerString(value: unknown, fallback = '0'): string {
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return fallback;
}

function metric(key: string, label: string, source: unknown, detailLabel: string): Metric {
  const item = record(source, `METRIC_${key}`);
  const total = number(item.total);
  const attention = number(item.active ?? item.pending ?? item.attentionRequired);
  return {
    key,
    label,
    value: String(total),
    detail: `${detailLabel} ${attention}`,
    tone: attention > 0 ? 'warning' : 'neutral',
  };
}

function adaptMetrics(value: unknown): readonly Metric[] {
  const metrics = record(value, 'METRICS');
  return [
    metric('computeOrders', '算力订单', metrics.computeOrders, '活跃'),
    metric('deviceOrders', '设备订单', metrics.deviceOrders, '活跃'),
    metric('payouts', '提现', metrics.payouts, '待处理'),
    metric('topups', '充值', metrics.topups, '需关注'),
  ];
}

function adaptActivity(value: unknown, index: number): ActivityItem {
  const item = record(value, 'ACTIVITY');
  const resource = string(item.resource);
  const resourceLabel = ({
    'compute-order': '算力订单',
    'device-order': '设备订单',
    payout: '提现申请',
    topup: '充值记录',
  } as Readonly<Record<string, string>>)[resource];
  const displayId = pick(item, ['displayId', 'id'], `activity-${index}`);
  return {
    id: pick(item, ['id', 'eventId'], `activity-${index}`),
    title: resourceLabel ? `${resourceLabel} · ${displayId}`
      : pick(item, ['title', 'action', 'eventType'], '业务活动'),
    detail: nullableString(item.detail ?? item.description)
      ?? (resourceLabel ? '业务状态已更新' : null),
    status: nullableString(item.status),
    occurredAt: pick(item, ['occurredAt', 'createdAt', 'timestamp']),
  };
}

export function adaptDashboard(payload: unknown): Dashboard {
  const root = record(payload, 'DASHBOARD');
  return {
    metrics: adaptMetrics(root.metrics),
    activity: array(root.activity).map(adaptActivity),
  };
}

function page<T>(payload: unknown, adapter: (value: unknown) => T): Page<T> {
  const root = record(payload, 'PAGE');
  return {
    items: array(root.items).map(adapter),
    nextCursor: nullableString(root.nextCursor),
  };
}

export function adaptComputeOrders(payload: unknown): Page<ComputeOrder> {
  return page(payload, (value) => {
    const item = record(value, 'COMPUTE_ORDER');
    return {
      id: pick(item, ['id', 'orderId']),
      orderNumber: pick(item, ['orderNumber'], ''),
      status: pick(item, ['status'], 'unknown'),
      quantity: pick(item, ['quantity'], '0'),
      capacityUnit: pick(item, ['capacityUnit'], ''),
      totalCreditMicros: integerString(item.totalCreditMicros),
      createdAt: pick(item, ['createdAt']),
      updatedAt: pick(item, ['updatedAt']),
    };
  });
}

export function adaptDeviceOrders(payload: unknown): Page<DeviceOrder> {
  return page(payload, (value) => {
    const item = record(value, 'DEVICE_ORDER');
    return {
      id: pick(item, ['id', 'orderId']),
      orderNumber: pick(item, ['orderNumber'], ''),
      status: pick(item, ['status'], 'unknown'),
      quantity: pick(item, ['quantity'], '0'),
      grossCreditMicros: integerString(item.grossCreditMicros),
      createdAt: pick(item, ['createdAt']),
      updatedAt: pick(item, ['updatedAt']),
    };
  });
}

export function adaptPayouts(payload: unknown): Page<Payout> {
  return page(payload, (value) => {
    const item = record(value, 'PAYOUT');
    return {
      id: pick(item, ['id', 'payoutId']),
      payoutNumber: pick(item, ['payoutNumber'], ''),
      status: pick(item, ['status'], 'unknown'),
      creditMicros: integerString(item.creditMicros),
      paymentAmountCents: integerString(item.paymentAmountCents),
      createdAt: pick(item, ['createdAt']),
      updatedAt: pick(item, ['updatedAt']),
    };
  });
}

export function adaptTopups(payload: unknown): Page<Topup> {
  return page(payload, (value) => {
    const item = record(value, 'TOPUP');
    return {
      id: pick(item, ['id']),
      provider: pick(item, ['provider'], ''),
      status: pick(item, ['status'], 'unknown'),
      amountCents: integerString(item.amountCents),
      currency: pick(item, ['currency'], ''),
      creditMicros: integerString(item.creditMicros),
      reversedAmountCents: integerString(item.reversedAmountCents),
      reversedCreditMicros: integerString(item.reversedCreditMicros),
      createdAt: pick(item, ['createdAt']),
      updatedAt: pick(item, ['updatedAt']),
    };
  });
}
