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
import { PostgresCreditBalanceSnapshotReader } from './credits/lot-allocator.js';
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
import { createKaiResourceAccessAuthenticator } from './account/kai-access.js';
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
import { PostgresSupplierInquiryCatalogStore } from './supplier-inquiry-catalog/store.js';
import { SupplierInquiryCatalogService } from './supplier-inquiry-catalog/service.js';
import { PostgresSupplierQuoteDirectoryStore } from './supplier-quote-directory/store.js';
import { SupplierQuoteDirectoryService } from './supplier-quote-directory/service.js';
import { QixiangProvider } from './payment/qixiang-provider.js';
import {
  loadQixiangCheckoutKey, loadQixiangGatePublicKey, loadQixiangGateReceipt, loadQixiangMerchantKey,
  qixiangCheckoutKeyPath, qixiangGatePublicKeyPath, qixiangMerchantKeyPath,
} from './payment/qixiang-credential.js';
import { PostgresQixiangEvidenceStore, QixiangEvidenceService } from './topups/qixiang-evidence.js';
import { PostgresQixiangTopupStore } from './topups/qixiang-store.js';
import { QixiangTopupService } from './topups/qixiang-service.js';
import { QixiangQueryWorker } from './topups/qixiang-worker.js';
import { CreditLotExpiryWorker, PostgresCreditLotExpiryStore } from './credits/lot-expiry-worker.js';
import { PostgresQixiangRefundStore } from './topups/qixiang-refund-store.js';
import { QixiangRefundService } from './topups/qixiang-refund-service.js';
import { qixiangDatabaseGateState, QixiangProductionGate } from './topups/qixiang-production-gate.js';
import { mobileRuntimePolicy } from './runtime-profile.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ComputeRequirementParser } from './compute-intelligence/parser.js';
import { ComputeIntelligenceService } from './compute-intelligence/service.js';
import { rankingWeightsFromEnvironment } from './compute-intelligence/engine.js';
import { ComputeDataFlywheelService } from './compute-data/service.js';
import { PostgresComputeDataFlywheelStore } from './compute-data/store.js';

const config = loadConfig(process.env);
if (config.NODE_ENV === 'production' && !config.readiness.coreReady) {
  throw new Error(`Production configuration is unsafe: ${config.readiness.coreBlockers.join(', ')}`);
}
const runtimePolicy = mobileRuntimePolicy(config.mobileApiProfile);
const commerceRuntime = runtimePolicy.commerceServicesEnabled;

const database = createDatabase(config);
const adminAuthSettings = adminAuthRuntimeSettings(config);
const privateObjects = commerceRuntime ? createPrivateObjectStore(config) : null;
const malwareScanner = commerceRuntime ? createMalwareScanner(config) : null;
const paymentProviders = commerceRuntime ? createPaymentProviders(config) : new Map();
const accountStore = database ? new PostgresAccountStore(database) : undefined;
const marketStore = commerceRuntime && database ? new PostgresMarketStore(database) : undefined;
const listingStore = commerceRuntime && database ? new PostgresListingAuditStore(database) : undefined;
const kaiIdentityStore = database ? new PostgresKaiIdentityStore(database) : undefined;
const resourceAccessAuthenticator = kaiIdentityStore
  ? createKaiResourceAccessAuthenticator(config, kaiIdentityStore)
  : undefined;
const accountService = accountStore && config.readiness.capabilities.accountSecurity.available
  ? new AccountService(accountStore, commerceRuntime
    ? createSmsProvider(config) ?? new UnavailableSmsProvider()
    : new UnavailableSmsProvider(), config,
    () => new Date(), resourceAccessAuthenticator ?? undefined)
  : undefined;
const kaiOidc = commerceRuntime && config.NODE_ENV !== 'production' && kaiIdentityStore && accountService
  && config.readiness.capabilities.kaiOidc.available
  ? new KaiOidcBroker(kaiIdentityStore, accountService, config)
  : undefined;
const subjectService = database && accountStore && config.readiness.capabilities.accountSecurity.available
  ? new SubjectService(new PostgresSubjectStore(database), accountStore, config, listingStore)
  : undefined;
const marketService = marketStore && accountStore && subjectService && config.readiness.capabilities.accountSecurity.available
  ? new MarketService(marketStore, accountStore, config, subjectService)
  : undefined;
const listingAuditService = listingStore && accountStore && subjectService && config.readiness.capabilities.accountSecurity.available
  ? new ListingAuditService(listingStore, accountStore, config, subjectService)
  : undefined;
