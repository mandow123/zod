import { describe, expect, it } from 'vitest';
import type { AccountStore } from '../src/account/store.js';
import type { AccountPrincipal } from '../src/account/types.js';
import { loadConfig } from '../src/config.js';
import { ListingAuditService } from '../src/listings/service.js';
import type { ListingAuditStore, PublishListingResult } from '../src/listings/store.js';
import type { CreditListing, OfferTemplate, PublicCreditListing } from '../src/listings/types.js';
import type { SubjectAccess } from '../src/subjects/types.js';

function enabledConfig() {
  return loadConfig({
    NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32), COMPUTE_PROVIDER: 'sidecar-v1',
    COMPUTE_PROVIDER_URL: 'https://h100-sidecar.internal', COMPUTE_PROVIDER_TOKEN: 'q'.repeat(48),
    COMPUTE_ALLOCATED_ACCELERATOR_COUNT: '1', COMPUTE_NODE_ACCELERATOR_COUNT: '8',
    NODE_GPU_FINGERPRINT_PEPPER: 'g'.repeat(40), NODE_CLAIM_TOKEN_PEPPER: 'n'.repeat(40),
    NODE_CLAIM_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
    NODE_SUPPORTED_AGENT_VERSIONS: '1.0.0',
  });
}

describe('listing publish service', () => {
  it('hides stale public listings and blocks new publication when node delivery is not configured', async () => {
    let publicReads = 0; let publishes = 0; let subjectReads = 0;
    const store = {
      listPublicListings: async () => { publicReads += 1; return []; },
      publishListing: async () => { publishes += 1; throw new Error('must not publish'); },
    } as unknown as ListingAuditStore;
    const subjects = { current: async () => { subjectReads += 1; throw new Error('must fail closed first'); } } as unknown as SubjectAccess;
    const service = new ListingAuditService(store, { recordAudit: async () => undefined } as unknown as AccountStore,
      loadConfig({ NODE_ENV: 'test', AUDIT_PEPPER: 'd'.repeat(32) }), subjects);
    expect(await service.publicListings()).toEqual([]);
    await expect(service.publish({ userId: '20000000-0000-4000-8000-000000000005' } as never, {
      offerId: '20000000-0000-4000-8000-000000000007', capacityTotal: '8',
      startMode: 'immediate', durationDays: 7,
    }, 'listing-runtime-gate-0001', { requestId: 'request-gated', ip: '127.0.0.1' })).rejects.toMatchObject({
      code: 'COMPUTE_FULFILLMENT_UNAVAILABLE', statusCode: 503,
    });
    expect({ publicReads, publishes, subjectReads }).toEqual({ publicReads: 0, publishes: 0, subjectReads: 0 });
  });

  it('sends a provider back to the active listing instead of creating a duplicate draft', async () => {
    const userId = '20000000-0000-4000-8000-000000000005';
    const resourceId = '20000000-0000-4000-8000-000000000003';
    const store = {
      createWizardDraft: async () => ({ status: 'listing_active' as const }),
    } as unknown as ListingAuditStore;
    const service = new ListingAuditService(
      store,
      { recordAudit: async () => undefined } as unknown as AccountStore,
      enabledConfig(),
      { current: async () => ({
        subjectId: '20000000-0000-4000-8000-000000000004', kind: 'personal', displayName: '供应方',
        subjectStatus: 'active', role: 'owner', userId, permissions: ['provider.offer.manage'],
      }) } as SubjectAccess,
    );
    await expect(service.createWizardDraft(
      { userId, sessionId: 'session', role: 'supplier' }, resourceId, 'wizard-active-listing-0001',
      { requestId: 'req-active-listing', ip: '127.0.0.1' },
    )).rejects.toMatchObject({ code: 'RESOURCE_LISTING_ALREADY_ACTIVE', statusCode: 409 });
  });

  it('marks only the current subject listing and strips supplier identity from the public result', async () => {
    const supplierSubjectId = '20000000-0000-4000-8000-000000000004';
    const listing: PublicCreditListing = {
      id: '20000000-0000-4000-8000-000000000001', offerId: '20000000-0000-4000-8000-000000000002',
      resourceId: '20000000-0000-4000-8000-000000000003', supplierId: supplierSubjectId, supplierSubjectId,
      title: 'H100 80G 整卡独享', serviceMode: 'dedicated', productCode: 'H100', kind: 'gpu', region: '上海',
      specifications: { memory: '80GB' }, sla: { availability: '99.9%' },
      capacityTotal: '8', capacityReserved: '0', capacitySold: '0', capacityAvailable: '8',
      capacityUnit: 'GPU时', minimumQuantity: '1', unitCreditMicros: 31_137_725n,
      referenceCnyMicros: 31_200_000n, conversionCnyMicrosPerCredit: 1_002_000n, status: 'active',
      startsAt: new Date('2026-08-13T08:00:00.000Z'), expiresAt: new Date('2026-08-20T08:00:00.000Z'),
      auditValidUntil: new Date('2026-09-01T08:00:00.000Z'), createdAt: new Date('2026-08-13T08:00:00.000Z'),
    };
    const store = { listPublicListings: async () => [listing] } as unknown as ListingAuditStore;
    const subjects = { current: async () => ({
      subjectId: supplierSubjectId, kind: 'personal', displayName: '供应方', subjectStatus: 'active', role: 'owner',
      userId: '20000000-0000-4000-8000-000000000005', permissions: ['orders.read'],
    }) } as SubjectAccess;
    const service = new ListingAuditService(
      store, { recordAudit: async () => undefined } as unknown as AccountStore,
      enabledConfig(), subjects,
    );
    const anonymous = (await service.publicListings(20))[0]!;
    expect(anonymous).toMatchObject({
      ownedByCurrentSubject: false, unitCredits: '31.137725',
      selloutEstimate: {
        kind: 'gross_before_fee', grossCredits: '249.101800', basis: 'remaining_capacity',
        remainingCapacity: '8.000000', asOf: expect.any(String),
        disclosure: '按当前剩余容量全部售完测算，未扣服务费',
      },
    });
    expect(anonymous).not.toHaveProperty('supplierId');
    expect(anonymous).not.toHaveProperty('supplierSubjectId');
    const authenticated = (await service.publicListings(20, {
      userId: '20000000-0000-4000-8000-000000000005', sessionId: 'session', role: 'supplier',
    }))[0]!;
    expect(authenticated).toMatchObject({ ownedByCurrentSubject: true, unitCredits: '31.137725' });
    expect(authenticated).not.toHaveProperty('supplierId');
    expect(authenticated).not.toHaveProperty('supplierSubjectId');
  });

  it('replays an immediate publish when server time advances between retries', async () => {
    const firstNow = new Date('2026-08-12T08:00:00.000Z');
    const secondNow = new Date('2026-08-12T08:05:00.000Z');
    let nowCalls = 0;
    let storedDigest: string | null = null;
    let storedListing: CreditListing | null = null;
    const store = {
      async publishListing(input: Parameters<ListingAuditStore['publishListing']>[0]): Promise<PublishListingResult> {
        if (storedDigest !== null) return storedDigest === input.payloadDigest && storedListing
          ? { status: 'replayed', listing: storedListing }
          : { status: 'conflict' };
        storedDigest = input.payloadDigest;
        storedListing = {
          id: '20000000-0000-4000-8000-000000000001', offerId: input.offerId,
          resourceId: '20000000-0000-4000-8000-000000000002', supplierId: '20000000-0000-4000-8000-000000000003',
          capacityTotal: input.capacityTotal, capacityReserved: '0', capacitySold: '0', capacityUnit: 'GPU时', minimumQuantity: '1',
          unitCreditMicros: 31_137_725n, referenceCnyMicros: 31_200_000n,
          conversionCnyMicrosPerCredit: 1_002_000n, status: 'active', startsAt: input.startsAt,
          expiresAt: input.expiresAt, auditValidUntil: new Date('2027-02-01T00:00:00.000Z'), createdAt: input.startsAt,
        };
        return { status: 'created', listing: storedListing };
      },
    } as unknown as ListingAuditStore;
    const accounts = { recordAudit: async () => undefined } as unknown as AccountStore;
    const subjects = {
      current: async () => ({
        subjectId: '20000000-0000-4000-8000-000000000004', kind: 'personal', displayName: '供应方',
        subjectStatus: 'active', role: 'owner', userId: '20000000-0000-4000-8000-000000000005',
        permissions: ['provider.listing.manage'],
      }),
    } as SubjectAccess;
    const service = new ListingAuditService(
      store, accounts, enabledConfig(), subjects,
      () => nowCalls++ === 0 ? firstNow : secondNow,
    );
    const principal: AccountPrincipal = {
      userId: '20000000-0000-4000-8000-000000000005', sessionId: '20000000-0000-4000-8000-000000000006', role: 'supplier',
    };
    const input = {
      offerId: '20000000-0000-4000-8000-000000000007', capacityTotal: '8', startMode: 'immediate' as const, durationDays: 7,
    };
    const requestId = 'listing-immediate-retry-0001';
    const created = await service.publish(principal, input, requestId, { requestId: 'req-1', ip: '127.0.0.1' });
    const replayed = await service.publish(principal, input, requestId, { requestId: 'req-2', ip: '127.0.0.1' });
    expect(created.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(replayed.listing.id).toBe(created.listing.id);
    expect(created.listing.startsAt).toBe(firstNow.toISOString());
  });

  it('replays an expired offer reaudit after the first response is lost', async () => {
    const subjectId = '20000000-0000-4000-8000-000000000004';
    const userId = '20000000-0000-4000-8000-000000000005';
    const expired: OfferTemplate = {
      id: '20000000-0000-4000-8000-000000000007', supplierId: subjectId,
      resourceId: '20000000-0000-4000-8000-000000000003', version: 7, submissionVersion: 2,
      title: 'H100 80G 整卡独享', serviceMode: 'dedicated', nativeUnit: 'GPU时', minimumQuantity: '1',
      sla: {}, deliveryTerms: {}, acceptanceTerms: {}, refundTerms: {}, cleanupTerms: {},
      suggestedPriceCnyMicros: 31_200_000n, priceComponents: {}, priceEvidence: [], status: 'expired',
      approvedReferenceCnyMicros: null, approvedUnitCreditMicros: null, conversionCnyMicrosPerCredit: null,
      auditValidUntil: null, submittedAt: new Date('2026-08-01T00:00:00.000Z'), approvedAt: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'), updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    let current = expired;
    const store = {
      getSupplierOffer: async () => ({ offer: current, audits: [] }),
      submitOffer: async (_subjectId: string, _userId: string, _offerId: string, expectedVersion: number) => {
        if (current.status === 'expired' && expectedVersion === current.version) {
          current = { ...current, status: 'under_review', version: current.version + 1, submissionVersion: current.submissionVersion + 1 };
          return { status: 'created' as const, offer: current, audits: [] };
        }
        return current.status === 'under_review' && current.version === expectedVersion + 1
          ? { status: 'replayed' as const, offer: current, audits: [] }
          : null;
      },
    } as unknown as ListingAuditStore;
    const audits: string[] = [];
    const service = new ListingAuditService(
      store, { recordAudit: async (input: { action: string }) => { audits.push(input.action); } } as unknown as AccountStore,
      enabledConfig(),
      { current: async () => ({ subjectId, userId, kind: 'personal', displayName: '供应方', subjectStatus: 'active', role: 'owner', permissions: ['provider.offer.manage'] }) } as SubjectAccess,
    );
    const principal: AccountPrincipal = { userId, sessionId: 'session', role: 'supplier' };
    const first = await service.resubmitExpiredOffer(principal, expired.id, expired.version, { requestId: 'req-1', ip: '127.0.0.1' });
    const replay = await service.resubmitExpiredOffer(principal, expired.id, expired.version, { requestId: 'req-2', ip: '127.0.0.1' });
    expect(first).toMatchObject({ replayed: false, offer: { status: 'under_review', version: 8, submissionVersion: 3 } });
    expect(replay).toMatchObject({ replayed: true, offer: { status: 'under_review', version: 8, submissionVersion: 3 } });
    expect(audits).toEqual(['OFFER_RESUBMITTED']);
  });

  it('serializes a conflicting window with a usable next start', async () => {
    const startsAt = new Date('2026-08-13T08:00:00.000Z');
    const expiresAt = new Date('2026-08-20T08:00:00.000Z');
    const nextAvailableAt = new Date('2026-08-24T08:00:00.000Z');
    const store = {
      async listingWindowAvailability() {
        return {
          status: 'window_conflict' as const, resourceId: '20000000-0000-4000-8000-000000000002',
          capacityTotal: '8.000000', capacityUnit: 'GPU时', minimumQuantity: '1.000000',
          auditValidUntil: new Date('2026-12-01T00:00:00.000Z'), requestedStartsAt: startsAt, requestedExpiresAt: expiresAt,
          blockingStartsAt: new Date('2026-08-12T08:00:00.000Z'), blockingExpiresAt: nextAvailableAt, nextAvailableAt,
        };
      },
    } as unknown as ListingAuditStore;
    const subjects = {
      current: async () => ({
        subjectId: '20000000-0000-4000-8000-000000000004', kind: 'personal', displayName: '供应方',
        subjectStatus: 'active', role: 'owner', userId: '20000000-0000-4000-8000-000000000005',
        permissions: ['provider.listing.manage'],
      }),
    } as SubjectAccess;
    const service = new ListingAuditService(
      store, { recordAudit: async () => undefined } as unknown as AccountStore,
      enabledConfig(), subjects,
      () => new Date('2026-08-13T07:59:30.000Z'),
    );
    const availability = await service.listingWindowAvailability({
      userId: '20000000-0000-4000-8000-000000000005', sessionId: '20000000-0000-4000-8000-000000000006', role: 'supplier',
    }, { offerId: '20000000-0000-4000-8000-000000000007', startMode: 'scheduled', startsAt: startsAt.toISOString(), expiresAt: expiresAt.toISOString() });
    expect(availability).toMatchObject({
      status: 'window_conflict', capacityTotal: '8.000000', blockingExpiresAt: nextAvailableAt.toISOString(),
      nextAvailableAt: nextAvailableAt.toISOString(),
    });
  });

  it('distinguishes scheduled capacity from capacity already selling', async () => {
    const now = new Date('2026-08-13T08:00:00.000Z');
    const base: CreditListing = {
      id: '20000000-0000-4000-8000-000000000001', offerId: '20000000-0000-4000-8000-000000000002',
      resourceId: '20000000-0000-4000-8000-000000000003', supplierId: '20000000-0000-4000-8000-000000000004',
      capacityTotal: '8', capacityReserved: '0', capacitySold: '0', capacityUnit: 'GPU时', minimumQuantity: '1',
      unitCreditMicros: 31_137_725n, referenceCnyMicros: 31_200_000n, conversionCnyMicrosPerCredit: 1_002_000n,
      status: 'active', startsAt: new Date('2026-08-12T08:00:00.000Z'), expiresAt: new Date('2026-08-20T08:00:00.000Z'),
      auditValidUntil: new Date('2027-02-01T00:00:00.000Z'), createdAt: new Date('2026-08-12T08:00:00.000Z'),
    };
    let listings = [base, { ...base, id: '20000000-0000-4000-8000-000000000005', startsAt: new Date('2026-08-20T08:00:00.000Z'), expiresAt: new Date('2026-08-27T08:00:00.000Z') }];
    const store = { listSupplierListings: async () => listings } as unknown as ListingAuditStore;
    const subjects = { current: async () => ({
      subjectId: base.supplierId, kind: 'personal', displayName: '供应方', subjectStatus: 'active', role: 'owner',
      userId: '20000000-0000-4000-8000-000000000006', permissions: ['provider.read'],
    }) } as SubjectAccess;
    const service = new ListingAuditService(store, { recordAudit: async () => undefined } as unknown as AccountStore,
      enabledConfig(), subjects, () => now);
    const principal: AccountPrincipal = { userId: '20000000-0000-4000-8000-000000000006', sessionId: 'session', role: 'supplier' };
    const serialized = await service.supplierListings(principal);
    expect(serialized.map((listing) => listing.sellingStage)).toEqual(['selling', 'scheduled']);
    listings = [{ ...base, status: 'paused' }];
    expect((await service.supplierListings(principal))[0]?.sellingStage).toBe('paused');
    listings = [{ ...base, status: 'paused', startsAt: new Date('2026-08-20T08:00:00.000Z') }];
    expect((await service.supplierListings(principal))[0]?.sellingStage).toBe('scheduled_paused');
  });
});
