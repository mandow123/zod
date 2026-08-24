import { z } from 'zod';

export type RewardDomain = 'streamer' | 'invite';
export type RewardMode = 'off' | 'shadow' | 'on';
export type RewardOrderKind = 'credit_order' | 'device_order' | 'vast_order';
export type RewardOrderStatus = 'attributed' | 'observation' | 'available' | 'transferred' | 'reversed' | 'recovery_required';

export type RewardPolicySnapshot = Readonly<{
  version: string;
  basisPoints: number;
  attributionTtlDays: number;
  refundObservationDays: number;
  firstOrderQualificationDays?: number;
}>;

export type RewardOrderClaimInput = Readonly<{
  orderKind: RewardOrderKind;
  orderId: string;
  buyerUserId: string;
  buyerSubjectId: string;
  productKind: string;
  productId: string;
  orderedAt: Date;
}>;

export type NetSettledEvent = Readonly<{
  type: 'commerce.order.net_settled.v1';
  source: string;
  eventId: string;
  orderKind: RewardOrderKind;
  orderId: string;
  sourceVersion: bigint;
  buyerUserId: string;
  buyerSubjectId: string;
  productKind: string;
  productId: string;
  finalNetConsumedMicros: bigint;
  settledAt: Date;
}>;

export type NetRevisedEvent = Readonly<{
  type: 'commerce.order.net_revised.v1';
  source: string;
  eventId: string;
  orderKind: RewardOrderKind;
  orderId: string;
  sourceVersion: bigint;
  buyerUserId: string;
  buyerSubjectId: string;
  productKind: string;
  productId: string;
  previousNetConsumedMicros: bigint;
  newNetConsumedMicros: bigint;
  reason: string;
  revisedAt: Date;
}>;

export type CommerceNetEvent = NetSettledEvent | NetRevisedEvent;

const uuid = z.string().uuid();
const safeSource = z.string().trim().regex(/^[a-z][a-z0-9_.-]{2,79}$/u);
const safeProductKind = z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/u);
const positiveVersion = z.string().regex(/^[1-9]\d*$/u).transform(BigInt);
const positiveCentMicros = z.string().regex(/^[1-9]\d*$/u).transform((value,context) => {
  const amount = BigInt(value);
  if (amount % 10_000n !== 0n) {
    context.addIssue({ code: 'custom', message: 'card hours require two-decimal micros' });
    return z.NEVER;
  }
  return amount;
});
const nonNegativeCentMicros = z.string().regex(/^\d+$/u).transform((value,context) => {
  const amount = BigInt(value);
  if (amount % 10_000n !== 0n) {
    context.addIssue({ code: 'custom', message: 'card hours require two-decimal micros' });
    return z.NEVER;
  }
  return amount;
});
const eventBase = z.object({
  source: safeSource,
  eventId: z.string().trim().min(8).max(160),
  orderKind: z.enum(['credit_order','device_order','vast_order']),
  orderId: uuid,
  sourceVersion: positiveVersion,
  buyerUserId: uuid,
  buyerSubjectId: uuid,
  productKind: safeProductKind,
  productId: uuid,
}).strict();

const settledEventSchema = eventBase.extend({
  type: z.literal('commerce.order.net_settled.v1'),
  finalNetConsumedMicros: positiveCentMicros,
  settledAt: z.iso.datetime().transform((value) => new Date(value)),
}).strict();

const revisedEventSchema = eventBase.extend({
  type: z.literal('commerce.order.net_revised.v1'),
  previousNetConsumedMicros: positiveCentMicros,
  newNetConsumedMicros: nonNegativeCentMicros,
  reason: z.string().trim().min(1).max(120),
  revisedAt: z.iso.datetime().transform((value) => new Date(value)),
}).strict().refine((value) => value.newNetConsumedMicros < value.previousNetConsumedMicros, {
  message: 'net revision must reduce final consumption', path: ['newNetConsumedMicros'],
});

export function parseCommerceNetEvent(value: unknown): CommerceNetEvent {
  const discriminated = z.discriminatedUnion('type',[settledEventSchema,revisedEventSchema]);
  return discriminated.parse(value) as CommerceNetEvent;
}

export function rewardMicros(netMicros: bigint, basisPoints: number) {
  if (netMicros < 0n || netMicros % 10_000n !== 0n || !Number.isInteger(basisPoints)
    || basisPoints < 1 || basisPoints > 300) throw new Error('REWARD_AMOUNT_CONTRACT_INVALID');
  return ((netMicros * BigInt(basisPoints)) / 10_000n / 10_000n) * 10_000n;
}

export function parsePolicySnapshot(domain: RewardDomain, value: unknown): RewardPolicySnapshot {
  const base = z.object({
    version: z.string().trim().min(1).max(80),
    basisPoints: z.number().int().min(1).max(300),
    attributionTtlDays: z.number().int().min(1).max(domain === 'streamer' ? 90 : 30),
    refundObservationDays: z.number().int().min(1).max(30),
  });
  return (domain === 'streamer'
    ? base.strict()
    : base.extend({firstOrderQualificationDays:z.number().int().min(1).max(90)}).strict()
  ).parse(value) as RewardPolicySnapshot;
}
