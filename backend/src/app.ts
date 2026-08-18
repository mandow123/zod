import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import rawBody from 'fastify-raw-body';
import Fastify from 'fastify';
import { registerAccountRoutes } from './account/routes.js';
import type { AccountService } from './account/service.js';
import { registerMarketRoutes } from './market/routes.js';
import type { MarketService } from './market/service.js';
import { registerNotificationRoutes } from './notifications/routes.js';
import type { NotificationService } from './notifications/service.js';
import { registerListingAuditRoutes } from './listings/routes.js';
import type { ListingAuditService } from './listings/service.js';
import { registerOperationsRoutes } from './operations/routes.js';
import type { OperationsService } from './operations/service.js';
import { registerSubjectRoutes } from './subjects/routes.js';
import type { SubjectService } from './subjects/service.js';
import type { RuntimeConfig } from './config.js';
import type { Database } from './database.js';
import { installErrorHandling } from './errors.js';
import { registerPublicPages } from './public-pages.js';
import { registerResourceEvidenceRoutes } from './resource-evidence/routes.js';
import type { ResourceEvidenceService } from './resource-evidence/service.js';
import { registerCreditRoutes } from './credits/routes.js';
import type { CreditLedgerService } from './credits/service.js';
import { registerCreditTopupRoutes } from './topups/routes.js';
import type { CreditTopupService } from './topups/service.js';
import { registerCreditOrderRoutes } from './credit-orders/routes.js';
import type { CreditOrderService } from './credit-orders/service.js';
import { registerFulfillmentRoutes } from './fulfillment/routes.js';
import type { FulfillmentService } from './fulfillment/service.js';
import { registerNodeEnrollmentRoutes } from './node-enrollment/routes.js';
import type { NodeEnrollmentService } from './node-enrollment/service.js';
import type { KaiOidcBroker } from './account/kai-oidc.js';
import { registerCreditPayoutRoutes } from './payouts/routes.js';
import type { CreditPayoutService } from './payouts/service.js';
import { registerDeviceCommerceRoutes } from './device-commerce/routes.js';
import type { DeviceCommerceService } from './device-commerce/service.js';
import { registerShippingAddressRoutes } from './shipping-addresses/routes.js';
import type { ShippingAddressService } from './shipping-addresses/service.js';
import { registerAssetPortfolioRoutes } from './assets/routes.js';
import type { AssetPortfolioService } from './assets/service.js';
import { registerVastMarketRoutes } from './vast-market/routes.js';
import type { VastMarketService } from './vast-market/service.js';
import { registerTopupReversalRoutes } from './topups/reversal-routes.js';
import type { TopupReversalService } from './topups/reversal-service.js';
import { registerCreatorCommissionRoutes } from './creator-commissions/routes.js';
import type { CreatorCommissionService } from './creator-commissions/service.js';
import { registerResourceInquiryRoutes } from './resource-inquiries/routes.js';
import type { ResourceInquiryService } from './resource-inquiries/service.js';
import {
  KAI_AUTH_ISSUER, KAI_AUTH_PUBLIC_CLIENT_ID, KAI_AUTH_REDIRECT_URI,
} from './account/kai-access.js';

type BuildAppOptions = Readonly<{
  config: RuntimeConfig;
  database: (Pick<Database, 'health'> & Partial<Pick<Database, 'schemaReadiness'>>) | null;
  accountService?: AccountService;
  subjectService?: SubjectService;
  marketService?: MarketService;
  notificationService?: NotificationService;
  listingAuditService?: ListingAuditService;
  operationsService?: OperationsService;
  resourceEvidenceService?: ResourceEvidenceService;
  creditLedgerService?: CreditLedgerService;
  creditTopupService?: CreditTopupService;
  topupReversalService?: TopupReversalService;
  creditPayoutService?: CreditPayoutService;
  deviceCommerceService?: DeviceCommerceService;
  shippingAddressService?: ShippingAddressService;
  creditOrderService?: CreditOrderService;
  fulfillmentService?: FulfillmentService;
  nodeEnrollmentService?: NodeEnrollmentService;
  kaiOidc?: KaiOidcBroker;
  assetPortfolioService?: AssetPortfolioService;
  vastMarketService?: VastMarketService;
  creatorCommissionService?: CreatorCommissionService;
  resourceInquiryService?: ResourceInquiryService;
  logger?: boolean;
}>;

