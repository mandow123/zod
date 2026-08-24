export const QIXIANG_RAIL = 'qixiang_alipay' as const;
export const QIXIANG_PROVIDER = 'qixiang' as const;
export const QIXIANG_CHECKOUT_ORIGIN = 'https://api.payqixiang.cn' as const;
export const QIXIANG_CHECKOUT_PATH_PREFIX = '/pay/submit/' as const;

export type QixiangTopupStatus =
  | 'created' | 'pending' | 'verifying' | 'succeeded' | 'failed' | 'expired' | 'manual_review';
export type QixiangTopupAction = 'open_checkout' | 'recheck' | 'contact_support';

export type QixiangConversion = Readonly<{
  numerator: 1000;
  denominator: 1002;
  rounding: 'floor';
  precision: 2;
}>;

export type QixiangCheckoutPolicy = Readonly<{
  kind: 'external_browser';
  allowedOrigin: typeof QIXIANG_CHECKOUT_ORIGIN;
  allowedPathPrefix: typeof QIXIANG_CHECKOUT_PATH_PREFIX;
}>;

export type QixiangTopupCapability = Readonly<{
  mode: 'off' | 'shadow' | 'on';
  available: boolean;
  canaryOnly:boolean;
  rails: readonly [] | readonly [typeof QIXIANG_RAIL];
  minAmountCents: number | null;
  maxAmountCents: number | null;
  conversion: QixiangConversion | null;
  lotValidityDays: 364;
  checkout: QixiangCheckoutPolicy | null;
  blockers: readonly string[];
}>;

export type QixiangReadinessGateInput = Readonly<{
  authenticated: boolean;
  readiness: unknown;
}>;

export type QixiangReadinessProjection = Readonly<{
  profile: Readonly<
    | { id: 'full_commerce'; routePolicy: 'full-commerce-v1' }
    | { id: 'inquiry_only'; routePolicy: 'allowlist-v1' }
  >;
  releaseReady: boolean;
  capability: QixiangTopupCapability;
}>;

export type QixiangCheckout = Readonly<{
  kind: 'external_browser';
  url: string;
  expiresAt: string;
}>;

export type QixiangTopup = Readonly<{
  id: string;
  topupNumber: string;
  provider: typeof QIXIANG_PROVIDER;
  rail: typeof QIXIANG_RAIL;
  status: QixiangTopupStatus;
  version: number;
  payment: Readonly<{ currency: 'CNY'; amountCents: number; amount: string }>;
  credit: Readonly<{ unit: 'KAI_CARD_HOUR'; amount: string; precision: 2 }>;
  conversion: Readonly<{ numerator: 1000; denominator: 1002; rounding: 'floor' }>;
  entitlement: Readonly<{ validityDays: 364; expiresAt: string | null }>;
  checkoutExpiresAt: string;
  createdAt: string;
  succeededAt: string | null;
  lastCheckedAt: string | null;
  allowedActions: readonly QixiangTopupAction[];
}>;

export type QixiangCreationPolicy = Readonly<{
  allowed: boolean;
  reason: null | 'unresolved_topup' | 'capability_unavailable' | 'amount_policy_unavailable';
  canaryOnly: boolean;
  requiredAmountCents: number | null;
}>;

export type QixiangTopupPage = Readonly<{
  items: readonly QixiangTopup[];
  nextCursor: string | null;
  creation: QixiangCreationPolicy;
}>;

export type QixiangPendingPhase =
  | 'create_persisted' | 'checkout_opened' | 'return_observed' | 'recheck_pending';

