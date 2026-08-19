import * as Crypto from 'expo-crypto';
import { apiRequest } from './api-client';
import { guardNewOrderRequest } from './distribution';

export type VastOffer = Readonly<{
  offerId: string;
  providerSource: 'vast_ai';
  updatedAt: string;
  gpu: Readonly<{ name: string; count: number; memoryGb: number }>;
  region: string;
  reliability: number;
  pricing: Readonly<{ cardHoursPerHour: string }>;
}>;

export type VastCatalog = Readonly<{
  availability: 'available' | 'unavailable';
  providerSource: 'vast_ai';
  updatedAt: string;
  resources: VastOffer[];
}>;

export type VastQuote = Readonly<{
  quoteId: string;
  providerSource: 'vast_ai';
  offerId: string;
  quotedAt: string;
  expiresAt: string;
  durationHours: number;
  gpu: VastOffer['gpu'];
  region: string;
  reliability: number;
  pricing: Readonly<{ cardHoursPerHour: string; totalCardHours: string }>;
}>;

export type VastOrderStatus = 'confirming' | 'pending_reconciliation' | 'provisioning' | 'ready' | 'running' | 'stopping' | 'closed' | 'refunded';
export type VastOrder = Readonly<{
  id: string;
  orderNumber: string;
  quoteId: string;
  providerSource: 'vast_ai';
  status: VastOrderStatus;
  amountCardHours: string;
  createdAt: string;
  updatedAt: string;
  reconciliationRequired: boolean;
}>;

export async function loadVastOffers() {
  const response = await apiRequest<{ ok: true } & VastCatalog>('/mobile/v1/vast/offers?limit=50', { auth: 'optional', retry: false });
  return response;
}

export async function createVastQuote(offerId: string, durationHours: number) {
  return guardNewOrderRequest(async () => {
    const response = await apiRequest<{ ok: true; quote: VastQuote }>('/mobile/v1/vast/quotes', {
      method: 'POST', auth: 'required', retry: false, body: { offerId, durationHours },
    });
    return response.quote;
  });
}

export async function createVastOrder(quoteId: string, idempotencyKey: string) {
  return guardNewOrderRequest(async () => {
    const response = await apiRequest<{ ok: true; replayed: boolean; order: VastOrder }>('/mobile/v1/vast/orders', {
      method: 'POST', auth: 'required', retry: false, body: { quoteId }, headers: { 'idempotency-key': idempotencyKey },
    });
    return response.order;
  });
}

export async function loadVastOrders() {
  const response = await apiRequest<{ ok: true; orders: VastOrder[] }>('/mobile/v1/vast/orders?limit=30', { auth: 'required', retry: false });
  return response.orders;
}

export function newVastOrderKey() { return `vast-order:${Crypto.randomUUID()}`; }
