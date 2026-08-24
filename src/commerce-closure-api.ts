import { apiRequest } from './api-client.ts';
import {
  decodeCommerceOrderCreateResponse, decodeCommerceOrderDetailResponse,
} from './commerce-closure.ts';

function mutationHeaders(idempotencyKey: string) {
  if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(idempotencyKey)) {
    throw new Error('COMMERCE_ORDER_IDEMPOTENCY_INVALID');
  }
  return { 'Idempotency-Key': idempotencyKey };
}

export async function createCommerceClosureOrder(
  listingId: string,
  quantity: string,
  idempotencyKey: string,
) {
  const response = await apiRequest<unknown>('/mobile/v1/orders', {
    method: 'POST',
    auth: 'required',
    retry: false,
    headers: mutationHeaders(idempotencyKey),
    body: { listingId, quantity },
  });
  return decodeCommerceOrderCreateResponse(response);
}

export async function loadCommerceClosureOrder(orderId: string) {
  const response = await apiRequest<unknown>(`/mobile/v1/orders/${encodeURIComponent(orderId)}`, {
    auth: 'required', retry: true,
  });
  return decodeCommerceOrderDetailResponse(response, orderId);
}
