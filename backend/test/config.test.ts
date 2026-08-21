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

const adminEnvironment = {
  ...secureEnvironment,
  ADMIN_AUTH_ENABLED: 'true',
  ADMIN_WEB_ORIGIN: 'https://admin.example.test/',
  ADMIN_API_ORIGIN: 'https://admin-api.example.test/',
  ADMIN_OIDC_CLIENT_ID: 'cloudpay-admin-broker',
  ADMIN_OIDC_CLIENT_SECRET: 'admin-client-secret-unique-value-0123456789',
  ADMIN_OIDC_REDIRECT_URI: 'https://admin-api.example.test/admin/v1/auth/callback',
  ADMIN_OIDC_SCOPE: 'profile openid email kai_admin',
  ADMIN_OIDC_GROUP_CLAIM: 'kai_admin_groups',
  ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON: JSON.stringify({
    'zeta-reviewers': 'price_reviewer',
    'alpha-support': 'support_viewer',
  }),
  ADMIN_OIDC_FLOW_PEPPER: 'F'.repeat(40),
  ADMIN_OIDC_SUBJECT_PEPPER: 'S'.repeat(40),
  ADMIN_OIDC_GROUP_PEPPER: 'G'.repeat(40),
  ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'),
  ADMIN_SESSION_TOKEN_PEPPER: 'T'.repeat(40),
  ADMIN_CSRF_TOKEN_PEPPER: 'C'.repeat(40),
  ADMIN_PII_ENCRYPTION_KEY: Buffer.alloc(32, 18).toString('base64'),
  ADMIN_AUDIT_PEPPER: 'U'.repeat(40),
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

  it('keeps administrator authentication disabled without changing existing core readiness', () => {
    const config = loadConfig(secureEnvironment);
    expect(config.adminAuthEnabled).toBe(false);
    expect(config.readiness.coreReady).toBe(true);
    expect(config.readiness.capabilities.adminAuth).toEqual({
      enabled: false, available: false, missing: [],
    });
    expect(config.adminAuthTtls).toEqual({
      loginTransactionSeconds: 300,
      sessionIdleSeconds: 1_800,
      sessionAbsoluteSeconds: 28_800,
      sessionRotationSeconds: 900,
      previousTokenGraceSeconds: 30,
      reauthFreshnessSeconds: 300,
    });
  });

  it('fails readiness closed when administrator authentication is enabled without its configuration', () => {
    const config = loadConfig({ ...secureEnvironment, ADMIN_AUTH_ENABLED: 'true' });
    expect(config.readiness.coreReady).toBe(false);
    expect(config.readiness.capabilities.adminAuth).toMatchObject({ enabled: true, available: false });
    expect(config.readiness.capabilities.adminAuth.missing).toEqual(expect.arrayContaining([
      'ADMIN_WEB_ORIGIN',
      'ADMIN_API_ORIGIN',
      'ADMIN_OIDC_CLIENT_ID',
      'ADMIN_OIDC_CLIENT_SECRET',
      'ADMIN_OIDC_REDIRECT_URI',
      'ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON',
      'ADMIN_SESSION_TOKEN_PEPPER',
    ]));
    expect(config.readiness.coreBlockers).toEqual(expect.arrayContaining(
      config.readiness.capabilities.adminAuth.missing,
    ));
  });

  it('normalizes one complete and isolated administrator authentication configuration', () => {
    const config = loadConfig(adminEnvironment);
    expect(config.readiness.coreReady).toBe(true);
    expect(config.readiness.capabilities.adminAuth).toEqual({ enabled: true, available: true, missing: [] });
    expect(config.adminWebOrigin).toBe('https://admin.example.test');
    expect(config.adminApiOrigin).toBe('https://admin-api.example.test');
    expect(config.adminOidcRedirectUri).toBe(adminEnvironment.ADMIN_OIDC_REDIRECT_URI);
    expect(config.adminOidcScopes).toEqual(['email', 'kai_admin', 'openid', 'profile']);
    expect(config.adminOidcGroupRoleMappings).toEqual([
      { group: 'alpha-support', roleCode: 'support_viewer' },
      { group: 'zeta-reviewers', roleCode: 'price_reviewer' },
    ]);
  });

  it('allows HTTP admin origins only on explicit local development and test hosts', () => {
    expect(loadConfig({ ...adminEnvironment, NODE_ENV: 'development', ADMIN_WEB_ORIGIN: 'http://localhost:3000/' })
      .readiness.capabilities.adminAuth.available).toBe(true);
    expect(loadConfig({ ...adminEnvironment, NODE_ENV: 'test', ADMIN_WEB_ORIGIN: 'http://127.0.0.1:3000' })
      .readiness.capabilities.adminAuth.available).toBe(true);
    expect(loadConfig({ ...adminEnvironment, ADMIN_WEB_ORIGIN: 'http://localhost:3000' })
      .readiness.capabilities.adminAuth.missing).toContain('ADMIN_WEB_ORIGIN(secure origin)');
    expect(loadConfig({ ...adminEnvironment, NODE_ENV: 'development', ADMIN_WEB_ORIGIN: 'http://admin.example.test' })
      .readiness.capabilities.adminAuth.missing).toContain('ADMIN_WEB_ORIGIN(secure origin)');
  });

  it.each([
    'https://user@admin.example.test/',
    'https://user:password@admin.example.test/',
    'https://admin.example.test/dashboard',
    'https://admin.example.test/?next=/dashboard',
    'https://admin.example.test/#fragment',
    ' https://admin.example.test/',
    'https://admin.exa\nmple.test/',
  ])('rejects an unsafe administrator Web origin: %s', (origin) => {
    const config = loadConfig({ ...adminEnvironment, ADMIN_WEB_ORIGIN: origin });
    expect(config.adminWebOrigin).toBeNull();
    expect(config.readiness.capabilities.adminAuth.missing).toContain('ADMIN_WEB_ORIGIN(secure origin)');
  });

  it.each([
    'http://admin-api.example.test/',
    'https://user@admin-api.example.test/',
    'https://admin-api.example.test/path',
    'https://admin-api.example.test/?query=1',
    ' https://admin-api.example.test/',
  ])('rejects an unsafe administrator API origin: %s', (origin) => {
    const config = loadConfig({ ...adminEnvironment, ADMIN_API_ORIGIN: origin });
    expect(config.adminApiOrigin).toBeNull();
    expect(config.readiness.capabilities.adminAuth.missing)
      .toContain('ADMIN_API_ORIGIN(secure isolated origin)');
  });

  it('requires the admin API, Web, public API, and callback deployment origins to remain isolated and bound', () => {
    expect(loadConfig({ ...adminEnvironment, ADMIN_API_ORIGIN: adminEnvironment.ADMIN_WEB_ORIGIN })
      .readiness.capabilities.adminAuth.missing).toContain('ADMIN_API_ORIGIN(isolated from Web origin)');
    expect(loadConfig({ ...adminEnvironment, ADMIN_API_ORIGIN: secureEnvironment.PUBLIC_ORIGIN })
      .readiness.capabilities.adminAuth.missing).toContain('ADMIN_API_ORIGIN(isolated from public API)');
    expect(loadConfig({ ...adminEnvironment,
      ADMIN_OIDC_REDIRECT_URI: 'https://another-admin-api.example.test/admin/v1/auth/callback' })
      .readiness.capabilities.adminAuth.missing)
      .toContain('ADMIN_OIDC_REDIRECT_URI(bound to admin API origin)');
  });

  it.each([
    'http://admin-api.example.test/admin/v1/auth/callback',
    'https://user@admin-api.example.test/admin/v1/auth/callback',
    'https://user:password@admin-api.example.test/admin/v1/auth/callback',
    'https://admin-api.example.test/admin/v1/auth/callback?next=/dashboard',
    'https://admin-api.example.test/admin/v1/auth/callback#fragment',
    'https://admin-api.example.test/admin/v1/auth/wrong',
    'https://cloudpay.kai.com/mobile/v1/auth/kai/callback',
    ' https://admin-api.example.test/admin/v1/auth/callback',
    'https://admin-api.exa\nmple.test/admin/v1/auth/callback',
  ])('rejects an unsafe administrator redirect URI: %s', (redirectUri) => {
    const capability = loadConfig({ ...adminEnvironment, ADMIN_OIDC_REDIRECT_URI: redirectUri })
      .readiness.capabilities.adminAuth;
    expect(capability.available).toBe(false);
    expect(capability.missing).toContain('ADMIN_OIDC_REDIRECT_URI(exact HTTPS admin callback)');
  });

  it.each([
    'profile email',
    'openid profile offline_access',
    'openid profile openid',
    'openid\tprofile',
    `openid ${'x'.repeat(129)}`,
  ])('rejects unsafe administrator OIDC scopes: %s', (scope) => {
    const config = loadConfig({ ...adminEnvironment, ADMIN_OIDC_SCOPE: scope });
    expect(config.adminOidcScopes).toEqual([]);
    expect(config.readiness.capabilities.adminAuth.missing)
      .toContain('ADMIN_OIDC_SCOPE(valid online OIDC scopes)');
  });

  it.each([
    '{invalid',
    '{}',
    JSON.stringify({ operators: 'unknown_role' }),
    JSON.stringify({ ' padded ': 'support_viewer' }),
    JSON.stringify({ 'control\u0001group': 'support_viewer' }),
    JSON.stringify(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`group-${index}`, 'support_viewer']))),
  ])('rejects an unsafe administrator Group allowlist', (mapping) => {
    const config = loadConfig({ ...adminEnvironment, ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON: mapping });
    expect(config.adminOidcGroupRoleMappings).toEqual([]);
    expect(config.readiness.capabilities.adminAuth.missing)
      .toContain('ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON(valid role allowlist)');
  });

  it('rejects invalid Group claim names without assuming a fixed claim', () => {
    for (const claim of ['', ' padded ', 'control\u0001claim', 'x'.repeat(129)]) {
      const config = loadConfig({ ...adminEnvironment, ADMIN_OIDC_GROUP_CLAIM: claim });
      expect(config.readiness.capabilities.adminAuth.available).toBe(false);
    }
  });

  it('supports only a canonical verified-email allowlist when the email claim is selected', () => {
    const emailEnvironment = {
      ...adminEnvironment,
      ADMIN_OIDC_GROUP_CLAIM: 'email',
      ADMIN_OIDC_SCOPE: 'openid profile email',
      ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON: JSON.stringify({
        'admin@example.test': 'super_admin',
      }),
    };
    const configured = loadConfig(emailEnvironment);
    expect(configured.readiness.capabilities.adminAuth.available).toBe(true);
    expect(configured.adminOidcGroupRoleMappings).toEqual([
      { group: 'admin@example.test', roleCode: 'super_admin' },
    ]);

    const missingEmailScope = loadConfig({ ...emailEnvironment, ADMIN_OIDC_SCOPE: 'openid profile' });
    expect(missingEmailScope.readiness.capabilities.adminAuth.missing)
      .toContain('ADMIN_OIDC_SCOPE(requires email for verified-email allowlist)');
    for (const mapping of [
      JSON.stringify({ 'Admin@example.test': 'super_admin' }),
      JSON.stringify({ 'not-an-email': 'super_admin' }),
    ]) {
      const invalid = loadConfig({ ...emailEnvironment, ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON: mapping });
      expect(invalid.readiness.capabilities.adminAuth.missing)
        .toContain('ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON(valid verified-email allowlist)');
    }
  });

  it('enforces administrator pepper length and canonical encryption key encoding', () => {
    const pepperNames = [
      'ADMIN_OIDC_FLOW_PEPPER', 'ADMIN_OIDC_SUBJECT_PEPPER', 'ADMIN_OIDC_GROUP_PEPPER',
      'ADMIN_SESSION_TOKEN_PEPPER', 'ADMIN_CSRF_TOKEN_PEPPER', 'ADMIN_AUDIT_PEPPER',
    ] as const;
    for (const name of pepperNames) {
      const capability = loadConfig({ ...adminEnvironment, [name]: 'short' }).readiness.capabilities.adminAuth;
      expect(capability.available).toBe(false);
      expect(capability.missing).toContain(`${name}(>=32 chars)`);
    }
    for (const name of ['ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY', 'ADMIN_PII_ENCRYPTION_KEY'] as const) {
      const capability = loadConfig({ ...adminEnvironment, [name]: Buffer.alloc(32, 5).toString('base64url') })
        .readiness.capabilities.adminAuth;
      expect(capability.available).toBe(false);
      expect(capability.missing).toContain(`${name}(base64 32 bytes)`);
    }
  });

  it('rejects surrounding or control whitespace instead of normalizing administrator credentials and keys', () => {
    const credentialNames = [
      'ADMIN_OIDC_CLIENT_ID', 'ADMIN_OIDC_CLIENT_SECRET',
      'ADMIN_OIDC_FLOW_PEPPER', 'ADMIN_OIDC_SUBJECT_PEPPER', 'ADMIN_OIDC_GROUP_PEPPER',
      'ADMIN_SESSION_TOKEN_PEPPER', 'ADMIN_CSRF_TOKEN_PEPPER', 'ADMIN_AUDIT_PEPPER',
      'ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY', 'ADMIN_PII_ENCRYPTION_KEY',
    ] as const;
    for (const name of credentialNames) {
      const value = adminEnvironment[name];
      expect(loadConfig({ ...adminEnvironment, [name]: `${value} ` })
        .readiness.capabilities.adminAuth.available).toBe(false);
    }
    expect(loadConfig({
      ...adminEnvironment,
      ADMIN_OIDC_CLIENT_SECRET: `${adminEnvironment.ADMIN_OIDC_CLIENT_SECRET.slice(0, 8)}\n${adminEnvironment.ADMIN_OIDC_CLIENT_SECRET.slice(8)}`,
    }).readiness.capabilities.adminAuth.available).toBe(false);
    expect(loadConfig({
      ...adminEnvironment,
      ADMIN_SESSION_TOKEN_PEPPER: `${adminEnvironment.ADMIN_SESSION_TOKEN_PEPPER.slice(0, 8)}\t${adminEnvironment.ADMIN_SESSION_TOKEN_PEPPER.slice(8)}`,
    }).readiness.capabilities.adminAuth.available).toBe(false);
  });

  it('requires every administrator secret and OIDC client registration to be independent', () => {
    expect(loadConfig({
      ...adminEnvironment,
      ADMIN_CSRF_TOKEN_PEPPER: adminEnvironment.ADMIN_SESSION_TOKEN_PEPPER,
    }).readiness.capabilities.adminAuth.missing).toContain('ADMIN_AUTH_SECRETS(independent)');
    expect(loadConfig({
      ...adminEnvironment,
      ADMIN_AUDIT_PEPPER: secureEnvironment.AUDIT_PEPPER,
    }).readiness.capabilities.adminAuth.missing).toContain('ADMIN_AUTH_SECRETS(independent)');
    expect(loadConfig({
      ...adminEnvironment,
      ADMIN_OIDC_CLIENT_SECRET: secureEnvironment.KAI_OIDC_CLIENT_SECRET,
    }).readiness.capabilities.adminAuth.missing).toContain('ADMIN_AUTH_SECRETS(independent)');
    expect(loadConfig({
      ...adminEnvironment,
      ADMIN_OIDC_CLIENT_ID: secureEnvironment.KAI_OIDC_CLIENT_ID,
    }).readiness.capabilities.adminAuth.missing).toContain('ADMIN_OIDC_CLIENT_ID(independent)');
  });

  it('enforces every administrator TTL boundary', () => {
    const invalidTtls = [
      ['ADMIN_LOGIN_TRANSACTION_TTL_SECONDS', '59'], ['ADMIN_LOGIN_TRANSACTION_TTL_SECONDS', '601'],
      ['ADMIN_SESSION_IDLE_TTL_SECONDS', '299'], ['ADMIN_SESSION_IDLE_TTL_SECONDS', '3601'],
      ['ADMIN_SESSION_ABSOLUTE_TTL_SECONDS', '1799'], ['ADMIN_SESSION_ABSOLUTE_TTL_SECONDS', '43201'],
      ['ADMIN_SESSION_ROTATION_SECONDS', '59'], ['ADMIN_SESSION_ROTATION_SECONDS', '1801'],
      ['ADMIN_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS', '0'], ['ADMIN_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS', '31'],
      ['ADMIN_REAUTH_FRESHNESS_SECONDS', '59'], ['ADMIN_REAUTH_FRESHNESS_SECONDS', '901'],
    ] as const;
    for (const [name, value] of invalidTtls) {
      expect(loadConfig({ ...adminEnvironment, [name]: value }).readiness.capabilities.adminAuth.available).toBe(false);
    }
  });

  it.each(['300 ', ' 300', '+300', '0300', '3e2', '0x12c', '300.0'])
  ('rejects a non-canonical administrator TTL: %s', (value) => {
    const capability = loadConfig({
      ...adminEnvironment,
      ADMIN_LOGIN_TRANSACTION_TTL_SECONDS: value,
    }).readiness.capabilities.adminAuth;
    expect(capability.available).toBe(false);
    expect(capability.missing).toContain('ADMIN_LOGIN_TRANSACTION_TTL_SECONDS(60-600)');
  });

  it('enforces administrator TTL relationships', () => {
    expect(loadConfig({
      ...adminEnvironment,
      ADMIN_SESSION_IDLE_TTL_SECONDS: '3600',
      ADMIN_SESSION_ABSOLUTE_TTL_SECONDS: '1800',
    }).readiness.capabilities.adminAuth.missing).toContain('ADMIN_SESSION_IDLE_TTL_SECONDS(<=absolute TTL)');
    expect(loadConfig({
      ...adminEnvironment,
      ADMIN_SESSION_IDLE_TTL_SECONDS: '300',
      ADMIN_SESSION_ROTATION_SECONDS: '301',
    }).readiness.capabilities.adminAuth.missing).toContain('ADMIN_SESSION_ROTATION_SECONDS(<=idle TTL)');
    expect(loadConfig({
      ...adminEnvironment,
      ADMIN_SESSION_ABSOLUTE_TTL_SECONDS: '1800',
      ADMIN_REAUTH_FRESHNESS_SECONDS: '900',
    }).readiness.capabilities.adminAuth.available).toBe(true);
  });

  it('does not leak administrator secrets, Group names, or mapping JSON through readiness', () => {
    const secret = 'DISTINCTIVE_ADMIN_SECRET_VALUE';
    const group = 'DISTINCTIVE_PRIVATE_GROUP';
    const mapping = JSON.stringify({ [group]: 'unknown_role' });
    const config = loadConfig({
      ...adminEnvironment,
      ADMIN_OIDC_CLIENT_SECRET: secret,
      ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON: mapping,
    });
    const readiness = JSON.stringify(config.readiness);
    expect(readiness).not.toContain(secret);
    expect(readiness).not.toContain(group);
    expect(readiness).not.toContain(mapping);
    expect(config.readiness.capabilities.adminAuth.available).toBe(false);
  });
});