const computeIntelligenceService = commerceRuntime && database && listingStore && subjectService
  && config.readiness.capabilities.accountSecurity.available
  ? new ComputeIntelligenceService(
    listingStore, subjectService, new ComputeRequirementParser(),
    new ComputeDataFlywheelService(new PostgresComputeDataFlywheelStore(database)),
    rankingWeightsFromEnvironment(process.env.KAI_COMPUTE_RANKING_WEIGHTS),
    config.NODE_ENV, config.NODE_ENV === 'production' ? 'business' : 'synthetic',
  ) : undefined;
const notificationService = commerceRuntime && database && accountStore && config.readiness.capabilities.accountSecurity.available
  ? new NotificationService(new PostgresNotificationStore(database), accountStore, config)
  : undefined;
const pushProvider = commerceRuntime ? createPushProvider(config) : null;
const operationsService = database && config.readiness.capabilities.observability.available
  ? new OperationsService(new PostgresOperationsStore(database), config)
  : undefined;
const resourceEvidenceService = commerceRuntime && database && accountStore && subjectService && config.readiness.capabilities.accountSecurity.available
  ? new ResourceEvidenceService(new ResourceEvidenceStore(database), accountStore, subjectService, privateObjects, config)
  : undefined;
const creditLedgerService = commerceRuntime && database && subjectService && config.readiness.capabilities.accountSecurity.available
  ? new CreditLedgerService(new PostgresCreditLedgerStore(database), subjectService,
    new PostgresCreditBalanceSnapshotReader(database))
  : undefined;
const creditTopupStore = commerceRuntime && database ? new PostgresCreditTopupStore(database) : undefined;
const creditTopupService = creditTopupStore && accountStore && subjectService && config.readiness.capabilities.accountSecurity.available
  ? new CreditTopupService(creditTopupStore, accountStore, subjectService, paymentProviders, config)
  : undefined;
const topupReversalService = commerceRuntime && database && config.readiness.capabilities.accountSecurity.available
  ? new TopupReversalService(new PostgresTopupReversalStore(database), config)
  : undefined;
const creditPayoutService = commerceRuntime && database && subjectService && config.readiness.capabilities.accountSecurity.available
  ? new CreditPayoutService(new PostgresCreditPayoutStore(database), subjectService, config)
  : undefined;
const deviceCommerceStore = commerceRuntime && database ? new PostgresDeviceCommerceStore(database) : undefined;
const deviceCommerceService = deviceCommerceStore && subjectService && config.readiness.capabilities.accountSecurity.available
  ? new DeviceCommerceService(deviceCommerceStore, subjectService, config)
  : undefined;
const shippingAddressService = commerceRuntime && database && subjectService && config.readiness.capabilities.accountSecurity.available
  && config.PII_ENCRYPTION_KEY && config.AUDIT_PEPPER
  ? new ShippingAddressService(new PostgresShippingAddressStore(database), subjectService, config)
  : undefined;
const creditOrderStore = commerceRuntime && database ? new PostgresCreditOrderStore(database) : undefined;
const fulfillmentStore = commerceRuntime && database ? new PostgresFulfillmentStore(database) : undefined;
const computeProvider = commerceRuntime ? createComputeProvider(config) : null;
const fulfillmentService = fulfillmentStore && subjectService && computeProvider
  && config.readiness.capabilities.accountSecurity.available
  ? new FulfillmentService(fulfillmentStore, subjectService, computeProvider, config)
  : undefined;
const creditOrderService = creditOrderStore && subjectService && config.readiness.capabilities.accountSecurity.available
  ? new CreditOrderService(creditOrderStore, subjectService, config, undefined, fulfillmentService)
  : undefined;
const assetPortfolioService = marketStore && deviceCommerceStore && creditOrderStore && subjectService
  && config.readiness.capabilities.accountSecurity.available
  ? new AssetPortfolioService(marketStore, deviceCommerceStore, creditOrderStore, subjectService)
  : undefined;
const vastProvider = commerceRuntime ? createVastAiProvider(config) : null;
const vastMarketService = commerceRuntime && database && subjectService && vastProvider
  && config.readiness.capabilities.accountSecurity.available
  ? new VastMarketService(new PostgresVastMarketStore(database),subjectService,vastProvider,config.vastPricingPolicy)
  : undefined;
const creatorCommissionStore=commerceRuntime&&database?new PostgresCreatorCommissionStore(database):undefined;
const creatorCommissionService=creatorCommissionStore&&subjectService&&config.readiness.capabilities.accountSecurity.available
  &&config.readiness.capabilities.creatorCommissions.available&&config.CREATOR_REFERRAL_SIGNING_SECRET
  ?new CreatorCommissionService(creatorCommissionStore,subjectService,
    new FirstPartyAttributionProvider(config.CREATOR_REFERRAL_SIGNING_SECRET),config.creatorCommissionPolicy,
    config.PUBLIC_ORIGIN,()=>new Date(),config.legacyCreatorCommissionMode)
  :undefined;
