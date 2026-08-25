import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { isAdminRoleCode, type AdminRoleCode } from './admin/permissions.js';
import { kaiCreditCommerceCapability } from './commerce/capabilities.js';
import {
  loadQixiangCheckoutKey, loadQixiangMerchantKey, qixiangCheckoutKeyPath, qixiangMerchantKeyPath,
} from './payment/qixiang-credential.js';

const optionalText = z.string().trim().optional().transform((value) => value || undefined);
const optionalUntrimmedText = z.string().optional().transform((value) => value === '' ? undefined : value);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MOBILE_API_PROFILE: optionalText,
  LOCAL_E2E: z.enum(['true', 'false']).default('false'),
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
  QIXIANG_TOPUP_MODE: optionalText,
  QIXIANG_RECOVERY_MODE: optionalText,
  QIXIANG_TECHNICAL_CANARY_MODE: z.enum(['on', 'off']).default('off'),
  QIXIANG_TECHNICAL_CANARY_USER_ID: optionalText,
  QIXIANG_TECHNICAL_CANARY_SUBJECT_ID: optionalText,
  QIXIANG_TECHNICAL_CANARY_TOPUP_ID: optionalText,
  QIXIANG_PID: optionalText,
  QIXIANG_APPROVED_MAX_CENTS: optionalText,
  QIXIANG_CHECKOUT_KEY_ID: optionalText,
  QIXIANG_CHECKOUT_CIPHER_VERSION: optionalText,
  QIXIANG_NOTIFY_URL: optionalText,
  QIXIANG_RETURN_URL: optionalText,
  QIXIANG_KEY_ROTATION_EVIDENCE_REF: optionalText,
  QIXIANG_OLD_KEY_REVOCATION_EVIDENCE_REF: optionalText,
  QIXIANG_MERCHANT_ENTITY_EVIDENCE_REF: optionalText,
  QIXIANG_DOMAIN_APP_SCENE_EVIDENCE_REF: optionalText,
  QIXIANG_SERVICE_CATEGORY_EVIDENCE_REF: optionalText,
  QIXIANG_REFUND_API_EVIDENCE_REF: optionalText,
  QIXIANG_REAL_FULFILLMENT_EVIDENCE_REF: optionalText,
  QIXIANG_RECONCILIATION_EVIDENCE_REF: optionalText,
  QIXIANG_APPROVED_MAX_EVIDENCE_REF: optionalText,
  QIXIANG_LOT_ACCOUNTING_EVIDENCE_REF: optionalText,
  CREDENTIALS_DIRECTORY: optionalText,
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
  ICP_FILING_STATUS: z.enum(['not_obtained', 'pending', 'issued', 'exempt_with_legal_evidence']).optional(),
  ICP_FILING_EVIDENCE_REF: optionalText,
  APP_FILING: optionalText,
  APP_FILING_STATUS: z.enum(['not_obtained', 'pending', 'issued', 'exempt_with_legal_evidence']).optional(),
  APP_FILING_EVIDENCE_REF: optionalText,
  INTERNET_SERVICE_CLASSIFICATION_STATUS: z.enum(['not_assessed', 'approved_with_legal_evidence']).optional(),
  INTERNET_SERVICE_CLASSIFICATION_EVIDENCE_REF: optionalText,
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
  KAI_CLOUD_PUBLIC_API_URL: optionalUntrimmedText,
  KAI_CLOUD_PUBLIC_TOKEN_URL: optionalUntrimmedText,
  KAI_CLOUD_PUBLIC_CLIENT_ID: optionalUntrimmedText,
  KAI_CLOUD_PUBLIC_CLIENT_SECRET: optionalUntrimmedText,
  KAI_CLOUD_PUBLIC_WEBHOOK_SECRET: optionalUntrimmedText,
  SEEDANCE_VIDEO_ENABLED: z.enum(['true', 'false']).default('false'),
  AI_API_KEY: optionalText,
  AI_API_BASE_URL: z.string().url().default('https://gw.aiapiway.com/v1'),
  ADMIN_AUTH_ENABLED: z.enum(['true', 'false']).default('false'),
  ADMIN_WEB_ORIGIN: optionalUntrimmedText,
  ADMIN_API_ORIGIN: optionalUntrimmedText,
  ADMIN_OIDC_CLIENT_ID: optionalUntrimmedText,
  ADMIN_OIDC_CLIENT_SECRET: optionalUntrimmedText,
  ADMIN_OIDC_REDIRECT_URI: optionalUntrimmedText,
  ADMIN_OIDC_SCOPE: optionalUntrimmedText,
  ADMIN_OIDC_GROUP_CLAIM: optionalUntrimmedText,
  ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON: optionalText,
  ADMIN_OIDC_FLOW_PEPPER: optionalUntrimmedText,
  ADMIN_OIDC_SUBJECT_PEPPER: optionalUntrimmedText,
  ADMIN_OIDC_GROUP_PEPPER: optionalUntrimmedText,
  ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY: optionalUntrimmedText,
  ADMIN_SESSION_TOKEN_PEPPER: optionalUntrimmedText,
  ADMIN_CSRF_TOKEN_PEPPER: optionalUntrimmedText,
  ADMIN_PII_ENCRYPTION_KEY: optionalUntrimmedText,
  ADMIN_AUDIT_PEPPER: optionalUntrimmedText,
  ADMIN_LOGIN_TRANSACTION_TTL_SECONDS: optionalUntrimmedText,
  ADMIN_SESSION_IDLE_TTL_SECONDS: optionalUntrimmedText,
  ADMIN_SESSION_ABSOLUTE_TTL_SECONDS: optionalUntrimmedText,
  ADMIN_SESSION_ROTATION_SECONDS: optionalUntrimmedText,
  ADMIN_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS: optionalUntrimmedText,
  ADMIN_REAUTH_FRESHNESS_SECONDS: optionalUntrimmedText,
  KAI_RESOURCE_ACCESS_TOKEN_FORMAT: optionalText,
  KAI_RESOURCE_ACCESS_TOKEN_AUDIENCE: optionalText,
  KAI_RESOURCE_ACCESS_TOKEN_REQUIRED_SCOPE: optionalText,
  VAST_API_URL: z.string().url().default('https://console.vast.ai'),
  VAST_API_KEY: optionalText,
  VAST_PRICING_POLICY_JSON: optionalText,
  CREATOR_REFERRAL_SIGNING_SECRET: optionalText,
  CREATOR_COMMISSION_POLICY_JSON: optionalText,
  LEGACY_CREATOR_COMMISSION_MODE: optionalText,
  STREAMER_REWARDS_MODE: optionalText,
  STREAMER_REFERRAL_SIGNING_SECRET: optionalText,
  STREAMER_REWARD_POLICY_JSON: optionalText,
  INVITE_REWARDS_MODE: optionalText,
  INVITE_REFERRAL_SIGNING_SECRET: optionalText,
  INVITE_REWARD_POLICY_JSON: optionalText,
  HONGHUAN_SUPPLIER_CATALOG_MODE: optionalText,
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

