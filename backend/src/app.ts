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
import { AppError, installErrorHandling } from './errors.js';
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
  adminRequestContext,
  authenticateAdminHttpRequest,
  registerAdminAuthRoutes,
} from './admin/routes.js';
import type { AdminAuthService } from './admin/auth-service.js';
import type { AdminAuthRuntimeSettings } from './admin/runtime.js';
import { registerAdminP0Routes } from './admin/p0-routes.js';
import type { AdminP0Service } from './admin/p0-service.js';
import { adminProcessMetrics, type AdminMetricRecorder } from './admin/metrics.js';
import { registerSupplierInquiryCatalogRoutes } from './supplier-inquiry-catalog/routes.js';
import type { SupplierInquiryCatalogService } from './supplier-inquiry-catalog/service.js';
import { registerSupplierQuoteDirectoryRoutes } from './supplier-quote-directory/routes.js';
import type { SupplierQuoteDirectoryService } from './supplier-quote-directory/service.js';
import { registerQixiangTopupRoutes } from './topups/qixiang-routes.js';
import { registerQixiangRefundRoutes } from './topups/qixiang-refund-routes.js';
import type { QixiangRefundService } from './topups/qixiang-refund-service.js';
import type { QixiangTopupService } from './topups/qixiang-service.js';
import {
  KAI_AUTH_ISSUER, KAI_AUTH_LOOPBACK_HOST, KAI_AUTH_LOOPBACK_PATH,
  KAI_AUTH_LOOPBACK_PORTS, KAI_AUTH_PUBLIC_CLIENT_ID, KAI_AUTH_REDIRECT_URIS,
} from './account/kai-access.js';

function isAdminApiRequest(rawUrl: string): boolean {
  return rawUrl === '/admin/v1' || rawUrl.startsWith('/admin/v1/') || rawUrl.startsWith('/admin/v1?');
}

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
  adminAuthService?: AdminAuthService;
  adminAuthSettings?: AdminAuthRuntimeSettings;
  adminP0Service?: AdminP0Service;
  adminMetrics?: AdminMetricRecorder;
  supplierInquiryCatalogService?: SupplierInquiryCatalogService;
  supplierQuoteDirectoryService?: SupplierQuoteDirectoryService;
  qixiangTopupService?: QixiangTopupService;
  qixiangRefundService?: QixiangRefundService;
  qixiangNewTopupsAvailable?: () => boolean|Promise<boolean>;
  qixiangBootstrapCanary?: boolean;
  qixiangBootstrapCanaryTopupId?: string|null;
  creditLotExpiryHealth?: () => Readonly<{ready:boolean;consecutiveFailures:number;lastAttemptAt:string|null;lastSuccessAt:string|null}>;
  qixiangQueryWorkerHealth?: () => Promise<Readonly<{ready:boolean;consecutiveFailures:number;
    lastAttemptAt:string|null;lastSuccessAt:string|null;healthyInstances:number;observedInstances:number}>>;
  logger?: boolean;
}>;

function requestPath(value:unknown){if(typeof value!=='string')return'/';const separator=value.indexOf('?');
  const path=separator<0?value:value.slice(0,separator);return path.startsWith('/')?path:'/';}

export function applicationLoggerOptions(){return{
  serializers:{req:(request:unknown)=>{const item=request&&typeof request==='object'?request as Record<string,unknown>:{};
    return{method:typeof item.method==='string'?item.method:undefined,url:requestPath(item.url),
      hostname:typeof item.hostname==='string'?item.hostname:undefined,
      remoteAddress:typeof item.remoteAddress==='string'?item.remoteAddress:undefined}as never;}},
  redact:{paths:[
    'req.headers.authorization','req.headers.x-kai-id-token','req.raw.rawHeaders',
    'req.headers.cookie','req.headers.wechatpay-signature',
    'req.headers.wechatpay-nonce','req.headers.wechatpay-serial','res.headers.set-cookie',
    'req.body.trackingNumber',
  ],censor:'[REDACTED]'},
};}