const resourceInquiryService=database&&subjectService&&config.readiness.capabilities.accountSecurity.available
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
const supplierInquiryCatalogService=database&&config.CURSOR_SECRET
  ?new SupplierInquiryCatalogService(new PostgresSupplierInquiryCatalogStore(database),
    config.honghuanSupplierCatalogMode,config.CURSOR_SECRET):undefined;
const supplierQuoteDirectoryService=database
  ?new SupplierQuoteDirectoryService(new PostgresSupplierQuoteDirectoryStore(database)):undefined;
const qixiangRuntime=commerceRuntime&&database&&subjectService&&config.qixiangRecoveryMode==='on'
  &&config.readiness.capabilities.qixiangRecovery.available&&config.CREDENTIALS_DIRECTORY&&config.AUDIT_PEPPER
  ?(()=>{const merchantKey=loadQixiangMerchantKey(qixiangMerchantKeyPath({credentialDirectory:config.CREDENTIALS_DIRECTORY}));
    const checkoutKey=loadQixiangCheckoutKey(qixiangCheckoutKeyPath({credentialDirectory:config.CREDENTIALS_DIRECTORY}));
    const productionGate=config.NODE_ENV==='production'?new QixiangProductionGate({
      receipt:loadQixiangGateReceipt('/var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json'),
      verificationPublicKeyPem:loadQixiangGatePublicKey(qixiangGatePublicKeyPath(config.CREDENTIALS_DIRECTORY)),
      environment:process.env,merchantKey,checkoutKey,
      releaseManifestSha256:createHash('sha256').update(readFileSync(join(process.cwd(),'RELEASE-MANIFEST.json'))).digest('hex'),
      receiptLoader:()=>loadQixiangGateReceipt('/var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json'),
      databaseStateLoader:()=>qixiangDatabaseGateState((text,values)=>database.query(text,values)),
    }):undefined;
    const provider=new QixiangProvider(merchantKey,config.AUDIT_PEPPER!);
    const store=new PostgresQixiangTopupStore(database);
    const evidence=new QixiangEvidenceService(new PostgresQixiangEvidenceStore(database),config);
    return{checkoutKey,provider,store,productionGate,service:new QixiangTopupService(store,subjectService,provider,evidence,checkoutKey,config,
      ()=>new Date(),productionGate),refundService:new QixiangRefundService(new PostgresQixiangRefundStore(database),provider,config,
      ()=>new Date(),productionGate)};})()
  :undefined;
const qixiangStartupGate=qixiangRuntime?.productionGate?await qixiangRuntime.productionGate.requireStartup():null;
const qixiangBootstrapCanary=qixiangStartupGate?.phase==='bootstrap_canary';
const qixiangBootstrapCanaryTopupId=qixiangBootstrapCanary?qixiangStartupGate.canaryTopupId:null;
let runtimeWorkerLogger:WorkerLogger|null=null;
const creditLotExpiryLogger:WorkerLogger={info:(fields,message)=>runtimeWorkerLogger?.info(fields,message),
  error:(fields,message)=>runtimeWorkerLogger?.error(fields,message)};
const creditLotExpiryWorker=commerceRuntime&&database
  ?new CreditLotExpiryWorker(new PostgresCreditLotExpiryStore(database),creditLotExpiryLogger):undefined;
const qixiangQueryLogger:WorkerLogger={info:(fields,message)=>runtimeWorkerLogger?.info(fields,message),
  error:(fields,message)=>runtimeWorkerLogger?.error(fields,message)};
const qixiangQueryWorker=qixiangRuntime
  ?new QixiangQueryWorker(qixiangRuntime.store,qixiangRuntime.provider,config.AUDIT_PEPPER!,qixiangQueryLogger,
    15_000,()=>new Date(),qixiangBootstrapCanaryTopupId)
  :undefined;
