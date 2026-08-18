import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const secureEnvironment = {
  NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://api.cloudpay.kai.com', DATABASE_URL: 'postgresql://db/cloudpay',
  ACCESS_TOKEN_SECRET: 'a'.repeat(64), REFRESH_TOKEN_PEPPER: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32),
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  AUDIT_PEPPER: 'd'.repeat(32),
  CURSOR_SECRET: 'e'.repeat(32),
  SMS_PROVIDER: 'aliyun', SMS_ACCESS_KEY_ID: 'id', SMS_ACCESS_KEY_SECRET: 'secret', SMS_SIGN_NAME: 'KAI', SMS_TEMPLATE_CODE: 'SMS_1',
  ALIPAY_APP_ID: 'app', ALIPAY_PRIVATE_KEY: 'private', ALIPAY_PUBLIC_KEY: 'public', ALIPAY_SELLER_ID: 'seller-1',
  ALIPAY_NOTIFY_URL: 'https://api.cloudpay.kai.com/pay/alipay',
  ALIPAY_RETURN_URL: 'https://api.cloudpay.kai.com/pay/alipay/return',
  TOPUP_ALIPAY_NOTIFY_URL: 'https://api.cloudpay.kai.com/mobile/v1/credits/topups/alipay/notify',
  WECHAT_APP_ID: 'wxapp', WECHAT_MCH_ID: 'mch', WECHAT_API_V3_KEY: 'v'.repeat(32), WECHAT_PRIVATE_KEY: 'private',
  WECHAT_MERCHANT_CERT_SERIAL: 'merchant-serial', WECHAT_PLATFORM_CERT_SERIAL: 'platform-serial', WECHAT_NOTIFY_URL: 'https://api.cloudpay.kai.com/pay/wechat',
  WECHAT_REFUND_NOTIFY_URL: 'https://api.cloudpay.kai.com/pay/wechat/refund',
  TOPUP_WECHAT_NOTIFY_URL: 'https://api.cloudpay.kai.com/mobile/v1/credits/topups/wechat/notify',
  WECHAT_PLATFORM_CERTIFICATE: 'certificate',
  PUSH_PROVIDER: 'expo', PUSH_CREDENTIALS_JSON: `{"accessToken":"${'p'.repeat(40)}"}`, OBJECT_STORAGE_PROVIDER: 's3',
  OBJECT_STORAGE_ENDPOINT: 'https://storage.example.com', OBJECT_STORAGE_REGION: 'cn-east-1', OBJECT_STORAGE_BUCKET: 'cloudpay',
  OBJECT_STORAGE_ACCESS_KEY: 'key', OBJECT_STORAGE_SECRET_KEY: 'secret', LEGAL_ENTITY_NAME: 'KAI', UNIFIED_SOCIAL_CREDIT_CODE: '913000000000000000',
  CLAMAV_HOST: 'clamav.internal', CLAMAV_PORT: '3310',
  METRICS_BEARER_TOKEN: 'm'.repeat(48),
  BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), BACKUP_KEY_ID: 'cloudpay-backup-2026-01',
  BACKUP_LOCAL_DIRECTORY: '/var/lib/cloudpay-backup',
  BACKUP_S3_ENDPOINT: 'https://backup.example.com', BACKUP_S3_REGION: 'cn-east-1', BACKUP_S3_BUCKET: 'cloudpay-dr',
  BACKUP_S3_ACCESS_KEY: 'backup-key', BACKUP_S3_SECRET_KEY: 'backup-secret', BACKUP_RETENTION_DAYS: '35',
  SUPPORT_EMAIL: 'support@example.com', SUPPORT_PHONE: '4000000000', PRIVACY_POLICY_URL: 'https://cloudpay.kai.com/privacy',
  TERMS_URL: 'https://cloudpay.kai.com/terms', INQUIRY_TERMS_URL: 'https://cloudpay.kai.com/inquiry-terms',
  ICP_FILING: 'ICP-TEST', APP_FILING: 'APP-TEST',
  COMPUTE_PROVIDER: 'sidecar-v1', COMPUTE_PROVIDER_URL: 'https://h100-sidecar.internal',
  COMPUTE_PROVIDER_TOKEN: 'q'.repeat(48),
  COMPUTE_ALLOCATED_ACCELERATOR_COUNT: '1',
  COMPUTE_NODE_ACCELERATOR_COUNT: '8',
  NODE_GPU_FINGERPRINT_PEPPER: 'g'.repeat(40),
  NODE_CLAIM_TOKEN_PEPPER: 'n'.repeat(40),
  NODE_CLAIM_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  NODE_SUPPORTED_AGENT_VERSIONS: '1.0.0',
  KAI_OIDC_CLIENT_ID: 'cloudpay-mobile-broker',
  KAI_OIDC_CLIENT_SECRET: 'oidc-client-secret-for-tests',
  KAI_OIDC_FLOW_PEPPER: 'o'.repeat(40),
  KAI_OIDC_SUBJECT_PEPPER: 'i'.repeat(40),
  KAI_OIDC_TRANSACTION_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString('base64'),
  KAI_OIDC_APP_REDIRECT_URIS: 'kaicloudpay://auth/kai/callback',
} as const;