const streamerRewardPolicySchema = z.object({
  version: z.string().trim().min(1).max(80),
  basisPoints: z.number().int().min(1).max(300),
  attributionTtlDays: z.number().int().min(1).max(90),
  refundObservationDays: z.number().int().min(1).max(30),
}).strict();

const inviteRewardPolicySchema = z.object({
  version: z.string().trim().min(1).max(80),
  basisPoints: z.number().int().min(1).max(300),
  attributionTtlDays: z.number().int().min(1).max(30),
  firstOrderQualificationDays: z.number().int().min(1).max(90),
  refundObservationDays: z.number().int().min(1).max(30),
}).strict();

type RewardMode = 'off' | 'shadow' | 'on';
type HonghuanSupplierCatalogMode = 'off'|'read_only'|'inquiry';
type QixiangTopupMode = 'off'|'shadow'|'on';
type QixiangRecoveryMode = 'off'|'on';
export type MobileApiProfile = 'inquiry_only' | 'full_commerce';

function rewardMode(value: string | undefined): RewardMode {
  return value === 'shadow' || value === 'on' ? value : 'off';
}

function honghuanSupplierCatalogMode(value:string|undefined):HonghuanSupplierCatalogMode{
  return value==='read_only'||value==='inquiry'?value:'off';
}

function qixiangTopupMode(value:string|undefined):QixiangTopupMode{
  return value==='shadow'||value==='on'?value:'off';
}

function qixiangRecoveryMode(value:string|undefined):QixiangRecoveryMode{return value==='on'?'on':'off';}

type Capability = Readonly<{ available: boolean; missing: string[] }>;

function capability(environment: Record<string, string | undefined>, keys: string[]): Capability {
  const missing = keys.filter((key) => !environment[key]?.trim());
  return { available: missing.length === 0, missing };
}

function mergeCapability(base: Capability, invalid: string[]): Capability {
  const missing = [...new Set([...base.missing, ...invalid])];
  return { available: missing.length === 0, missing };
}

const ADMIN_REQUIRED_KEYS = [
  'ADMIN_WEB_ORIGIN',
  'ADMIN_API_ORIGIN',
  'ADMIN_OIDC_CLIENT_ID',
  'ADMIN_OIDC_CLIENT_SECRET',
  'ADMIN_OIDC_REDIRECT_URI',
  'ADMIN_OIDC_SCOPE',
  'ADMIN_OIDC_GROUP_CLAIM',
  'ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON',
  'ADMIN_OIDC_FLOW_PEPPER',
  'ADMIN_OIDC_SUBJECT_PEPPER',
  'ADMIN_OIDC_GROUP_PEPPER',
  'ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY',
  'ADMIN_SESSION_TOKEN_PEPPER',
  'ADMIN_CSRF_TOKEN_PEPPER',
  'ADMIN_PII_ENCRYPTION_KEY',
  'ADMIN_AUDIT_PEPPER',
] as const;

const ADMIN_PEPPER_KEYS = [
  'ADMIN_OIDC_FLOW_PEPPER',
  'ADMIN_OIDC_SUBJECT_PEPPER',
  'ADMIN_OIDC_GROUP_PEPPER',
  'ADMIN_SESSION_TOKEN_PEPPER',
  'ADMIN_CSRF_TOKEN_PEPPER',
  'ADMIN_AUDIT_PEPPER',
] as const;

const ADMIN_ENCRYPTION_KEY_KEYS = [
  'ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY',
  'ADMIN_PII_ENCRYPTION_KEY',
] as const;

const ADMIN_SECRET_KEYS = [
  'ADMIN_OIDC_CLIENT_SECRET',
  ...ADMIN_PEPPER_KEYS,
  ...ADMIN_ENCRYPTION_KEY_KEYS,
] as const;

const EXISTING_SECURITY_KEY_NAMES = [
  'KAI_OIDC_CLIENT_SECRET',
  'KAI_OIDC_FLOW_PEPPER',
  'KAI_OIDC_SUBJECT_PEPPER',
  'KAI_OIDC_TRANSACTION_ENCRYPTION_KEY',
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_PEPPER',
  'OTP_PEPPER',
  'PII_ENCRYPTION_KEY',
  'AUDIT_PEPPER',
] as const;

const ADMIN_CALLBACK_PATH = '/admin/v1/auth/callback';
const MOBILE_KAI_OIDC_CALLBACK_URL = 'https://api.kaicloudpay.com/mobile/v1/auth/kai/callback';
const MAX_ADMIN_GROUP_MAPPINGS = 64;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

type ParsedEnvironment = z.infer<typeof environmentSchema>;
type AdminGroupRoleMapping = Readonly<{ group: string; roleCode: AdminRoleCode }>;

function stableStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function parseAdminWebOrigin(value: string | undefined, nodeEnvironment: ParsedEnvironment['NODE_ENV'], invalid: string[]) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const localhostHttp = url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)
      || !value.startsWith(`${url.protocol}//`)
      || url.origin === 'null' || url.username || url.password || value.includes('?') || value.includes('#')
      || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)
      || (nodeEnvironment === 'production' && url.protocol !== 'https:')
      || (nodeEnvironment !== 'production' && url.protocol === 'http:' && !localhostHttp)) {
      throw new Error('invalid admin origin');
    }
    return url.origin;
  } catch {
    invalid.push('ADMIN_WEB_ORIGIN(secure origin)');
    return null;
  }
}

function parseAdminRedirectUri(value: string | undefined, invalid: string[]) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)
      || !value.startsWith('https://') || url.protocol !== 'https:'
      || url.origin === 'null' || url.username || url.password || value.includes('?') || value.includes('#')
      || url.pathname !== ADMIN_CALLBACK_PATH || url.href !== value
      || value === MOBILE_KAI_OIDC_CALLBACK_URL) {
      throw new Error('invalid admin callback');
    }
    return value;
  } catch {
    invalid.push('ADMIN_OIDC_REDIRECT_URI(exact HTTPS admin callback)');
    return null;
  }
}

function parseAdminApiOrigin(value: string | undefined, nodeEnvironment: ParsedEnvironment['NODE_ENV'], invalid: string[]) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const localhostHttp = url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)
      || !value.startsWith(`${url.protocol}//`) || url.origin === 'null' || url.username || url.password
      || value.includes('?') || value.includes('#') || url.pathname !== '/'
      || !['http:', 'https:'].includes(url.protocol)
      || (nodeEnvironment === 'production' && url.protocol !== 'https:')
      || (nodeEnvironment !== 'production' && url.protocol === 'http:' && !localhostHttp)) {
      throw new Error('invalid admin API origin');
    }
    return url.origin;
  } catch {
    invalid.push('ADMIN_API_ORIGIN(secure isolated origin)');
    return null;
  }
}

