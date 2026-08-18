import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { kaiCreditCommerceCapability } from './commerce/capabilities.js';

const optionalText = z.string().trim().optional().transform((value) => value || undefined);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:4100'),
  DATABASE_URL: optionalText,
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  ACCESS_TOKEN_SECRET: optionalText,
  REFRESH_TOKEN_PEPPER: optionalText,
  OTP_PEPPER: optionalText,
  PII_ENCRYPTION_KEY: optionalText,
  AUDIT_PEPPER: optionalText,
  CURSOR_SECRET: optionalText,
  SMS_PROVIDER: optionalText,
  SMS_ACCESS_KEY_ID: optionalText,
  SMS_ACCESS_KEY_SECRET: optionalText,
  SMS_SIGN_NAME: optionalText,
  SMS_TEMPLATE_CODE: optionalText,
  ALIPAY_APP_ID: optionalText,
  ALIPAY_PRIVATE_KEY: optionalText,
  ALIPAY_PUBLIC_KEY: optionalText,
  ALIPAY_SELLER_ID: optionalText,
  ALIPAY_NOTIFY_URL: optionalText,
  ALIPAY_RETURN_URL: optionalText,
  TOPUP_ALIPAY_NOTIFY_URL: optionalText,
  WECHAT_APP_ID: optionalText,
  WECHAT_MCH_ID: optionalText,
  WECHAT_API_V3_KEY: optionalText,
  WECHAT_PRIVATE_KEY: optionalText,
  WECHAT_MERCHANT_CERT_SERIAL: optionalText,
  WECHAT_PLATFORM_CERT_SERIAL: optionalText,
  WECHAT_NOTIFY_URL: optionalText,
  WECHAT_REFUND_NOTIFY_URL: optionalText,
  TOPUP_WECHAT_NOTIFY_URL: optionalText,
  WECHAT_PLATFORM_CERTIFICATE: optionalText,
  PUSH_PROVIDER: optionalText,
  PUSH_CREDENTIALS_JSON: optionalText,
  OBJECT_STORAGE_PROVIDER: optionalText,
  OBJECT_STORAGE_ENDPOINT: optionalText,
  OBJECT_STORAGE_REGION: optionalText,
  OBJECT_STORAGE_BUCKET: optionalText,
  OBJECT_STORAGE_ACCESS_KEY: optionalText,
  OBJECT_STORAGE_SECRET_KEY: optionalText,
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  CLAMAV_HOST: optionalText,
  CLAMAV_PORT: optionalText,
  METRICS_BEARER_TOKEN: optionalText,
  BACKUP_ENCRYPTION_KEY: optionalText,
  BACKUP_KEY_ID: optionalText,
  BACKUP_LOCAL_DIRECTORY: optionalText,
  BACKUP_S3_ENDPOINT: optionalText,
  BACKUP_S3_REGION: optionalText,
  BACKUP_S3_BUCKET: optionalText,
  BACKUP_S3_ACCESS_KEY: optionalText,
  BACKUP_S3_SECRET_KEY: optionalText,
  BACKUP_S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(35),
  LEGAL_ENTITY_NAME: optionalText,
  UNIFIED_SOCIAL_CREDIT_CODE: optionalText,
  SUPPORT_EMAIL: optionalText,
  SUPPORT_PHONE: optionalText,
  PRIVACY_POLICY_URL: optionalText,
  TERMS_URL: optionalText,
  INQUIRY_TERMS_URL: optionalText,
  ICP_FILING: optionalText,
  APP_FILING: optionalText,
  COMPUTE_PROVIDER: optionalText,
  COMPUTE_PROVIDER_URL: optionalText,
  COMPUTE_PROVIDER_TOKEN: optionalText,
  COMPUTE_ALLOCATED_ACCELERATOR_COUNT: z.coerce.number().int().min(1).max(1).optional(),
  COMPUTE_NODE_ACCELERATOR_COUNT: z.coerce.number().int().min(1).max(64).optional(),
  NODE_GPU_FINGERPRINT_PEPPER: optionalText,
  NODE_CLAIM_TOKEN_PEPPER: optionalText,
  NODE_CLAIM_TOKEN_ENCRYPTION_KEY: optionalText,
  NODE_SUPPORTED_AGENT_VERSIONS: optionalText,
  KAI_OIDC_CLIENT_ID: optionalText,
  KAI_OIDC_CLIENT_SECRET: optionalText,
  KAI_OIDC_FLOW_PEPPER: optionalText,
  KAI_OIDC_SUBJECT_PEPPER: optionalText,
  KAI_OIDC_TRANSACTION_ENCRYPTION_KEY: optionalText,
  KAI_OIDC_APP_REDIRECT_URIS: optionalText,
  VAST_API_URL: z.string().url().default('https://console.vast.ai'),
  VAST_API_KEY: optionalText,
  VAST_PRICING_POLICY_JSON: optionalText,
  CREATOR_REFERRAL_SIGNING_SECRET: optionalText,
  CREATOR_COMMISSION_POLICY_JSON: optionalText,
});

