import { apiRequest } from './api-client';

type StagingEnvelope = Readonly<{
  ok: true;
  environment: 'staging';
  simulation: true;
  requestId: string;
}>;

export type StagingBalance = Readonly<{
  unit: 'KAI_CARD_HOUR'; precision: 2; available: string; reserved: string; total: string; version: number;
}>;
export type StagingTopupStatus = 'processing' | 'succeeded' | 'failed' | 'canceled';
export type StagingTopup = Readonly<{
  id: string;
  paymentAmount: string;
  currency: 'CNY';
  creditAmount: string;
  status: StagingTopupStatus;
  channel: 'demo';
  version: number;
  allowedActions: Array<'refresh' | 'view_balance' | 'create_new'>;
  createdAt: string;
  updatedAt: string;
}>;

export type StagingCatalogItem = Readonly<{
  id: string;
  simulation: true;
  title: string;
  productCode: string;
  region: string;
  specifications: Readonly<Record<string, unknown>>;
  capacityUnit: 'GPU时';
  unitPriceCredits: string;
  capacityAvailable: string;
  purchasable: boolean;
  auditLabel: string;
  inventoryLabel: string;
  version: number;
  updatedAt: string;
}>;

export type StagingOrderStatus = 'reserved' | 'canceled' | 'acceptance_pending' | 'accepted'
  | 'refunded' | 'disputed' | 'failed';
export type StagingFulfillmentStatus = 'queued' | 'provisioning' | 'ready' | 'running'
  | 'disconnected' | 'stopping' | 'stopped' | 'failed';
export type StagingOrderAction = 'cancel' | 'access_preview' | 'request_stop' | 'accept' | 'open_dispute' | 'submit_manual_delivery';
export type StagingOrder = Readonly<{
  id: string;
  number: string;
  status: StagingOrderStatus;
  version: number;
  listingSnapshot: Readonly<{
    id: string;
    title: string;
    productCode: string;
    region: string;
    specifications: Readonly<Record<string, unknown>>;
    simulation: true;
  }>;
  quantity: string;
  capacityUnit: 'GPU时';
  unitPriceCredits: string;
  totalCredits: string;
  reservedCredits: string;
  fulfillment: Readonly<{
    status: StagingFulfillmentStatus;
    connectionStatus: 'not_available' | 'ready' | 'connected' | 'disconnected' | 'stopped';
  }>;
  metering: null | Readonly<{
    reservedCredits: string;
    consumedCredits: string;
    refundableCredits: string;
    measuredAt: string;
    evidenceRef: string;
  }>;
  manualDeliveryRequest: null | Readonly<{
    id: string; status: 'submitted' | 'key_verified' | 'provisioning' | 'ready' | 'rejected' | 'canceled';
    version: number; key: Readonly<{ id: string; label: string; algorithm: string; fingerprint: string }>;
    allowedActions: never[]; createdAt: string; updatedAt: string;
  }>;
  allowedActions: StagingOrderAction[];
  createdAt: string;
  updatedAt: string;
}>;

export type StagingAccessPreview = Readonly<{
  mode: 'demo_terminal';
  headline: '测试终端已就绪';
  connectable: false;
  copyAllowed: false;
  terminalScript: string[];
}>;

export type StagingCommissionStatus = 'attributed' | 'refund_observation' | 'available' | 'reversed' | 'transferred';
export type StagingCommission = Readonly<{
  id: string;
  orderKind: 'staging_compute_order';
  orderId: string;
  status: StagingCommissionStatus;
  commissionCardHours: string;
  completedAt: string | null;
  availableAt: string | null;
  createdAt: string;
  updatedAt: string;
  simulation: true;
  allowedActions: Array<'transfer'>;
}>;
export type StagingCommissionLedger = Readonly<{
  unit: 'KAI_CARD_HOUR';
  precision: 2;
  policy: Readonly<{ version: 'staging-demo-v1'; commissionBasisPoints: 100; observationDays: 7 }>;
  balances: Readonly<{ pendingCardHours: string; availableCardHours: string; transferredCardHours: string }>;
  commissions: StagingCommission[];
  allowedActions: Array<'transfer'>;
}>;
export type StagingRewardEvent = Readonly<{
  eventId: string;
  transferId: string;
  cardHours: string;
  status: 'pending' | 'consumed';
  createdAt: string;
  consumedAt: string | null;
  simulation: true;
  allowedActions: Array<'consume'>;
}>;

const auth = { auth: 'none' as const };
const mutation = (key: string, body: unknown) => ({
  method: 'POST' as const,
  auth: 'none' as const,
  headers: { 'Idempotency-Key': key },
  body,
  retry: false,
});

export async function loadStagingBalance() {
  const response = await apiRequest<StagingEnvelope & { balance: StagingBalance }>('/mobile/v1/staging/balance', auth);
  return response.balance;
}

export async function loadStagingTopups() {
  const response = await apiRequest<StagingEnvelope & { items: StagingTopup[]; nextCursor: string | null }>(
    '/mobile/v1/staging/topups?limit=50', auth,
  );
  return response.items;
}

