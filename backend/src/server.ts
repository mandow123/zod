import { buildApp } from './app.js';
import { AccountService } from './account/service.js';
import { createSmsProvider, UnavailableSmsProvider } from './account/sms.js';
import { PostgresAccountStore } from './account/store.js';
import { AccountDeletionWorker, PostgresAccountDeletionStore } from './account/deletion-worker.js';
import { MarketService } from './market/service.js';
import { PostgresMarketStore } from './market/store.js';
import { ListingAuditService } from './listings/service.js';
import { PostgresListingAuditStore } from './listings/store.js';
import { SubjectService } from './subjects/service.js';
import { PostgresSubjectStore } from './subjects/store.js';
import { NotificationService } from './notifications/service.js';
import { PostgresNotificationStore } from './notifications/store.js';
import { createPushProvider } from './notifications/push-provider.js';
import { PostgresPushOutboxStore } from './notifications/push-store.js';
import { PushOutboxWorker, PushProcessor } from './notifications/push-worker.js';
import type { WorkerLogger } from './refunds/processor.js';
import { OperationsService } from './operations/service.js';
import { PostgresOperationsStore } from './operations/store.js';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { createPrivateObjectStore } from './storage/object-store.js';
import { createMalwareScanner } from './evidence/scanner.js';
import { EvidenceScanWorker } from './evidence/worker.js';
import { ResourceEvidenceStore } from './resource-evidence/store.js';
import { ResourceEvidenceService } from './resource-evidence/service.js';
import { ResourceEvidenceScanStore } from './resource-evidence/scan-store.js';
import { CreditLedgerService } from './credits/service.js';
import { PostgresCreditLedgerStore } from './credits/store.js';
import { createPaymentProviders } from './payment/providers.js';
import { CreditTopupService } from './topups/service.js';
import { PostgresCreditTopupStore } from './topups/store.js';
import { PostgresTopupRecoveryStore, TopupRecoveryWorker } from './topups/recovery.js';
import { CreditOrderService } from './credit-orders/service.js';
import { PostgresCreditOrderStore } from './credit-orders/store.js';
import { CreditOrderExpiryWorker } from './credit-orders/expiry-worker.js';
import { CreditSupplierSettlementWorker } from './credit-orders/settlement-worker.js';
import { createComputeProvider } from './fulfillment/provider.js';
import { PostgresFulfillmentStore } from './fulfillment/store.js';
import { FulfillmentService } from './fulfillment/service.js';
import { FulfillmentExpiryWorker } from './fulfillment/expiry-worker.js';
import { secretHash } from './account/crypto.js';
import { NodeEnrollmentStore } from './node-enrollment/store.js';
import { NodeEnrollmentService } from './node-enrollment/service.js';
import { PostgresKaiIdentityStore } from './account/kai-identity-store.js';
import { KaiOidcBroker } from './account/kai-oidc.js';
import { PostgresCreditPayoutStore } from './payouts/store.js';
import { CreditPayoutService } from './payouts/service.js';
import { PostgresDeviceCommerceStore } from './device-commerce/store.js';
import { DeviceCommerceService } from './device-commerce/service.js';
import { DeviceOrderExpiryWorker } from './device-commerce/expiry-worker.js';
import { DeviceSettlementWorker } from './device-commerce/settlement-worker.js';
import { PostgresShippingAddressStore } from './shipping-addresses/store.js';
import { ShippingAddressService } from './shipping-addresses/service.js';
import { PostgresTopupReversalStore } from './topups/reversal-store.js';
import { TopupReversalService } from './topups/reversal-service.js';
import { AssetPortfolioService } from './assets/service.js';
import { createVastAiProvider } from './vast-market/provider.js';
import { PostgresVastMarketStore } from './vast-market/store.js';
import { VastMarketService } from './vast-market/service.js';
import { VastReconciliationWorker } from './vast-market/recovery-worker.js';
import { FirstPartyAttributionProvider } from './creator-commissions/provider.js';
import { PostgresCreatorCommissionStore } from './creator-commissions/store.js';
import { CreatorCommissionService } from './creator-commissions/service.js';
import { CreatorCommissionWorker } from './creator-commissions/worker.js';
import { PostgresResourceInquiryStore } from './resource-inquiries/store.js';
import { ResourceInquiryService } from './resource-inquiries/service.js';
import { ResourceInquiryExpiryWorker } from './resource-inquiries/worker.js';
import { AdminAuthService } from './admin/auth-service.js';
import { PostgresAdminAuditStore } from './admin/audit-store.js';
import { PostgresAdminIdentityStore } from './admin/identity-store.js';
import { PostgresAdminLoginTransactionStore } from './admin/login-transaction-store.js';
import { PostgresAdminRbacStore } from './admin/rbac-store.js';
import { adminAuthRuntimeSettings } from './admin/runtime.js';
import { PostgresAdminSessionStore } from './admin/session-store.js';
import { AdminSessionMaintenance } from './admin/maintenance.js';
import { PostgresAdminP0Store } from './admin/p0-store.js';
import { AdminP0Service } from './admin/p0-service.js';
import { KaiOidcClient } from './identity/kai-oidc-client.js';
import { KaiIdTokenVerifier } from './identity/kai-id-token-verifier.js';

