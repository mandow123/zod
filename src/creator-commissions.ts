import { apiRequest } from './api-client';
import { parseOwnedReferralToken } from './external-link-policy';

export type CreatorCommissionStatus = 'attributed' | 'refund_observation' | 'pending' | 'available' | 'reversed' | 'transferred';
export type CreatorCommission = Readonly<{
  id: string;
  orderKind: 'credit_order' | 'device_order' | 'vast_order';
  orderId: string;
  status: CreatorCommissionStatus;
  commissionCardHours: string;
  completedAt: string | null;
  availableAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;
export type CreatorCommissionSummary = Readonly<{
  unit: 'KAI_CARD_HOUR';
  precision: 2;
  balances: Readonly<{
    pendingCardHours: string;
    availableCardHours: string;
    transferredCardHours: string;
  }>;
  commissions: CreatorCommission[];
}>;
export type CreatorReferralLink = Readonly<{
  id: string;
  code: string;
  providerSource: 'first_party';
  token: string;
  url: string;
  expiresAt: string;
}>;
export type CreatorRewardEvent = Readonly<{
  eventId: string;
  transferId: string;
  cardHours: string;
  status: 'unconsumed' | 'consumed';
  createdAt: string;
  consumedAt: string | null;
}>;

export type CreatorReferralAttribution = Readonly<{
  id: string;
  providerSource: 'first_party';
  expiresAt: string;
}>;

export function parseCreatorReferralToken(url: string) {
  return parseOwnedReferralToken(url);
}

export async function loadCreatorCommissionSummary() {
  const response = await apiRequest<{ ok: true } & CreatorCommissionSummary>('/mobile/v1/creator/commissions', {
    auth: 'required', retry: false,
  });
  return response;
}

export async function createCreatorReferralLink(idempotencyKey: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; referralLink: CreatorReferralLink }>(
    '/mobile/v1/creator/referral-links', {
      method: 'POST', auth: 'required', retry: false, body: {}, headers: { 'idempotency-key': idempotencyKey },
    },
  );
  return response.referralLink;
}

export async function attributeCreatorReferral(token: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; attribution: CreatorReferralAttribution }>(
    '/mobile/v1/referrals/attribute', {
      method: 'POST', auth: 'required', retry: false, body: { token },
    },
  );
  return response.attribution;
}

export async function transferCreatorCommission(idempotencyKey: string) {
  const response = await apiRequest<{ ok: true; replayed: boolean; transfer: Readonly<{
    cardHours: string;
    rewardEvent: CreatorRewardEvent;
  }> }>('/mobile/v1/creator/commissions/transfer', {
    method: 'POST', auth: 'required', retry: false, body: {}, headers: { 'idempotency-key': idempotencyKey },
  });
  return response.transfer;
}

export async function loadCreatorRewardEvents(limit = 20) {
  const response = await apiRequest<{ ok: true; events: CreatorRewardEvent[] }>(
    `/mobile/v1/creator/reward-events?limit=${encodeURIComponent(String(limit))}`,
    { auth: 'required', retry: false },
  );
  return response.events;
}

export async function consumeCreatorRewardEvent(eventId: string) {
  const response = await apiRequest<{ ok: true; event: CreatorRewardEvent }>(
    `/mobile/v1/creator/reward-events/${encodeURIComponent(eventId)}/consume`, {
      method: 'POST', auth: 'required', retry: false, body: {},
    },
  );
  return response.event;
}