export type QixiangPendingTopup = Readonly<{
  schemaVersion: 1;
  subjectFingerprint: string;
  phase: QixiangPendingPhase;
  amountCents: number;
  rail: typeof QIXIANG_RAIL;
  idempotencyKey: string;
  requestDigest: string;
  topupId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export class QixiangContractError extends Error {
  constructor(code = 'QIXIANG_CONTRACT_INVALID') { super(code); this.name = 'QixiangContractError'; }
}

export class QixiangPendingIntegrityError extends Error {
  constructor(code = 'QIXIANG_PENDING_INTEGRITY') { super(code); this.name = 'QixiangPendingIntegrityError'; }
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MONEY_PATTERN = /^(?:0|[1-9]\d*)\.\d{2}$/u;
const CHECKOUT_PATH_PATTERN = /^\/pay\/submit\/[A-Za-z0-9_-]{1,256}\/$/u;
const CANONICAL_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function record(value: unknown, pending = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (pending) throw new QixiangPendingIntegrityError();
    throw new QixiangContractError();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], pending = false) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    if (pending) throw new QixiangPendingIntegrityError();
    throw new QixiangContractError();
  }
}

function text(value: unknown, maximum = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new QixiangContractError();
  }
  return value;
}

function pendingText(value: unknown, maximum = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new QixiangPendingIntegrityError();
  }
  return value;
}

function positiveSafeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new QixiangContractError();
  return Number(value);
}

function pendingPositiveSafeInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new QixiangPendingIntegrityError();
  return Number(value);
}

function isoDate(value: unknown) {
  const result = text(value, 40);
  const timestamp = Date.parse(result);
  if (!CANONICAL_UTC_PATTERN.test(result) || Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== result) {
    throw new QixiangContractError();
  }
  return result;
}

function pendingIsoDate(value: unknown) {
  const result = pendingText(value, 40);
  const timestamp = Date.parse(result);
  if (!CANONICAL_UTC_PATTERN.test(result) || Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== result) {
    throw new QixiangPendingIntegrityError();
  }
  return result;
}

function nullableIsoDate(value: unknown) { return value === null ? null : isoDate(value); }

function conversion(value: unknown, includePrecision: boolean): QixiangConversion | Omit<QixiangConversion, 'precision'> {
  const item = record(value);
  exactKeys(item, includePrecision
    ? ['numerator', 'denominator', 'rounding', 'precision']
    : ['numerator', 'denominator', 'rounding']);
  if (item.numerator !== 1000 || item.denominator !== 1002 || item.rounding !== 'floor'
    || (includePrecision && item.precision !== 2)) throw new QixiangContractError();
  return includePrecision
    ? { numerator: 1000, denominator: 1002, rounding: 'floor', precision: 2 }
    : { numerator: 1000, denominator: 1002, rounding: 'floor' };
}

function checkoutPolicy(value: unknown): QixiangCheckoutPolicy {
  const item = record(value);
  exactKeys(item, ['kind', 'allowedOrigin', 'allowedPathPrefix']);
  if (item.kind !== 'external_browser' || item.allowedOrigin !== QIXIANG_CHECKOUT_ORIGIN
    || item.allowedPathPrefix !== QIXIANG_CHECKOUT_PATH_PREFIX) throw new QixiangContractError();
  return { kind: 'external_browser', allowedOrigin: QIXIANG_CHECKOUT_ORIGIN,
    allowedPathPrefix: QIXIANG_CHECKOUT_PATH_PREFIX };
}

function blockers(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) throw new QixiangContractError();
  const result = value.map((entry) => text(entry, 120));
  if (new Set(result).size !== result.length) throw new QixiangContractError();
  return result;
}

function rails(value: unknown): readonly [] | readonly [typeof QIXIANG_RAIL] {
  if (!Array.isArray(value) || value.length > 1 || (value.length === 1 && value[0] !== QIXIANG_RAIL)) {
    throw new QixiangContractError();
  }
  return value.length === 0 ? [] : [QIXIANG_RAIL];
}