const config = loadConfig(process.env);
if (config.NODE_ENV === 'production' && !config.readiness.coreReady) {
  throw new Error(`Production configuration is unsafe: ${config.readiness.coreBlockers.join(', ')}`);
}

const database = createDatabase(config);
const adminAuthSettings = adminAuthRuntimeSettings(config);
const privateObjects = createPrivateObjectStore(config);
const malwareScanner = createMalwareScanner(config);
const paymentProviders = createPaymentProviders(config);
const accountStore = database ? new PostgresAccountStore(database) : undefined;
const marketStore = database ? new PostgresMarketStore(database) : undefined;
const listingStore = database ? new PostgresListingAuditStore(database) : undefined;
const accountService = accountStore && config.readiness.capabilities.tokenSecurity.available
  ? new AccountService(accountStore, createSmsProvider(config) ?? new UnavailableSmsProvider(), config)
  : undefined;
const kaiOidc = database && accountService && config.readiness.capabilities.kaiOidc.available
  ? new KaiOidcBroker(new PostgresKaiIdentityStore(database), accountService, config)
  : undefined;
const subjectService = database && accountStore && config.readiness.capabilities.tokenSecurity.available
  ? new SubjectService(new PostgresSubjectStore(database), accountStore, config, listingStore)
  : undefined;
const marketService = marketStore && accountStore && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new MarketService(marketStore, accountStore, config, subjectService)
  : undefined;
const listingAuditService = listingStore && accountStore && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new ListingAuditService(listingStore, accountStore, config, subjectService)
  : undefined;
const notificationService = database && accountStore && config.readiness.capabilities.tokenSecurity.available
  ? new NotificationService(new PostgresNotificationStore(database), accountStore, config)
  : undefined;
const pushProvider = createPushProvider(config);
const operationsService = database && config.readiness.capabilities.observability.available
  ? new OperationsService(new PostgresOperationsStore(database), config)
  : undefined;
const resourceEvidenceService = database && accountStore && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new ResourceEvidenceService(new ResourceEvidenceStore(database), accountStore, subjectService, privateObjects, config)
  : undefined;
const creditLedgerService = database && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new CreditLedgerService(new PostgresCreditLedgerStore(database), subjectService)
  : undefined;
const creditTopupStore = database ? new PostgresCreditTopupStore(database) : undefined;
const creditTopupService = creditTopupStore && accountStore && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new CreditTopupService(creditTopupStore, accountStore, subjectService, paymentProviders, config)
  : undefined;
const topupReversalService = database && config.readiness.capabilities.tokenSecurity.available
  ? new TopupReversalService(new PostgresTopupReversalStore(database), config)
  : undefined;
const creditPayoutService = database && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new CreditPayoutService(new PostgresCreditPayoutStore(database), subjectService, config)
  : undefined;
const deviceCommerceStore = database ? new PostgresDeviceCommerceStore(database) : undefined;
const deviceCommerceService = deviceCommerceStore && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new DeviceCommerceService(deviceCommerceStore, subjectService, config)
  : undefined;
const shippingAddressService = database && subjectService && config.readiness.capabilities.tokenSecurity.available
  && config.PII_ENCRYPTION_KEY && config.AUDIT_PEPPER
  ? new ShippingAddressService(new PostgresShippingAddressStore(database), subjectService, config)
  : undefined;
const creditOrderStore = database ? new PostgresCreditOrderStore(database) : undefined;
const fulfillmentStore = database ? new PostgresFulfillmentStore(database) : undefined;
const computeProvider = createComputeProvider(config);
const fulfillmentService = fulfillmentStore && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new FulfillmentService(fulfillmentStore, subjectService, computeProvider, config)
  : undefined;
const creditOrderService = creditOrderStore && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new CreditOrderService(creditOrderStore, subjectService, config, undefined, fulfillmentService)
  : undefined;
