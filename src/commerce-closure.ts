import {
  decodeQixiangTopupCapability, type QixiangTopupCapability,
} from './qixiang-topups.ts';

export const COMMERCE_CLOSURE_SERVICE = 'kai-cloudpay-backend' as const;

export type CommerceClosurePhase =
  | 'order_create_persisted'
  | 'funding_required'
  | 'wallet_opened'
  | 'funding_succeeded'
  | 'order_retry_persisted'
  | 'order_created';

export type CommerceClosurePending = Readonly<{
  schemaVersion: 1;
  subjectFingerprint: string;
  phase: CommerceClosurePhase;
  listingId: string;
  quantity: string;
  idempotencyKey: string;
  requestDigest: string;
  topupId: string | null;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type CommerceOrderStatus =
  | 'reserved' | 'confirmed' | 'provisioning' | 'ready' | 'in_service'
  | 'acceptance_pending' | 'disputed' | 'accepted' | 'release_pending' | 'refund_pending'
  | 'closed' | 'cancelled' | 'expired' | 'refunded';

export type CommerceOrderAction =
  | 'cancel_order' | 'confirm_order' | 'start_delivery'
  | 'submit_delivery' | 'accept_delivery' | 'report_delivery_issue';

export type CommerceOrder = Readonly<{
  id: string;
  orderNumber: string;
  status: CommerceOrderStatus;
  side: 'buyer' | 'provider';
  listingId: string;
  title: string;
  productCode: string | null;
  region: string | null;
  quantity: string;
  capacityUnit: string;
  unitCredits: string;
  totalCredits: string;
  reservationExpiresAt: string;
  confirmedAt: string | null;
  deliveryStartedAt: string | null;
  deliveryReadyAt: string | null;
  acceptedAt: string | null;
  settlementAvailableAt: string | null;
  actions: readonly CommerceOrderAction[];
  aftercarePolicy: Readonly<{
    model: 'metering_issue_before_acceptance' | 'delivery_aftercare';
    issueWindowHours: 24 | null;
    postAcceptanceRefundAvailable: boolean;
  }>;
  requiresAttention: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type CommerceClosureCapability = Readonly<{
  service: typeof COMMERCE_CLOSURE_SERVICE;
  profile: Readonly<{ id: 'full_commerce'; routePolicy: 'full-commerce-v1' }>;
  qixiangTopups: QixiangTopupCapability;
}>;

export type CommerceClosureGateInput = Readonly<{
  authenticated: boolean;
  readiness: unknown;
}>;

export class CommerceClosureContractError extends Error {
  constructor(code = 'COMMERCE_CLOSURE_CONTRACT_INVALID') {
    super(code); this.name = 'CommerceClosureContractError';
  }
}

export class CommerceClosurePendingIntegrityError extends Error {
  constructor(code = 'COMMERCE_CLOSURE_PENDING_INTEGRITY') {
    super(code); this.name = 'CommerceClosurePendingIntegrityError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const QUANTITY_PATTERN = /^(?:0|[1-9]\d{0,17})\.\d{6}$/u;
const CREDIT_PATTERN = /^(?:0|[1-9]\d{0,11})\.\d{2}$/u;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u;

function object(value: unknown, pending = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (pending) throw new CommerceClosurePendingIntegrityError();
    throw new CommerceClosureContractError();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], pending = false) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    if (pending) throw new CommerceClosurePendingIntegrityError();
    throw new CommerceClosureContractError();
  }
}

function text(value: unknown, maximum = 256, pending = false) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || CONTROL_PATTERN.test(value)) {
    if (pending) throw new CommerceClosurePendingIntegrityError();
    throw new CommerceClosureContractError();
  }
  return value;
}

function uuid(value: unknown, pending = false) {
  const decoded = text(value, 64, pending);
  if (!UUID_PATTERN.test(decoded)) {
    if (pending) throw new CommerceClosurePendingIntegrityError();
    throw new CommerceClosureContractError();
  }
  return decoded;
}

function utc(value: unknown, pending = false) {
  const decoded = text(value, 40, pending);
  const timestamp = Date.parse(decoded);
  if (!UTC_PATTERN.test(decoded) || Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== decoded) {
    if (pending) throw new CommerceClosurePendingIntegrityError();
    throw new CommerceClosureContractError();
  }
  return decoded;
}

function nullableText(value: unknown, maximum = 256) {
  return value === null ? null : text(value, maximum);
}

function nullableUtc(value: unknown) { return value === null ? null : utc(value); }

function blockers(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) throw new CommerceClosureContractError();
  const decoded = value.map((entry) => text(entry, 160));
  if (new Set(decoded).size !== decoded.length) throw new CommerceClosureContractError();
  return decoded;
}

function positiveQuantity(value: unknown, pending = false) {
  const decoded = text(value, 40, pending);
  if (!QUANTITY_PATTERN.test(decoded) || /^0\.0{6}$/u.test(decoded)) {
    if (pending) throw new CommerceClosurePendingIntegrityError();
    throw new CommerceClosureContractError();
  }
  return decoded;
}