export function decodeQixiangTopupCapability(value: unknown): QixiangTopupCapability {
  const item = record(value);
  exactKeys(item, ['mode', 'available', 'canaryOnly', 'rails', 'minAmountCents', 'maxAmountCents', 'conversion',
    'lotValidityDays', 'checkout', 'blockers']);
  if (!['off', 'shadow', 'on'].includes(String(item.mode)) || typeof item.available !== 'boolean'
    ||typeof item.canaryOnly!=='boolean'
    || item.lotValidityDays !== 364) throw new QixiangContractError();
  const decodedRails = rails(item.rails);
  const decodedBlockers = blockers(item.blockers);
  const minimum = item.minAmountCents === null ? null : positiveSafeInteger(item.minAmountCents);
  const maximum = item.maxAmountCents === null ? null : positiveSafeInteger(item.maxAmountCents);
  const decodedConversion = item.conversion === null ? null : conversion(item.conversion, true) as QixiangConversion;
  const decodedCheckout = item.checkout === null ? null : checkoutPolicy(item.checkout);
  const mode = item.mode as QixiangTopupCapability['mode'];
  if ((mode === 'off' || mode === 'shadow') && (item.available !== false || decodedRails.length !== 0
      || minimum !== null || maximum !== null || decodedConversion !== null || decodedCheckout !== null)) {
    throw new QixiangContractError();
  }
  if (item.available === true && (mode !== 'on' || decodedRails.length !== 1 || minimum === null || maximum === null
      || minimum > maximum || decodedConversion === null || decodedCheckout === null || decodedBlockers.length !== 0)) {
    throw new QixiangContractError();
  }
  if(item.canaryOnly===true&&(item.available!==true||minimum!==501||maximum!==501))throw new QixiangContractError();
  if(item.canaryOnly===true&&mode!=='on')throw new QixiangContractError();
  if (mode === 'on' && item.available === false && decodedBlockers.length === 0) throw new QixiangContractError();
  return {
    mode, available: item.available, canaryOnly:item.canaryOnly,rails: decodedRails, minAmountCents: minimum, maxAmountCents: maximum,
    conversion: decodedConversion, lotValidityDays: 364, checkout: decodedCheckout, blockers: decodedBlockers,
  };
}

export function decodeQixiangReadinessProjection(value: unknown): QixiangReadinessProjection {
  const root = record(value); const profile = record(root.profile); const release = record(root.release);
  const capabilities = record(root.capabilities);
  exactKeys(profile, ['id', 'routePolicy']);
  if (!((profile.id === 'full_commerce' && profile.routePolicy === 'full-commerce-v1')
      || (profile.id === 'inquiry_only' && profile.routePolicy === 'allowlist-v1'))
    || typeof release.ready !== 'boolean' || !Object.hasOwn(capabilities, 'qixiangTopups')) {
    throw new QixiangContractError();
  }
  return {
    profile: profile as QixiangReadinessProjection['profile'], releaseReady: release.ready,
    capability: decodeQixiangTopupCapability(capabilities.qixiangTopups),
  };
}

export function qixiangTopupGate(input: QixiangReadinessGateInput): QixiangTopupCapability | null {
  if (!input.authenticated) return null;
  try {
    const readiness = decodeQixiangReadinessProjection(input.readiness);
    if (readiness.profile.id !== 'full_commerce') return null;
    const capability = readiness.capability;
    if(!readiness.releaseReady&&!capability.canaryOnly)return null;
    return capability.mode === 'on' && capability.available && capability.rails.length === 1
      && capability.minAmountCents !== null && capability.maxAmountCents !== null
      && capability.conversion !== null && capability.checkout !== null && capability.blockers.length === 0
      ? capability : null;
  } catch { return null; }
}

export function qixiangCreditCents(amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1
    || amountCents > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) throw new QixiangContractError();
  return Math.floor((amountCents * 1000) / 1002);
}

export function qixiangAmount(amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new QixiangContractError();
  return `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`;
}

export function qixiangCreditAmount(amountCents: number) { return qixiangAmount(qixiangCreditCents(amountCents)); }

