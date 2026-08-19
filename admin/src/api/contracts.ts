export type AdminPermission = string;

export type AdminIdentity = Readonly<{
  displayName: string;
  email: string | null;
  roles: readonly string[];
  permissions: readonly AdminPermission[];
  authzVersion: number;
}>;

export type AdminSession = Readonly<{
  createdAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  reauthenticatedAt: string | null;
}>;

export type Me = Readonly<{
  admin: AdminIdentity;
  session: AdminSession;
  csrfToken: string;
}>;

export type Metric = Readonly<{
  key: string;
  label: string;
  value: string;
  detail: string | null;
  tone: 'neutral' | 'positive' | 'warning' | 'critical';
}>;

export type ActivityItem = Readonly<{
  id: string;
  title: string;
  detail: string | null;
  status: string | null;
  occurredAt: string;
}>;

export type Dashboard = Readonly<{
  metrics: readonly Metric[];
  activity: readonly ActivityItem[];
}>;

export type ComputeOrder = Readonly<{
  id: string;
  orderNumber: string;
  status: string;
  quantity: string;
  capacityUnit: string;
  totalCreditMicros: string;
  createdAt: string;
  updatedAt: string;
}>;

export type DeviceOrder = Readonly<{
  id: string;
  orderNumber: string;
  status: string;
  quantity: string;
  grossCreditMicros: string;
  createdAt: string;
  updatedAt: string;
}>;

export type Payout = Readonly<{
  id: string;
  payoutNumber: string;
  status: string;
  creditMicros: string;
  paymentAmountCents: string;
  createdAt: string;
  updatedAt: string;
}>;

export type Topup = Readonly<{
  id: string;
  provider: string;
  status: string;
  amountCents: string;
  currency: string;
  creditMicros: string;
  reversedAmountCents: string;
  reversedCreditMicros: string;
  createdAt: string;
  updatedAt: string;
}>;

export type Page<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
}>;

export type ListQuery = Readonly<{
  cursor?: string;
  limit?: number;
}>;