export async function loadStagingTopup(id: string) {
  const response = await apiRequest<StagingEnvelope & { topup: StagingTopup }>(
    `/mobile/v1/staging/topups/${encodeURIComponent(id)}`, auth,
  );
  return response.topup;
}

export async function createStagingTopup(amount: string, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { topup: StagingTopup }>(
    '/mobile/v1/staging/topups', mutation(idempotencyKey, { amount }),
  );
  return response.topup;
}

export async function loadStagingCatalog(query = '') {
  const search = new URLSearchParams({ limit: '50' });
  if (query.trim()) search.set('query', query.trim());
  const response = await apiRequest<StagingEnvelope & { items: StagingCatalogItem[]; nextCursor: string | null }>(
    `/mobile/v1/staging/catalog?${search.toString()}`, auth,
  );
  return response.items;
}

export async function loadStagingOrders() {
  const response = await apiRequest<StagingEnvelope & { items: StagingOrder[]; nextCursor: string | null }>(
    '/mobile/v1/staging/compute-orders?limit=50', auth,
  );
  return response.items;
}

export async function loadStagingOrder(id: string) {
  const response = await apiRequest<StagingEnvelope & { order: StagingOrder }>(
    `/mobile/v1/staging/compute-orders/${encodeURIComponent(id)}`, auth,
  );
  return response.order;
}

export async function createStagingOrder(listingId: string, quantity: string, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { order: StagingOrder; balance: StagingBalance }>(
    '/mobile/v1/staging/compute-orders', mutation(idempotencyKey, { listingId, quantity }),
  );
  return response;
}

type StagingOrderVersionRef = Pick<StagingOrder, 'id' | 'version'>;

export async function cancelStagingOrder(order: StagingOrderVersionRef, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { order: StagingOrder; balance: StagingBalance }>(
    `/mobile/v1/staging/compute-orders/${encodeURIComponent(order.id)}/cancel`,
    mutation(idempotencyKey, { expectedVersion: order.version }),
  );
  return response;
}

export async function requestStagingOrderStop(order: StagingOrderVersionRef, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { order: StagingOrder }>(
    `/mobile/v1/staging/compute-orders/${encodeURIComponent(order.id)}/request-stop`,
    mutation(idempotencyKey, { expectedVersion: order.version }),
  );
  return response.order;
}

export async function acceptStagingOrder(order: StagingOrderVersionRef, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { order: StagingOrder; balance: StagingBalance }>(
    `/mobile/v1/staging/compute-orders/${encodeURIComponent(order.id)}/accept`,
    mutation(idempotencyKey, { expectedVersion: order.version }),
  );
  return response;
}

export async function disputeStagingOrder(order: StagingOrderVersionRef, category: 'access' | 'metering' | 'disconnect' | 'other',
  description: string, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { order: StagingOrder }>(
    `/mobile/v1/staging/compute-orders/${encodeURIComponent(order.id)}/disputes`,
    mutation(idempotencyKey, { expectedVersion: order.version, category, description }),
  );
  return response.order;
}

export async function loadStagingAccessPreview(orderId: string) {
  const response = await apiRequest<StagingEnvelope & { accessPreview: StagingAccessPreview }>(
    `/mobile/v1/staging/compute-orders/${encodeURIComponent(orderId)}/access-preview`, auth,
  );
  const preview = response.accessPreview;
  const allowedKeys = new Set(['mode', 'headline', 'connectable', 'copyAllowed', 'terminalScript']);
  const safeTerminalScript = ['欢迎进入 Zod 测试终端', '当前不会连接真实节点，也不会执行命令。'];
  if (preview.mode !== 'demo_terminal' || preview.connectable !== false || preview.copyAllowed !== false
    || preview.headline !== '测试终端已就绪'
    || Object.keys(preview).some((key) => !allowedKeys.has(key))
    || !Array.isArray(preview.terminalScript) || preview.terminalScript.length !== safeTerminalScript.length
    || preview.terminalScript.some((line, index) => line !== safeTerminalScript[index])) {
    throw new Error('模拟终端返回了不允许显示的连接字段。');
  }
  return preview;
}

export async function loadStagingCommissions() {
  return apiRequest<StagingEnvelope & StagingCommissionLedger>('/mobile/v1/staging/creator/commissions', auth);
}

export async function transferStagingCommissions(idempotencyKey: string) {
  return apiRequest<StagingEnvelope & { transfer: { cardHours: string; rewardEvent: StagingRewardEvent }; balance: StagingBalance }>(
    '/mobile/v1/staging/creator/commissions/transfer', mutation(idempotencyKey, {}),
  );
}

export async function loadStagingRewards() {
  const response = await apiRequest<StagingEnvelope & { events: StagingRewardEvent[] }>(
    '/mobile/v1/staging/creator/reward-events?limit=20', auth,
  );
  return response.events;
}

export async function consumeStagingReward(eventId: string, idempotencyKey: string) {
  const response = await apiRequest<StagingEnvelope & { event: StagingRewardEvent }>(
    `/mobile/v1/staging/creator/reward-events/${encodeURIComponent(eventId)}/consume`,
    mutation(idempotencyKey, {}),
  );
  return response.event;
}
