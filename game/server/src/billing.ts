import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { PlatformError } from './platform.ts';

export type CloudPayMode = 'disabled' | 'sandbox';
export type BillingOrderStatus = 'created' | 'reserved' | 'fulfilled' | 'settled' | 'cancelled' | 'failed';

export const CARD_HOUR_CURRENCY = 'KAI_CARD_HOUR' as const;
export const CARD_HOUR_MINOR_UNIT = 'micro-card-hour' as const;
export const CARD_HOUR_SCALE = 6 as const;

export type BillingProduct = Readonly<{
  id: string;
  name: string;
  description: string;
  delivery: 'ai-service' | 'hosting-service' | 'digital-entitlement';
  price: Readonly<{
    currency: typeof CARD_HOUR_CURRENCY;
    minorUnit: typeof CARD_HOUR_MINOR_UNIT;
    scale: typeof CARD_HOUR_SCALE;
    minorAmount: string;
    displayAmount: string;
  }>;
  gameScoreConvertible: false;
}>;

const product = (
  id: string,
  name: string,
  description: string,
  delivery: BillingProduct['delivery'],
  minorAmount: string,
): BillingProduct => Object.freeze({
  id, name, description, delivery,
  price: Object.freeze({
    currency: CARD_HOUR_CURRENCY,
    minorUnit: CARD_HOUR_MINOR_UNIT,
    scale: CARD_HOUR_SCALE,
    minorAmount,
    displayAmount: formatCardHours(minorAmount),
  }),
  gameScoreConvertible: false,
});

export const BILLING_CATALOG: readonly BillingProduct[] = Object.freeze([
  product('ai-review', 'AI 对局复盘', '生成本局关键决策、替代出法与学习建议。', 'ai-service', '50000'),
  product('advanced-ai-match', '高级 AI 对手', '开启一局更高强度、可解释的 AI 对局。', 'ai-service', '20000'),
  product('room-hosting-60m', '私人房托管 60 分钟', '为好友房提供一小时云端房间托管。', 'hosting-service', '100000'),
  product('ai-commentary', 'AI 语音解说', '为一局已完成对局生成 AI 语音解说。', 'ai-service', '80000'),
  product('season-pass', '赛季权益', '解锁本赛季专属装扮和战绩留存权益。', 'digital-entitlement', '500000'),
]);

const PRODUCTS_BY_ID = new Map(BILLING_CATALOG.map((entry) => [entry.id, entry]));

export type BillingStatusEvent = Readonly<{
  status: BillingOrderStatus;
  at: string;
  reason: string;
}>;

export type BillingOrder = {
  id: string;
  userId: string;
  productId: string;
  quantity: number;
  unitMinorAmount: string;
  totalMinorAmount: string;
  currency: typeof CARD_HOUR_CURRENCY;
  minorUnit: typeof CARD_HOUR_MINOR_UNIT;
  status: BillingOrderStatus;
  cloudPayOrderRef: string | null;
  mode: 'sandbox';
  simulated: true;
  createdAt: string;
  updatedAt: string;
  statusHistory: BillingStatusEvent[];
};

type PersistedBillingState = {
  orders: Record<string, BillingOrder>;
  idempotency: Record<string, { orderId: string; requestFingerprint: string }>;
};

type BillingEnvelope = {
  schemaVersion: 1;
  warning: 'LOCAL_SANDBOX_ONLY_NOT_A_PRODUCTION_PAYMENT_LEDGER';
  state: PersistedBillingState;
};