const assetPortfolioService = marketStore && deviceCommerceStore && creditOrderStore && subjectService
  && config.readiness.capabilities.tokenSecurity.available
  ? new AssetPortfolioService(marketStore, deviceCommerceStore, creditOrderStore, subjectService)
  : undefined;
const vastProvider = createVastAiProvider(config);
const vastMarketService = database && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new VastMarketService(new PostgresVastMarketStore(database),subjectService,vastProvider,config.vastPricingPolicy)
  : undefined;
const creatorCommissionStore=database?new PostgresCreatorCommissionStore(database):undefined;
const creatorCommissionService=creatorCommissionStore&&subjectService&&config.readiness.capabilities.tokenSecurity.available
  &&config.readiness.capabilities.creatorCommissions.available&&config.CREATOR_REFERRAL_SIGNING_SECRET
  ?new CreatorCommissionService(creatorCommissionStore,subjectService,
    new FirstPartyAttributionProvider(config.CREATOR_REFERRAL_SIGNING_SECRET),config.creatorCommissionPolicy,config.PUBLIC_ORIGIN)
  :undefined;
const resourceInquiryService=database&&subjectService&&config.readiness.capabilities.tokenSecurity.available
  ?new ResourceInquiryService(new PostgresResourceInquiryStore(database),subjectService,config):undefined;
const adminSessionStore = database && adminAuthSettings
  ? new PostgresAdminSessionStore(database, {
    previousTokenGraceMs: adminAuthSettings.previousTokenGraceSeconds * 1_000,
  }) : undefined;
const adminAuthService = database && adminAuthSettings && adminSessionStore
  ? new AdminAuthService(
    new PostgresAdminIdentityStore(database),
    new PostgresAdminRbacStore(database),
    adminSessionStore,
    new PostgresAdminLoginTransactionStore(database),
    new PostgresAdminAuditStore(database, adminAuthSettings.auditPepper),
    new KaiOidcClient(
      adminAuthSettings.oidcClientId,
      adminAuthSettings.oidcClientSecret,
      adminAuthSettings.oidcRedirectUri,
    ),
    new KaiIdTokenVerifier(adminAuthSettings.oidcClientId),
    adminAuthSettings,
  ) : undefined;
const adminP0Service = database && adminAuthSettings
  ? new AdminP0Service(new PostgresAdminP0Store(database)) : undefined;
const nodeEnrollmentService = database && accountStore && subjectService
  && config.readiness.capabilities.nodeEnrollment.available && config.AUDIT_PEPPER
  ? new NodeEnrollmentService(new NodeEnrollmentStore(database,
    config.NODE_GPU_FINGERPRINT_PEPPER!, config.NODE_CLAIM_TOKEN_PEPPER!, config.NODE_CLAIM_TOKEN_ENCRYPTION_KEY!,
    'gpu-dedicated-v1', config.nodeSupportedAgentVersions), subjectService, {
      record: async (input) => accountStore.recordAudit({ actorId: input.actorUserId,
        actorKind: input.actorUserId ? 'user' : 'system', action: input.action, entityType: input.entityType,
        entityId: input.entityId, requestId: input.requestId,
        ipHash: secretHash(input.ip || 'unknown', config.AUDIT_PEPPER!),
        payloadDigest: secretHash(JSON.stringify(input.details), config.AUDIT_PEPPER!), metadata: input.details }),
    })
  : undefined;
const app = await buildApp({
  config,
  database,
  ...(accountService ? { accountService } : {}),
  ...(subjectService ? { subjectService } : {}),
  ...(marketService ? { marketService } : {}),
  ...(listingAuditService ? { listingAuditService } : {}),
  ...(notificationService ? { notificationService } : {}),
  ...(operationsService ? { operationsService } : {}),
  ...(resourceEvidenceService ? { resourceEvidenceService } : {}),
  ...(creditLedgerService ? { creditLedgerService } : {}),
  ...(creditTopupService ? { creditTopupService } : {}),
  ...(topupReversalService ? { topupReversalService } : {}),
  ...(creditPayoutService ? { creditPayoutService } : {}),
  ...(deviceCommerceService ? { deviceCommerceService } : {}),
  ...(shippingAddressService ? { shippingAddressService } : {}),
  ...(creditOrderService ? { creditOrderService } : {}),
  ...(fulfillmentService ? { fulfillmentService } : {}),
  ...(nodeEnrollmentService ? { nodeEnrollmentService } : {}),
  ...(kaiOidc ? { kaiOidc } : {}),
  ...(assetPortfolioService ? { assetPortfolioService } : {}),
  ...(vastMarketService ? { vastMarketService } : {}),
  ...(creatorCommissionService ? { creatorCommissionService } : {}),
  ...(resourceInquiryService ? { resourceInquiryService } : {}),
  ...(adminAuthService && adminAuthSettings ? {
    adminAuthService,
    adminAuthSettings,
    ...(adminP0Service ? { adminP0Service } : {}),
  } : {}),
});
const adminSessionMaintenance = adminSessionStore
  ? new AdminSessionMaintenance(adminSessionStore, {
    logger: { error: (event) => app.log.error(event, 'administrator session registry cleanup failed') },
  }) : undefined;
