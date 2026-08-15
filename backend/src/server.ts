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

const config = loadConfig(process.env);
if (config.NODE_ENV === 'production' && !config.readiness.coreReady) {
  throw new Error(`Production configuration is unsafe: ${config.readiness.coreBlockers.join(', ')}`);
}

const database = createDatabase(config);
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
const creditOrderStore = database ? new PostgresCreditOrderStore(database) : undefined;
const fulfillmentStore = database ? new PostgresFulfillmentStore(database) : undefined;
const computeProvider = createComputeProvider(config);
const fulfillmentService = fulfillmentStore && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new FulfillmentService(fulfillmentStore, subjectService, computeProvider, config)
  : undefined;
const creditOrderService = creditOrderStore && subjectService && config.readiness.capabilities.tokenSecurity.available
  ? new CreditOrderService(creditOrderStore, subjectService, config, undefined, fulfillmentService)
  : undefined;
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
  ...(creditOrderService ? { creditOrderService } : {}),
  ...(fulfillmentService ? { fulfillmentService } : {}),
  ...(nodeEnrollmentService ? { nodeEnrollmentService } : {}),
  ...(kaiOidc ? { kaiOidc } : {}),
});
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
accountDeletionWorker?.start();
resourceEvidenceWorker?.start();
topupRecoveryWorker?.start();
creditOrderExpiryWorker?.start();
creditSupplierSettlementWorker?.start();
fulfillmentExpiryWorker?.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'graceful shutdown');
  await pushWorker?.stop();
  await accountDeletionWorker?.stop();
  await resourceEvidenceWorker?.stop();
  await topupRecoveryWorker?.stop();
  await creditOrderExpiryWorker?.stop();
  await creditSupplierSettlementWorker?.stop();
  await fulfillmentExpiryWorker?.stop();
  await app.close();
  await database?.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
