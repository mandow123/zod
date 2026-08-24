import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AccountService } from '../src/account/service.js';
import { loadConfig } from '../src/config.js';
import { INQUIRY_ONLY_ROUTE_ALLOWLIST, mobileRuntimePolicy } from '../src/runtime-profile.js';

const inquiryEnvironment = {
  NODE_ENV: 'test', MOBILE_API_PROFILE: 'inquiry_only', HONGHUAN_SUPPLIER_CATALOG_MODE: 'inquiry',
  TRUST_PROXY_HOPS:'1',
  PUBLIC_ORIGIN: 'https://cloudpay.kai.com', DATABASE_URL: 'postgresql://dedicated/inquiries',
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'), AUDIT_PEPPER: 'a'.repeat(32), CURSOR_SECRET: 'c'.repeat(32),
  KAI_OIDC_SUBJECT_PEPPER: 'k'.repeat(32), KAI_RESOURCE_ACCESS_TOKEN_FORMAT: 'opaque',
  OBJECT_STORAGE_PROVIDER: 's3', OBJECT_STORAGE_ENDPOINT: 'https://objects.example.test',
  OBJECT_STORAGE_REGION: 'cn-east-1', OBJECT_STORAGE_BUCKET: 'inquiry-evidence',
  OBJECT_STORAGE_ACCESS_KEY: 'object-key', OBJECT_STORAGE_SECRET_KEY: 'object-secret',
  METRICS_BEARER_TOKEN: 'm'.repeat(40), BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  BACKUP_KEY_ID: 'inquiry-backup-2026', BACKUP_LOCAL_DIRECTORY: '/var/lib/inquiry-backup',
  BACKUP_S3_ENDPOINT: 'https://backup.example.test', BACKUP_S3_REGION: 'cn-east-1',
  BACKUP_S3_BUCKET: 'inquiry-backup', BACKUP_S3_ACCESS_KEY: 'backup-key', BACKUP_S3_SECRET_KEY: 'backup-secret',
  LEGAL_ENTITY_NAME: '凯云算力有限公司', UNIFIED_SOCIAL_CREDIT_CODE: '913000000000000000',
  SUPPORT_EMAIL: 'support@example.test', SUPPORT_PHONE: '4000000000',
  PRIVACY_POLICY_URL: 'https://cloudpay.kai.com/privacy', TERMS_URL: 'https://cloudpay.kai.com/terms',
  INQUIRY_TERMS_URL: 'https://cloudpay.kai.com/inquiry-terms',
  ICP_FILING: 'ICP-TEST', ICP_FILING_STATUS:'issued', ICP_FILING_EVIDENCE_REF:'evidence://icp/test',
  APP_FILING: 'APP-TEST', APP_FILING_STATUS:'issued', APP_FILING_EVIDENCE_REF:'evidence://app/test',
  INTERNET_SERVICE_CLASSIFICATION_STATUS:'approved_with_legal_evidence',
  INTERNET_SERVICE_CLASSIFICATION_EVIDENCE_REF:'evidence://legal/classification-test',
  // Misconfigured commerce/reward values must neither open routes nor activate rewards in this profile.
  STREAMER_REWARDS_MODE: 'on', INVITE_REWARDS_MODE: 'shadow', LEGACY_CREATOR_COMMISSION_MODE: 'drain',
  ALIPAY_APP_ID: 'must-not-open-commerce', COMPUTE_PROVIDER: 'sidecar-v1',
} as const;
const config = loadConfig(inquiryEnvironment);

const database = {
  health: async () => true,
  schemaReadiness: async () => ({
    ready: true, expected: '0065_credit_order_transition_closure.sql',
    applied: '0065_credit_order_transition_closure.sql', missing: [], mismatched: [],
  }),
};