describe('runtime configuration', () => {
  it('fails closed when production secrets and providers are absent', () => {
    const config = loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://localhost:4100' });
    expect(config.readiness.coreReady).toBe(false);
    expect(config.readiness.releaseReady).toBe(false);
    expect(config.readiness.coreBlockers).toContain('DATABASE_URL');
    expect(config.readiness.coreBlockers).toContain('PUBLIC_ORIGIN(HTTPS)');
    expect(config.readiness.coreBlockers).toContain('KAI_OIDC_CLIENT_ID');
    expect(config.readiness.capabilities.kaiOidc.available).toBe(false);
    expect(config.readiness.releaseBlockers).toContain('COMPUTE_PROVIDER_NOT_CONFIGURED');
  });

  it('opens KAI credit commerce when every runtime and channel invariant is configured', () => {
    const config = loadConfig(secureEnvironment);
    expect(config.readiness.coreReady).toBe(true);
    expect(config.readiness.serviceReady).toBe(true);
    expect(config.readiness.serviceBlockers).toEqual([]);
    expect(config.readiness.releaseReady).toBe(true);
    expect(config.readiness.releaseBlockers).toEqual([]);
    expect(config.readiness.releaseBlockers).not.toContain('KAI_CREDIT_ORDER_CAPTURE_NOT_IMPLEMENTED');
    expect(config.readiness.releaseBlockers).not.toContain('KAI_CREDIT_TOPUP_NOT_IMPLEMENTED');
    expect(config.readiness.releaseBlockers).not.toContain('KAI_CREDIT_SUPPLIER_SETTLEMENT_NOT_IMPLEMENTED');
    expect(config.readiness.capabilities.nodeEnrollment.available).toBe(true);
    expect(config.readiness.capabilities.computeFulfillment.available).toBe(true);
    expect(config.readiness.capabilities.kaiOidc.available).toBe(true);
  });

  it('reports commerce ready when every implementation invariant is present', () => {
    const config = loadConfig(secureEnvironment);
    expect(config.readiness.capabilities.creditCommerce).toMatchObject({ implemented: true, available: true });
    expect(config.readiness.releaseReady).toBe(true);
    expect(config.readiness.releaseBlockers).not.toContain('KAI_RESOURCE_AUDIT_GATE_NOT_IMPLEMENTED');
    expect(config.readiness.releaseBlockers).not.toContain('KAI_CREDIT_LEDGER_NOT_IMPLEMENTED');
  });

  it('rejects unsupported or unauthenticated push configurations', () => {
    expect(loadConfig({ ...secureEnvironment, PUSH_PROVIDER: 'fcm' }).readiness.capabilities.push.available).toBe(false);
    expect(loadConfig({ ...secureEnvironment, PUSH_CREDENTIALS_JSON: '{}' }).readiness.capabilities.push.available).toBe(false);
  });

  it('requires an independent long-lived subject mapping pepper for unified identity', () => {
    const config = loadConfig({
      ...secureEnvironment,
      KAI_OIDC_SUBJECT_PEPPER: secureEnvironment.KAI_OIDC_FLOW_PEPPER,
    });
    expect(config.readiness.capabilities.kaiOidc.available).toBe(false);
    expect(config.readiness.coreBlockers).toContain('KAI_OIDC_SUBJECT_PEPPER(independent from flow pepper)');
  });

  it('does not open verified topups without one exact public provider callback', () => {
    const config = loadConfig({
      ...secureEnvironment,
      TOPUP_ALIPAY_NOTIFY_URL: undefined,
      TOPUP_WECHAT_NOTIFY_URL: undefined,
    });
    expect(config.readiness.capabilities.creditCommerce.blockers).toContain('KAI_CREDIT_TOPUP_PROVIDER_NOT_CONFIGURED');
    expect(config.readiness.releaseReady).toBe(false);
  });

  it('keeps production fulfillment closed unless the sidecar contract is complete and private-TLS capable', () => {
    const incomplete = loadConfig({
      ...secureEnvironment,
      COMPUTE_PROVIDER_URL: 'http://h100-sidecar.internal:9443',
      COMPUTE_PROVIDER_TOKEN: 'short',
    });
    expect(incomplete.readiness.capabilities.computeProvider.available).toBe(false);
    expect(incomplete.readiness.capabilities.computeProvider.missing).toEqual(expect.arrayContaining([
      'COMPUTE_PROVIDER_URL(HTTPS)',
      'COMPUTE_PROVIDER_TOKEN(>=32 chars)',
    ]));
    expect(incomplete.readiness.releaseBlockers).toContain('COMPUTE_PROVIDER_NOT_CONFIGURED');
  });

  it('keeps compute closed when node enrollment secrets or the agent allowlist are unsafe', () => {
    const incomplete = loadConfig({
      ...secureEnvironment,
      NODE_CLAIM_TOKEN_ENCRYPTION_KEY: secureEnvironment.PII_ENCRYPTION_KEY,
      NODE_SUPPORTED_AGENT_VERSIONS: '1.0.0, bad version',
    });
    expect(incomplete.readiness.capabilities.nodeEnrollment.available).toBe(false);
    expect(incomplete.readiness.capabilities.computeFulfillment.available).toBe(false);
    expect(incomplete.readiness.releaseBlockers).toEqual(expect.arrayContaining([
      'NODE_CLAIM_TOKEN_ENCRYPTION_KEY(independent)',
      'NODE_SUPPORTED_AGENT_VERSIONS(valid comma-separated versions)',
    ]));
  });

  it('rejects a non-canonical node claim key before any credential is issued', () => {
    const config = loadConfig({ ...secureEnvironment,
      NODE_CLAIM_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64url') });
    expect(config.readiness.capabilities.nodeEnrollment.missing)
      .toContain('NODE_CLAIM_TOKEN_ENCRYPTION_KEY(base64 32 bytes)');
    expect(config.readiness.capabilities.computeFulfillment.available).toBe(false);
  });

  it('keeps Vast.ai unavailable until both the API key and server pricing policy are valid', () => {
    const missing = loadConfig(secureEnvironment);
    expect(missing.readiness.capabilities.vastAi.available).toBe(false);
    expect(missing.vastPricingPolicy).toBeNull();
    const configured = loadConfig({ ...secureEnvironment,VAST_API_KEY:'vast-key-for-server-only-use',
      VAST_PRICING_POLICY_JSON:JSON.stringify({ version:'ops-v1',cardHourMicrosPerProviderUsd:'2000000',
        markupBasisPoints:500,quoteTtlSeconds:120,reconciliationGraceSeconds:300,
        defaultImage:'vastai/base-image:latest',defaultDiskGb:32,defaultRuntype:'ssh_direct' }) });
    expect(configured.readiness.capabilities.vastAi.available).toBe(true);
    expect(configured.vastPricingPolicy).toMatchObject({ version:'ops-v1',cardHourMicrosPerProviderUsd:2_000_000n });
    const invalid = loadConfig({ ...secureEnvironment,VAST_API_KEY:'vast-key',VAST_PRICING_POLICY_JSON:'{}' });
    expect(invalid.readiness.capabilities.vastAi.available).toBe(false);
  });
});