const vastPricingPolicySchema = z.object({
  version: z.string().trim().min(1).max(80),
  cardHourMicrosPerProviderUsd: z.string().regex(/^[1-9]\d*$/u).transform(BigInt),
  markupBasisPoints: z.number().int().min(0).max(10_000),
  quoteTtlSeconds: z.number().int().min(30).max(600),
  reconciliationGraceSeconds: z.number().int().min(30).max(3_600),
  defaultImage: z.string().trim().min(1).max(1_024),
  defaultDiskGb: z.number().int().min(8).max(2_048),
  defaultRuntype: z.enum(['ssh','ssh_direct','jupyter','jupyter_direct']),
}).strict();

const creatorCommissionPolicySchema = z.object({
  version: z.string().trim().min(1).max(80),
  commissionBasisPoints: z.number().int().min(1).max(5_000),
  attributionTtlDays: z.number().int().min(1).max(90),
  refundObservationDays: z.number().int().min(1).max(30),
}).strict();

type Capability = Readonly<{ available: boolean; missing: string[] }>;

function capability(environment: Record<string, string | undefined>, keys: string[]): Capability {
  const missing = keys.filter((key) => !environment[key]?.trim());
  return { available: missing.length === 0, missing };
}

function mergeCapability(base: Capability, invalid: string[]): Capability {
  const missing = [...new Set([...base.missing, ...invalid])];
  return { available: missing.length === 0, missing };
}

function pushCapability(environment: Record<string, string | undefined>, parsed: {
  PUSH_PROVIDER: string | undefined; PUSH_CREDENTIALS_JSON: string | undefined;
}): Capability {
  const base = capability(environment, ['PUSH_PROVIDER', 'PUSH_CREDENTIALS_JSON']);
  const invalid: string[] = [];
  if (parsed.PUSH_PROVIDER && parsed.PUSH_PROVIDER !== 'expo') invalid.push('PUSH_PROVIDER(expo)');
  if (parsed.PUSH_CREDENTIALS_JSON) {
    try {
      const credentials = JSON.parse(parsed.PUSH_CREDENTIALS_JSON) as { accessToken?: unknown };
      if (!credentials || typeof credentials !== 'object'
        || typeof credentials.accessToken !== 'string' || credentials.accessToken.trim().length < 32) {
        invalid.push('PUSH_CREDENTIALS_JSON(accessToken>=32 chars)');
      }
    } catch {
      invalid.push('PUSH_CREDENTIALS_JSON(valid JSON)');
    }
  }
  return mergeCapability(base, invalid);
}

function secretCapability(environment: Record<string, string | undefined>): Capability {
  const requirements: Array<[string, number]> = [
    ['ACCESS_TOKEN_SECRET', 64],
    ['REFRESH_TOKEN_PEPPER', 32],
    ['OTP_PEPPER', 32],
    ['AUDIT_PEPPER', 32],
    ['CURSOR_SECRET', 32],
  ];
  const missing = requirements.flatMap(([key, minimum]) => {
    const length = environment[key]?.trim().length ?? 0;
    return length >= minimum ? [] : [`${key}(>=${minimum} chars)`];
  });
  const encryptionKey = environment.PII_ENCRYPTION_KEY?.trim();
  if (!encryptionKey || Buffer.from(encryptionKey, 'base64').length !== 32) {
    missing.push('PII_ENCRYPTION_KEY(base64 32 bytes)');
  }
  return { available: missing.length === 0, missing };
}

