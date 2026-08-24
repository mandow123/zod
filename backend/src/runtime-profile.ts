import type { MobileApiProfile } from './config.js';

export const INQUIRY_ONLY_ROUTE_ALLOWLIST = [
  { method: 'GET', url: '/mobile/v1/health', audience: 'public' },
  { method: 'GET', url: '/mobile/v1/readiness', audience: 'public' },
  { method: 'GET', url: '/mobile/v1/legal', audience: 'public' },
  { method: 'GET', url: '/mobile/v1/supplier-inquiry-catalog', audience: 'public' },
  { method: 'GET', url: '/mobile/v1/supplier-inquiry-catalog/:resourceId', audience: 'public' },
  { method: 'GET', url: '/mobile/v1/supplier-quote-directory', audience: 'public' },
  { method: 'GET', url: '/privacy', audience: 'public' },
  { method: 'GET', url: '/terms', audience: 'public' },
  { method: 'GET', url: '/inquiry-terms', audience: 'public' },
  { method: 'GET', url: '/account/delete', audience: 'public' },
  { method: 'GET', url: '/mobile/v1/me', audience: 'paired_kai' },
  { method: 'POST', url: '/mobile/v1/auth/kai/consents', audience: 'paired_kai' },
  { method: 'GET', url: '/mobile/v1/subjects', audience: 'paired_kai' },
  { method: 'PUT', url: '/mobile/v1/me/current-subject', audience: 'paired_kai' },
  { method: 'POST', url: '/mobile/v1/resource-inquiries', audience: 'buyer' },
  { method: 'GET', url: '/mobile/v1/resource-inquiries', audience: 'buyer' },
  { method: 'GET', url: '/mobile/v1/resource-inquiries/:inquiryId', audience: 'buyer' },
  { method: 'GET', url: '/mobile/v1/resource-inquiries/:inquiryId/clarifications', audience: 'buyer' },
  { method: 'POST', url: '/mobile/v1/resource-inquiries/:inquiryId/clarifications', audience: 'buyer' },
  { method: 'POST', url: '/mobile/v1/resource-inquiries/:inquiryId/cancel', audience: 'buyer' },
  { method: 'GET', url: '/internal/metrics', audience: 'internal' },
] as const;

const fullCommerceWorkers = [
  'push_outbox', 'vast_reconciliation', 'legacy_creator_commission', 'resource_inquiry_expiry',
  'account_deletion', 'evidence_scan', 'topup_recovery', 'credit_order_expiry',
  'credit_supplier_settlement', 'fulfillment_expiry', 'device_order_expiry', 'device_settlement',
  'qixiang_query_reconciliation', 'qixiang_credit_lot_expiry',
] as const;

export function mobileRuntimePolicy(profile: MobileApiProfile) {
  if (profile === 'inquiry_only') return {
    commerceServicesEnabled: false,
    workerNames: [] as const,
    routePolicy: 'allowlist-v1' as const,
  };
  return {
    commerceServicesEnabled: true,
    workerNames: fullCommerceWorkers,
    routePolicy: 'full-commerce-v1' as const,
  };
}