export async function buildApp({ config, database, accountService, subjectService, marketService, notificationService, listingAuditService, operationsService, resourceEvidenceService, creditLedgerService, creditTopupService, topupReversalService, creditPayoutService, deviceCommerceService, shippingAddressService, creditOrderService, fulfillmentService, nodeEnrollmentService, kaiOidc, assetPortfolioService, vastMarketService, creatorCommissionService, resourceInquiryService, logger = true }: BuildAppOptions) {
  const app = Fastify({
    logger: logger ? {
      redact: {
        paths: [
          'req.headers.authorization', 'req.headers.x-kai-id-token', 'req.raw.rawHeaders',
          'req.headers.cookie', 'req.headers.wechatpay-signature',
          'req.headers.wechatpay-nonce', 'req.headers.wechatpay-serial', 'res.headers.set-cookie',
          'req.body.trackingNumber',
        ],
        censor: '[REDACTED]',
      },
    } : false,
    trustProxy: config.trustedProxy,
    requestIdHeader: 'x-request-id',
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: config.NODE_ENV === 'production' ? [config.PUBLIC_ORIGIN] : true,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'x-kai-id-token', 'content-type', 'idempotency-key', 'x-request-id'],
  });
  await app.register(rateLimit, {
    // Dense device acceptance runs intentionally exercise many read-after-write
    // transitions in one minute. Keep the production guard unchanged while
    // preventing the isolated E2E server from banning the emulator mid-flow.
    max: config.NODE_ENV === 'test' ? 10_000 : 120,
    timeWindow: '1 minute',
    ban: 3,
  });
  await app.register(formbody);
  await app.register(rawBody, { field: 'rawBody', global: false, encoding: 'utf8', runFirst: true });

  installErrorHandling(app);
  await registerPublicPages(app, config);

  app.get('/mobile/v1/health', async () => ({
    ok: true,
    service: 'kai-cloudpay-backend',
    apiVersion: 'mobile/v1',
    time: new Date().toISOString(),
  }));

  app.get('/mobile/v1/readiness', async (_request, reply) => {
    const databaseConnected = database ? await database.health() : false;
    const schema = databaseConnected && database?.schemaReadiness
      ? await database.schemaReadiness()
      : { ready: databaseConnected, expected: null, applied: null, missing: [], mismatched: [] };
    const databaseReady = databaseConnected && schema.ready;
    const deploymentBlockers = [
      ...(databaseConnected ? [] : ['DATABASE_CONNECTION']),
      ...(databaseConnected && !schema.ready ? ['DATABASE_SCHEMA'] : []),
      ...(config.readiness.capabilities.accountSecurity.available ? [] : ['AUTHENTICATION']),
      ...(config.NODE_ENV !== 'production' || config.readiness.capabilities.kaiResourceAccess.available ? [] : ['UNIFIED_IDENTITY']),
      ...(config.readiness.capabilities.sms.available ? [] : ['SMS']),
      ...(config.readiness.capabilities.push.available ? [] : ['PUSH']),
      ...(config.readiness.capabilities.objectStorage.available ? [] : ['OBJECT_STORAGE']),
      ...(config.readiness.capabilities.malwareScanning.available ? [] : ['MALWARE_SCANNING']),
      ...(config.readiness.capabilities.observability.available ? [] : ['OBSERVABILITY']),
      ...(config.readiness.capabilities.backup.available ? [] : ['BACKUP']),
      ...(config.readiness.capabilities.legal.available ? [] : ['LEGAL']),
      ...(config.readiness.capabilities.publicHttps ? [] : ['PUBLIC_HTTPS']),
    ];
    const deploymentReady = config.readiness.serviceReady && databaseReady;
    const commerceBlockers = [
      ...deploymentBlockers,
      ...config.readiness.capabilities.creditCommerce.blockers,
    ];
    const commerceReady = deploymentReady && config.readiness.capabilities.creditCommerce.available;
    return reply.status(deploymentReady ? 200 : 503).send({
      ok: deploymentReady,
      service: 'kai-cloudpay-backend',
      app: {
        name: 'KAI CloudPay',
        androidPackage: 'com.kaicloud.marketplace',
        iosBundleId: 'com.kaicloud.marketplace',
      },
      capabilities: {
        database: databaseReady,
        authentication: config.readiness.capabilities.accountSecurity.available,
        unifiedIdentity: config.readiness.capabilities.kaiResourceAccess.available,
        sms: config.readiness.capabilities.sms.available,
        alipay: config.readiness.capabilities.alipay.available,
        wechat: config.readiness.capabilities.wechat.available,
        push: config.readiness.capabilities.push.available,
        objectStorage: config.readiness.capabilities.objectStorage.available,
        malwareScanning: config.readiness.capabilities.malwareScanning.available,
        observability: config.readiness.capabilities.observability.available,
        backup: config.readiness.capabilities.backup.available,
        legal: config.readiness.capabilities.legal.available,
        publicHttps: config.readiness.capabilities.publicHttps,
        creditCommerce: config.readiness.capabilities.creditCommerce.available,
        nodeEnrollment: config.readiness.capabilities.nodeEnrollment.available,
        computeFulfillment: config.readiness.capabilities.computeFulfillment.available,
        vastAi: config.readiness.capabilities.vastAi.available,
        creatorCommissions: config.readiness.capabilities.creatorCommissions.available,
      },
      database: { connected: databaseConnected, schema },
      authentication: {
        mode: 'auth-kai-native',
        issuer: KAI_AUTH_ISSUER,
        clientId: KAI_AUTH_PUBLIC_CLIENT_ID,
        redirectUri: KAI_AUTH_REDIRECT_URI,
        resourceAccess: {
          ready: config.readiness.capabilities.kaiResourceAccess.available,
          tokenFormat: config.KAI_RESOURCE_ACCESS_TOKEN_FORMAT ?? null,
          audience: config.KAI_RESOURCE_ACCESS_TOKEN_AUDIENCE ?? null,
          requiredScope: config.KAI_RESOURCE_ACCESS_TOKEN_REQUIRED_SCOPE ?? null,
          binding: config.KAI_RESOURCE_ACCESS_TOKEN_FORMAT === 'opaque'
            ? 'id-token-at_hash+userinfo'
            : config.KAI_RESOURCE_ACCESS_TOKEN_FORMAT === 'jwt' ? 'jwt-audience' : null,
          blockers: config.readiness.capabilities.kaiResourceAccess.missing,
        },
      },
      deployment: { ready: deploymentReady, blockers: deploymentBlockers },
      commerce: {
        model: 'kai-credit-only',
        ready: commerceReady,
        implemented: config.readiness.capabilities.creditCommerce.implemented,
        blockers: [...new Set(commerceBlockers)],
      },
      release: { ready: commerceReady, blockers: [...new Set(commerceBlockers)] },
    });
  });

  if (accountService) await registerAccountRoutes(app, accountService, config, kaiOidc);
  if (accountService && subjectService) await registerSubjectRoutes(app, accountService, subjectService);
  if (accountService && marketService) await registerMarketRoutes(app, accountService, marketService);
  if (accountService && listingAuditService) await registerListingAuditRoutes(app, accountService, listingAuditService);
  if (accountService && notificationService) await registerNotificationRoutes(app, accountService, notificationService);
  if (accountService && resourceEvidenceService) await registerResourceEvidenceRoutes(app, accountService, resourceEvidenceService);
  if (accountService && creditLedgerService) await registerCreditRoutes(app, accountService, creditLedgerService);
  if (accountService && creditTopupService) await registerCreditTopupRoutes(app, accountService, creditTopupService);
  if (accountService && topupReversalService) await registerTopupReversalRoutes(app, accountService, topupReversalService);
  if (accountService && creditPayoutService) await registerCreditPayoutRoutes(app, accountService, creditPayoutService);
  if (accountService && deviceCommerceService) await registerDeviceCommerceRoutes(app, accountService, deviceCommerceService);
  if (accountService && shippingAddressService) await registerShippingAddressRoutes(app, accountService, shippingAddressService);
  if (accountService && creditOrderService) await registerCreditOrderRoutes(app, accountService, creditOrderService);
  if (accountService && fulfillmentService) await registerFulfillmentRoutes(app, accountService, fulfillmentService);
  if (accountService && nodeEnrollmentService) await registerNodeEnrollmentRoutes(app, accountService, nodeEnrollmentService);
  if (accountService && assetPortfolioService) await registerAssetPortfolioRoutes(app, accountService, assetPortfolioService);
  if (accountService && vastMarketService) await registerVastMarketRoutes(app,accountService,vastMarketService);
  if (accountService && creatorCommissionService) await registerCreatorCommissionRoutes(app,accountService,creatorCommissionService);
  if (accountService && resourceInquiryService) await registerResourceInquiryRoutes(app,accountService,resourceInquiryService);
  if (operationsService) await registerOperationsRoutes(app, accountService, operationsService);

  return app;
}