export type RuntimeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(input: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const parsed = environmentSchema.parse(input);
  const environment = { ...input };
  const database = capability(environment, ['DATABASE_URL']);
  const tokenSecurity = secretCapability(environment);
  const publicHttps = new URL(parsed.PUBLIC_ORIGIN).protocol === 'https:';
  const sms = capability(environment, [
    'SMS_PROVIDER', 'SMS_ACCESS_KEY_ID', 'SMS_ACCESS_KEY_SECRET', 'SMS_SIGN_NAME', 'SMS_TEMPLATE_CODE',
  ]);
  const alipay = capability(environment, [
    'ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY', 'ALIPAY_SELLER_ID', 'TOPUP_ALIPAY_NOTIFY_URL',
  ]);
  const wechatBase = capability(environment, [
    'WECHAT_APP_ID', 'WECHAT_MCH_ID', 'WECHAT_API_V3_KEY', 'WECHAT_PRIVATE_KEY', 'WECHAT_MERCHANT_CERT_SERIAL',
    'WECHAT_PLATFORM_CERT_SERIAL', 'TOPUP_WECHAT_NOTIFY_URL', 'WECHAT_PLATFORM_CERTIFICATE',
  ]);
  const expectedAlipayTopupNotify = new URL('/mobile/v1/credits/topups/alipay/notify', parsed.PUBLIC_ORIGIN).toString();
  const expectedWechatTopupNotify = new URL('/mobile/v1/credits/topups/wechat/notify', parsed.PUBLIC_ORIGIN).toString();
  const alipayTopup = mergeCapability(alipay, parsed.TOPUP_ALIPAY_NOTIFY_URL
    && parsed.TOPUP_ALIPAY_NOTIFY_URL !== expectedAlipayTopupNotify ? ['TOPUP_ALIPAY_NOTIFY_URL(exact public route)'] : []);
  const wechat = mergeCapability(wechatBase, [
    ...(parsed.WECHAT_API_V3_KEY && Buffer.byteLength(parsed.WECHAT_API_V3_KEY) !== 32
      ? ['WECHAT_API_V3_KEY(exactly 32 bytes)'] : []),
    ...(parsed.TOPUP_WECHAT_NOTIFY_URL && parsed.TOPUP_WECHAT_NOTIFY_URL !== expectedWechatTopupNotify
      ? ['TOPUP_WECHAT_NOTIFY_URL(exact public route)'] : []),
  ]);
  const computeProviderBase = capability(environment, [
    'COMPUTE_PROVIDER', 'COMPUTE_PROVIDER_URL', 'COMPUTE_PROVIDER_TOKEN', 'COMPUTE_ALLOCATED_ACCELERATOR_COUNT',
    'COMPUTE_NODE_ACCELERATOR_COUNT',
  ]);
  const computeProviderProtocol = parsed.COMPUTE_PROVIDER_URL
    ? (() => { try { return new URL(parsed.COMPUTE_PROVIDER_URL).protocol; } catch { return 'invalid:'; } })()
    : null;
  const computeProvider = mergeCapability(computeProviderBase, [
    ...(parsed.COMPUTE_PROVIDER && parsed.COMPUTE_PROVIDER !== 'sidecar-v1' ? ['COMPUTE_PROVIDER(sidecar-v1)'] : []),
    ...(computeProviderProtocol && parsed.NODE_ENV === 'production' && computeProviderProtocol !== 'https:'
      ? ['COMPUTE_PROVIDER_URL(HTTPS)'] : []),
    ...(parsed.COMPUTE_PROVIDER_TOKEN && parsed.COMPUTE_PROVIDER_TOKEN.length < 32
      ? ['COMPUTE_PROVIDER_TOKEN(>=32 chars)'] : []),
  ]);
  const supportedAgentVersions = [...new Set((parsed.NODE_SUPPORTED_AGENT_VERSIONS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean))];
  const nodeEnrollmentBase = capability(environment, [
    'NODE_GPU_FINGERPRINT_PEPPER', 'NODE_CLAIM_TOKEN_PEPPER', 'NODE_CLAIM_TOKEN_ENCRYPTION_KEY',
    'NODE_SUPPORTED_AGENT_VERSIONS',
  ]);
  const nodeClaimKey = parsed.NODE_CLAIM_TOKEN_ENCRYPTION_KEY?.trim();
  const enrollmentSecrets = [parsed.NODE_GPU_FINGERPRINT_PEPPER, parsed.NODE_CLAIM_TOKEN_PEPPER, nodeClaimKey]
    .filter((value): value is string => Boolean(value));
  const otherSecuritySecrets = [parsed.ACCESS_TOKEN_SECRET, parsed.REFRESH_TOKEN_PEPPER, parsed.OTP_PEPPER,
    parsed.PII_ENCRYPTION_KEY, parsed.AUDIT_PEPPER, parsed.CURSOR_SECRET, parsed.COMPUTE_PROVIDER_TOKEN]
    .filter((value): value is string => Boolean(value));
  const nodeEnrollment = mergeCapability(nodeEnrollmentBase, [
    ...(parsed.NODE_GPU_FINGERPRINT_PEPPER && parsed.NODE_GPU_FINGERPRINT_PEPPER.length < 32
      ? ['NODE_GPU_FINGERPRINT_PEPPER(>=32 chars)'] : []),
    ...(parsed.NODE_CLAIM_TOKEN_PEPPER && parsed.NODE_CLAIM_TOKEN_PEPPER.length < 32
      ? ['NODE_CLAIM_TOKEN_PEPPER(>=32 chars)'] : []),
    ...(new Set(enrollmentSecrets).size !== enrollmentSecrets.length
      || enrollmentSecrets.some((secret) => otherSecuritySecrets.includes(secret))
      ? ['NODE_ENROLLMENT_SECRETS(independent)'] : []),
    ...(nodeClaimKey && (Buffer.from(nodeClaimKey, 'base64').length !== 32
      || Buffer.from(nodeClaimKey, 'base64').toString('base64') !== nodeClaimKey)
      ? ['NODE_CLAIM_TOKEN_ENCRYPTION_KEY(base64 32 bytes)'] : []),
    ...(nodeClaimKey && parsed.PII_ENCRYPTION_KEY && nodeClaimKey === parsed.PII_ENCRYPTION_KEY
      ? ['NODE_CLAIM_TOKEN_ENCRYPTION_KEY(independent)'] : []),
    ...(supportedAgentVersions.length > 0 && supportedAgentVersions.some(
      (version) => !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(version),
    ) ? ['NODE_SUPPORTED_AGENT_VERSIONS(valid comma-separated versions)'] : []),
  ]);
  const computeFulfillment = {
    available: computeProvider.available && nodeEnrollment.available,
    missing: [...new Set([...computeProvider.missing, ...nodeEnrollment.missing])],
  } as const;
  const kaiOidcRedirects = [...new Set((parsed.KAI_OIDC_APP_REDIRECT_URIS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean))];
  const kaiOidcBase = capability(environment, [
    'KAI_OIDC_CLIENT_ID', 'KAI_OIDC_CLIENT_SECRET', 'KAI_OIDC_FLOW_PEPPER', 'KAI_OIDC_SUBJECT_PEPPER',
    'KAI_OIDC_TRANSACTION_ENCRYPTION_KEY', 'KAI_OIDC_APP_REDIRECT_URIS',
  ]);
  const kaiOidcKey = parsed.KAI_OIDC_TRANSACTION_ENCRYPTION_KEY?.trim();
  const kaiOidc = mergeCapability(kaiOidcBase, [
    ...(parsed.KAI_OIDC_CLIENT_ID && !/^[A-Za-z0-9._:-]{3,200}$/u.test(parsed.KAI_OIDC_CLIENT_ID)
      ? ['KAI_OIDC_CLIENT_ID(valid confidential client id)'] : []),
    ...(parsed.KAI_OIDC_CLIENT_SECRET && parsed.KAI_OIDC_CLIENT_SECRET.length < 16
      ? ['KAI_OIDC_CLIENT_SECRET(>=16 chars)'] : []),
    ...(parsed.KAI_OIDC_FLOW_PEPPER && parsed.KAI_OIDC_FLOW_PEPPER.length < 32
      ? ['KAI_OIDC_FLOW_PEPPER(>=32 chars)'] : []),
    ...(parsed.KAI_OIDC_SUBJECT_PEPPER && parsed.KAI_OIDC_SUBJECT_PEPPER.length < 32
      ? ['KAI_OIDC_SUBJECT_PEPPER(>=32 chars; stable identity key)'] : []),
    ...(parsed.KAI_OIDC_FLOW_PEPPER && parsed.KAI_OIDC_SUBJECT_PEPPER
      && parsed.KAI_OIDC_FLOW_PEPPER === parsed.KAI_OIDC_SUBJECT_PEPPER
      ? ['KAI_OIDC_SUBJECT_PEPPER(independent from flow pepper)'] : []),
    ...(kaiOidcKey && (Buffer.from(kaiOidcKey, 'base64').length !== 32
      || Buffer.from(kaiOidcKey, 'base64').toString('base64') !== kaiOidcKey)
      ? ['KAI_OIDC_TRANSACTION_ENCRYPTION_KEY(base64 32 bytes)'] : []),
    ...(kaiOidcRedirects.length > 0 && kaiOidcRedirects.some(
      (value) => value !== 'kaicloudpay://auth/kai/callback',
    ) ? ['KAI_OIDC_APP_REDIRECT_URIS(registered exact app redirects)'] : []),
  ]);
  let vastPricingPolicy: z.infer<typeof vastPricingPolicySchema> | null = null;
  const vastInvalid: string[] = [];
  if (parsed.VAST_PRICING_POLICY_JSON) {
    try {
      const result = vastPricingPolicySchema.safeParse(JSON.parse(parsed.VAST_PRICING_POLICY_JSON));
      if (result.success) vastPricingPolicy = result.data;
      else vastInvalid.push('VAST_PRICING_POLICY_JSON(valid server pricing policy)');
    } catch { vastInvalid.push('VAST_PRICING_POLICY_JSON(valid JSON)'); }
  }
  const vastProtocol = new URL(parsed.VAST_API_URL).protocol;
  const vastAi = mergeCapability(capability(environment,['VAST_API_KEY','VAST_PRICING_POLICY_JSON']), [
    ...vastInvalid,
    ...(parsed.NODE_ENV === 'production' && vastProtocol !== 'https:' ? ['VAST_API_URL(HTTPS)'] : []),
  ]);
  let creatorCommissionPolicy: z.infer<typeof creatorCommissionPolicySchema> | null = null;
  const creatorCommissionInvalid: string[] = [];
  if (parsed.CREATOR_COMMISSION_POLICY_JSON) {
    try {
      const result = creatorCommissionPolicySchema.safeParse(JSON.parse(parsed.CREATOR_COMMISSION_POLICY_JSON));
      if (result.success) creatorCommissionPolicy = result.data;
      else creatorCommissionInvalid.push('CREATOR_COMMISSION_POLICY_JSON(valid creator commission policy)');
    } catch { creatorCommissionInvalid.push('CREATOR_COMMISSION_POLICY_JSON(valid JSON)'); }
  }
  const creatorCommissions = mergeCapability(capability(environment,[
    'CREATOR_REFERRAL_SIGNING_SECRET','CREATOR_COMMISSION_POLICY_JSON',
  ]), [
    ...creatorCommissionInvalid,
    ...(parsed.CREATOR_REFERRAL_SIGNING_SECRET && parsed.CREATOR_REFERRAL_SIGNING_SECRET.length < 32
      ? ['CREATOR_REFERRAL_SIGNING_SECRET(>=32 chars)'] : []),
  ]);
  const creditCommerce = kaiCreditCommerceCapability({
    verifiedTopupProviderAvailable: alipayTopup.available || wechat.available,
    computeProviderAvailable: computeFulfillment.available,
  });
  const push = pushCapability(environment, parsed);
  const objectStorageBase = capability(environment, [
    'OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_ENDPOINT', 'OBJECT_STORAGE_REGION', 'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_KEY',
  ]);
  const storageEndpointProtocol = parsed.OBJECT_STORAGE_ENDPOINT
    ? (() => { try { return new URL(parsed.OBJECT_STORAGE_ENDPOINT).protocol; } catch { return 'invalid:'; } })()
    : null;
  const objectStorage = mergeCapability(objectStorageBase, [
    ...(parsed.OBJECT_STORAGE_PROVIDER && parsed.OBJECT_STORAGE_PROVIDER !== 's3' ? ['OBJECT_STORAGE_PROVIDER(s3)'] : []),
    ...(storageEndpointProtocol && storageEndpointProtocol !== 'https:' && parsed.NODE_ENV === 'production' ? ['OBJECT_STORAGE_ENDPOINT(HTTPS)'] : []),
  ]);
  const malwareBase = capability(environment, ['CLAMAV_HOST', 'CLAMAV_PORT']);
  const clamavPort = Number(parsed.CLAMAV_PORT);
  const malwareScanning = mergeCapability(malwareBase,
    parsed.CLAMAV_PORT && (!Number.isInteger(clamavPort) || clamavPort < 1 || clamavPort > 65535)
      ? ['CLAMAV_PORT(1-65535)']
      : []);
  const legal = capability(environment, [
    'LEGAL_ENTITY_NAME', 'UNIFIED_SOCIAL_CREDIT_CODE', 'SUPPORT_EMAIL', 'SUPPORT_PHONE',
    'PRIVACY_POLICY_URL', 'TERMS_URL', 'INQUIRY_TERMS_URL', 'ICP_FILING', 'APP_FILING',
  ]);
  const metricsBase = capability(environment, ['METRICS_BEARER_TOKEN']);
  const observability = mergeCapability(metricsBase,
    parsed.METRICS_BEARER_TOKEN && parsed.METRICS_BEARER_TOKEN.length < 32
      ? ['METRICS_BEARER_TOKEN(>=32 chars)']
      : []);
  const backupBase = capability(environment, [
    'BACKUP_ENCRYPTION_KEY', 'BACKUP_KEY_ID', 'BACKUP_LOCAL_DIRECTORY', 'BACKUP_S3_ENDPOINT', 'BACKUP_S3_REGION',
    'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY', 'BACKUP_S3_SECRET_KEY',
  ]);
  const backupKey = parsed.BACKUP_ENCRYPTION_KEY?.trim();
  const backupEndpointProtocol = parsed.BACKUP_S3_ENDPOINT
    ? (() => { try { return new URL(parsed.BACKUP_S3_ENDPOINT).protocol; } catch { return 'invalid:'; } })()
    : null;
  const backup = mergeCapability(backupBase, [
    ...(backupKey && Buffer.from(backupKey, 'base64').length !== 32 ? ['BACKUP_ENCRYPTION_KEY(base64 32 bytes)'] : []),
    ...(parsed.BACKUP_KEY_ID && !/^[A-Za-z0-9._-]{4,64}$/u.test(parsed.BACKUP_KEY_ID) ? ['BACKUP_KEY_ID(4-64 safe chars)'] : []),
    ...(parsed.BACKUP_LOCAL_DIRECTORY && !isAbsolute(parsed.BACKUP_LOCAL_DIRECTORY) ? ['BACKUP_LOCAL_DIRECTORY(absolute path)'] : []),
    ...(backupEndpointProtocol && backupEndpointProtocol !== 'https:' && parsed.NODE_ENV === 'production' ? ['BACKUP_S3_ENDPOINT(HTTPS)'] : []),
  ]);
  const coreBlockers = [
    ...database.missing,
    ...tokenSecurity.missing,
    ...(publicHttps || parsed.NODE_ENV !== 'production' ? [] : ['PUBLIC_ORIGIN(HTTPS)']),
    ...(parsed.NODE_ENV === 'production' ? kaiOidc.missing : []),
  ];
  const serviceBlockers = [
    ...coreBlockers,
    ...sms.missing,
    ...push.missing,
    ...objectStorage.missing,
    ...malwareScanning.missing,
    ...observability.missing,
    ...backup.missing,
    ...legal.missing,
  ];
  const commerceBlockers = [...serviceBlockers, ...creditCommerce.blockers, ...nodeEnrollment.missing];

  return {
    ...parsed,
    databaseSsl: parsed.DATABASE_SSL === 'true',
    trustedProxy: parsed.TRUST_PROXY_HOPS === 0 ? false : parsed.TRUST_PROXY_HOPS,
    objectStorageForcePathStyle: parsed.OBJECT_STORAGE_FORCE_PATH_STYLE === 'true',
    backupS3ForcePathStyle: parsed.BACKUP_S3_FORCE_PATH_STYLE === 'true',
    nodeSupportedAgentVersions: supportedAgentVersions,
    kaiOidcAppRedirects: kaiOidcRedirects,
    vastPricingPolicy,
    creatorCommissionPolicy,
    readiness: {
      coreReady: coreBlockers.length === 0,
      serviceReady: serviceBlockers.length === 0,
      releaseReady: commerceBlockers.length === 0,
      coreBlockers: [...new Set(coreBlockers)],
      serviceBlockers: [...new Set(serviceBlockers)],
      releaseBlockers: [...new Set(commerceBlockers)],
      capabilities: {
        database, tokenSecurity, kaiOidc, sms, alipay: alipayTopup, wechat, push, objectStorage, malwareScanning, observability, backup, legal,
        publicHttps, creditCommerce, computeProvider, nodeEnrollment, computeFulfillment, vastAi, creatorCommissions,
      },
    },
  } as const;
}