const initialState = (): PersistedBillingState => ({ orders: {}, idempotency: {} });
const allowedStatuses = new Set<BillingOrderStatus>(['created', 'reserved', 'fulfilled', 'settled', 'cancelled', 'failed']);
const transitions: Readonly<Record<BillingOrderStatus, readonly BillingOrderStatus[]>> = Object.freeze({
  created: ['reserved', 'cancelled', 'failed'],
  reserved: ['fulfilled', 'cancelled', 'failed'],
  fulfilled: ['settled', 'failed'],
  settled: [],
  cancelled: [],
  failed: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function validateOrder(value: unknown, field: string, expectedId?: string): asserts value is BillingOrder {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const id = requireString(value.id, `${field}.id`);
  if (expectedId && id !== expectedId) throw new Error(`${field}.id must match its key`);
  for (const key of ['userId', 'productId', 'unitMinorAmount', 'totalMinorAmount', 'createdAt', 'updatedAt']) {
    requireString(value[key], `${field}.${key}`);
  }
  if (!Number.isSafeInteger(value.quantity) || Number(value.quantity) < 1 || Number(value.quantity) > 100) {
    throw new Error(`${field}.quantity is invalid`);
  }
  if (!/^\d+$/.test(String(value.unitMinorAmount)) || !/^\d+$/.test(String(value.totalMinorAmount))) {
    throw new Error(`${field} contains an invalid minor-unit amount`);
  }
  if (value.currency !== CARD_HOUR_CURRENCY || value.minorUnit !== CARD_HOUR_MINOR_UNIT) {
    throw new Error(`${field} contains an invalid currency`);
  }
  if (!allowedStatuses.has(value.status as BillingOrderStatus)) throw new Error(`${field}.status is invalid`);
  if (value.cloudPayOrderRef !== null && typeof value.cloudPayOrderRef !== 'string') {
    throw new Error(`${field}.cloudPayOrderRef is invalid`);
  }
  if (value.mode !== 'sandbox' || value.simulated !== true) throw new Error(`${field} is not a sandbox order`);
  if (!Array.isArray(value.statusHistory) || value.statusHistory.length < 1) throw new Error(`${field}.statusHistory is invalid`);
  let previousStatus: BillingOrderStatus | null = null;
  for (const [index, event] of value.statusHistory.entries()) {
    if (!isRecord(event)) throw new Error(`${field}.statusHistory.${index} must be an object`);
    if (!allowedStatuses.has(event.status as BillingOrderStatus)) throw new Error(`${field}.statusHistory.${index}.status is invalid`);
    const eventStatus = event.status as BillingOrderStatus;
    if (index === 0 && eventStatus !== 'created') throw new Error(`${field}.statusHistory must start at created`);
    if (previousStatus && !transitions[previousStatus].includes(eventStatus)) {
      throw new Error(`${field}.statusHistory contains an invalid transition`);
    }
    requireString(event.at, `${field}.statusHistory.${index}.at`);
    requireString(event.reason, `${field}.statusHistory.${index}.reason`);
    previousStatus = eventStatus;
  }
  if (previousStatus !== value.status) throw new Error(`${field}.status does not match its history`);
  if (BigInt(String(value.unitMinorAmount)) * BigInt(Number(value.quantity)) !== BigInt(String(value.totalMinorAmount))) {
    throw new Error(`${field}.totalMinorAmount is invalid`);
  }
}

function decode(contents: string): PersistedBillingState {
  const parsed = JSON.parse(contents) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.warning !== 'LOCAL_SANDBOX_ONLY_NOT_A_PRODUCTION_PAYMENT_LEDGER') {
    throw new Error('BILLING_SANDBOX_SNAPSHOT_INVALID');
  }
  if (!isRecord(parsed.state) || !isRecord(parsed.state.orders) || !isRecord(parsed.state.idempotency)) {
    throw new Error('BILLING_SANDBOX_STATE_INVALID');
  }
  for (const [id, order] of Object.entries(parsed.state.orders)) validateOrder(order, `orders.${id}`, id);
  for (const [key, entry] of Object.entries(parsed.state.idempotency)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !isRecord(entry)) throw new Error(`idempotency.${key} is invalid`);
    const orderId = requireString(entry.orderId, `idempotency.${key}.orderId`);
    const fingerprint = requireString(entry.requestFingerprint, `idempotency.${key}.requestFingerprint`);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error(`idempotency.${key}.requestFingerprint is invalid`);
    if (!(orderId in parsed.state.orders)) throw new Error(`idempotency.${key} references an unknown order`);
  }
  return parsed.state as PersistedBillingState;
}

async function atomicWrite(path: string, contents: string) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export type SandboxBillingStoreOptions = Readonly<{
  writeSnapshot?: (path: string, contents: string) => Promise<void>;
}>;

