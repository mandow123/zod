import { apiRequest } from './api-client';
import {
  decodeQixiangCreateResponse, decodeQixiangRecheckResponse, decodeQixiangTopupDetail,
  decodeQixiangTopupList, QIXIANG_RAIL,
} from './qixiang-topups.ts';

function mutationHeaders(idempotencyKey: string) {
  if (idempotencyKey.length < 16 || idempotencyKey.length > 120) throw new Error('QIXIANG_IDEMPOTENCY_INVALID');
  return { 'Idempotency-Key': idempotencyKey };
}

export async function createQixiangTopup(amountCents: number, idempotencyKey: string) {
  const response = await apiRequest<unknown>('/mobile/v1/credits/topups/qixiang', {
    method: 'POST', auth: 'required', retry: false, headers: mutationHeaders(idempotencyKey),
    body: { amountCents, rail: QIXIANG_RAIL },
  });
  return decodeQixiangCreateResponse(response);
}

export async function listQixiangTopups(cursor: string | null = null) {
  const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
  const response = await apiRequest<unknown>(`/mobile/v1/credits/topups/qixiang?limit=30${suffix}`, {
    auth: 'required', retry: true,
  });
  return decodeQixiangTopupList(response);
}

export async function loadQixiangTopup(topupId: string) {
  const response = await apiRequest<unknown>(
    `/mobile/v1/credits/topups/qixiang/${encodeURIComponent(topupId)}`,
    { auth: 'required', retry: true },
  );
  return decodeQixiangTopupDetail(response, topupId);
}

export async function recheckQixiangTopup(
  topupId: string,
  expectedVersion: number,
  idempotencyKey: string,
) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('QIXIANG_VERSION_INVALID');
  const response = await apiRequest<unknown>(
    `/mobile/v1/credits/topups/qixiang/${encodeURIComponent(topupId)}/recheck`,
    { method: 'POST', auth: 'required', retry: false, headers: mutationHeaders(idempotencyKey),
      body: { expectedVersion } },
  );
  return decodeQixiangRecheckResponse(response);
}
