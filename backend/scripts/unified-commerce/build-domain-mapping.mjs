#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { auditToken, parseArgs, readCredential, required, sha256, stable, writeJson0600 } from './lib/canonical.mjs';
import { sqliteJson } from './lib/sqlite.mjs';
import { validateEmbeddedDigest } from './lib/validation.mjs';

const args = parseArgs(process.argv.slice(2));
const databasePath = required(args, 'sqlite');
const auditKey = await readCredential(required(args, 'audit-key-file'));
const inventory = JSON.parse(await readFile(required(args, 'source-inventory'), 'utf8'));
const inventoryDigest = validateEmbeddedDigest(inventory, 'reportDigest', 'UNIFIED_SOURCE_INVENTORY_DIGEST_INVALID');
if (inventory?.privacy?.piiValuesIncluded !== false || inventory?.source?.sha256 === undefined) {
  throw new Error('UNIFIED_SOURCE_INVENTORY_INVALID');
}
const sourceDatabase = await readFile(databasePath);
if (inventory.source.sha256 !== sha256(sourceDatabase) || inventory.source.bytes !== sourceDatabase.length) {
  throw new Error('UNIFIED_SOURCE_DATABASE_MISMATCH');
}
const token = (table, value) => auditToken(auditKey, table.replaceAll('_', '-'), String(value));
const rows = async (sql) => sqliteJson(databasePath, sql);
const source = {
  users: await rows(`SELECT id,role,enterprise_status,lifecycle_status,supplier_capability_level FROM users ORDER BY id`),
  identities: await rows(`SELECT provider,subject,user_id FROM external_identities ORDER BY provider,subject`),
  listings: await rows(`SELECT id,supplier_user_id,kind,product_code,gpu,provider,region,unit,unit_price_cents,
    verified_quantity,quote_reserved,order_locked,delivering,consumed,frozen,status,version,minimum_quantity,trade_mode
    FROM listings ORDER BY id`),
  orders: await rows(`SELECT id,buyer_user_id,listing_id,quantity,unit,unit_price_cents,amount_cents,currency,status,
    payment_provider,kind,product_code,settlement_mode FROM orders ORDER BY id`),
  payments: await rows(`SELECT id,order_id,provider,amount_cents,currency,provider_txn_id,status,gateway,channel,
    provider_status,query_attempts FROM payments ORDER BY id`),
  allocations: await rows(`SELECT id,owner_user_id,order_id,listing_id,quantity,unit,status,kind,product_code,
    swap_reserved FROM allocations ORDER BY id`),
  settlements: await rows(`SELECT id,order_id,supplier_user_id,gross_cents,platform_fee_cents,supplier_net_cents,
    referral_commission_cents,currency,status FROM settlements ORDER BY id`),
};
const counts = Object.fromEntries(Object.entries(source).filter(([name]) => name !== 'identities')
  .map(([name, values]) => [name, values.length]));
const expected = { users: 15, listings: 25, orders: 2, payments: 2, allocations: 1, settlements: 1 };
if (stable(counts) !== stable(expected) || stable(inventory.requiredDomainCounts) !== stable(expected)) {
  throw new Error('UNIFIED_SOURCE_COUNTS_INVALID');
}
const matchedSourceIdentities = new Map((inventory.dataIslands?.nodeAuthPg18?.sourceIdentityMatches ?? [])
  .map((match) => [match.sourceUserToken, match.verifiedSubjectToken]));
