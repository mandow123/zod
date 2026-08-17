import * as Crypto from 'expo-crypto';
import { apiRequest } from './api-client';

export type DeviceProduct = Readonly<{
  id: string; sku: string; title: string; productType: 'physical_delivery'; campaignKey: string;
  catalogSource?: 'server' | 'bundled_campaign';
  template?: Readonly<{ key: string }>;
  supplier: Readonly<{ displayName: string; verified?: boolean }>;
  activationStatus: 'pending_activation' | 'active' | 'suspended';
  purchasable: boolean; blockedReason?: string | null;
  capabilities?: Readonly<{ creditOnly: boolean; requiresShippingAddress: boolean; physicalDelivery: boolean; maxQuantityPerOrder: number }>;
  inventory: Readonly<{ total: number; reserved: number; sold: number; available: number }>;
  pricing: Readonly<{ unitCredit: string; listUnitCredit: string; discountPercent: number }>;
  expectedDelivery: Readonly<{ days: number; label: string }>;
  specifications: Record<string, unknown>;
}>;

export type DeviceOrderStatus = 'reserved' | 'confirmed' | 'shipping' | 'received' | 'cancelled' | 'expired';
export type DeviceOrder = Readonly<{
  id: string; orderNumber: string; productId: string; campaignKey: string; campaignVersion: string; side?: 'buyer' | 'provider';
  actions?: readonly ('cancel' | 'confirm' | 'ship' | 'receive')[];
  status: DeviceOrderStatus; quantity: number; unitCredit: string; totalCredit: string;
  serviceFeeCredit: string | null; supplierNetCredit: string | null;
  reservationTransactionId: string; resolutionTransactionId: string | null; reservationExpiresAt: string;
  confirmedAt: string | null; shippedAt: string | null; receivedAt: string | null; logisticsProvider?: string | null; trackingDisplay?: string | null;
  settlement?: null | Readonly<{ status: 'pending' | 'succeeded'; grossCredit: string; serviceFeeCredit: string; netCredit: string; availableAt: string; settledAt: string | null }>;
  createdAt: string;
}>;

export type DeviceAsset = Readonly<{ id: string; orderId: string; ownerSubjectId: string; productId: string; title: string; quantity: number; status: 'owned'; acquiredAt: string }>;
export type ShippingAddress = Readonly<{ id: string; reference: string; recipientName: string; phone: string; province: string; city: string; district: string; detail: string; isDefault: boolean; createdAt: string }>;
export type ShippingAddressInput = Readonly<{ recipientName: string; phone: string; province: string; city: string; district: string; detail: string; isDefault?: boolean }>;

const actionKey = (prefix: string) => `${prefix}:${Crypto.randomUUID()}`;

export async function loadDeviceProducts() { const response = await apiRequest<{ ok: true; products: DeviceProduct[] }>('/mobile/v1/device-products', { auth: 'optional', retry: false }); return response.products; }
export async function loadDeviceProduct(productId: string) { const response = await apiRequest<{ ok: true; product: DeviceProduct }>(`/mobile/v1/device-products/${encodeURIComponent(productId)}`, { auth: 'optional', retry: false }); return response.product; }
export async function createDeviceOrder(input: Readonly<{ productId: string; quantity: number; shippingAddressReference: string; idempotencyKey: string }>) { const response = await apiRequest<{ ok: true; replayed: boolean; order: DeviceOrder }>('/mobile/v1/device-orders', { method: 'POST', auth: 'required', retry: false, body: { productId: input.productId, quantity: input.quantity, shippingAddressReference: input.shippingAddressReference }, headers: { 'idempotency-key': input.idempotencyKey } }); return response.order; }
export async function loadDeviceOrders() { const response = await apiRequest<{ ok: true; orders: DeviceOrder[] }>('/mobile/v1/device-orders', { auth: 'required', retry: false }); return response.orders; }
export async function loadDeviceOrder(orderId: string) { const response = await apiRequest<{ ok: true; order: DeviceOrder }>(`/mobile/v1/device-orders/${encodeURIComponent(orderId)}`, { auth: 'required', retry: false }); return response.order; }
export async function loadDeviceAssets() { const response = await apiRequest<{ ok: true; assets: DeviceAsset[] }>('/mobile/v1/device-assets', { auth: 'required', retry: false }); return response.assets; }
export async function loadShippingAddresses() { const response = await apiRequest<{ ok: true; addresses: ShippingAddress[] }>('/mobile/v1/shipping-addresses', { auth: 'required', retry: false }); return response.addresses; }
export async function createShippingAddress(input: ShippingAddressInput, idempotencyKey: string) { const response = await apiRequest<{ ok: true; address: ShippingAddress }>('/mobile/v1/shipping-addresses', { method: 'POST', auth: 'required', retry: false, body: input, headers: { 'idempotency-key': idempotencyKey } }); return response.address; }
export async function deleteShippingAddress(addressId: string) { return apiRequest<{ ok: true; deleted: true }>(`/mobile/v1/shipping-addresses/${encodeURIComponent(addressId)}`, { method: 'DELETE', auth: 'required', retry: false }); }
export async function cancelDeviceOrder(orderId: string, idempotencyKey = actionKey('device-order-cancel')) { const response = await apiRequest<{ ok: true; replayed: boolean; order: DeviceOrder }>(`/mobile/v1/device-orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', auth: 'required', retry: false, body: {}, headers: { 'idempotency-key': idempotencyKey } }); return response.order; }
export async function receiveDeviceOrder(orderId: string, idempotencyKey = actionKey('device-order-receive')) { const response = await apiRequest<{ ok: true; replayed: boolean; order: DeviceOrder }>(`/mobile/v1/device-orders/${encodeURIComponent(orderId)}/receive`, { method: 'POST', auth: 'required', retry: false, body: {}, headers: { 'idempotency-key': idempotencyKey } }); return response.order; }
export async function confirmDeviceOrder(orderId: string, idempotencyKey: string) { const response = await apiRequest<{ ok: true; replayed: boolean; order: DeviceOrder }>(`/mobile/v1/provider/device-orders/${encodeURIComponent(orderId)}/confirm`, { method: 'POST', auth: 'required', retry: false, body: {}, headers: { 'idempotency-key': idempotencyKey } }); return response.order; }
export async function shipDeviceOrder(orderId: string, input: Readonly<{ logisticsProvider: string; trackingNumber: string; idempotencyKey: string }>) { const response = await apiRequest<{ ok: true; replayed: boolean; order: DeviceOrder }>(`/mobile/v1/provider/device-orders/${encodeURIComponent(orderId)}/ship`, { method: 'POST', auth: 'required', retry: false, body: { logisticsProvider: input.logisticsProvider, trackingNumber: input.trackingNumber }, headers: { 'idempotency-key': input.idempotencyKey } }); return response.order; }