type AddOrderResult =
  | { kind: 'created' | 'replayed'; order: BillingOrder }
  | { kind: 'conflict' };

type CancelOrderResult =
  | { kind: 'cancelled' | 'replayed'; order: BillingOrder }
  | { kind: 'not-found' };

function immutableOrderCopy(source: BillingOrder): BillingOrder {
  const copy = structuredClone(source);
  for (const event of copy.statusHistory) Object.freeze(event);
  Object.freeze(copy.statusHistory);
  return Object.freeze(copy);
}

export class SandboxBillingStore {
  private state = initialState();
  private transactionQueue: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly writeSnapshot: (path: string, contents: string) => Promise<void>;

  constructor(path: string, options: SandboxBillingStoreOptions = {}) {
    this.path = path;
    this.writeSnapshot = options.writeSnapshot ?? atomicWrite;
  }

  async load() {
    try {
      this.state = decode(await readFile(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = initialState();
    }
  }

  order(id: string) {
    const order = this.state.orders[id];
    return order ? immutableOrderCopy(order) : null;
  }

  private persist(nextState: PersistedBillingState) {
    const envelope: BillingEnvelope = {
      schemaVersion: 1,
      warning: 'LOCAL_SANDBOX_ONLY_NOT_A_PRODUCTION_PAYMENT_LEDGER',
      state: nextState,
    };
    const snapshot = `${JSON.stringify(envelope, null, 2)}\n`;
    decode(snapshot);
    return this.writeSnapshot(this.path, snapshot);
  }

  private exclusive<T>(operation: () => Promise<T>) {
    const result = this.transactionQueue.then(operation, operation);
    this.transactionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  addDurably(order: BillingOrder, keyHash: string, requestFingerprint: string): Promise<AddOrderResult> {
    const candidate = structuredClone(order);
    return this.exclusive(async () => {
      const previous = this.state.idempotency[keyHash];
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) return { kind: 'conflict' };
        const previousOrder = this.state.orders[previous.orderId];
        if (!previousOrder) throw new Error('BILLING_IDEMPOTENCY_ORDER_MISSING');
        return { kind: 'replayed', order: immutableOrderCopy(previousOrder) };
      }
      if (this.state.orders[candidate.id]) throw new Error('BILLING_ORDER_DUPLICATE');

      const nextState = structuredClone(this.state);
      nextState.orders[candidate.id] = candidate;
      nextState.idempotency[keyHash] = { orderId: candidate.id, requestFingerprint };
      await this.persist(nextState);
      this.state = nextState;
      return { kind: 'created', order: immutableOrderCopy(nextState.orders[candidate.id]!) };
    });
  }

  cancelDurably(userId: string, id: string): Promise<CancelOrderResult> {
    return this.exclusive(async () => {
      const current = this.state.orders[id];
      if (!current || current.userId !== userId) return { kind: 'not-found' };
      if (current.status === 'cancelled') return { kind: 'replayed', order: immutableOrderCopy(current) };

      const nextState = structuredClone(this.state);
      const nextOrder = nextState.orders[id]!;
      transitionOrder(nextOrder, 'cancelled', 'cancelled by player in local sandbox');
      await this.persist(nextState);
      this.state = nextState;
      return { kind: 'cancelled', order: immutableOrderCopy(nextOrder) };
    });
  }
}

export function formatCardHours(minorAmount: string) {
  if (!/^\d+$/.test(minorAmount)) throw new Error('CARD_HOUR_MINOR_AMOUNT_INVALID');
  const value = BigInt(minorAmount);
  const scale = 1_000_000n;
  return `${value / scale}.${String(value % scale).padStart(CARD_HOUR_SCALE, '0')}`;
}

export function transitionOrder(order: BillingOrder, next: BillingOrderStatus, reason: string, at = new Date().toISOString()) {
  if (!transitions[order.status].includes(next)) throw new PlatformError(409, 'BILLING_STATUS_TRANSITION_INVALID', `订单不能从 ${order.status} 变为 ${next}。`);
  order.status = next;
  order.updatedAt = at;
  order.statusHistory.push({ status: next, at, reason });
  return order;
}

function idempotencyKeyHash(userId: string, key: string) {
  return createHash('sha256').update(`${userId}\0${key}`).digest('hex');
}

function requestFingerprint(productId: string, quantity: number) {
  return createHash('sha256').update(JSON.stringify({ productId, quantity })).digest('hex');
}

function validateIdempotencyKey(key: string | undefined) {
  if (!key || key.length < 8 || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new PlatformError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 位有效 Idempotency-Key。');
  }
  return key;
}

export class CloudPayBillingService {
  readonly mode: CloudPayMode;
  private readonly store: SandboxBillingStore;