const identityByUser = new Map(); const conflicts = [];
for (const identity of source.identities) {
  const sourceUserToken = token('users', identity.user_id);
  if (identity.provider !== 'kai_identity' || typeof identity.subject !== 'string' || identity.subject.length === 0) {
    conflicts.push({ entityType: 'user', sourceToken: sourceUserToken,
      code: 'IDENTITY_PROVIDER_NOT_VERIFIED' }); continue;
  }
  const verifiedSubjectToken = matchedSourceIdentities.get(sourceUserToken);
  if (!verifiedSubjectToken) {
    conflicts.push({ entityType: 'user', sourceToken: sourceUserToken,
      code: 'AUTH_PG_VERIFIED_SUBJECT_NOT_MATCHED' }); continue;
  }
  if (identityByUser.has(identity.user_id)) {
    conflicts.push({ entityType: 'user', sourceToken: sourceUserToken, code: 'IDENTITY_AMBIGUOUS' });
    identityByUser.delete(identity.user_id); continue;
  }
  identityByUser.set(identity.user_id, verifiedSubjectToken);
}
const userIds = new Set(source.users.map((row) => row.id));
const listingIds = new Set(source.listings.map((row) => row.id));
const orderIds = new Set(source.orders.map((row) => row.id));
for (const user of source.users) if (!identityByUser.has(user.id)) conflicts.push({ entityType: 'user',
  sourceToken: token('users', user.id), code: 'VERIFIED_KAI_SUBJECT_REQUIRED' });