function parseAdminScopes(value: string | undefined, invalid: string[]): readonly string[] {
  if (!value) return Object.freeze([]);
  const scopes = value.split(' ');
  const valid = value === value.trim()
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && scopes.length <= 32
    && scopes.every((scope) => /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/u.test(scope))
    && new Set(scopes).size === scopes.length
    && scopes.includes('openid')
    && !scopes.includes('offline_access');
  if (!valid) {
    invalid.push('ADMIN_OIDC_SCOPE(valid online OIDC scopes)');
    return Object.freeze([]);
  }
  return Object.freeze(stableStrings(scopes));
}

function validateAdminGroupClaim(value: string | undefined, invalid: string[]) {
  if (value && (value !== value.trim() || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(value)
    || CONTROL_CHARACTER_PATTERN.test(value))) {
    invalid.push('ADMIN_OIDC_GROUP_CLAIM(valid claim name)');
  }
}

function parseAdminGroupRoleMappings(value: string | undefined, invalid: string[]): readonly AdminGroupRoleMapping[] {
  if (!value) return Object.freeze([]);
  try {
    const decoded = JSON.parse(value) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('not an object');
    const entries = Object.entries(decoded);
    if (entries.length < 1 || entries.length > MAX_ADMIN_GROUP_MAPPINGS) throw new Error('invalid mapping count');
    const mappings = entries.map(([group, roleCode]) => {
      if (group.length < 1 || group.length > 256 || group !== group.trim()
        || CONTROL_CHARACTER_PATTERN.test(group) || !isAdminRoleCode(roleCode)) {
        throw new Error('invalid group mapping');
      }
      return Object.freeze({ group, roleCode });
    });
    mappings.sort((left, right) => left.group < right.group ? -1 : left.group > right.group ? 1 : 0);
    return Object.freeze(mappings);
  } catch {
    invalid.push('ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON(valid role allowlist)');
    return Object.freeze([]);
  }
}

function isCanonicalBase64Key(value: string): boolean {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

function parseAdminTtl(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
  invalid: string[],
) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/u.test(value)) {
    invalid.push(`${name}(${minimum}-${maximum})`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid.push(`${name}(${minimum}-${maximum})`);
    return fallback;
  }
  return parsed;
}

function adminAuthConfiguration(environment: Record<string, string | undefined>, parsed: ParsedEnvironment) {
  const invalid: string[] = [];
  const adminWebOrigin = parseAdminWebOrigin(parsed.ADMIN_WEB_ORIGIN, parsed.NODE_ENV, invalid);
  const adminApiOrigin = parseAdminApiOrigin(parsed.ADMIN_API_ORIGIN, parsed.NODE_ENV, invalid);
  const adminOidcRedirectUri = parseAdminRedirectUri(parsed.ADMIN_OIDC_REDIRECT_URI, invalid);
  const adminOidcScopes = parseAdminScopes(parsed.ADMIN_OIDC_SCOPE, invalid);
  validateAdminGroupClaim(parsed.ADMIN_OIDC_GROUP_CLAIM, invalid);
  const adminOidcGroupRoleMappings = parseAdminGroupRoleMappings(
    parsed.ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON,
    invalid,
  );
  if (parsed.ADMIN_OIDC_GROUP_CLAIM === 'email') {
    if (!adminOidcScopes.includes('email')) {
      invalid.push('ADMIN_OIDC_SCOPE(requires email for verified-email allowlist)');
    }
    if (adminOidcGroupRoleMappings.some((mapping) => mapping.group !== mapping.group.toLowerCase()
      || !/^[^\s@]+@[^\s@]+$/u.test(mapping.group))) {
      invalid.push('ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON(valid verified-email allowlist)');
    }
  }
  if (adminApiOrigin && adminWebOrigin && adminApiOrigin === adminWebOrigin) {
    invalid.push('ADMIN_API_ORIGIN(isolated from Web origin)');
  }
  if (adminApiOrigin && parsed.PUBLIC_ORIGIN) {
    try {
      if (adminApiOrigin === new URL(parsed.PUBLIC_ORIGIN).origin) {
        invalid.push('ADMIN_API_ORIGIN(isolated from public API)');
      }
    } catch { /* PUBLIC_ORIGIN has its own readiness validation. */ }
  }
  if (adminApiOrigin && adminOidcRedirectUri
    && new URL(adminOidcRedirectUri).origin !== adminApiOrigin) {
    invalid.push('ADMIN_OIDC_REDIRECT_URI(bound to admin API origin)');
  }

  if (parsed.ADMIN_OIDC_CLIENT_ID && !/^[A-Za-z0-9._:-]{3,200}$/u.test(parsed.ADMIN_OIDC_CLIENT_ID)) {
    invalid.push('ADMIN_OIDC_CLIENT_ID(valid confidential client id)');
  }
  if (parsed.ADMIN_OIDC_CLIENT_SECRET && (parsed.ADMIN_OIDC_CLIENT_SECRET.length < 16
    || parsed.ADMIN_OIDC_CLIENT_SECRET !== parsed.ADMIN_OIDC_CLIENT_SECRET.trim()
    || CONTROL_CHARACTER_PATTERN.test(parsed.ADMIN_OIDC_CLIENT_SECRET))) {
    invalid.push('ADMIN_OIDC_CLIENT_SECRET(>=16 chars)');
  }
  for (const name of ADMIN_PEPPER_KEYS) {
    const value = parsed[name];
    if (value && (value.length < 32 || value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value))) {
      invalid.push(`${name}(>=32 chars)`);
    }
  }
  for (const name of ADMIN_ENCRYPTION_KEY_KEYS) {
    const value = parsed[name];
    if (value && !isCanonicalBase64Key(value)) invalid.push(`${name}(base64 32 bytes)`);
  }

  const adminSecrets = [
    parsed.ADMIN_OIDC_CLIENT_SECRET,
    ...ADMIN_PEPPER_KEYS.map((name) => parsed[name]),
    ...ADMIN_ENCRYPTION_KEY_KEYS.map((name) => parsed[name]),
  ].filter((value): value is string => Boolean(value));
  const existingSecrets = EXISTING_SECURITY_KEY_NAMES
    .map((name) => parsed[name])
    .filter((value): value is string => Boolean(value));
  if (new Set(adminSecrets).size !== adminSecrets.length
    || adminSecrets.some((secret) => existingSecrets.includes(secret))) {
    invalid.push('ADMIN_AUTH_SECRETS(independent)');
  }
  if (parsed.ADMIN_OIDC_CLIENT_ID && parsed.KAI_OIDC_CLIENT_ID
    && parsed.ADMIN_OIDC_CLIENT_ID === parsed.KAI_OIDC_CLIENT_ID) {
    invalid.push('ADMIN_OIDC_CLIENT_ID(independent)');
  }

  const loginTransactionSeconds = parseAdminTtl(
    parsed.ADMIN_LOGIN_TRANSACTION_TTL_SECONDS, 300, 60, 600,
    'ADMIN_LOGIN_TRANSACTION_TTL_SECONDS', invalid,
  );
  const sessionIdleSeconds = parseAdminTtl(
    parsed.ADMIN_SESSION_IDLE_TTL_SECONDS, 1_800, 300, 3_600,
    'ADMIN_SESSION_IDLE_TTL_SECONDS', invalid,
  );
  const sessionAbsoluteSeconds = parseAdminTtl(
    parsed.ADMIN_SESSION_ABSOLUTE_TTL_SECONDS, 28_800, 1_800, 43_200,
    'ADMIN_SESSION_ABSOLUTE_TTL_SECONDS', invalid,
  );
  const sessionRotationSeconds = parseAdminTtl(
    parsed.ADMIN_SESSION_ROTATION_SECONDS, 900, 60, 1_800,
    'ADMIN_SESSION_ROTATION_SECONDS', invalid,
  );
  const previousTokenGraceSeconds = parseAdminTtl(
    parsed.ADMIN_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS, 30, 1, 30,
    'ADMIN_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS', invalid,
  );
  const reauthFreshnessSeconds = parseAdminTtl(
    parsed.ADMIN_REAUTH_FRESHNESS_SECONDS, 300, 60, 900,
    'ADMIN_REAUTH_FRESHNESS_SECONDS', invalid,
  );
  if (sessionIdleSeconds > sessionAbsoluteSeconds) {
    invalid.push('ADMIN_SESSION_IDLE_TTL_SECONDS(<=absolute TTL)');
  }
  if (sessionRotationSeconds > sessionIdleSeconds) {
    invalid.push('ADMIN_SESSION_ROTATION_SECONDS(<=idle TTL)');
  }
  if (reauthFreshnessSeconds > sessionAbsoluteSeconds) {
    invalid.push('ADMIN_REAUTH_FRESHNESS_SECONDS(<=absolute TTL)');
  }

  const enabled = parsed.ADMIN_AUTH_ENABLED === 'true';
  const configured = mergeCapability(capability(environment, [...ADMIN_REQUIRED_KEYS]), invalid);
  const adminAuth = enabled
    ? { enabled: true, available: configured.available, missing: stableStrings(configured.missing) }
    : { enabled: false, available: false, missing: [] as string[] };

  return {
    adminAuth,
    adminWebOrigin,
    adminApiOrigin,
    adminOidcRedirectUri,
    adminOidcScopes,
    adminOidcGroupRoleMappings,
    adminAuthTtls: Object.freeze({
      loginTransactionSeconds,
      sessionIdleSeconds,
      sessionAbsoluteSeconds,
      sessionRotationSeconds,
      previousTokenGraceSeconds,
      reauthFreshnessSeconds,
    }),
  } as const;
}