export function qixiangAmountInputCents(value: string, minimum: number, maximum: number) {
  if (!MONEY_PATTERN.test(value) || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
    || minimum < 1 || maximum < minimum) throw new QixiangContractError('QIXIANG_AMOUNT_INPUT_INVALID');
  const [whole = '', cents = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(cents);
  if (!Number.isSafeInteger(amount) || amount < minimum || amount > maximum) {
    throw new QixiangContractError('QIXIANG_AMOUNT_INPUT_INVALID');
  }
  return amount;
}

export function assertQixiangCheckoutUrl(raw: unknown) {
  const value = text(raw, 400);
  let url: URL;
  try { url = new URL(value); } catch { throw new QixiangContractError(); }
  if (url.protocol !== 'https:' || url.origin !== QIXIANG_CHECKOUT_ORIGIN || url.hostname !== 'api.payqixiang.cn'
    || url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || !CHECKOUT_PATH_PATTERN.test(url.pathname) || value !== `${QIXIANG_CHECKOUT_ORIGIN}${url.pathname}`) {
    throw new QixiangContractError();
  }
  return value;
}

export function decodeQixiangCheckout(value: unknown): QixiangCheckout {
  const item = record(value);
  exactKeys(item, ['kind', 'url', 'expiresAt']);
  if (item.kind !== 'external_browser') throw new QixiangContractError();
  return { kind: 'external_browser', url: assertQixiangCheckoutUrl(item.url), expiresAt: isoDate(item.expiresAt) };
}

function actions(value: unknown): readonly QixiangTopupAction[] {
  if (!Array.isArray(value) || value.length > 3) throw new QixiangContractError();
  const result = value.map((entry) => {
    if (!['open_checkout', 'recheck', 'contact_support'].includes(String(entry))) throw new QixiangContractError();
    return entry as QixiangTopupAction;
  });
  if (new Set(result).size !== result.length) throw new QixiangContractError();
  return result;
}

export function decodeQixiangTopup(value: unknown): QixiangTopup {
  const item = record(value); const payment = record(item.payment); const credit = record(item.credit);
  const itemConversion = record(item.conversion); const entitlement = record(item.entitlement);
  exactKeys(item, ['id', 'topupNumber', 'provider', 'rail', 'status', 'version', 'payment', 'credit', 'conversion',
    'entitlement', 'checkoutExpiresAt', 'createdAt', 'succeededAt', 'lastCheckedAt', 'allowedActions']);
  exactKeys(payment, ['currency', 'amountCents', 'amount']);
  exactKeys(credit, ['unit', 'amount', 'precision']);
  exactKeys(itemConversion, ['numerator', 'denominator', 'rounding']);
  exactKeys(entitlement, ['validityDays', 'expiresAt']);
  const id = text(item.id, 64); const status = text(item.status, 24) as QixiangTopupStatus;
  if (!UUID_V4_PATTERN.test(id) || item.provider !== QIXIANG_PROVIDER || item.rail !== QIXIANG_RAIL
    || !['created', 'pending', 'verifying', 'succeeded', 'failed', 'expired', 'manual_review'].includes(status)
    || payment.currency !== 'CNY' || credit.unit !== 'KAI_CARD_HOUR' || credit.precision !== 2
    || entitlement.validityDays !== 364) throw new QixiangContractError();
  conversion(itemConversion, false);
  const amountCents = positiveSafeInteger(payment.amountCents, Math.floor(Number.MAX_SAFE_INTEGER / 1000));
  const paymentAmount = text(payment.amount, 40); const creditAmount = text(credit.amount, 40);
  if (!MONEY_PATTERN.test(paymentAmount) || !MONEY_PATTERN.test(creditAmount)
    || paymentAmount !== qixiangAmount(amountCents) || creditAmount !== qixiangCreditAmount(amountCents)) {
    throw new QixiangContractError();
  }
  const createdAt = isoDate(item.createdAt); const succeededAt = nullableIsoDate(item.succeededAt);
  const expiresAt = nullableIsoDate(entitlement.expiresAt); const checkoutExpiresAt = isoDate(item.checkoutExpiresAt);
  const lastCheckedAt = nullableIsoDate(item.lastCheckedAt); const decodedActions = actions(item.allowedActions);
  if ((status === 'succeeded') !== (succeededAt !== null && expiresAt !== null)
    || (status !== 'succeeded' && (succeededAt !== null || expiresAt !== null))
    || (succeededAt !== null && expiresAt !== null
      && Date.parse(expiresAt) !== Date.parse(succeededAt) + 364 * 24 * 60 * 60 * 1000)
    || (decodedActions.includes('open_checkout') && !['created', 'pending'].includes(status))
    || (decodedActions.includes('recheck') && ['succeeded', 'failed'].includes(status))) {
    throw new QixiangContractError();
  }
  return {
    id, topupNumber: text(item.topupNumber, 64), provider: QIXIANG_PROVIDER, rail: QIXIANG_RAIL, status,
    version: positiveSafeInteger(item.version), payment: { currency: 'CNY', amountCents, amount: paymentAmount },
    credit: { unit: 'KAI_CARD_HOUR', amount: creditAmount, precision: 2 },
    conversion: { numerator: 1000, denominator: 1002, rounding: 'floor' },
    entitlement: { validityDays: 364, expiresAt }, checkoutExpiresAt, createdAt, succeededAt, lastCheckedAt,
    allowedActions: decodedActions,
  };
}

function nullableCursor(value: unknown) {
  if (value === null) return null;
  return text(value, 256);
}

function decodeCheckoutOrNull(value: unknown) { return value === null ? null : decodeQixiangCheckout(value); }

function assertCheckoutCoherence(topup: QixiangTopup, checkout: QixiangCheckout | null) {
  const mayOpenCheckout = topup.allowedActions.includes('open_checkout');
  if ((checkout !== null) !== mayOpenCheckout
    || (checkout !== null && topup.checkoutExpiresAt !== checkout.expiresAt)) throw new QixiangContractError();
}

export function decodeQixiangCreateResponse(value: unknown) {
  const response = record(value); exactKeys(response, ['topup', 'checkout']);
  const topup = decodeQixiangTopup(response.topup); const checkout = decodeCheckoutOrNull(response.checkout);
  assertCheckoutCoherence(topup, checkout);
  return { topup, checkout } as const;
}

export function decodeQixiangTopupDetail(value: unknown, expectedId: string) {
  if (!UUID_V4_PATTERN.test(expectedId)) throw new QixiangContractError();
  const response = record(value); exactKeys(response, ['topup', 'checkout']);
  const topup = decodeQixiangTopup(response.topup); const checkout = decodeCheckoutOrNull(response.checkout);
  if (topup.id !== expectedId) throw new QixiangContractError('QIXIANG_TOPUP_ID_MISMATCH');
  assertCheckoutCoherence(topup, checkout);
  return { topup, checkout } as const;
}

export function decodeQixiangTopupList(value: unknown): QixiangTopupPage {
  const response = record(value); const creation = record(response.creation);
  exactKeys(response, ['items', 'nextCursor', 'creation']);
  exactKeys(creation, ['allowed', 'reason', 'canaryOnly', 'requiredAmountCents']);
  if (!Array.isArray(response.items) || typeof creation.allowed !== 'boolean'
    || typeof creation.canaryOnly !== 'boolean'
    || ![null, 'unresolved_topup', 'capability_unavailable', 'amount_policy_unavailable'].includes(
      creation.reason as null | string)) throw new QixiangContractError();
  if ((creation.allowed && creation.reason !== null) || (!creation.allowed && creation.reason === null)) {
    throw new QixiangContractError();
  }
  if((creation.canaryOnly&&creation.requiredAmountCents!==501)
    ||(!creation.canaryOnly&&creation.requiredAmountCents!==null))throw new QixiangContractError();
  const items = response.items.map(decodeQixiangTopup);
  if (new Set(items.map((entry) => entry.id)).size !== items.length) throw new QixiangContractError();
  return { items, nextCursor: nullableCursor(response.nextCursor), creation: {
    allowed: creation.allowed, reason: creation.reason as QixiangCreationPolicy['reason'],
    canaryOnly:creation.canaryOnly,requiredAmountCents:creation.requiredAmountCents as number|null,
  } };
}

export function decodeQixiangRecheckResponse(value: unknown) {
  const response = record(value); exactKeys(response, ['topup']);
  return { topup: decodeQixiangTopup(response.topup) } as const;
}

export function decodeQixiangPendingTopup(value: unknown): QixiangPendingTopup {
  const item = record(value, true);
  exactKeys(item, ['schemaVersion', 'subjectFingerprint', 'phase', 'amountCents', 'rail', 'idempotencyKey',
    'requestDigest', 'topupId', 'createdAt', 'updatedAt'], true);
  const phase = item.phase as QixiangPendingPhase;
  if (item.schemaVersion !== 1 || !['create_persisted', 'checkout_opened', 'return_observed', 'recheck_pending'].includes(phase)
    || item.rail !== QIXIANG_RAIL) throw new QixiangPendingIntegrityError();
  const subjectFingerprint = pendingText(item.subjectFingerprint, 128);
  const idempotencyKey = pendingText(item.idempotencyKey, 120);
  const requestDigest = pendingText(item.requestDigest, 128);
  if (!DIGEST_PATTERN.test(subjectFingerprint) || !DIGEST_PATTERN.test(requestDigest)
    || idempotencyKey.length < 16) throw new QixiangPendingIntegrityError();
  const topupId = item.topupId === null ? null : pendingText(item.topupId, 64);
  if (topupId !== null && !UUID_V4_PATTERN.test(topupId)) throw new QixiangPendingIntegrityError();
  if ((phase === 'create_persisted') !== (topupId === null)) throw new QixiangPendingIntegrityError();
  const createdAt = pendingIsoDate(item.createdAt); const updatedAt = pendingIsoDate(item.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new QixiangPendingIntegrityError();
  return { schemaVersion: 1, subjectFingerprint, phase, amountCents: pendingPositiveSafeInteger(item.amountCents),
    rail: QIXIANG_RAIL, idempotencyKey, requestDigest, topupId, createdAt, updatedAt };
}

export function parseQixiangPendingTopup(raw: string): QixiangPendingTopup {
  try { return decodeQixiangPendingTopup(JSON.parse(raw) as unknown); }
  catch (reason) {
    if (reason instanceof QixiangPendingIntegrityError) throw reason;
    throw new QixiangPendingIntegrityError();
  }
}

export function qixiangPendingForSubject(pending: QixiangPendingTopup, subjectFingerprint: string) {
  if (!DIGEST_PATTERN.test(subjectFingerprint) || pending.subjectFingerprint !== subjectFingerprint) {
    throw new QixiangPendingIntegrityError('QIXIANG_PENDING_SUBJECT_MISMATCH');
  }
  return pending;
}

export function advanceQixiangPending(
  pending: QixiangPendingTopup,
  phase: Exclude<QixiangPendingPhase, 'create_persisted'>,
  updatedAt: string,
  topupId = pending.topupId,
): QixiangPendingTopup {
  const allowed: Readonly<Record<QixiangPendingPhase, readonly QixiangPendingPhase[]>> = {
    create_persisted: ['checkout_opened', 'return_observed'],
    checkout_opened: ['return_observed', 'recheck_pending'],
    return_observed: ['recheck_pending'],
    recheck_pending: ['recheck_pending'],
  };
  if (!allowed[pending.phase].includes(phase) || topupId === null) throw new QixiangPendingIntegrityError();
  return decodeQixiangPendingTopup({ ...pending, phase, topupId, updatedAt });
}

export function shouldClearQixiangPending(topup: QixiangTopup) {
  return topup.status === 'succeeded' || topup.status === 'failed';
}