const nodeEnrollmentService = commerceRuntime && database && accountStore && subjectService
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
  ...(computeIntelligenceService ? { computeIntelligenceService } : {}),
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
  ...(supplierInquiryCatalogService ? { supplierInquiryCatalogService } : {}),
  ...(supplierQuoteDirectoryService ? { supplierQuoteDirectoryService } : {}),
  ...(resourceInquiryService ? { resourceInquiryService } : {}),
  ...(adminAuthService && adminAuthSettings ? {
    adminAuthService,
    adminAuthSettings,
    ...(adminP0Service ? { adminP0Service } : {}),
  } : {}),
  ...(qixiangRuntime ? { qixiangTopupService:qixiangRuntime.service } : {}),
  ...(qixiangRuntime ? { qixiangRefundService:qixiangRuntime.refundService } : {}),
  ...(qixiangBootstrapCanary?{qixiangBootstrapCanary:true,qixiangBootstrapCanaryTopupId}:{}),
  ...(creditLotExpiryWorker?{creditLotExpiryHealth:()=>creditLotExpiryWorker.health()}:{}),
  ...(qixiangQueryWorker?{qixiangQueryWorkerHealth:()=>qixiangQueryWorker.health()}:{}),
  ...(qixiangRuntime?{qixiangNewTopupsAvailable:async()=>config.qixiangTopupMode==='on'
    &&(Boolean(qixiangBootstrapCanary)||Boolean(creditLotExpiryWorker?.health().ready))
    &&Boolean((await qixiangQueryWorker?.health())?.ready)}:{}),
});
runtimeWorkerLogger=app.log as WorkerLogger;
const adminSessionMaintenance = adminSessionStore
  ? new AdminSessionMaintenance(adminSessionStore, {
    logger: { error: (event) => app.log.error(event, 'administrator session registry cleanup failed') },
  }) : undefined;
const vastReconciliationWorker = commerceRuntime && vastMarketService && vastProvider?.available
  ? new VastReconciliationWorker(vastMarketService,app.log as WorkerLogger)
  : undefined;
const creatorCommissionWorker=commerceRuntime&&creatorCommissionStore&&config.creatorCommissionPolicy
  &&config.legacyCreatorCommissionMode==='drain'&&config.readiness.capabilities.creatorCommissions.available
  ?new CreatorCommissionWorker(creatorCommissionStore,config.creatorCommissionPolicy.refundObservationDays,app.log as WorkerLogger)
  :undefined;
const resourceInquiryExpiryWorker=commerceRuntime&&resourceInquiryService
  ?new ResourceInquiryExpiryWorker(resourceInquiryService,app.log as WorkerLogger):undefined;
const topupRecoveryWorker = commerceRuntime && database && creditTopupStore && paymentProviders.size > 0
  ? new TopupRecoveryWorker(new PostgresTopupRecoveryStore(database), creditTopupStore, paymentProviders, app.log as WorkerLogger)
  : undefined;
const creditOrderExpiryWorker = commerceRuntime && creditOrderStore
  ? new CreditOrderExpiryWorker(creditOrderStore, app.log as WorkerLogger)
  : undefined;
const creditSupplierSettlementWorker = commerceRuntime && creditOrderStore
  ? new CreditSupplierSettlementWorker(creditOrderStore, app.log as WorkerLogger)
  : undefined;
const fulfillmentExpiryWorker = commerceRuntime && fulfillmentService && computeProvider?.available
  ? new FulfillmentExpiryWorker(fulfillmentService, app.log as WorkerLogger)
  : undefined;
const deviceOrderExpiryWorker = commerceRuntime && deviceCommerceStore
  ? new DeviceOrderExpiryWorker(deviceCommerceStore, app.log as WorkerLogger)
  : undefined;
const deviceSettlementWorker = commerceRuntime && deviceCommerceStore
  ? new DeviceSettlementWorker(deviceCommerceStore, app.log as WorkerLogger)
  : undefined;
const resourceEvidenceWorker = commerceRuntime && database && privateObjects && malwareScanner
  ? new EvidenceScanWorker(new ResourceEvidenceScanStore(database), privateObjects, malwareScanner, app.log as WorkerLogger)
  : undefined;
const pushWorker = commerceRuntime && database && pushProvider && config.readiness.capabilities.accountSecurity.available
  ? (() => {
      const store = new PostgresPushOutboxStore(database);
      return new PushOutboxWorker(store, new PushProcessor(store, pushProvider, config), app.log as WorkerLogger);
    })()
  : undefined;
const accountDeletionWorker = commerceRuntime && database && config.readiness.capabilities.accountSecurity.available
  ? new AccountDeletionWorker(new PostgresAccountDeletionStore(database, config), app.log as WorkerLogger)
  : undefined;
adminSessionMaintenance?.start();
if (commerceRuntime) {
  if(!qixiangBootstrapCanary){
    pushWorker?.start();vastReconciliationWorker?.start();creatorCommissionWorker?.start();
    resourceInquiryExpiryWorker?.start();accountDeletionWorker?.start();resourceEvidenceWorker?.start();
    topupRecoveryWorker?.start();creditOrderExpiryWorker?.start();creditSupplierSettlementWorker?.start();
    fulfillmentExpiryWorker?.start();deviceOrderExpiryWorker?.start();deviceSettlementWorker?.start();
  }
  qixiangQueryWorker?.start();
  if(!qixiangBootstrapCanary)creditLotExpiryWorker?.start();
}

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
  await qixiangQueryWorker?.stop();
  await creditLotExpiryWorker?.stop();
  qixiangRuntime?.checkoutKey.fill(0);
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