function fixture(failDynamicReadiness = false, falseWithoutBlocker = false) {
  let createCalls = 0;
  const principal = { userId: '10000000-0000-4000-8000-000000000001', sessionId: 'paired-kai', role: 'member' as const };
  const accounts = {
    authenticate: async () => ({ principal, identity: {} }),
    authenticateBootstrap: async () => ({ principal, identity: {} }),
    legalDocuments: () => ({ terms: {}, privacy: {}, inquiry: {} }),
    profile: async () => ({ id: principal.userId }),
    acceptKaiConsents: async () => ({ replayed: false, accepted: {} }),
  } as unknown as AccountService;
  const subjects = {
    list: async () => ({ subjects: [], currentSubjectId: null }),
    select: async () => ({ id: '20000000-0000-4000-8000-000000000001' }),
  };
  const catalog = {
    readiness: async () => {
      if (failDynamicReadiness) throw new Error('catalog schema unavailable');
      return { mode: 'inquiry', ready: true, blockers: [] };
    },
    list: async () => ({ items: [], nextCursor: null }),
    get: async () => ({ resourceId: 'gpu-honghuan-a100-sxm4-80gb-1' }),
  };
  const inquiries = {
    create: async () => { createCalls += 1; return { replayed: false, inquiry: { id: 'inquiry' } }; },
    list: async () => ({ inquiries: [], nextCursor: null }), get: async () => ({ id: 'inquiry' }),
    clarifications: async () => [], clarify: async () => ({ replayed: false }), cancel: async () => ({ replayed: false }),
  };
  const operations = {
    authorizeMetrics: () => undefined, prometheus: async () => 'cloudpay_inquiry_profile 1\n',
    inquiryReleaseReadiness: async () => {
      if (failDynamicReadiness) throw new Error('backup tables unavailable');
      return falseWithoutBlocker
        ? { ready: false, backup: { ready: false }, restore: { ready: false },kaiPaired: { ready: false },
          appSession:{ready:false},durability:{mode:'local_only',offsiteBackup:false,highAvailability:false,
            disasterRecovery:false,riskAccepted:true},blockers: [] }
        : { ready: true, backup: { ready: true }, restore: { ready: true },kaiPaired: { ready: true },
          appSession:{ready:true},durability:{mode:'local_only',offsiteBackup:false,highAvailability:false,
            disasterRecovery:false,riskAccepted:true},blockers: [] };
    },
  };
  const supplierDirectory = { readiness: async () => ({ ready: true, blockers: [] }),
    list: async () => ({ items: [], totalPublished: 100 }) };
  return { accounts, subjects, catalog, supplierDirectory, inquiries, operations, createCalls: () => createCalls };
}

async function appFixture(failDynamicReadiness = false, falseWithoutBlocker = false, runtimeConfig = config) {
  const services = fixture(failDynamicReadiness, falseWithoutBlocker);
  const app = await buildApp({
    config:runtimeConfig, database, accountService: services.accounts,
    subjectService: services.subjects as never, supplierInquiryCatalogService: services.catalog as never,
    supplierQuoteDirectoryService: services.supplierDirectory as never,
    resourceInquiryService: services.inquiries as never, operationsService: services.operations as never,
    // Even if callers accidentally supply full-commerce services, the profile branch must ignore them.
    marketService: {} as never, listingAuditService: {} as never, notificationService: {} as never,
    creditLedgerService: {} as never, creditTopupService: {} as never, topupReversalService: {} as never,
    creditPayoutService: {} as never, deviceCommerceService: {} as never, shippingAddressService: {} as never,
    creditOrderService: {} as never, fulfillmentService: {} as never, nodeEnrollmentService: {} as never,
    assetPortfolioService: {} as never, vastMarketService: {} as never, creatorCommissionService: {} as never,
    logger: false,
  });
  return { app, services };
}