  constructor(mode: CloudPayMode, store: SandboxBillingStore) {
    this.mode = mode;
    this.store = store;
  }

  catalog() {
    return Object.freeze({
      mode: this.mode,
      enabled: this.mode === 'sandbox',
      sandbox: this.mode === 'sandbox',
      currency: CARD_HOUR_CURRENCY,
      minorUnit: CARD_HOUR_MINOR_UNIT,
      scale: CARD_HOUR_SCALE,
      products: BILLING_CATALOG,
      gameScoreConversion: 'forbidden' as const,
    });
  }

  private requireSandbox() {
    if (this.mode !== 'sandbox') {
      throw new PlatformError(503, 'CLOUDPAY_BILLING_DISABLED', '卡时计费尚未启用；当前不会创建订单或扣减卡时。');
    }
  }

  async createOrder(userId: string, input: Readonly<{ productId: string; quantity?: number; idempotencyKey?: string }>) {
    this.requireSandbox();
    const key = validateIdempotencyKey(input.idempotencyKey);
    const productEntry = PRODUCTS_BY_ID.get(input.productId);
    if (!productEntry) throw new PlatformError(400, 'BILLING_PRODUCT_INVALID', '请选择有效的卡时服务。');
    const quantity = input.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new PlatformError(400, 'BILLING_QUANTITY_INVALID', '购买数量必须是 1–100 的整数。');
    }
    const keyHash = idempotencyKeyHash(userId, key);
    const fingerprint = requestFingerprint(productEntry.id, quantity);

    const id = randomUUID();
    const now = new Date().toISOString();
    const order: BillingOrder = {
      id,
      userId,
      productId: productEntry.id,
      quantity,
      unitMinorAmount: productEntry.price.minorAmount,
      totalMinorAmount: (BigInt(productEntry.price.minorAmount) * BigInt(quantity)).toString(),
      currency: CARD_HOUR_CURRENCY,
      minorUnit: CARD_HOUR_MINOR_UNIT,
      status: 'created',
      cloudPayOrderRef: null,
      mode: 'sandbox',
      simulated: true,
      createdAt: now,
      updatedAt: now,
      statusHistory: [{ status: 'created', at: now, reason: 'sandbox order created' }],
    };
    order.cloudPayOrderRef = `sandbox-local:${id}`;
    transitionOrder(order, 'reserved', 'local sandbox reservation; no CloudPay request was sent', now);
    const result = await this.store.addDurably(order, keyHash, fingerprint);
    if (result.kind === 'conflict') {
      throw new PlatformError(409, 'IDEMPOTENCY_KEY_REUSED', '同一 Idempotency-Key 不能用于不同订单参数。');
    }
    return { order: result.order, replayed: result.kind === 'replayed' };
  }

  order(userId: string, id: string) {
    this.requireSandbox();
    const order = this.store.order(id);
    if (!order || order.userId !== userId) throw new PlatformError(404, 'BILLING_ORDER_NOT_FOUND', '订单不存在。');
    return order;
  }

  async cancelOrder(userId: string, id: string) {
    this.requireSandbox();
    const result = await this.store.cancelDurably(userId, id);
    if (result.kind === 'not-found') throw new PlatformError(404, 'BILLING_ORDER_NOT_FOUND', '订单不存在。');
    return { order: result.order, replayed: result.kind === 'replayed' };
  }
}

export const sandboxWarning = Object.freeze({
  simulated: true,
  warning: 'SANDBOX ONLY：没有调用 cloudpay.kai.com，也没有锁定、扣减或结算真实卡时。',
});