const ADMIN_PRODUCTION_INSPECTION_KEYS = [
  ...ADMIN_REQUIRED_KEYS,
  'ADMIN_LOGIN_TRANSACTION_TTL_SECONDS',
  'ADMIN_SESSION_IDLE_TTL_SECONDS',
  'ADMIN_SESSION_ABSOLUTE_TTL_SECONDS',
  'ADMIN_SESSION_ROTATION_SECONDS',
  'ADMIN_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS',
  'ADMIN_REAUTH_FRESHNESS_SECONDS',
  'PUBLIC_ORIGIN',
  'KAI_OIDC_CLIENT_ID',
  ...EXISTING_SECURITY_KEY_NAMES,
] as const;

function adminIssueNames(issues: readonly string[]): string[] {
  return stableStrings(issues.flatMap((issue) => {
    const name = issue.match(/^ADMIN_[A-Z0-9_]+/u)?.[0];
    if (!name) return [];
    return name === 'ADMIN_AUTH_SECRETS' ? [...ADMIN_SECRET_KEYS] : [name];
  }));
}

/**
 * Validates administrator production configuration independently from the runtime
 * feature flag. The result deliberately contains variable names only, so callers
 * can report it in CI or an operator terminal without exposing supplied values.
 */
export function adminProductionConfigurationIssues(
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
): readonly string[] {
  const environment = Object.fromEntries(ADMIN_PRODUCTION_INSPECTION_KEYS.flatMap((name) =>
    typeof input[name] === 'string' ? [[name, input[name]]] : []));

  // PUBLIC_ORIGIN is validated by the full production gate. Keep this focused
  // administrator inspection usable even when an unrelated public origin is
  // absent or malformed, while still enforcing origin isolation when it is valid.
  if (environment.PUBLIC_ORIGIN) {
    try {
      new URL(environment.PUBLIC_ORIGIN);
    } catch {
      delete environment.PUBLIC_ORIGIN;
    }
  }

  const parsed = environmentSchema.parse({
    ...environment,
    NODE_ENV: 'production',
    ADMIN_AUTH_ENABLED: 'true',
  });
  return Object.freeze(adminIssueNames(adminAuthConfiguration(environment, parsed).adminAuth.missing));
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

function accountSecurityCapability(environment: Record<string, string | undefined>): Capability {
  const requirements: Array<[string, number]> = [
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

function legacyLocalAuthCapability(environment: Record<string, string | undefined>): Capability {
  const requirements: Array<[string, number]> = [
    ['ACCESS_TOKEN_SECRET', 64],
    ['REFRESH_TOKEN_PEPPER', 32],
    ['OTP_PEPPER', 32],
  ];
  const missing = requirements.flatMap(([key, minimum]) => {
    const length = environment[key]?.trim().length ?? 0;
    return length >= minimum ? [] : [`${key}(>=${minimum} chars)`];
  });
  return { available: missing.length === 0, missing };
}

export type RuntimeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(input: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const parsed = environmentSchema.parse(input);
  const profileValid = parsed.MOBILE_API_PROFILE === 'inquiry_only' || parsed.MOBILE_API_PROFILE === 'full_commerce';
  const profileConfigurationBlockers = [
    ...(parsed.MOBILE_API_PROFILE !== undefined && !profileValid
      ? ['MOBILE_API_PROFILE(inquiry_only|full_commerce)'] : []),
    ...(parsed.NODE_ENV === 'production' && parsed.MOBILE_API_PROFILE === undefined
      ? ['MOBILE_API_PROFILE(required in production)'] : []),
  ];
  const mobileApiProfile: MobileApiProfile = parsed.MOBILE_API_PROFILE === 'inquiry_only'
    ? 'inquiry_only'
    : 'full_commerce';
  const inquiryOnly = mobileApiProfile === 'inquiry_only';
  const environment = { ...input };
  const adminConfiguration = adminAuthConfiguration(environment, parsed);
  const database = capability(environment, ['DATABASE_URL']);
  const accountSecurity = accountSecurityCapability(environment);
  const legacyLocalAuth = parsed.NODE_ENV === 'test' && parsed.LOCAL_E2E === 'true'
    ? legacyLocalAuthCapability(environment)
    : { available: false, missing: ['LOCAL_E2E(disabled)'] } as const;
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
  const qixiangTechnicalCanaryMode=parsed.QIXIANG_TECHNICAL_CANARY_MODE==='on';
  const requestedQixiangTopupMode=qixiangTopupMode(parsed.QIXIANG_TOPUP_MODE);
  const qixiangMode:QixiangTopupMode=inquiryOnly?'off':requestedQixiangTopupMode;
  const requestedQixiangRecoveryMode=qixiangRecoveryMode(parsed.QIXIANG_RECOVERY_MODE
    ??(requestedQixiangTopupMode==='on'?'on':undefined));
  const qixiangRecoveryModeValue:QixiangRecoveryMode=inquiryOnly?'off':requestedQixiangRecoveryMode;
  const qixiangApprovedMax=parsed.QIXIANG_APPROVED_MAX_CENTS&&/^\d+$/u.test(parsed.QIXIANG_APPROVED_MAX_CENTS)
    ?Number(parsed.QIXIANG_APPROVED_MAX_CENTS):null;
  const qixiangExpectedNotify='https://api.kaicloudpay.com/mobile/v1/credits/topups/qixiang/notify';
  const qixiangExpectedReturn='https://api.kaicloudpay.com/payments/qixiang/return';
  let qixiangMerchantCredentialAvailable=false;
  let qixiangCheckoutCredentialAvailable=false;
  if((qixiangMode==='on'||qixiangRecoveryModeValue==='on')&&parsed.CREDENTIALS_DIRECTORY){
    try{
      loadQixiangMerchantKey(qixiangMerchantKeyPath({credentialDirectory:parsed.CREDENTIALS_DIRECTORY}));
      qixiangMerchantCredentialAvailable=true;
    }catch{/* Readiness remains fail-closed without exposing file or secret details. */}
    try{
      const checkoutKey=loadQixiangCheckoutKey(qixiangCheckoutKeyPath({credentialDirectory:parsed.CREDENTIALS_DIRECTORY}));
      qixiangCheckoutCredentialAvailable=true;
      checkoutKey.fill(0);
    }catch{/* Readiness remains fail-closed without exposing file or secret details. */}
  }
  const qixiangCanaryIdentityBlockers=qixiangTechnicalCanaryMode?[
    ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(parsed.QIXIANG_TECHNICAL_CANARY_USER_ID??'')?[]:['QIXIANG_TECHNICAL_CANARY_USER_ID']),
    ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(parsed.QIXIANG_TECHNICAL_CANARY_SUBJECT_ID??'')?[]:['QIXIANG_TECHNICAL_CANARY_SUBJECT_ID']),
    ...(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(parsed.QIXIANG_TECHNICAL_CANARY_TOPUP_ID??'')?[]:['QIXIANG_TECHNICAL_CANARY_TOPUP_ID']),
  ]:[];
  const qixiangCommonBlockers=qixiangMode!=='on'?[]:[
    ...(parsed.QIXIANG_PID==='4611'?[]:['QIXIANG_MERCHANT_ENTITY_MATCH']),
    ...(qixiangMerchantCredentialAvailable?[]:['QIXIANG_MERCHANT_CREDENTIAL_UNAVAILABLE']),
    ...(qixiangCheckoutCredentialAvailable?[]:['QIXIANG_CHECKOUT_CREDENTIAL_UNAVAILABLE']),
    ...(parsed.QIXIANG_CHECKOUT_KEY_ID&&/^[a-z0-9][a-z0-9._-]{7,63}$/u.test(parsed.QIXIANG_CHECKOUT_KEY_ID)
      &&parsed.QIXIANG_CHECKOUT_CIPHER_VERSION==='1'?[]:['QIXIANG_CHECKOUT_CREDENTIAL_UNAVAILABLE']),
    ...(parsed.QIXIANG_NOTIFY_URL===qixiangExpectedNotify&&parsed.QIXIANG_RETURN_URL===qixiangExpectedReturn
      ?[]:['QIXIANG_NOTIFY_RETURN_MISMATCH']),
    ...qixiangCanaryIdentityBlockers,
  ];
  const qixiangBlockers=qixiangMode!=='on'?[]:[
    ...qixiangCommonBlockers,
    ...(qixiangTechnicalCanaryMode?[]:[
    ...(parsed.QIXIANG_KEY_ROTATION_EVIDENCE_REF?[]:['QIXIANG_KEY_ROTATED']),
    ...(parsed.QIXIANG_OLD_KEY_REVOCATION_EVIDENCE_REF?[]:['QIXIANG_OLD_KEY_REVOKED']),
    ...(parsed.QIXIANG_MERCHANT_ENTITY_EVIDENCE_REF?[]:['QIXIANG_MERCHANT_ENTITY_MATCH']),
    ...(parsed.QIXIANG_DOMAIN_APP_SCENE_EVIDENCE_REF?[]:['QIXIANG_DOMAIN_APP_SCENE_APPROVED']),
    ...(parsed.QIXIANG_SERVICE_CATEGORY_EVIDENCE_REF?[]:['QIXIANG_SERVICE_CATEGORY_APPROVED']),
    ...(parsed.QIXIANG_REFUND_API_EVIDENCE_REF?[]:['QIXIANG_REFUND_API_CONFIRMED']),
    ...(parsed.QIXIANG_REAL_FULFILLMENT_EVIDENCE_REF?[]:['QIXIANG_REAL_FULFILLMENT']),
    ...(parsed.QIXIANG_RECONCILIATION_EVIDENCE_REF?[]:['QIXIANG_RECONCILIATION']),
    ...(parsed.QIXIANG_APPROVED_MAX_EVIDENCE_REF&&qixiangApprovedMax!==null
      &&Number.isSafeInteger(qixiangApprovedMax)&&qixiangApprovedMax>=100&&qixiangApprovedMax<=4_999_999
      ?[]:['QIXIANG_APPROVED_MAX_UNVERIFIED']),
    ...(parsed.QIXIANG_LOT_ACCOUNTING_EVIDENCE_REF?[]:['QIXIANG_LOT_ACCOUNTING']),
    ]),
    ...(qixiangTechnicalCanaryMode&&qixiangApprovedMax!==501?['QIXIANG_TECHNICAL_CANARY_AMOUNT']:[]),
  ];
  const qixiangTopups={mode:qixiangMode,available:qixiangMode==='on'&&qixiangBlockers.length===0,
    rails:qixiangMode==='on'?['qixiang_alipay'] as const:[] as const,
    minAmountCents:qixiangMode==='on'?(qixiangTechnicalCanaryMode?501:100):null,
    maxAmountCents:qixiangMode==='on'&&qixiangBlockers.length===0
      ?(qixiangTechnicalCanaryMode?501:qixiangApprovedMax):null,
    conversion:qixiangMode==='on'?{numerator:1000 as const,denominator:1002 as const,
      rounding:'floor' as const,precision:2 as const}:null,
    lotValidityDays:364 as const,
    checkout:qixiangMode==='on'?{kind:'external_browser' as const,allowedOrigin:'https://api.payqixiang.cn' as const,
      allowedPathPrefix:'/pay/submit/' as const}:null,
    blockers:[...new Set(qixiangBlockers)]} as const;
  const qixiangRecoveryBlockers=qixiangRecoveryModeValue==='off'?[]:[
    ...(parsed.QIXIANG_PID==='4611'?[]:['QIXIANG_MERCHANT_ENTITY_MATCH']),
    ...(qixiangMerchantCredentialAvailable?[]:['QIXIANG_MERCHANT_CREDENTIAL_UNAVAILABLE']),
    ...(qixiangCheckoutCredentialAvailable?[]:['QIXIANG_CHECKOUT_CREDENTIAL_UNAVAILABLE']),
    ...(parsed.QIXIANG_CHECKOUT_KEY_ID&&/^[a-z0-9][a-z0-9._-]{7,63}$/u.test(parsed.QIXIANG_CHECKOUT_KEY_ID)
      &&parsed.QIXIANG_CHECKOUT_CIPHER_VERSION==='1'?[]:['QIXIANG_CHECKOUT_CREDENTIAL_UNAVAILABLE']),
  ];
  const qixiangRecovery={mode:qixiangRecoveryModeValue,
    available:qixiangRecoveryModeValue==='on'&&qixiangRecoveryBlockers.length===0,
    blockers:[...new Set(qixiangRecoveryBlockers)]} as const;
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
  const otherSecuritySecrets = [
    ...(parsed.NODE_ENV === 'test' && parsed.LOCAL_E2E === 'true'
      ? [parsed.ACCESS_TOKEN_SECRET, parsed.REFRESH_TOKEN_PEPPER, parsed.OTP_PEPPER]
      : []),
    parsed.PII_ENCRYPTION_KEY, parsed.AUDIT_PEPPER, parsed.CURSOR_SECRET, parsed.COMPUTE_PROVIDER_TOKEN,
  ]
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
  const kaiResourceAccessBase = capability(environment, [
    'KAI_OIDC_SUBJECT_PEPPER',
    'KAI_RESOURCE_ACCESS_TOKEN_FORMAT',
  ]);
  const kaiResourceFormat = parsed.KAI_RESOURCE_ACCESS_TOKEN_FORMAT;
  const kaiResourceAccess = mergeCapability(kaiResourceAccessBase, [
    ...(kaiResourceFormat && kaiResourceFormat !== 'opaque'
      ? ['KAI_RESOURCE_ACCESS_TOKEN_FORMAT(opaque paired-token contract)'] : []),
    ...(parsed.KAI_OIDC_SUBJECT_PEPPER && parsed.KAI_OIDC_SUBJECT_PEPPER.length < 32
      ? ['KAI_OIDC_SUBJECT_PEPPER(>=32 chars; stable identity key)'] : []),
    ...(parsed.KAI_OIDC_FLOW_PEPPER && parsed.KAI_OIDC_SUBJECT_PEPPER
      && parsed.KAI_OIDC_FLOW_PEPPER === parsed.KAI_OIDC_SUBJECT_PEPPER
      ? ['KAI_OIDC_SUBJECT_PEPPER(independent from flow pepper)'] : []),
  ]);
  const kaiCloudPublicBase = capability(environment, [
    'KAI_CLOUD_PUBLIC_API_URL', 'KAI_CLOUD_PUBLIC_TOKEN_URL', 'KAI_CLOUD_PUBLIC_CLIENT_ID',
    'KAI_CLOUD_PUBLIC_CLIENT_SECRET', 'KAI_CLOUD_PUBLIC_WEBHOOK_SECRET',
  ]);
  const kaiCloudPublicInvalid: string[] = [];
  for (const [name, value] of [
    ['KAI_CLOUD_PUBLIC_API_URL', parsed.KAI_CLOUD_PUBLIC_API_URL],
    ['KAI_CLOUD_PUBLIC_TOKEN_URL', parsed.KAI_CLOUD_PUBLIC_TOKEN_URL],
  ] as const) {
    if (!value) continue;
    try { if (new URL(value).protocol !== 'https:') kaiCloudPublicInvalid.push(`${name}(HTTPS)`); }
    catch { kaiCloudPublicInvalid.push(`${name}(secure URL)`); }
  }
  if (parsed.KAI_CLOUD_PUBLIC_CLIENT_ID && !/^[A-Za-z0-9._:-]{3,200}$/u.test(parsed.KAI_CLOUD_PUBLIC_CLIENT_ID)) {
    kaiCloudPublicInvalid.push('KAI_CLOUD_PUBLIC_CLIENT_ID(valid confidential client id)');
  }
  const kaiCloudSecrets = [parsed.KAI_CLOUD_PUBLIC_CLIENT_SECRET, parsed.KAI_CLOUD_PUBLIC_WEBHOOK_SECRET]
    .filter((value): value is string => Boolean(value));
  if (kaiCloudSecrets.some((value) => value.length < 32) || new Set(kaiCloudSecrets).size !== kaiCloudSecrets.length) {
    kaiCloudPublicInvalid.push('KAI_CLOUD_PUBLIC_SECRETS(independent >=32 chars)');
  }
  const kaiCloudPublicApi = mergeCapability(kaiCloudPublicBase, kaiCloudPublicInvalid);
  const seedance = mergeCapability(capability(environment, ['AI_API_KEY']), [
    ...(parsed.AI_API_BASE_URL.startsWith('https://') ? [] : ['AI_API_BASE_URL(HTTPS)']),
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
  const legacyCreatorCommissionMode = !inquiryOnly && parsed.LEGACY_CREATOR_COMMISSION_MODE === 'drain' ? 'drain' : 'off';
  const legacyCreatorRequirements = mergeCapability(capability(environment,[
    'CREATOR_REFERRAL_SIGNING_SECRET','CREATOR_COMMISSION_POLICY_JSON',
  ]), [
    ...creatorCommissionInvalid,
    ...(parsed.CREATOR_REFERRAL_SIGNING_SECRET && parsed.CREATOR_REFERRAL_SIGNING_SECRET.length < 32
      ? ['CREATOR_REFERRAL_SIGNING_SECRET(>=32 chars)'] : []),
  ]);
  const creatorCommissions = {
    available: legacyCreatorCommissionMode === 'drain' && legacyCreatorRequirements.available,
    mode: legacyCreatorCommissionMode,
    missing: legacyCreatorCommissionMode === 'drain' ? legacyCreatorRequirements.missing : [],
  } as const;
  const legacyCreatorMode = {
    available: creatorCommissions.available,
    mode: legacyCreatorCommissionMode,
    missing: creatorCommissions.missing,
  } as const;

  let streamerRewardPolicy: z.infer<typeof streamerRewardPolicySchema> | null = null;
  const streamerRewardInvalid: string[] = [];
  if (parsed.STREAMER_REWARD_POLICY_JSON) {
    try {
      const result = streamerRewardPolicySchema.safeParse(JSON.parse(parsed.STREAMER_REWARD_POLICY_JSON));
      if (result.success) streamerRewardPolicy = result.data;
      else streamerRewardInvalid.push('STREAMER_REWARD_POLICY_JSON(valid strict streamer policy)');
    } catch { streamerRewardInvalid.push('STREAMER_REWARD_POLICY_JSON(valid JSON)'); }
  }
  let inviteRewardPolicy: z.infer<typeof inviteRewardPolicySchema> | null = null;
  const inviteRewardInvalid: string[] = [];
  if (parsed.INVITE_REWARD_POLICY_JSON) {
    try {
      const result = inviteRewardPolicySchema.safeParse(JSON.parse(parsed.INVITE_REWARD_POLICY_JSON));
      if (result.success) inviteRewardPolicy = result.data;
      else inviteRewardInvalid.push('INVITE_REWARD_POLICY_JSON(valid strict invite policy)');
    } catch { inviteRewardInvalid.push('INVITE_REWARD_POLICY_JSON(valid JSON)'); }
  }
  const streamerRewardsMode = inquiryOnly ? 'off' : rewardMode(parsed.STREAMER_REWARDS_MODE);
  const inviteRewardsMode = inquiryOnly ? 'off' : rewardMode(parsed.INVITE_REWARDS_MODE);
  const equalRewardSecrets = Boolean(parsed.STREAMER_REFERRAL_SIGNING_SECRET
    && parsed.INVITE_REFERRAL_SIGNING_SECRET
    && parsed.STREAMER_REFERRAL_SIGNING_SECRET === parsed.INVITE_REFERRAL_SIGNING_SECRET);
  const streamerRequirements = mergeCapability(capability(environment,[
    'STREAMER_REFERRAL_SIGNING_SECRET','STREAMER_REWARD_POLICY_JSON',
  ]), [
    ...streamerRewardInvalid,
    ...(parsed.STREAMER_REFERRAL_SIGNING_SECRET && parsed.STREAMER_REFERRAL_SIGNING_SECRET.length < 32
      ? ['STREAMER_REFERRAL_SIGNING_SECRET(>=32 chars)'] : []),
    ...(equalRewardSecrets ? ['STREAMER_REFERRAL_SIGNING_SECRET(independent from invite secret)'] : []),
    ...(streamerRewardsMode === 'off' ? [] : [
      'STREAMER_REWARDS_RUNTIME_INTEGRATION(pending atomic commerce claim and final-net producer)',
    ]),
  ]);
  const inviteRequirements = mergeCapability(capability(environment,[
    'INVITE_REFERRAL_SIGNING_SECRET','INVITE_REWARD_POLICY_JSON',
  ]), [
    ...inviteRewardInvalid,
    ...(parsed.INVITE_REFERRAL_SIGNING_SECRET && parsed.INVITE_REFERRAL_SIGNING_SECRET.length < 32
      ? ['INVITE_REFERRAL_SIGNING_SECRET(>=32 chars)'] : []),
    ...(equalRewardSecrets ? ['INVITE_REFERRAL_SIGNING_SECRET(independent from streamer secret)'] : []),
    ...(inviteRewardsMode === 'off' ? [] : [
      'INVITE_REWARDS_RUNTIME_INTEGRATION(pending atomic commerce claim and final-net producer)',
    ]),
  ]);
  const streamerRewards = {
    available: streamerRewardsMode !== 'off' && streamerRequirements.available,
    mode: streamerRewardsMode,
    missing: streamerRewardsMode === 'off' ? [] : streamerRequirements.missing,
  } as const;
  const inviteRewards = {
    available: inviteRewardsMode !== 'off' && inviteRequirements.available,
    mode: inviteRewardsMode,
    missing: inviteRewardsMode === 'off' ? [] : inviteRequirements.missing,
  } as const;
  const creditCommerce = kaiCreditCommerceCapability({
    verifiedTopupProviderAvailable: alipayTopup.available || wechat.available || qixiangTopups.available,
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
  const legalBase = capability(environment, [
    'LEGAL_ENTITY_NAME', 'UNIFIED_SOCIAL_CREDIT_CODE', 'SUPPORT_EMAIL', 'SUPPORT_PHONE',
    'PRIVACY_POLICY_URL', 'TERMS_URL', 'INQUIRY_TERMS_URL', 'ICP_FILING_STATUS', 'APP_FILING_STATUS',
    'INTERNET_SERVICE_CLASSIFICATION_STATUS',
  ]);
  const filingInvariant=(prefix:'ICP'|'APP',status:typeof parsed.ICP_FILING_STATUS,filing:string|undefined,
    evidenceRef:string|undefined)=>[
      ...(status==='issued'&&(!filing||!evidenceRef)?[`${prefix}_FILING(issued requires number and evidenceRef)`]:[]),
      ...(status==='pending'&&(filing||!evidenceRef)?[`${prefix}_FILING(pending requires empty number and evidenceRef)`]:[]),
      ...(status==='not_obtained'&&(filing||evidenceRef)?[`${prefix}_FILING(not_obtained requires empty number and evidenceRef)`]:[]),
      ...(status==='exempt_with_legal_evidence'&&(filing||!evidenceRef)
        ?[`${prefix}_FILING(exempt requires empty number and legal evidenceRef)`]:[]),
    ];
  const legal = {
    ...mergeCapability(legalBase, [
      ...filingInvariant('ICP',parsed.ICP_FILING_STATUS,parsed.ICP_FILING,parsed.ICP_FILING_EVIDENCE_REF),
      ...filingInvariant('APP',parsed.APP_FILING_STATUS,parsed.APP_FILING,parsed.APP_FILING_EVIDENCE_REF),
      ...(parsed.INTERNET_SERVICE_CLASSIFICATION_STATUS==='approved_with_legal_evidence'
        &&!parsed.INTERNET_SERVICE_CLASSIFICATION_EVIDENCE_REF
        ?['INTERNET_SERVICE_CLASSIFICATION(approved requires legal evidenceRef)']:[]),
      ...(parsed.INTERNET_SERVICE_CLASSIFICATION_STATUS==='not_assessed'
        &&parsed.INTERNET_SERVICE_CLASSIFICATION_EVIDENCE_REF
        ?['INTERNET_SERVICE_CLASSIFICATION(not_assessed requires empty evidenceRef)']:[]),
    ]),
    publicReleaseBlockers: [
      ...(['issued','exempt_with_legal_evidence'].includes(parsed.ICP_FILING_STATUS??'')?[]:['ICP_FILING_NOT_APPROVED']),
      ...(['issued','exempt_with_legal_evidence'].includes(parsed.APP_FILING_STATUS??'')?[]:['APP_FILING_NOT_APPROVED']),
      ...(parsed.INTERNET_SERVICE_CLASSIFICATION_STATUS==='approved_with_legal_evidence'
        ?[]:['INTERNET_SERVICE_CLASSIFICATION_REQUIRED']),
    ],
  } as const;
  const metricsBase = capability(environment, ['METRICS_BEARER_TOKEN']);
  const observability = mergeCapability(metricsBase,
    parsed.METRICS_BEARER_TOKEN && parsed.METRICS_BEARER_TOKEN.length < 32
      ? ['METRICS_BEARER_TOKEN(>=32 chars)']
      : []);
  const localBackupBase = capability(environment, ['BACKUP_ENCRYPTION_KEY', 'BACKUP_KEY_ID', 'BACKUP_LOCAL_DIRECTORY']);
  const backupKey = parsed.BACKUP_ENCRYPTION_KEY?.trim();
  const backupEndpointProtocol = parsed.BACKUP_S3_ENDPOINT
    ? (() => { try { return new URL(parsed.BACKUP_S3_ENDPOINT).protocol; } catch { return 'invalid:'; } })()
    : null;
  const localBackup = mergeCapability(localBackupBase, [
    ...(backupKey && Buffer.from(backupKey, 'base64').length !== 32 ? ['BACKUP_ENCRYPTION_KEY(base64 32 bytes)'] : []),
    ...(parsed.BACKUP_KEY_ID && !/^[A-Za-z0-9._-]{4,64}$/u.test(parsed.BACKUP_KEY_ID) ? ['BACKUP_KEY_ID(4-64 safe chars)'] : []),
    ...(parsed.BACKUP_LOCAL_DIRECTORY && !isAbsolute(parsed.BACKUP_LOCAL_DIRECTORY) ? ['BACKUP_LOCAL_DIRECTORY(absolute path)'] : []),
  ]);
  const offsiteBackup = mergeCapability(localBackup, [
    ...capability(environment, ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_REGION', 'BACKUP_S3_BUCKET',
      'BACKUP_S3_ACCESS_KEY', 'BACKUP_S3_SECRET_KEY']).missing,
    ...(backupEndpointProtocol && backupEndpointProtocol !== 'https:' && parsed.NODE_ENV === 'production' ? ['BACKUP_S3_ENDPOINT(HTTPS)'] : []),
  ]);
  const backup = inquiryOnly ? localBackup : offsiteBackup;
  const coreBlockers = [
    ...profileConfigurationBlockers,
    ...database.missing,
    ...accountSecurity.missing,
    ...(parsed.NODE_ENV === 'production' && parsed.LOCAL_E2E === 'true'
      ? ['LOCAL_E2E(production forbidden)']
      : []),
    ...(publicHttps || parsed.NODE_ENV !== 'production' ? [] : ['PUBLIC_ORIGIN(HTTPS)']),
    ...(parsed.NODE_ENV === 'production' ? kaiResourceAccess.missing : []),
    ...(adminConfiguration.adminAuth.enabled ? adminConfiguration.adminAuth.missing : []),
  ];
  const serviceBlockers = inquiryOnly ? [
    ...coreBlockers,
    ...(parsed.TRUST_PROXY_HOPS === 1 ? [] : ['TRUST_PROXY_HOPS(exactly 1 for private socket proxy)']),
    ...observability.missing,
    ...backup.missing,
    ...legal.missing,
  ] : [
    ...coreBlockers,
    ...sms.missing,
    ...push.missing,
    ...objectStorage.missing,
    ...malwareScanning.missing,
    ...observability.missing,
    ...backup.missing,
    ...legal.missing,
  ];
  const requestedRewardBlockers = [
    ...(streamerRewardsMode === 'off' ? [] : streamerRewards.missing),
    ...(inviteRewardsMode === 'off' ? [] : inviteRewards.missing),
    ...(legacyCreatorCommissionMode === 'drain' ? legacyCreatorMode.missing : []),
  ];
  const honghuanMode=honghuanSupplierCatalogMode(parsed.HONGHUAN_SUPPLIER_CATALOG_MODE);
  const honghuanSupplierCatalog={mode:honghuanMode,available:honghuanMode!=='off',missing:[]} as const;
  const commerceBlockers = inquiryOnly ? [
    ...serviceBlockers,
    ...(honghuanMode === 'inquiry' ? [] : ['HONGHUAN_SUPPLIER_CATALOG_MODE(inquiry)']),
    ...legal.publicReleaseBlockers,
  ] : [
    ...serviceBlockers, ...creditCommerce.blockers, ...qixiangTopups.blockers, ...qixiangRecovery.blockers,
    ...nodeEnrollment.missing, ...requestedRewardBlockers,
    ...(honghuanMode==='off'?[]:honghuanSupplierCatalog.missing),
    ...legal.publicReleaseBlockers,
  ];

  return {
    ...parsed,
    mobileApiProfile,
    databaseSsl: parsed.DATABASE_SSL === 'true',
    localE2E: parsed.LOCAL_E2E === 'true',
    trustedProxy: parsed.TRUST_PROXY_HOPS === 0 ? false : parsed.TRUST_PROXY_HOPS,
    objectStorageForcePathStyle: parsed.OBJECT_STORAGE_FORCE_PATH_STYLE === 'true',
    backupS3ForcePathStyle: parsed.BACKUP_S3_FORCE_PATH_STYLE === 'true',
    nodeSupportedAgentVersions: supportedAgentVersions,
    kaiOidcAppRedirects: kaiOidcRedirects,
    adminAuthEnabled: adminConfiguration.adminAuth.enabled,
    adminWebOrigin: adminConfiguration.adminWebOrigin,
    adminApiOrigin: adminConfiguration.adminApiOrigin,
    adminOidcRedirectUri: adminConfiguration.adminOidcRedirectUri,
    adminOidcScopes: adminConfiguration.adminOidcScopes,
    adminOidcGroupRoleMappings: adminConfiguration.adminOidcGroupRoleMappings,
    adminAuthTtls: adminConfiguration.adminAuthTtls,
    vastPricingPolicy,
    creatorCommissionPolicy,
    legacyCreatorCommissionMode,
    streamerRewardsMode,
    inviteRewardsMode,
    streamerRewardPolicy,
    inviteRewardPolicy,
    qixiangTopupMode:qixiangMode,
    qixiangRecoveryMode:qixiangRecoveryModeValue,
    qixiangTechnicalCanaryMode,
    seedanceVideoEnabled: parsed.SEEDANCE_VIDEO_ENABLED === 'true',
    qixiangApprovedMaxCents:qixiangApprovedMax,
    honghuanSupplierCatalogMode:honghuanMode,
    readiness: {
      coreReady: coreBlockers.length === 0,
      serviceReady: serviceBlockers.length === 0,
      startupReady: (inquiryOnly ? serviceBlockers : commerceBlockers).length === 0,
      releaseReady: commerceBlockers.length === 0,
      coreBlockers: [...new Set(coreBlockers)],
      serviceBlockers: [...new Set(serviceBlockers)],
      startupBlockers: [...new Set(inquiryOnly ? serviceBlockers : commerceBlockers)],
      releaseBlockers: [...new Set(commerceBlockers)],
      capabilities: {
        database, accountSecurity, legacyLocalAuth, kaiOidc, kaiResourceAccess, kaiCloudPublicApi, seedance, sms, alipay: alipayTopup, wechat, push,
        objectStorage, malwareScanning, observability, backup, localBackup, offsiteBackup, legal,
        publicHttps, creditCommerce, qixiangTopups, qixiangRecovery, computeProvider, nodeEnrollment, computeFulfillment, vastAi, creatorCommissions,
        legacyCreatorMode, streamerRewards, inviteRewards, honghuanSupplierCatalog,
        adminAuth: adminConfiguration.adminAuth,
      },
    },
  } as const;
}