const entities = {
  users: source.users.map((row) => ({ sourceToken: token('users', row.id),
    verifiedKaiSubjectToken: identityByUser.get(row.id) ?? null,
    verificationBasis: identityByUser.has(row.id)
      ? '18_node_auth_pg:production_subject_pepper_hmac_sha512_exact_match:audit_hmac_sha256_token' : null,
    role: row.role, lifecycleStatus: row.lifecycle_status, enterpriseStatus: row.enterprise_status,
    supplierCapabilityLevel: row.supplier_capability_level, canonicalEligible: identityByUser.has(row.id) })),
  listings: source.listings.map((row) => {
    const sourceToken = token('listings', row.id);
    conflicts.push({ entityType: 'listing', sourceToken, code: 'LISTING_STAGING_EVIDENCE_REQUIRED' });
    if (!userIds.has(row.supplier_user_id)) conflicts.push({ entityType: 'listing', sourceToken: token('listings', row.id),
      code: 'SUPPLIER_REFERENCE_MISSING' });
    if (!identityByUser.has(row.supplier_user_id)) conflicts.push({ entityType: 'listing', sourceToken: token('listings', row.id),
      code: 'SUPPLIER_IDENTITY_UNVERIFIED' });
    return { sourceToken, supplierToken: token('users', row.supplier_user_id),
      resourceSignatureToken: token('resource_signature', stable([row.kind, row.product_code, row.gpu, row.provider,
        row.region, row.unit])), kind: row.kind, unit: row.unit, unitPriceCents: row.unit_price_cents,
      verifiedQuantity: row.verified_quantity, quoteReserved: row.quote_reserved, orderLocked: row.order_locked,
      delivering: row.delivering, consumed: row.consumed, frozen: row.frozen, minimumQuantity: row.minimum_quantity,
      tradeMode: row.trade_mode, sourceStatus: row.status, version: row.version,
      importState: 'legacy_import_staging', canonicalEligible: false };
  }),
  orders: source.orders.map((row) => {
    if (!userIds.has(row.buyer_user_id)) conflicts.push({ entityType: 'order', sourceToken: token('orders', row.id),
      code: 'BUYER_REFERENCE_MISSING' });
    if (!listingIds.has(row.listing_id)) conflicts.push({ entityType: 'order', sourceToken: token('orders', row.id),
      code: 'LISTING_REFERENCE_MISSING' });
    const manualReviewRequired = !identityByUser.has(row.buyer_user_id)
      || !['completed', 'cancelled', 'refunded', 'closed'].includes(String(row.status).toLowerCase());
    if (manualReviewRequired) conflicts.push({ entityType: 'order', sourceToken: token('orders', row.id),
      code: 'ORDER_MANUAL_REVIEW_REQUIRED' });
    return { sourceToken: token('orders', row.id), buyerToken: token('users', row.buyer_user_id),
      listingToken: token('listings', row.listing_id), quantity: row.quantity, unit: row.unit,
      unitPriceCents: row.unit_price_cents, amountCents: row.amount_cents, currency: row.currency,
      sourceStatus: row.status, paymentRail: row.payment_provider, kind: row.kind,
      productSignatureToken: token('product', row.product_code ?? ''), settlementMode: row.settlement_mode,
      importState: manualReviewRequired ? 'manual_review' : 'legacy_import_staging', manualReviewRequired,
      canonicalEligible: false };
  }),
  payments: source.payments.map((row) => {
    const sourceToken = token('payments', row.id);
    conflicts.push({ entityType: 'payment', sourceToken, code: 'PAYMENT_ACTIVE_QUERY_CONFIRMATION_REQUIRED' });
    if (!orderIds.has(row.order_id)) conflicts.push({ entityType: 'payment', sourceToken: token('payments', row.id),
      code: 'ORDER_REFERENCE_MISSING' });
    return { sourceToken, orderToken: token('orders', row.order_id), provider: row.provider,
      amountCents: row.amount_cents, currency: row.currency, sourceStatus: row.status, gateway: row.gateway,
      channel: row.channel, sourceProviderStatus: row.provider_status, queryAttempts: row.query_attempts,
      outTradeNoToken: token('out_trade_no', row.id),
      tradeNoToken: row.provider_txn_id ? token('trade_no', row.provider_txn_id) : null,
      confirmationState: 'active_query_unconfirmed', canonicalEligible: false, grantAllowed: false };
  }),
  allocations: source.allocations.map((row) => {
    const sourceToken = token('allocations', row.id);
    conflicts.push({ entityType: 'allocation', sourceToken, code: 'LEGACY_ALLOCATION_NO_CREDIT_LOT' });
    return { sourceToken,
    ownerToken: token('users', row.owner_user_id), orderToken: token('orders', row.order_id),
    listingToken: token('listings', row.listing_id), quantity: row.quantity, unit: row.unit, status: row.status,
    kind: row.kind, productSignatureToken: token('product', row.product_code ?? ''), swapReserved: row.swap_reserved,
    importState: 'legacy_import_staging', canonicalEligible: false, creditLotCreated: false };
  }),
  settlements: source.settlements.map((row) => {
    const sourceToken = token('settlements', row.id);
    conflicts.push({ entityType: 'settlement', sourceToken, code: 'SETTLEMENT_HOLDING_REVIEW_REQUIRED' });
    return { sourceToken,
    orderToken: token('orders', row.order_id), supplierToken: token('users', row.supplier_user_id),
    grossCents: row.gross_cents, platformFeeCents: row.platform_fee_cents,
    supplierNetCents: row.supplier_net_cents, referralCommissionCents: row.referral_commission_cents,
    currency: row.currency, sourceStatus: row.status, importState: 'holding_review', canonicalEligible: false };
  }),
};
const tradeTokens = entities.payments.map((row) => row.tradeNoToken).filter(Boolean);
const conservation = {
  ordersExact: source.orders.every((row) => Math.round(Number(row.quantity) * Number(row.unit_price_cents)) === Number(row.amount_cents)),
  paymentsMatchOrders: source.payments.every((payment) => {
    const order = source.orders.find((row) => row.id === payment.order_id);
    return order && payment.amount_cents === order.amount_cents && payment.currency === order.currency;
  }),
  settlementsBalance: source.settlements.every((row) => Number(row.gross_cents) === Number(row.platform_fee_cents)
    + Number(row.supplier_net_cents) + Number(row.referral_commission_cents)),
  providerTransactionsUnique: new Set(tradeTokens).size === tradeTokens.length,
};
if (Object.values(conservation).some((value) => !value)) throw new Error('UNIFIED_SOURCE_CONSERVATION_FAILED');
const output = { schemaVersion: 1, sourceInventoryDigest: inventoryDigest, expectedCounts: expected,
  identityPolicy: { provider: 'kai_identity', binding: 'exact_subject_only', guessedBindingAllowed: false },
  entities, conflicts, conservation, canonicalPromotion: { enabled: false, eligible: false,
    blocker: 'UNIFIED_ARCHITECTURE_REVIEW_REQUIRED' },
  privacy: { piiValuesIncluded: false, rawClaimsIncluded: false, rawCallbacksIncluded: false,
    providerIdentifiersTokenized: true } };
output.mappingDigest = sha256(stable(output));
const written = await writeJson0600(required(args, 'output'), output);
process.stdout.write(`${JSON.stringify({ ok: true, output: written, mappingDigest: output.mappingDigest,
  conflicts: conflicts.length })}\n`);