function positiveCredit(value: unknown) {
  const decoded = text(value, 40);
  if (!CREDIT_PATTERN.test(decoded) || decoded === '0.00') throw new CommerceClosureContractError();
  return decoded;
}

export function decodeCommerceClosureReadiness(value: unknown): CommerceClosureCapability {
  const root = object(value);
  const profile = object(root.profile);
  const release = object(root.release);
  const commerce = object(root.commerce);
  const capabilities = object(root.capabilities);
  exactKeys(profile, ['id', 'routePolicy']);
  exactKeys(commerce, ['model', 'ready', 'implemented', 'blockers']);
  if (root.service !== COMMERCE_CLOSURE_SERVICE
    || profile.id !== 'full_commerce' || profile.routePolicy !== 'full-commerce-v1'
    || typeof release.ready !== 'boolean' || !Object.hasOwn(release, 'blockers')
    || commerce.model !== 'kai-credit-only' || typeof commerce.ready !== 'boolean'
    || typeof commerce.implemented !== 'boolean' || capabilities.creditCommerce !== true
    || !Object.hasOwn(capabilities, 'qixiangTopups')) throw new CommerceClosureContractError();
  const releaseBlockers = blockers(release.blockers);
  const commerceBlockers = blockers(commerce.blockers);
  const qixiangTopups = decodeQixiangTopupCapability(capabilities.qixiangTopups);
  if (release.ready !== true || releaseBlockers.length !== 0
    || commerce.ready !== true || commerce.implemented !== true || commerceBlockers.length !== 0
    || qixiangTopups.mode !== 'on' || qixiangTopups.available !== true
    || qixiangTopups.rails.length !== 1 || qixiangTopups.blockers.length !== 0
    || qixiangTopups.minAmountCents === null || qixiangTopups.maxAmountCents === null
    || qixiangTopups.conversion === null || qixiangTopups.checkout === null) {
    throw new CommerceClosureContractError('COMMERCE_CLOSURE_CAPABILITY_UNAVAILABLE');
  }
  return {
    service: COMMERCE_CLOSURE_SERVICE,
    profile: { id: 'full_commerce', routePolicy: 'full-commerce-v1' },
    qixiangTopups,
  };
}

export function commerceClosureGate(input: CommerceClosureGateInput): CommerceClosureCapability | null {
  if (!input.authenticated) return null;
  try { return decodeCommerceClosureReadiness(input.readiness); } catch { return null; }
}

function decodeActions(value: unknown, side: CommerceOrder['side'], status: CommerceOrderStatus) {
  if (!Array.isArray(value) || value.length > 3) throw new CommerceClosureContractError();
  const allowed = new Set<CommerceOrderAction>([
    'cancel_order', 'confirm_order', 'start_delivery', 'submit_delivery', 'accept_delivery', 'report_delivery_issue',
  ]);
  const decoded = value.map((entry) => {
    if (typeof entry !== 'string' || !allowed.has(entry as CommerceOrderAction)) {
      throw new CommerceClosureContractError();
    }
    return entry as CommerceOrderAction;
  });
  if (new Set(decoded).size !== decoded.length) throw new CommerceClosureContractError();
  const buyer = new Set<CommerceOrderAction>(['cancel_order', 'accept_delivery', 'report_delivery_issue']);
  if (decoded.some((entry) => side === 'buyer' ? !buyer.has(entry) : buyer.has(entry))) {
    throw new CommerceClosureContractError();
  }
  const actionStatus: Partial<Record<CommerceOrderAction, CommerceOrderStatus>> = {
    cancel_order: 'reserved', confirm_order: 'reserved', start_delivery: 'confirmed', submit_delivery: 'provisioning',
    accept_delivery: 'acceptance_pending', report_delivery_issue: 'acceptance_pending',
  };
  if (decoded.some((entry) => actionStatus[entry] !== status)) throw new CommerceClosureContractError();
  return decoded;
}