describe('production inquiry-only API profile', () => {
  it('reports inquiry release readiness without representing commerce as enabled', async () => {
    const { app } = await appFixture();
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/readiness' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      profile: { id: 'inquiry_only', routePolicy: 'allowlist-v1' },
      release: { ready: true, profile: 'inquiry_only', scope: 'supplier_inquiry', blockers: [] },
      commerce: { enabled: false, ready: false, reason: 'PROFILE_DISABLED', releaseBlocking: false },
      capabilities: {
        objectStorage: false, unifiedIdentity: true,kaiPairedProbe: { ready: true },appSessionProbe:{ready:true},
        durability:{mode:'local_only',offsiteBackup:false,highAvailability:false,disasterRecovery:false,riskAccepted:true},
        services: { ready: true, account: true, subjects: true, resourceInquiries: true, supplierCatalog: true, operations: true },
        legacyCreatorMode: { mode: 'off', ready: false },
        streamerRewards: { mode: 'off', ready: false }, inviteRewards: { mode: 'off', ready: false },
      },
    });
    await app.close();
  });

  it('serves honest legal pages while public release remains blocked for filings and classification',async()=>{
    const blocked=loadConfig({...inquiryEnvironment,ICP_FILING:undefined,ICP_FILING_STATUS:'not_obtained',
      ICP_FILING_EVIDENCE_REF:undefined,APP_FILING:undefined,APP_FILING_STATUS:'not_obtained',
      APP_FILING_EVIDENCE_REF:undefined,INTERNET_SERVICE_CLASSIFICATION_STATUS:'not_assessed',
      INTERNET_SERVICE_CLASSIFICATION_EVIDENCE_REF:undefined});
    const {app}=await appFixture(false,false,blocked);
    const readiness=await app.inject({method:'GET',url:'/mobile/v1/readiness'});
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({capabilities:{legal:true},release:{ready:false,blockers:[
      'ICP_FILING_NOT_APPROVED','APP_FILING_NOT_APPROVED','INTERNET_SERVICE_CLASSIFICATION_REQUIRED',
    ]}});
    const legal=await app.inject({method:'GET',url:'/mobile/v1/legal'});
    expect(legal.statusCode).toBe(200);
    expect(legal.json()).toMatchObject({ok:true,operator:{legalEntityName:'凯云算力有限公司'},documents:{terms:{},privacy:{},inquiry:{}}});
    await app.close();
  });

  it('fails closed when any allowlisted service is absent even if config and schema are complete', async () => {
    const app = await buildApp({ config, database, logger: false });
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/readiness' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false, capabilities: { services: { ready: false } },
      release: { ready: false, blockers: expect.arrayContaining([
        'ACCOUNT_SERVICE', 'SUBJECT_SERVICE', 'RESOURCE_INQUIRY_SERVICE',
        'HONGHUAN_SUPPLIER_CATALOG_SERVICE', 'OPERATIONS_SERVICE',
      ]) },
    });
    await app.close();
  });

  it('checks direct operational readiness booleans rather than trusting an empty blocker array', async () => {
    const { app } = await appFixture(false, true);
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/readiness' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false, capabilities: { objectStorage: false, unifiedIdentity: false },
      release: { ready: false, blockers: expect.arrayContaining([
        'APP_STORED_SESSION','UNIFIED_IDENTITY', 'BACKUP', 'BACKUP_RECOVERY', 'INQUIRY_OPERATIONAL_EVIDENCE',
      ]) },
    });
    await app.close();
  });

  it('returns a closed readiness envelope instead of 500 when catalog or backup probes fail', async () => {
    const { app } = await appFixture(true);
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/readiness' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false, release: { ready: false, blockers: expect.arrayContaining([
        'HONGHUAN_SUPPLIER_CATALOG_READINESS', 'BACKUP_RECOVERY_READINESS',
      ]) },
    });
    await app.close();
  });

  it('registers the approved allowlist and keeps every commerce, provider, operator and legacy route physically absent', async () => {
    const { app } = await appFixture();
    expect(INQUIRY_ONLY_ROUTE_ALLOWLIST).toHaveLength(21);
    for (const { method, url } of INQUIRY_ONLY_ROUTE_ALLOWLIST) expect(app.hasRoute({ method, url })).toBe(true);

    const forbidden = [
      ['POST', '/mobile/v1/auth/otp/request'], ['GET', '/mobile/v1/auth/kai/start'],
      ['POST', '/mobile/v1/auth/kai/exchange'], ['GET', '/mobile/v1/auth/sessions'],
      ['POST', '/mobile/v1/subjects/organizations'], ['GET', '/mobile/v1/provider/bootstrap'],
      ['GET', '/mobile/v1/inquiry-catalog'], ['GET', '/mobile/v1/market/resources'],
      ['GET', '/mobile/v1/market/listings'], ['GET', '/mobile/v1/credits/balance'],
      ['POST', '/mobile/v1/credits/topups'], ['POST', '/mobile/v1/orders'],
      ['GET', '/mobile/v1/provider/resource-inquiries'], ['GET', '/mobile/v1/operator/resource-inquiries'],
      ['GET', '/mobile/v1/operator/operations/summary'], ['GET', '/mobile/v1/vast/offers'],
      ['GET', '/mobile/v1/creator/commissions'], ['GET', '/mobile/v1/notifications'],
      ['POST', '/mobile/v1/account/deletion/public'], ['POST', '/mobile/v1/account/deletion'],
    ] as const;
    for (const [method, url] of forbidden) {
      expect(app.hasRoute({ method, url })).toBe(false);
      expect((await app.inject({ method, url })).statusCode).toBe(404);
    }
    await app.close();
  });

  it('has no worker or commerce-service activation plan regardless of unrelated provider configuration', () => {
    expect(mobileRuntimePolicy(config.mobileApiProfile)).toEqual({
      commerceServicesEnabled: false, workerNames: [], routePolicy: 'allowlist-v1',
    });
  });

  it('accepts only the formal supplier-resource union and rejects legacy candidate payloads before service code', async () => {
    const { app, services } = await appFixture();
    const legacy = await app.inject({
      method: 'POST', url: '/mobile/v1/resource-inquiries', headers: { 'idempotency-key': 'legacy-disabled-0001' },
      payload: {
        candidateId: '30000000-0000-4000-8000-000000000001', gpuCount: 1,
        startsAt: '2026-08-25T01:00:00.000Z', endsAt: '2026-08-25T09:00:00.000Z', timeZone: 'Asia/Shanghai',
        confirmBy: '2026-08-24T01:00:00.000Z', billingMode: 'hourly', allowSubstitutes: false,
        maxCreditAmount: '100.00', useCase: 'research',
        description: '用于已通过数据合规审核的内部科研计算与模型验证任务。', environment: 'container',
        network: 'private_network', storageGiB: 2048, dataRegion: '中国大陆·华东',
        terms: { termsVersion: '2026-08-11', privacyVersion: '2026-08-11', inquiryVersion: '2026-08-18' },
      },
    });
    expect(legacy.statusCode).toBe(400);
    expect(legacy.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(services.createCalls()).toBe(0);
    await app.close();
  });
});