export async function buildApp({ config, database, accountService, subjectService, marketService, notificationService, listingAuditService, operationsService, resourceEvidenceService, creditLedgerService, creditTopupService, topupReversalService, creditPayoutService, deviceCommerceService, shippingAddressService, creditOrderService, fulfillmentService, nodeEnrollmentService, kaiOidc, assetPortfolioService, vastMarketService, creatorCommissionService, resourceInquiryService, adminAuthService, adminAuthSettings, adminP0Service, adminMetrics = adminProcessMetrics, supplierInquiryCatalogService, supplierQuoteDirectoryService, qixiangTopupService, qixiangRefundService, qixiangNewTopupsAvailable, qixiangBootstrapCanary=false, qixiangBootstrapCanaryTopupId=null, creditLotExpiryHealth, qixiangQueryWorkerHealth, logger = true }: BuildAppOptions) {
  const inquiryOnly = config.mobileApiProfile === 'inquiry_only';
  const app = Fastify({
    logger: logger ? applicationLoggerOptions() : false,
    trustProxy: config.trustedProxy,
    requestIdHeader: 'x-request-id',
    bodyLimit: 1_048_576,
  });

  app.addHook('onResponse', async (request, reply) => {
    const rawUrl = request.raw.url ?? '';
    if (reply.statusCode >= 500 && reply.statusCode <= 599 && isAdminApiRequest(rawUrl)) {
      adminMetrics.recordHttp5xx();
    }
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

  if(qixiangBootstrapCanary)app.addHook('onRequest',async(request)=>{const method=request.method.toUpperCase();
    if(['GET','HEAD','OPTIONS'].includes(method))return;const path=requestPath(request.url);
    const identityMutation=path.startsWith('/mobile/v1/auth/')||path==='/mobile/v1/me/current-subject';
    const canaryCreate=method==='POST'&&path==='/mobile/v1/credits/topups/qixiang';
    const canaryRecheck=method==='POST'&&qixiangBootstrapCanaryTopupId!==null
      &&path===`/mobile/v1/credits/topups/qixiang/${qixiangBootstrapCanaryTopupId}/recheck`;
    if(identityMutation||canaryCreate||canaryRecheck)return;
    throw new AppError('QIXIANG_BOOTSTRAP_ROUTE_BLOCKED',503,'当前仅允许指定的 ¥5.01 支付验收，其他交易已关闭。');});

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
    let supplierCatalogState:{mode:typeof config.honghuanSupplierCatalogMode;ready:boolean;blockers:readonly string[]};
    if (!supplierInquiryCatalogService) supplierCatalogState={mode:config.honghuanSupplierCatalogMode,ready:false,
      blockers:config.honghuanSupplierCatalogMode==='off'?[]:['HONGHUAN_SUPPLIER_CATALOG_SERVICE']};
    else {
      try { supplierCatalogState=await supplierInquiryCatalogService.readiness(); }
      catch { supplierCatalogState={mode:config.honghuanSupplierCatalogMode,ready:false,
        blockers:['HONGHUAN_SUPPLIER_CATALOG_READINESS']}; }
    }
    let qixiangState:{ready:boolean;maxAmountCents:number|null;blockers:string[]}={ready:false,maxAmountCents:null,
      blockers:config.qixiangTopupMode==='on'?['QIXIANG_RUNTIME_SERVICE']:[]};
    if(config.qixiangTopupMode==='on'&&qixiangTopupService){try{qixiangState=qixiangBootstrapCanary
      ?await qixiangTopupService.startupReadiness():await qixiangTopupService.readiness();}
      catch{qixiangState={ready:false,maxAmountCents:null,blockers:['QIXIANG_RUNTIME_READINESS']};}}
    if(config.qixiangTopupMode==='on'&&!qixiangBootstrapCanary&&creditLotExpiryHealth&&!creditLotExpiryHealth().ready){qixiangState={...qixiangState,
      ready:false,blockers:[...new Set([...qixiangState.blockers,'QIXIANG_LOT_EXPIRY_WORKER_UNHEALTHY'])]};}
    if(config.qixiangTopupMode==='on'&&qixiangQueryWorkerHealth){try{if(!(await qixiangQueryWorkerHealth()).ready){
      qixiangState={...qixiangState,ready:false,blockers:[...new Set([...qixiangState.blockers,
        'QIXIANG_QUERY_WORKER_UNHEALTHY'])]};}}catch{qixiangState={...qixiangState,ready:false,
      blockers:[...new Set([...qixiangState.blockers,'QIXIANG_QUERY_WORKER_UNHEALTHY'])]};}}
    if (inquiryOnly) {
      let backupRecoveryState:{ready:boolean;backup:{ready:boolean};restore:{ready:boolean};
        kaiPaired:{ready:boolean};appSession:{ready:boolean};durability?:{mode:'local_only';offsiteBackup:false;
          highAvailability:false;disasterRecovery:false;riskAccepted:true};blockers:string[]};
      if (!operationsService) backupRecoveryState={ready:false,backup:{ready:false},restore:{ready:false},
        kaiPaired:{ready:false},appSession:{ready:false},blockers:['OPERATIONS_SERVICE']};
      else {
        try { backupRecoveryState=await operationsService.inquiryReleaseReadiness(); }
        catch { backupRecoveryState={ready:false,backup:{ready:false},restore:{ready:false},
          kaiPaired:{ready:false},appSession:{ready:false},blockers:['BACKUP_RECOVERY_READINESS']}; }
      }
      const requiredServicesReady=Boolean(accountService&&subjectService&&resourceInquiryService
        &&supplierInquiryCatalogService&&operationsService);
      const catalogReady=Boolean(supplierInquiryCatalogService)&&databaseReady
        &&config.honghuanSupplierCatalogMode==='inquiry'&&supplierCatalogState.ready;
      const accountReady=Boolean(accountService)&&config.readiness.capabilities.accountSecurity.available;
      const kaiPairedReady=Boolean(accountService&&subjectService&&resourceInquiryService)
        &&config.readiness.capabilities.kaiResourceAccess.available&&backupRecoveryState.kaiPaired.ready;
      const appSessionReady=backupRecoveryState.appSession.ready;
      const backupReady=config.readiness.capabilities.backup.available&&backupRecoveryState.backup.ready;
      const restoreReady=backupRecoveryState.restore.ready;
      const releaseBlockers = [...new Set([
        ...(databaseConnected ? [] : ['DATABASE_CONNECTION']),
        ...(databaseReady ? [] : ['DATABASE_SCHEMA_0065']),
        ...(accountService ? [] : ['ACCOUNT_SERVICE']),
        ...(subjectService ? [] : ['SUBJECT_SERVICE']),
        ...(resourceInquiryService ? [] : ['RESOURCE_INQUIRY_SERVICE']),
        ...(supplierInquiryCatalogService ? [] : ['HONGHUAN_SUPPLIER_CATALOG_SERVICE']),
        ...(operationsService ? [] : ['OPERATIONS_SERVICE']),
        ...(requiredServicesReady ? [] : ['INQUIRY_ONLY_SERVICE_SET']),
        ...(accountReady ? [] : ['AUTHENTICATION']),
        ...(kaiPairedReady ? [] : ['UNIFIED_IDENTITY']),
        ...(appSessionReady ? [] : ['APP_STORED_SESSION']),
        ...(config.readiness.capabilities.observability.available&&operationsService ? [] : ['OBSERVABILITY']),
        ...(backupReady ? [] : ['BACKUP']),
        ...(restoreReady ? [] : ['BACKUP_RECOVERY']),
        ...(config.readiness.capabilities.legal.available&&accountService ? [] : ['LEGAL']),
        ...config.readiness.capabilities.legal.publicReleaseBlockers,
        ...(config.readiness.capabilities.publicHttps ? [] : ['PUBLIC_HTTPS']),
        ...(config.honghuanSupplierCatalogMode === 'inquiry'
          ? [] : ['HONGHUAN_SUPPLIER_CATALOG_MODE(inquiry)']),
        ...(catalogReady ? [] : ['HONGHUAN_SUPPLIER_CATALOG_READINESS']),
        ...(backupRecoveryState.ready ? [] : ['INQUIRY_OPERATIONAL_EVIDENCE']),
        ...supplierCatalogState.blockers,
        ...backupRecoveryState.blockers,
      ])];
      const releaseReady = releaseBlockers.length === 0;
      return reply.status(releaseReady ? 200 : 503).send({
        ok: releaseReady,
        service: 'kai-cloudpay-backend',
        app: {
          name: 'KAI CloudPay', androidPackage: 'com.kaicloud.marketplace', iosBundleId: 'com.kaicloud.marketplace',
        },
        profile: { id: 'inquiry_only', routePolicy: 'allowlist-v1' },
        capabilities: {
          database: databaseReady,
          authentication: accountReady,
          unifiedIdentity: kaiPairedReady,
          objectStorage: false,
          observability: config.readiness.capabilities.observability.available&&Boolean(operationsService),
          backup: backupReady,
          backupRecovery: backupRecoveryState,
          kaiPairedProbe: backupRecoveryState.kaiPaired,
          appSessionProbe: backupRecoveryState.appSession,
          durability: backupRecoveryState.durability??{mode:'local_only',offsiteBackup:false,
            highAvailability:false,disasterRecovery:false,riskAccepted:true},
          services: {
            ready: requiredServicesReady, account: Boolean(accountService), subjects: Boolean(subjectService),
            resourceInquiries: Boolean(resourceInquiryService), supplierCatalog: Boolean(supplierInquiryCatalogService),
            operations: Boolean(operationsService),
          },
          legal: config.readiness.capabilities.legal.available&&Boolean(accountService),
          publicHttps: config.readiness.capabilities.publicHttps,
          honghuanSupplierCatalog: {
            mode: supplierCatalogState.mode,
            ready: catalogReady,
            blockers: [...new Set([
              ...(databaseReady ? [] : ['DATABASE_SCHEMA_0065']), ...supplierCatalogState.blockers,
            ])],
          },
          legacyCreatorMode: { mode: 'off', ready: false, blockers: [] },
          streamerRewards: { mode: 'off', ready: false, blockers: [] },
          inviteRewards: { mode: 'off', ready: false, blockers: [] },
        },
        database: { connected: databaseConnected, schema },
        authentication: {
          mode: 'auth-kai-native', issuer: KAI_AUTH_ISSUER, clientId: KAI_AUTH_PUBLIC_CLIENT_ID,
          resourceAccess: {
            ready: kaiPairedReady,
            tokenFormat: config.KAI_RESOURCE_ACCESS_TOKEN_FORMAT ?? null,
            binding: config.KAI_RESOURCE_ACCESS_TOKEN_FORMAT === 'opaque' ? 'id-token-at_hash+userinfo' : null,
            blockers: config.readiness.capabilities.kaiResourceAccess.missing,
          },
        },
        deployment: { ready: releaseReady, blockers: releaseBlockers },
        commerce: { enabled: false, ready: false, reason: 'PROFILE_DISABLED', releaseBlocking: false },
        release: { ready: releaseReady, profile: 'inquiry_only', scope: 'supplier_inquiry', blockers: releaseBlockers },
      });
    }
    const supplierCatalogBlockers=config.honghuanSupplierCatalogMode==='off'?[]:[...supplierCatalogState.blockers,
      ...(!databaseReady?['DATABASE_SCHEMA_0065']:[])];
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
      ...supplierCatalogBlockers,
    ];
    const deploymentReady = config.readiness.serviceReady && databaseReady && supplierCatalogBlockers.length===0;
    const rewardConfigurationBlockers = [
      ...(config.streamerRewardsMode === 'off' ? [] : config.readiness.capabilities.streamerRewards.missing),
      ...(config.inviteRewardsMode === 'off' ? [] : config.readiness.capabilities.inviteRewards.missing),
      ...(config.legacyCreatorCommissionMode === 'drain' ? config.readiness.capabilities.legacyCreatorMode.missing : []),
    ];
    const commerceBlockers = [
      ...deploymentBlockers,
      ...config.readiness.capabilities.creditCommerce.blockers,
      ...qixiangState.blockers,
      ...(qixiangBootstrapCanary?['QIXIANG_BOOTSTRAP_CANARY_ONLY']:[]),
      ...rewardConfigurationBlockers,
    ];
    const commerceReady = deploymentReady && config.readiness.capabilities.creditCommerce.available
      && !qixiangBootstrapCanary&&qixiangState.blockers.length===0&&rewardConfigurationBlockers.length === 0;
    const technicalCanaryReady = qixiangBootstrapCanary&&qixiangState.ready&&databaseReady
      &&config.readiness.capabilities.accountSecurity.available
      &&config.readiness.capabilities.kaiResourceAccess.available;
    return reply.status(deploymentReady||technicalCanaryReady ? 200 : 503).send({
      ok: deploymentReady,
      service: 'kai-cloudpay-backend',
      app: {
        name: 'KAI CloudPay',
        androidPackage: 'com.kaicloud.marketplace',
        iosBundleId: 'com.kaicloud.marketplace',
      },
      profile: { id: 'full_commerce', routePolicy: 'full-commerce-v1' },
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
        adminAuth: config.readiness.capabilities.adminAuth.available,
        qixiangTopups: {
          ...config.readiness.capabilities.qixiangTopups,
          available: qixiangState.ready,
          canaryOnly:qixiangBootstrapCanary,
          minAmountCents:qixiangBootstrapCanary?501:config.readiness.capabilities.qixiangTopups.minAmountCents,
          maxAmountCents: qixiangState.maxAmountCents,
          blockers: [...new Set(qixiangState.blockers)],
        },
        legacyCreatorMode: {
          mode: config.legacyCreatorCommissionMode,
          ready: databaseReady && config.readiness.capabilities.legacyCreatorMode.available,
          blockers: config.readiness.capabilities.legacyCreatorMode.missing,
        },
        streamerRewards: {
          mode: config.streamerRewardsMode,
          ready: databaseReady && config.readiness.capabilities.streamerRewards.available,
          blockers: [
            ...config.readiness.capabilities.streamerRewards.missing,
            ...(config.streamerRewardsMode !== 'off' && !databaseReady ? ['DATABASE_SCHEMA_0061'] : []),
          ],
        },
        inviteRewards: {
          mode: config.inviteRewardsMode,
          ready: databaseReady && config.readiness.capabilities.inviteRewards.available,
          blockers: [
            ...config.readiness.capabilities.inviteRewards.missing,
            ...(config.inviteRewardsMode !== 'off' && !databaseReady ? ['DATABASE_SCHEMA_0061'] : []),
          ],
        },
        honghuanSupplierCatalog: {
          mode: supplierCatalogState.mode,
          ready: databaseReady && supplierCatalogState.ready,
          blockers: [...new Set(supplierCatalogBlockers)],
        },
      },
      database: { connected: databaseConnected, schema },
      authentication: {
        mode: 'auth-kai-native',
        issuer: KAI_AUTH_ISSUER,
        clientId: KAI_AUTH_PUBLIC_CLIENT_ID,
        redirect: {
          mode: 'native-ipv4-loopback-pool',
          host: KAI_AUTH_LOOPBACK_HOST,
          path: KAI_AUTH_LOOPBACK_PATH,
          ports: KAI_AUTH_LOOPBACK_PORTS,
          registeredUris: KAI_AUTH_REDIRECT_URIS,
          selection: 'random-order-first-bind',
        },
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

  if (accountService) await registerAccountRoutes(app, accountService, config, kaiOidc, config.mobileApiProfile);
  if (accountService && subjectService) {
    await registerSubjectRoutes(app, accountService, subjectService, config.mobileApiProfile);
  }
  if (config.adminAuthEnabled && config.readiness.capabilities.adminAuth.available
    && adminAuthService && adminAuthSettings) {
    await registerAdminAuthRoutes(app, adminAuthService, adminAuthSettings);
    if (adminP0Service) {
      await registerAdminP0Routes(app, adminP0Service, async (action, request, reply) => {
        const authenticated = await authenticateAdminHttpRequest(
          request, reply, adminAuthService, adminAuthSettings,
        );
        const context = adminRequestContext(request);
        return {
          principal: { permissions: authenticated.principal.permissions },
          recordSucceeded: async () => {
            try {
              await adminAuthService.recordAuthorizedRead(authenticated, action, context);
            } catch {
              throw new AppError('ADMIN_AUDIT_UNAVAILABLE', 503, '管理员审计服务暂时不可用。');
            }
          },
          recordDenied: (failureCode: string) => adminAuthService.recordSecurityDenial(
            'permission', failureCode, context, authenticated,
          ),
          recordFailed: (failureCode: string) => adminAuthService.recordFailedRead(
            authenticated, action, failureCode, context,
          ),
        };
      }, adminAuthSettings, async (request, failureCode) => {
        await adminAuthService.recordSecurityDenial(
          'origin', failureCode, adminRequestContext(request),
        );
      });
    }
  }
  if (inquiryOnly) {
    if (supplierInquiryCatalogService) await registerSupplierInquiryCatalogRoutes(app,supplierInquiryCatalogService);
    if (supplierQuoteDirectoryService) await registerSupplierQuoteDirectoryRoutes(app,supplierQuoteDirectoryService);
    if (accountService && resourceInquiryService) {
      await registerResourceInquiryRoutes(app,accountService,resourceInquiryService,'inquiry_only');
    }
    if (operationsService) await registerOperationsRoutes(app, undefined, operationsService, false);
    return app;
  }
  if (accountService && marketService) await registerMarketRoutes(app, accountService, marketService);
  if (accountService && listingAuditService) await registerListingAuditRoutes(app, accountService, listingAuditService);
  if (accountService && notificationService) await registerNotificationRoutes(app, accountService, notificationService);
  if (accountService && resourceEvidenceService) await registerResourceEvidenceRoutes(app, accountService, resourceEvidenceService);
  if (accountService && creditLedgerService) await registerCreditRoutes(app, accountService, creditLedgerService);
  if (accountService && creditTopupService) await registerCreditTopupRoutes(app, accountService, creditTopupService);
  if (config.qixiangRecoveryMode === 'on' && accountService && qixiangTopupService) {
    await registerQixiangTopupRoutes(app, accountService, qixiangTopupService,qixiangNewTopupsAvailable
      ??(config.qixiangTopupMode === 'on'),qixiangBootstrapCanary?config.QIXIANG_TECHNICAL_CANARY_USER_ID:undefined);
  }
  if (config.qixiangRecoveryMode === 'on' && accountService && qixiangRefundService) {
    await registerQixiangRefundRoutes(app, accountService, qixiangRefundService);
  }
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
  if (supplierInquiryCatalogService) await registerSupplierInquiryCatalogRoutes(app,supplierInquiryCatalogService);
  if (supplierQuoteDirectoryService) await registerSupplierQuoteDirectoryRoutes(app,supplierQuoteDirectoryService);
  if (accountService && resourceInquiryService) await registerResourceInquiryRoutes(app,accountService,resourceInquiryService,'full_commerce');
  if (operationsService) await registerOperationsRoutes(app, accountService, operationsService);

  return app;
}
