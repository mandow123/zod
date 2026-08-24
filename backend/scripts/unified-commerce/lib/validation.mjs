import { sha256, stable } from './canonical.mjs';

export const expectedCounts = Object.freeze({ users: 15, listings: 25, orders: 2, payments: 2,
  allocations: 1, settlements: 1 });

export function validateEmbeddedDigest(value, field, errorCode) {
  const embedded = value?.[field];
  if (!/^[0-9a-f]{64}$/u.test(embedded ?? '')) throw new Error(errorCode);
  const unsigned = { ...value }; delete unsigned[field];
  const calculated = sha256(stable(unsigned));
  if (calculated !== embedded) throw new Error(errorCode);
  return calculated;
}

export function validateMapping(mapping) {
  const mappingDigest = validateEmbeddedDigest(mapping, 'mappingDigest', 'UNIFIED_MAPPING_DIGEST_INVALID');
  if (mapping?.schemaVersion !== 1 || mapping?.identityPolicy?.provider !== 'kai_identity'
    || mapping?.identityPolicy?.binding !== 'exact_subject_only'
    || mapping?.identityPolicy?.guessedBindingAllowed !== false
    || mapping?.canonicalPromotion?.enabled !== false) throw new Error('UNIFIED_MAPPING_CONTRACT_INVALID');
  const counts = Object.fromEntries(Object.keys(expectedCounts).map((name) => [name, mapping.entities?.[name]?.length ?? -1]));
  if (stable(counts) !== stable(expectedCounts)) throw new Error('UNIFIED_MAPPING_COUNTS_INVALID');
  const tokens = new Map();
  for (const [kind, rows] of Object.entries(mapping.entities)) for (const row of rows) {
    if (typeof row.sourceToken !== 'string' || row.sourceToken.length < 65) throw new Error('UNIFIED_MAPPING_TOKEN_INVALID');
    const key = `${kind}:${row.sourceToken}`;
    if (tokens.has(key)) throw new Error('UNIFIED_MAPPING_TOKEN_DUPLICATE');
    tokens.set(key, true);
  }
  const userTokens = new Set(mapping.entities.users.map((row) => row.sourceToken));
  const listingTokens = new Set(mapping.entities.listings.map((row) => row.sourceToken));
  const orderTokens = new Set(mapping.entities.orders.map((row) => row.sourceToken));
  const referenceChecks = [
    ...mapping.entities.listings.map((row) => userTokens.has(row.supplierToken)),
    ...mapping.entities.orders.map((row) => userTokens.has(row.buyerToken) && listingTokens.has(row.listingToken)),
    ...mapping.entities.payments.map((row) => orderTokens.has(row.orderToken)),
    ...mapping.entities.allocations.map((row) => userTokens.has(row.ownerToken)
      && orderTokens.has(row.orderToken) && listingTokens.has(row.listingToken)),
    ...mapping.entities.settlements.map((row) => orderTokens.has(row.orderToken) && userTokens.has(row.supplierToken)),
  ];
  const tradeTokens = mapping.entities.payments.map((row) => row.tradeNoToken).filter(Boolean);
  const checks = { referencesComplete: referenceChecks.every(Boolean),
    providerTransactionsUnique: new Set(tradeTokens).size === tradeTokens.length,
    listingsQuarantined: mapping.entities.listings.every((row) => row.importState === 'legacy_import_staging'
      && row.canonicalEligible === false),
    ordersNonCanonical: mapping.entities.orders.every((row) => row.canonicalEligible === false
      && (row.importState === 'legacy_import_staging' || row.importState === 'manual_review')),
    paymentsUnconfirmed: mapping.entities.payments.every((row) => row.confirmationState === 'active_query_unconfirmed'
      && row.canonicalEligible === false && row.grantAllowed === false),
    legacyCreditsNotPromotedToLots: mapping.entities.allocations.every((row) => row.creditLotCreated === false
      && row.canonicalEligible === false),
    ordersExact: mapping.conservation?.ordersExact === true,
    paymentsMatchOrders: mapping.conservation?.paymentsMatchOrders === true,
    settlementsBalance: mapping.conservation?.settlementsBalance === true };
  if (Object.values(checks).some((value) => !value)) throw new Error('UNIFIED_MAPPING_INVARIANT_FAILED');
  return { counts, checks, mappingDigest };
}

const forbiddenKey = /(?:email|account|name|claim|license|path|checkoutUrl|raw|password|secret|merchantId|providerTxnId|outTradeNo|tradeNo)/iu;
const allowedTokenKey = /^(?:outTradeNo|tradeNo|providerTxn|providerTransaction|verifiedKaiSubject)[A-Za-z0-9]*Token$/u;
const safeNegativeAttestation = new Set(['rawClaimsIncluded', 'rawCallbacksIncluded']);
export function rejectSensitiveShape(value, path = '') {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSensitiveShape(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (safeNegativeAttestation.has(key) && child !== false) {
      throw new Error(`UNIFIED_SENSITIVE_FIELD_REJECTED:${path}.${key}`);
    }
    if (forbiddenKey.test(key) && !allowedTokenKey.test(key) && !safeNegativeAttestation.has(key)) {
      throw new Error(`UNIFIED_SENSITIVE_FIELD_REJECTED:${path}.${key}`);
    }
    rejectSensitiveShape(child, `${path}.${key}`);
  }
}