const vastReconciliationWorker = vastMarketService && vastProvider.available
  ? new VastReconciliationWorker(vastMarketService,app.log as WorkerLogger)
  : undefined;
const creatorCommissionWorker=creatorCommissionStore&&config.creatorCommissionPolicy
  &&config.readiness.capabilities.creatorCommissions.available
  ?new CreatorCommissionWorker(creatorCommissionStore,config.creatorCommissionPolicy.refundObservationDays,app.log as WorkerLogger)
  :undefined;
const resourceInquiryExpiryWorker=resourceInquiryService
  ?new ResourceInquiryExpiryWorker(resourceInquiryService,app.log as WorkerLogger):undefined;
const topupRecoveryWorker = database && creditTopupStore && paymentProviders.size > 0
  ? new TopupRecoveryWorker(new PostgresTopupRecoveryStore(database), creditTopupStore, paymentProviders, app.log as WorkerLogger)
  : undefined;
const creditOrderExpiryWorker = creditOrderStore
  ? new CreditOrderExpiryWorker(creditOrderStore, app.log as WorkerLogger)
  : undefined;
const creditSupplierSettlementWorker = creditOrderStore
  ? new CreditSupplierSettlementWorker(creditOrderStore, app.log as WorkerLogger)
  : undefined;
const fulfillmentExpiryWorker = fulfillmentService && computeProvider.available
  ? new FulfillmentExpiryWorker(fulfillmentService, app.log as WorkerLogger)
  : undefined;
const deviceOrderExpiryWorker = deviceCommerceStore
  ? new DeviceOrderExpiryWorker(deviceCommerceStore, app.log as WorkerLogger)
  : undefined;
const deviceSettlementWorker = deviceCommerceStore
  ? new DeviceSettlementWorker(deviceCommerceStore, app.log as WorkerLogger)
  : undefined;
const resourceEvidenceWorker = database && privateObjects && malwareScanner
  ? new EvidenceScanWorker(new ResourceEvidenceScanStore(database), privateObjects, malwareScanner, app.log as WorkerLogger)
  : undefined;
const pushWorker = database && pushProvider && config.readiness.capabilities.tokenSecurity.available
  ? (() => {
      const store = new PostgresPushOutboxStore(database);
      return new PushOutboxWorker(store, new PushProcessor(store, pushProvider, config), app.log as WorkerLogger);
    })()
  : undefined;
const accountDeletionWorker = database && config.readiness.capabilities.tokenSecurity.available
  ? new AccountDeletionWorker(new PostgresAccountDeletionStore(database, config), app.log as WorkerLogger)
  : undefined;
pushWorker?.start();
vastReconciliationWorker?.start();
creatorCommissionWorker?.start();
resourceInquiryExpiryWorker?.start();
accountDeletionWorker?.start();
resourceEvidenceWorker?.start();
topupRecoveryWorker?.start();
creditOrderExpiryWorker?.start();
creditSupplierSettlementWorker?.start();
fulfillmentExpiryWorker?.start();
deviceOrderExpiryWorker?.start();
deviceSettlementWorker?.start();
adminSessionMaintenance?.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'graceful shutdown');
  await pushWorker?.stop();
  await accountDeletionWorker?.stop();
  await resourceEvidenceWorker?.stop();
  await topupRecoveryWorker?.stop();
  await creditOrderExpiryWorker?.stop();
  await creditSupplierSettlementWorker?.stop();
  await fulfillmentExpiryWorker?.stop();
  await deviceOrderExpiryWorker?.stop();
  await deviceSettlementWorker?.stop();
  adminSessionMaintenance?.stop();
  vastReconciliationWorker?.stop();
  creatorCommissionWorker?.stop();
  resourceInquiryExpiryWorker?.stop();
  await app.close();
  await database?.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
