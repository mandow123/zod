import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/database.js';
import { PostgresListingAuditStore } from '../src/listings/store.js';
import { creditMicrosFromCnyMicros, KAI_CNY_MICROS_PER_CREDIT } from '../src/listings/types.js';

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => pgResult(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => {
      const client = { query: async (text: string, values?: unknown[]) => pgResult(await transaction.query(text, values)) } as unknown as PoolClient;
      return work(client);
    }),
    close: () => pglite.close(),
  } as unknown as Database;
}

async function migrate(pglite: PGlite) {
  for (const name of ['0001_cloudpay_ledger.sql', '0003_market_reservations.sql', '0012_mobile_publish.sql', '0015_credit_listing_audits.sql', '0016_trading_subjects.sql', '0017_offer_wizard_drafts.sql', '0021_offer_revision_drafts.sql', '0039_compute_node_readiness.sql']) {
    await pglite.exec(await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8'));
  }
}

describe('credit listing double-audit workflow', () => {
  it('requires two reviewers, computes H100 credits exactly, and publishes only within audit validity', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    await migrate(pglite);
    const database = adapter(pglite);
    const store = new PostgresListingAuditStore(database);
    const supplierUserId = randomUUID(); const resourceReviewer = randomUUID(); const priceReviewer = randomUUID();
    const supplierId = randomUUID(); const resourceId = randomUUID();
    await database.query(
      `INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES
       ($1, 'supplier', '供应方', 'supplier'), ($2, 'resource-reviewer', '资源审核员', 'operator'),
       ($3, 'price-reviewer', '价格审核员', 'operator')`, [supplierUserId, resourceReviewer, priceReviewer],
    );
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '供应方', $2)`, [supplierId, supplierUserId]);
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [supplierId, supplierUserId]);
    await database.query(
      `INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status)
       VALUES ($1, $2, $1, '凯云算力有限公司', '91310101MA1ABCDEF0', '凯', 'approved')`, [supplierId, supplierUserId],
    );
    await database.query(
      `INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications,
        capacity_total, capacity_unit, status, verification_digest, verified_at)
       VALUES ($1, $2, 'gpu', 'H100-SXM-80G', '华东-上海', '{"memory":"80GB"}', 100, 'GPU时',
        'verified', $3, now())`, [resourceId, supplierId, `sha256:${'a'.repeat(64)}`],
    );
    const nodeId = randomUUID();
    await database.query(`INSERT INTO compute_nodes(id, supplier_id, node_public_key, node_key_fingerprint,
        inventory_digest, status, last_heartbeat_at, heartbeat_boot_id, heartbeat_sequence,
        heartbeat_payload_digest, heartbeat_signature)
      VALUES ($1,$2,$3,$4,$5,'ready',now(),$6,1,$7,$8)`,
    [nodeId, supplierId, `ed25519:${'A'.repeat(44)}`, `sha256:${'b'.repeat(64)}`,
      `sha256:${'c'.repeat(64)}`, randomUUID(), `sha256:${'d'.repeat(64)}`, `ed25519:${'B'.repeat(88)}`]);
    await database.query(`INSERT INTO compute_resource_bindings(id, resource_id, node_id, status,
        resource_verification_digest, policy_digest, attested_policy_digest, inventory_digest, gpu_set_digest, confirmed_at)
      VALUES ($1,$2,$3,'ready',$4,$5,$5,$6,$7,now())`,
    [randomUUID(), resourceId, nodeId, `sha256:${'a'.repeat(64)}`, `sha256:${'e'.repeat(64)}`,
      `sha256:${'c'.repeat(64)}`, `sha256:${'f'.repeat(64)}`]);
    const offerInput = {
      id: randomUUID(), subjectId: supplierId, userId: supplierUserId, resourceId, clientRequestId: 'offer-request-00000001',
      payloadDigest: 'offer-digest-a', title: '独享 H100 80GB', serviceMode: 'dedicated' as const,
      nativeUnit: 'GPU时', minimumQuantity: '1', sla: { availability: '99.9%' },
      deliveryTerms: { mode: 'ssh' }, acceptanceTerms: { test: 'nvidia-smi' }, refundTerms: { outage: true },
      cleanupTerms: { wipe: true }, suggestedPriceCnyMicros: 31_200_000n,
      priceComponents: { compute: 'included' }, priceEvidence: [{ type: 'contract', digest: `sha256:${'b'.repeat(64)}` }],
    };
    const created = await store.createOffer(offerInput);
    expect(created?.status).toBe('created');
    if (!created || created.status === 'conflict') throw new Error('offer was not created');
    const replay = await store.createOffer({ ...offerInput, id: randomUUID() });
    expect(replay?.status).toBe('replayed');
    expect((await store.createOffer({ ...offerInput, id: randomUUID(), payloadDigest: 'different' }))?.status).toBe('conflict');

    const submitted = await store.submitOffer(supplierId, supplierUserId, created.offer.id, 1);
    expect(submitted?.offer.status).toBe('under_review');
    expect(submitted?.audits.map((audit) => audit.kind).sort()).toEqual(['price', 'resource']);
    const resourceValid = new Date(Date.now() + 80 * 86_400_000);
    const priceValid = new Date(Date.now() + 25 * 86_400_000);
    const resourceDecision = await store.decideAudit({
      reviewerId: resourceReviewer, offerId: created.offer.id, kind: 'resource', approved: true, changesRequested: false,
      decisionReason: '在线挑战、配置和控制权均通过。', evidenceSummary: 'H100 80GB，NVLink 与库存一致。',
      evidenceDigest: `sha256:${'c'.repeat(64)}`, decisionDigest: 'resource-decision', validUntil: resourceValid,
    });
    expect(resourceDecision).not.toBeNull();
    expect(await store.decideAudit({
      reviewerId: resourceReviewer, offerId: created.offer.id, kind: 'price', approved: true, changesRequested: false,
      decisionReason: '价格证据通过。', evidenceSummary: '合同与同地区可比报价。',
      evidenceDigest: `sha256:${'d'.repeat(64)}`, decisionDigest: 'price-decision-same-reviewer', validUntil: priceValid,
      approvedReferenceCnyMicros: 31_200_000n, conversionCnyMicrosPerCredit: KAI_CNY_MICROS_PER_CREDIT,
      approvedUnitCreditMicros: creditMicrosFromCnyMicros(31_200_000n),
    })).toBe('four_eyes_violation');
    const priceDecision = await store.decideAudit({
      reviewerId: priceReviewer, offerId: created.offer.id, kind: 'price', approved: true, changesRequested: false,
      decisionReason: '价格证据通过。', evidenceSummary: '合同与同地区可比报价。',
      evidenceDigest: `sha256:${'d'.repeat(64)}`, decisionDigest: 'price-decision', validUntil: priceValid,
      approvedReferenceCnyMicros: 31_200_000n, conversionCnyMicrosPerCredit: KAI_CNY_MICROS_PER_CREDIT,
      approvedUnitCreditMicros: creditMicrosFromCnyMicros(31_200_000n),
    });
    expect(priceDecision && typeof priceDecision !== 'string' ? priceDecision.offer.status : null).toBe('approved');
    expect(priceDecision && typeof priceDecision !== 'string' ? priceDecision.offer.approvedUnitCreditMicros : null).toBe(31_137_725n);
    const auditNotifications = await database.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM notifications WHERE user_id = $1 AND category = 'market' ORDER BY created_at`, [supplierUserId],
    );
    expect(auditNotifications.rows).toHaveLength(2);
    expect(auditNotifications.rows.every(({ data }) => data.route === 'provider_offer'
      && data.offerId === created.offer.id && data.subjectId === supplierId)).toBe(true);
    expect(auditNotifications.rows.map(({ data }) => data.offerStatus)).toEqual(['under_review', 'approved']);

    const startsAt = new Date(Date.now() - 60_000); const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    const published = await store.publishListing({
      id: randomUUID(), subjectId: supplierId, userId: supplierUserId, offerId: created.offer.id, clientRequestId: 'listing-request-000001',
      payloadDigest: 'listing-digest', capacityTotal: '50', startsAt, expiresAt,
    });
    expect(published.status).toBe('created');
    if (published.status === 'created') expect(published.listing.unitCreditMicros).toBe(31_137_725n);
    const publicListings = await store.listPublicListings(20);
    expect(publicListings).toHaveLength(1);
    expect(publicListings[0]).toMatchObject({
      offerId: created.offer.id, title: '独享 H100 80GB', productCode: 'H100-SXM-80G', kind: 'gpu', region: '华东-上海',
      specifications: { memory: '80GB' }, capacityAvailable: '50.000000', unitCreditMicros: 31_137_725n, status: 'active',
    });

    const alternate = await store.createOffer({
      ...offerInput, id: randomUUID(), clientRequestId: 'offer-request-00000002', payloadDigest: 'offer-digest-b',
      title: 'H100 夜间算力', serviceMode: 'dedicated',
    });
    if (!alternate || alternate.status === 'conflict') throw new Error('alternate offer was not created');
    await store.submitOffer(supplierId, supplierUserId, alternate.offer.id, 1);
    await store.decideAudit({
      reviewerId: resourceReviewer, offerId: alternate.offer.id, kind: 'resource', approved: true, changesRequested: false,
      decisionReason: '同一资源的备用服务方案复核通过。', evidenceSummary: '资源控制权和配置保持一致。',
      evidenceDigest: `sha256:${'1'.repeat(64)}`, decisionDigest: 'alternate-resource-decision', validUntil: resourceValid,
    });
    await store.decideAudit({
      reviewerId: priceReviewer, offerId: alternate.offer.id, kind: 'price', approved: true, changesRequested: false,
      decisionReason: '备用时段价格通过。', evidenceSummary: '夜间服务报价依据有效。',
      evidenceDigest: `sha256:${'2'.repeat(64)}`, decisionDigest: 'alternate-price-decision', validUntil: priceValid,
      approvedReferenceCnyMicros: 31_200_000n, conversionCnyMicrosPerCredit: KAI_CNY_MICROS_PER_CREDIT,
      approvedUnitCreditMicros: creditMicrosFromCnyMicros(31_200_000n),
    });
    const crossOfferOverlap = await store.publishListing({
      id: randomUUID(), subjectId: supplierId, userId: supplierUserId, offerId: alternate.offer.id,
      clientRequestId: 'listing-request-cross-offer', payloadDigest: 'cross-offer-overlap', capacityTotal: '10', startsAt, expiresAt,
    });
    expect(crossOfferOverlap.status).toBe('window_conflict');
    const occupiedWindow = await store.listingWindowAvailability({
      subjectId: supplierId, offerId: alternate.offer.id,
      startsAt: new Date(startsAt.getTime() + 1_000), expiresAt: new Date(expiresAt.getTime() - 1_000),
    });
    expect(occupiedWindow).toMatchObject({
      status: 'window_conflict', resourceId, capacityTotal: '100.000000', capacityUnit: 'GPU时',
      blockingStartsAt: startsAt, blockingExpiresAt: expiresAt, nextAvailableAt: expiresAt,
    });
    const nextWindow = await store.listingWindowAvailability({
      subjectId: supplierId, offerId: alternate.offer.id, startsAt: expiresAt,
      expiresAt: new Date(expiresAt.getTime() + 86_400_000),
    });
    expect(nextWindow).toMatchObject({
      status: 'available', resourceId, capacityTotal: '100.000000', capacityUnit: 'GPU时', nextAvailableAt: expiresAt,
    });

    const raceStartsAt = new Date(expiresAt.getTime() + 60_000);
    const raceExpiresAt = new Date(raceStartsAt.getTime() + 86_400_000);
    const raceOneId = randomUUID(); const raceTwoId = randomUUID();
    const raceResults = await Promise.all([
      store.publishListing({
        id: raceOneId, subjectId: supplierId, userId: supplierUserId, offerId: created.offer.id,
        clientRequestId: 'listing-request-race-0001', payloadDigest: 'race-one', capacityTotal: '10',
        startsAt: raceStartsAt, expiresAt: raceExpiresAt,
      }),
      store.publishListing({
        id: raceTwoId, subjectId: supplierId, userId: supplierUserId, offerId: alternate.offer.id,
        clientRequestId: 'listing-request-race-0002', payloadDigest: 'race-two', capacityTotal: '10',
        startsAt: raceStartsAt, expiresAt: raceExpiresAt,
      }),
    ]);
    expect(raceResults.map((item) => item.status).sort()).toEqual(['created', 'window_conflict']);
    await database.query(`DELETE FROM credit_market_listings WHERE id IN ($1, $2)`, [raceOneId, raceTwoId]);

    await database.query(`UPDATE credit_market_listings SET capacity_reserved = 49.5 WHERE id = $1`, [publicListings[0]!.id]);
    expect(await store.listPublicListings(20)).toHaveLength(0);
    await database.query(`UPDATE credit_market_listings SET capacity_reserved = 0 WHERE id = $1`, [publicListings[0]!.id]);
    expect((await store.setListingStatus({ subjectId: supplierId, listingId: publicListings[0]!.id, targetStatus: 'paused' })).status).toBe('updated');
    expect((await store.setListingStatus({ subjectId: supplierId, listingId: publicListings[0]!.id, targetStatus: 'paused' })).status).toBe('replayed');
    expect(await store.listPublicListings(20)).toHaveLength(0);
    expect((await store.setListingStatus({ subjectId: randomUUID(), listingId: publicListings[0]!.id, targetStatus: 'active' })).status).toBe('not_found');
    expect((await store.setListingStatus({ subjectId: supplierId, listingId: publicListings[0]!.id, targetStatus: 'active' })).status).toBe('updated');
    expect(await store.listPublicListings(20)).toHaveLength(1);
    await database.query(`UPDATE credit_market_listings SET capacity_reserved = 1 WHERE id = $1`, [publicListings[0]!.id]);
    expect((await store.setListingStatus({ subjectId: supplierId, listingId: publicListings[0]!.id, targetStatus: 'withdrawn' })).status).toBe('reserved_capacity');
    await database.query(`UPDATE credit_market_listings SET capacity_reserved = 0 WHERE id = $1`, [publicListings[0]!.id]);
    const supplierListings = await store.listSupplierListings(supplierId);
    expect(supplierListings).toHaveLength(1);
    expect(supplierListings[0]).toMatchObject({ offerId: created.offer.id, capacityTotal: '50.000000' });
    expect(await store.listSupplierListings(randomUUID())).toHaveLength(0);

    const overlapping = await store.publishListing({
      id: randomUUID(), subjectId: supplierId, userId: supplierUserId, offerId: created.offer.id, clientRequestId: 'listing-request-000002',
      payloadDigest: 'overlap', capacityTotal: '10', startsAt: new Date(startsAt.getTime() + 1_000), expiresAt,
    });
    expect(overlapping.status).toBe('window_conflict');
    const beyondAudit = await store.publishListing({
      id: randomUUID(), subjectId: supplierId, userId: supplierUserId, offerId: created.offer.id, clientRequestId: 'listing-request-000003',
      payloadDigest: 'beyond-audit', capacityTotal: '10', startsAt: new Date(Date.now() + 30 * 86_400_000),
      expiresAt: new Date(Date.now() + 31 * 86_400_000),
    });
    expect(beyondAudit.status).toBe('audit_expired');
    const belowMinimum = await store.publishListing({
      id: randomUUID(), subjectId: supplierId, userId: supplierUserId, offerId: created.offer.id,
      clientRequestId: 'listing-request-minimum03', payloadDigest: 'below-minimum', capacityTotal: '0.5',
      startsAt: new Date(expiresAt.getTime() + 1_000), expiresAt: new Date(expiresAt.getTime() + 86_400_000),
    });
    expect(belowMinimum.status).toBe('minimum_not_met');
    expect((await store.setListingStatus({ subjectId: supplierId, listingId: publicListings[0]!.id, targetStatus: 'withdrawn' })).status).toBe('updated');
    expect(await store.listPublicListings(20)).toHaveLength(0);
    expect((await store.setListingStatus({ subjectId: supplierId, listingId: publicListings[0]!.id, targetStatus: 'active' })).status).toBe('invalid_transition');
    await database.query(`UPDATE credit_market_listings SET status = 'active', expires_at = now() - interval '1 minute' WHERE id = $1`, [publicListings[0]!.id]);
    expect((await store.listSupplierListings(supplierId))[0]?.status).toBe('expired');

    // An audit expiry is a persisted supplier state, not only a buyer-side filter.
    await database.query(`UPDATE offer_templates SET audit_valid_until = now() - interval '1 minute' WHERE id = $1`, [created.offer.id]);
    await database.query(
      `UPDATE credit_market_listings SET status = 'active', starts_at = now() - interval '1 minute', expires_at = now() + interval '1 day'
       WHERE id = $1`, [publicListings[0]!.id],
    );
    expect(await store.listPublicListings(20)).toHaveLength(0);
    const expiredOffer = (await store.listSupplierOffers(supplierId))[0]!.offer;
    expect(expiredOffer.status).toBe('expired');
    expect((await store.listSupplierListings(supplierId))[0]?.status).toBe('expired');
    const expiryNotifications = await database.query<{ count: string }>(
      `SELECT count(*)::text FROM notifications WHERE user_id = $1 AND title = '审核已到期，请重新提交'`, [supplierUserId],
    );
    expect(expiryNotifications.rows[0]?.count).toBe('1');
    await store.listPublicListings(20);
    await store.listSupplierOffers(supplierId);
    const repeatedNotifications = await database.query<{ count: string }>(
      `SELECT count(*)::text FROM notifications WHERE user_id = $1 AND title = '审核已到期，请重新提交'`, [supplierUserId],
    );
    expect(repeatedNotifications.rows[0]?.count).toBe('1');

    const resubmitted = await store.submitOffer(supplierId, supplierUserId, created.offer.id, expiredOffer.version);
    expect(resubmitted).toMatchObject({ status: 'created', offer: { status: 'under_review', submissionVersion: 2 } });
    expect(resubmitted?.offer.approvedReferenceCnyMicros).toBeNull();
    expect(resubmitted?.offer.approvedUnitCreditMicros).toBeNull();
    expect(resubmitted?.offer.auditValidUntil).toBeNull();
    const resubmitReplay = await store.submitOffer(supplierId, supplierUserId, created.offer.id, expiredOffer.version);
    expect(resubmitReplay).toMatchObject({ status: 'replayed', offer: { submissionVersion: 2 } });
    const secondSubmissionAudits = await database.query<{ count: string }>(
      `SELECT count(*)::text FROM offer_audit_versions WHERE offer_id = $1 AND submission_version = 2`, [created.offer.id],
    );
    expect(secondSubmissionAudits.rows[0]?.count).toBe('2');

    const secondResourceValid = new Date(Date.now() + 70 * 86_400_000);
    const secondPriceValid = new Date(Date.now() + 20 * 86_400_000);
    await store.decideAudit({
      reviewerId: resourceReviewer, offerId: created.offer.id, kind: 'resource', approved: true, changesRequested: false,
      decisionReason: '复核资源通过。', evidenceSummary: '资源配置与控制权复核一致。',
      evidenceDigest: `sha256:${'e'.repeat(64)}`, decisionDigest: 'resource-reaudit', validUntil: secondResourceValid,
    });
    const reapproved = await store.decideAudit({
      reviewerId: priceReviewer, offerId: created.offer.id, kind: 'price', approved: true, changesRequested: false,
      decisionReason: '复核价格通过。', evidenceSummary: '近期合同与成本材料复核一致。',
      evidenceDigest: `sha256:${'f'.repeat(64)}`, decisionDigest: 'price-reaudit', validUntil: secondPriceValid,
      approvedReferenceCnyMicros: 31_200_000n, conversionCnyMicrosPerCredit: KAI_CNY_MICROS_PER_CREDIT,
      approvedUnitCreditMicros: creditMicrosFromCnyMicros(31_200_000n),
    });
    expect(reapproved && typeof reapproved !== 'string' ? reapproved.offer.status : null).toBe('approved');
    expect((await store.listSupplierListings(supplierId))[0]?.status).toBe('expired');
    expect(await store.listPublicListings(20)).toHaveLength(0);

    const republished = await store.publishListing({
      id: randomUUID(), subjectId: supplierId, userId: supplierUserId, offerId: created.offer.id,
      clientRequestId: 'listing-request-after-reaudit', payloadDigest: 'after-reaudit', capacityTotal: '25',
      startsAt: new Date(Date.now() - 1_000), expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(republished.status).toBe('created');
    expect((await store.listPublicListings(20))).toMatchObject([{ capacityTotal: '25.000000', status: 'active' }]);
    await database.close();
  });

  it('returns only the relevant step after an auditor requests changes', { timeout: 30_000 }, async () => {
    const pglite = new PGlite(); await migrate(pglite); const database = adapter(pglite); const store = new PostgresListingAuditStore(database);
    const supplierUserId = randomUUID(); const reviewer = randomUUID(); const supplierId = randomUUID(); const resourceId = randomUUID();
    await database.query(`INSERT INTO users(id, phone_ciphertext, display_name, role) VALUES ($1, 's', '供应方', 'supplier'), ($2, 'r', '审核员', 'operator')`, [supplierUserId, reviewer]);
    await database.query(`INSERT INTO trading_subjects(id, kind, display_name, owner_user_id) VALUES ($1, 'personal', '供应方', $2)`, [supplierId, supplierUserId]);
    await database.query(`INSERT INTO subject_memberships(subject_id, user_id, role) VALUES ($1, $2, 'owner')`, [supplierId, supplierUserId]);
    await database.query(`INSERT INTO supplier_profiles(id, created_by_user_id, subject_id, legal_name, credit_code, contact_name, status) VALUES ($1, $2, $1, '凯云', '91310101MA1ABCDEF0', '凯', 'approved')`, [supplierId, supplierUserId]);
    await database.query(`INSERT INTO compute_resources(id, supplier_id, kind, product_code, region, specifications, capacity_total, capacity_unit, status) VALUES ($1, $2, 'gpu', 'H100', '上海', '{}', 10, 'GPU时', 'verified')`, [resourceId, supplierId]);
    const created = await store.createOffer({
      id: randomUUID(), subjectId: supplierId, userId: supplierUserId, resourceId, clientRequestId: 'offer-request-changes01', payloadDigest: 'a',
      title: 'H100 独享', serviceMode: 'dedicated', nativeUnit: 'GPU时', minimumQuantity: '1', sla: {}, deliveryTerms: {},
      acceptanceTerms: {}, refundTerms: {}, cleanupTerms: {}, suggestedPriceCnyMicros: 31_200_000n,
      priceComponents: {}, priceEvidence: [{ evidence: true }],
    });
    if (!created || created.status === 'conflict') throw new Error('offer was not created');
    await store.submitOffer(supplierId, supplierUserId, created.offer.id, 1);
    const decision = await store.decideAudit({
      reviewerId: reviewer, offerId: created.offer.id, kind: 'price', approved: false, changesRequested: true,
      decisionReason: '请补充近三个月合同。', evidenceSummary: '当前仅有截图，不能核价。',
      evidenceDigest: `sha256:${'e'.repeat(64)}`, decisionDigest: 'changes', returnStep: 'price',
    });
    expect(decision && typeof decision !== 'string' ? decision.offer.status : null).toBe('changes_requested');
    expect(decision && typeof decision !== 'string'
      ? decision.audits.find((audit) => audit.kind === 'resource')?.status : null).toBe('cancelled');
    expect(decision && typeof decision !== 'string'
      ? decision.audits.find((audit) => audit.kind === 'price')?.returnStep : null).toBe('price');

    const revision = await store.createOfferRevision({
      id: randomUUID(), subjectId: supplierId, userId: supplierUserId, offerId: created.offer.id,
      clientRequestId: 'offer-revision-create01',
    });
    expect(revision).toMatchObject({ status: 'created', draft: { currentStep: 'price', status: 'active' } });
    if (!revision || revision.status === 'conflict') throw new Error('revision was not created');
    expect(revision.draft.payload).toMatchObject({ title: 'H100 独享', suggestedPriceCny: '31.200000' });
    expect((await store.getSupplierOffer(supplierId, created.offer.id))?.offer).toMatchObject({
      status: 'changes_requested', title: 'H100 独享', submissionVersion: 1,
    });

    const saved = await store.updateOfferRevision({
      subjectId: supplierId, offerId: created.offer.id, expectedVersion: revision.draft.version, currentStep: 'review',
      payload: { ...revision.draft.payload, priceEvidence: [{ type: 'contract', source: '三月合同', summary: '同地区同型号成交合同' }] },
    });
    expect(saved).toMatchObject({ status: 'active', version: 2, currentStep: 'review' });
    expect(await store.updateOfferRevision({
      subjectId: supplierId, offerId: created.offer.id, expectedVersion: revision.draft.version, currentStep: 'price', payload: {},
    })).toBeNull();
    if (!saved) throw new Error('revision was not saved');

    const submitInput = {
      subjectId: supplierId, userId: supplierUserId, offerId: created.offer.id, expectedVersion: saved.version,
      submitRequestId: 'offer-revision-submit01', submitPayloadDigest: 'revised-offer-a', title: 'H100 独享',
      serviceMode: 'dedicated' as const, nativeUnit: 'GPU时', minimumQuantity: '1', sla: {}, deliveryTerms: {},
      acceptanceTerms: {}, refundTerms: {}, cleanupTerms: {}, suggestedPriceCnyMicros: 31_200_000n,
      priceComponents: {}, priceEvidence: [{ type: 'contract', source: '三月合同', summary: '同地区同型号成交合同' }],
    };
    const resubmitted = await store.submitOfferRevision(submitInput);
    expect(resubmitted).toMatchObject({ status: 'created', offer: { status: 'under_review', submissionVersion: 2 }, audits: [{}, {}] });
    expect(await store.submitOfferRevision(submitInput)).toMatchObject({ status: 'replayed', offer: { submissionVersion: 2 } });
    const history = await database.query<{ submission_version: number; status: string; return_step: string | null }>(
      `SELECT submission_version, status, return_step FROM offer_audit_versions WHERE offer_id = $1 ORDER BY submission_version, kind`,
      [created.offer.id],
    );
    expect(history.rows.filter((row) => row.submission_version === 1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'changes_requested', return_step: 'price' }),
      expect.objectContaining({ status: 'cancelled' }),
    ]));
    expect(history.rows.filter((row) => row.submission_version === 2)).toHaveLength(2);
    await database.close();
  });
});