export function decodeCommerceOrder(value: unknown): CommerceOrder {
  const item = object(value);
  const aftercare = object(item.aftercarePolicy);
  exactKeys(item, [
    'id', 'orderNumber', 'status', 'side', 'listingId', 'title', 'productCode', 'region', 'quantity',
    'capacityUnit', 'unitCredits', 'totalCredits', 'reservationExpiresAt', 'confirmedAt', 'deliveryStartedAt',
    'deliveryReadyAt', 'acceptedAt', 'settlementAvailableAt', 'actions', 'aftercarePolicy', 'requiresAttention',
    'createdAt', 'updatedAt',
  ]);
  exactKeys(aftercare, ['model', 'issueWindowHours', 'postAcceptanceRefundAvailable']);
  const status = text(item.status, 32) as CommerceOrderStatus;
  const side = item.side as CommerceOrder['side'];
  if (![
    'reserved', 'confirmed', 'provisioning', 'ready', 'in_service', 'acceptance_pending', 'disputed', 'accepted',
    'release_pending', 'refund_pending', 'closed', 'cancelled', 'expired', 'refunded',
  ].includes(status) || !['buyer', 'provider'].includes(String(side))
    || typeof item.requiresAttention !== 'boolean') throw new CommerceClosureContractError();
  const model = aftercare.model;
  if (!((model === 'metering_issue_before_acceptance' && aftercare.issueWindowHours === 24
      && aftercare.postAcceptanceRefundAvailable === false)
    || (model === 'delivery_aftercare' && aftercare.issueWindowHours === null
      && aftercare.postAcceptanceRefundAvailable === true))) throw new CommerceClosureContractError();
  const createdAt = utc(item.createdAt); const updatedAt = utc(item.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new CommerceClosureContractError();
  return {
    id: uuid(item.id), orderNumber: text(item.orderNumber, 64), status, side, listingId: uuid(item.listingId),
    title: text(item.title, 200), productCode: nullableText(item.productCode, 120),
    region: nullableText(item.region, 120), quantity: positiveQuantity(item.quantity),
    capacityUnit: text(item.capacityUnit, 40), unitCredits: positiveCredit(item.unitCredits),
    totalCredits: positiveCredit(item.totalCredits), reservationExpiresAt: utc(item.reservationExpiresAt),
    confirmedAt: nullableUtc(item.confirmedAt), deliveryStartedAt: nullableUtc(item.deliveryStartedAt),
    deliveryReadyAt: nullableUtc(item.deliveryReadyAt), acceptedAt: nullableUtc(item.acceptedAt),
    settlementAvailableAt: nullableUtc(item.settlementAvailableAt),
    actions: decodeActions(item.actions, side, status),
    aftercarePolicy: {
      model: model as CommerceOrder['aftercarePolicy']['model'],
      issueWindowHours: aftercare.issueWindowHours as 24 | null,
      postAcceptanceRefundAvailable: aftercare.postAcceptanceRefundAvailable as boolean,
    },
    requiresAttention: item.requiresAttention, createdAt, updatedAt,
  };
}

export function decodeCommerceOrderCreateResponse(value: unknown) {
  const response = object(value); exactKeys(response, ['ok', 'replayed', 'order']);
  if (response.ok !== true || typeof response.replayed !== 'boolean') throw new CommerceClosureContractError();
  return { ok: true, replayed: response.replayed, order: decodeCommerceOrder(response.order) } as const;
}

export function decodeCommerceOrderDetailResponse(value: unknown, expectedOrderId: string) {
  const expected = uuid(expectedOrderId);
  const response = object(value); exactKeys(response, ['ok', 'order']);
  if (response.ok !== true) throw new CommerceClosureContractError();
  const order = decodeCommerceOrder(response.order);
  if (order.id !== expected) throw new CommerceClosureContractError('COMMERCE_ORDER_ID_MISMATCH');
  return { ok: true, order } as const;
}

export function decodeCommerceClosurePending(value: unknown): CommerceClosurePending {
  const item = object(value, true);
  exactKeys(item, [
    'schemaVersion', 'subjectFingerprint', 'phase', 'listingId', 'quantity', 'idempotencyKey', 'requestDigest',
    'topupId', 'orderId', 'createdAt', 'updatedAt',
  ], true);
  const phase = item.phase as CommerceClosurePhase;
  if (item.schemaVersion !== 1 || ![
    'order_create_persisted', 'funding_required', 'wallet_opened', 'funding_succeeded',
    'order_retry_persisted', 'order_created',
  ].includes(phase)) throw new CommerceClosurePendingIntegrityError();
  const subjectFingerprint = text(item.subjectFingerprint, 64, true);
  const requestDigest = text(item.requestDigest, 64, true);
  if (!DIGEST_PATTERN.test(subjectFingerprint) || !DIGEST_PATTERN.test(requestDigest)) {
    throw new CommerceClosurePendingIntegrityError();
  }
  const topupId = item.topupId === null ? null : uuid(item.topupId, true);
  const orderId = item.orderId === null ? null : uuid(item.orderId, true);
  if ((phase === 'funding_succeeded' || phase === 'order_retry_persisted') && topupId === null
    || (phase === 'order_created') !== (orderId !== null)
    || (phase !== 'order_created' && orderId !== null)) throw new CommerceClosurePendingIntegrityError();
  const createdAt = utc(item.createdAt, true); const updatedAt = utc(item.updatedAt, true);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new CommerceClosurePendingIntegrityError();
  return {
    schemaVersion: 1, subjectFingerprint, phase, listingId: uuid(item.listingId, true),
    quantity: positiveQuantity(item.quantity, true), idempotencyKey: text(item.idempotencyKey, 120, true),
    requestDigest, topupId, orderId, createdAt, updatedAt,
  };
}

export function parseCommerceClosurePending(raw: string) {
  try { return decodeCommerceClosurePending(JSON.parse(raw)); }
  catch (error) {
    if (error instanceof CommerceClosurePendingIntegrityError) throw error;
    throw new CommerceClosurePendingIntegrityError();
  }
}

export function commerceClosurePendingForSubject(pending: CommerceClosurePending, subjectFingerprint: string) {
  if (pending.subjectFingerprint !== subjectFingerprint) {
    throw new CommerceClosurePendingIntegrityError('COMMERCE_CLOSURE_SUBJECT_MISMATCH');
  }
  return pending;
}
