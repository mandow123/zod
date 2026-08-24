import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { fullCommerceStaticFailures } from '../deploy/direct-ubuntu/full-commerce-gate-core.mjs';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function environment() {
  const directory = mkdtempSync(join(tmpdir(), 'qixiang-config-'));
  directories.push(directory);
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, 'qixiang-merchant-key'), 'TEST_ONLY_ROTATED_MERCHANT_KEY\n', { mode: 0o600 });
  writeFileSync(join(directory, 'qixiang-checkout-key'), `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
  return {
    NODE_ENV: 'test', MOBILE_API_PROFILE: 'full_commerce', PUBLIC_ORIGIN: 'https://cloudpay.kai.com',
    QIXIANG_TOPUP_MODE: 'on', QIXIANG_PID: '4611', QIXIANG_APPROVED_MAX_CENTS: '4999999',
    QIXIANG_CHECKOUT_KEY_ID: 'qixiang-checkout-2026a', QIXIANG_CHECKOUT_CIPHER_VERSION: '1',
    QIXIANG_NOTIFY_URL: 'https://cloudpay.kai.com/mobile/v1/credits/topups/qixiang/notify',
    QIXIANG_RETURN_URL: 'https://cloudpay.kai.com/payments/qixiang/return', CREDENTIALS_DIRECTORY: directory,
    QIXIANG_KEY_ROTATION_EVIDENCE_REF: 'audit://qixiang/key-rotation',
    QIXIANG_OLD_KEY_REVOCATION_EVIDENCE_REF: 'audit://qixiang/old-key-revocation',
    QIXIANG_MERCHANT_ENTITY_EVIDENCE_REF: 'audit://qixiang/entity',
    QIXIANG_DOMAIN_APP_SCENE_EVIDENCE_REF: 'audit://qixiang/domain-scene',
    QIXIANG_SERVICE_CATEGORY_EVIDENCE_REF: 'audit://qixiang/service-category',
    QIXIANG_REFUND_API_EVIDENCE_REF: 'audit://qixiang/refund-api',
    QIXIANG_REAL_FULFILLMENT_EVIDENCE_REF: 'audit://qixiang/fulfillment',
    QIXIANG_RECONCILIATION_EVIDENCE_REF: 'audit://qixiang/reconciliation',
    QIXIANG_APPROVED_MAX_EVIDENCE_REF: 'audit://qixiang/max',
    QIXIANG_LOT_ACCOUNTING_EVIDENCE_REF: 'audit://qixiang/lot-accounting',
  } as const;
}

describe('Qixiang runtime configuration gate', () => {
  it('full-commerce host gate binds the actual domain/package/entity and rejects a plaintext key',()=>{
    const input={...environment(),NODE_ENV:'production',MOBILE_API_PROFILE:'full_commerce',HOST:'127.0.0.1',PORT:'4100',
      TRUST_PROXY_HOPS:'1',DATABASE_URL:'postgresql://app:test@127.0.0.1:5432/cloudpay',DATABASE_SSL:'false',QIXIANG_RECOVERY_MODE:'on',
      LEGAL_ENTITY_NAME:'上海申比芯人工智能科技有限公司',UNIFIED_SOCIAL_CREDIT_CODE:'91310112MAKJAYAJ7U',
      ICP_FILING:'沪ICP备TEST号',ICP_FILING_STATUS:'issued',ICP_FILING_EVIDENCE_REF:'evidence://icp/receipt',
      ICP_FILING_DOMAIN:'cloudpay.kai.com',APP_FILING:'沪ICP备TEST号-A',APP_FILING_STATUS:'issued',
      APP_FILING_EVIDENCE_REF:'evidence://app/receipt',APP_FILING_PACKAGE:'com.kaicloud.marketplace',
      FILING_OPERATOR_CREDIT_CODE:'91310112MAKJAYAJ7U',
      INTERNET_SERVICE_CLASSIFICATION_STATUS:'approved_with_legal_evidence',
      INTERNET_SERVICE_CLASSIFICATION_EVIDENCE_REF:'evidence://legal/classification'};
    expect(fullCommerceStaticFailures(input)).toEqual([]);
    expect(fullCommerceStaticFailures({...input,ICP_FILING_DOMAIN:'kaicloudpay.com'})).toContain('ICP_FILING');
    expect(fullCommerceStaticFailures({...input,QIXIANG_KEY:'plaintext'})).toContain('PLAINTEXT_QIXIANG_SECRET_IN_ENV');
  });
  it('ships a separate full-commerce host gate that never accepts a plaintext merchant key',()=>{
    const root=join(import.meta.dirname,'..');
    const core=readFileSync(join(root,'deploy/direct-ubuntu/full-commerce-gate-core.mjs'),'utf8');
    const dropIn=readFileSync(join(root,'deploy/direct-ubuntu/cloudpay-mobile-backend-commerce-credentials.conf'),'utf8');
    const verifier=readFileSync(join(root,'deploy/direct-ubuntu/verify-qixiang-production-evidence.mjs'),'utf8');
    const enroll=readFileSync(join(root,'deploy/direct-ubuntu/enroll-qixiang-commerce-credentials.mjs'),'utf8');
    expect(dropIn).toContain('LoadCredentialEncrypted=qixiang-merchant-key:');
    expect(dropIn).toContain('LoadCredentialEncrypted=qixiang-checkout-key:');
    expect(dropIn).toContain('LoadCredentialEncrypted=qixiang-gate-verification-public:');
    expect(dropIn).toContain('ReadOnlyPaths=/var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json');
    expect(dropIn).toContain('ExecStartPre=+/usr/bin/node');
    expect(dropIn).not.toContain('Environment=');
    expect(core).toContain("env.ICP_FILING_DOMAIN !== 'cloudpay.kai.com'");
    expect(core).toContain("env.APP_FILING_PACKAGE !== 'com.kaicloud.marketplace'");
    expect(core).toContain('PLAINTEXT_QIXIANG_SECRET_IN_ENV');
    expect(verifier).toContain('QIXIANG_CURRENT_KEY_LIVE_PROOF_FAILED');
    expect(verifier).toContain('QIXIANG_RETIRED_KEY_STILL_ACTIVE');
    expect(verifier).toContain("sign(null, Buffer.from(canonicalJson(payload)), signingKey)");
    expect(verifier).toContain('RELEASE-MANIFEST.json');
    expect(enroll).toContain('for await(const chunk of process.stdin)');
    expect(enroll).toContain("'--with-key=host'");
    expect(enroll).toContain("generateKeyPairSync('ed25519')");
    expect(enroll).toContain('await writeJournal(journal);await finalize(journal)');
    expect(enroll).toContain('QIXIANG_COMMERCE_CREDENTIAL_ALREADY_EXISTS');
    expect(enroll).not.toContain('--locked');
    expect(enroll).not.toContain('process.env.');
  });
  it('reads both dedicated 0600 credentials and opens only the statically complete runtime gate', () => {
    const config = loadConfig(environment());
    const capability = config.readiness.capabilities.qixiangTopups;
    expect(capability.mode).toBe('on');
    expect(capability.available).toBe(true);
    expect(capability.blockers).toEqual([]);
    expect(capability.blockers).not.toContain('QIXIANG_MERCHANT_CREDENTIAL_UNAVAILABLE');
    expect(capability.blockers).not.toContain('QIXIANG_CHECKOUT_CREDENTIAL_UNAVAILABLE');
    expect(config.qixiangRecoveryMode).toBe('on');
    expect(config.readiness.capabilities.qixiangRecovery).toEqual({mode:'on',available:true,blockers:[]});
    expect(capability).toEqual({ mode: 'on', available: true, rails: ['qixiang_alipay'], minAmountCents: 100,
      maxAmountCents: 4_999_999, conversion: { numerator: 1000, denominator: 1002, rounding: 'floor', precision: 2 },
      lotValidityDays: 364, checkout: { kind: 'external_browser', allowedOrigin: 'https://api.payqixiang.cn',
        allowedPathPrefix: '/pay/submit/' }, blockers: capability.blockers });
    expect(Object.keys(capability).sort()).toEqual(['available','blockers','checkout','conversion','lotValidityDays',
      'maxAmountCents','minAmountCents','mode','rails'].sort());
  });

  it('can close new topups while keeping historical reconciliation and refunds available',()=>{
    const config=loadConfig({...environment(),QIXIANG_TOPUP_MODE:'off',QIXIANG_RECOVERY_MODE:'on'});
    expect(config.readiness.capabilities.qixiangTopups.available).toBe(false);
    expect(config.readiness.capabilities.qixiangRecovery).toEqual({mode:'on',available:true,blockers:[]});
  });

  it('fails closed on a noncanonical checkout credential or mixed-case key id', () => {
    const input = environment();
    writeFileSync(join(input.CREDENTIALS_DIRECTORY, 'qixiang-checkout-key'), 'not-base64\n', { mode: 0o600 });
    expect(loadConfig({ ...input, QIXIANG_CHECKOUT_KEY_ID: 'Qixiang-Key-1' })
      .readiness.capabilities.qixiangTopups.blockers).toContain('QIXIANG_CHECKOUT_CREDENTIAL_UNAVAILABLE');
  });

  it.each([':bad-key1', '.bad-key1', '-bad-key1'])(
    'fails closed when the checkout key id starts with a forbidden character: %s', (keyId) => {
      expect(loadConfig({ ...environment(), QIXIANG_CHECKOUT_KEY_ID: keyId })
        .readiness.capabilities.qixiangTopups.blockers).toContain('QIXIANG_CHECKOUT_CREDENTIAL_UNAVAILABLE');
    },
  );

  it('does not read credentials in shadow or inquiry-only profiles', () => {
    const input = { ...environment(), CREDENTIALS_DIRECTORY: '/definitely/not/readable' };
    const shadow = loadConfig({ ...input, QIXIANG_TOPUP_MODE: 'shadow' });
    expect(shadow.readiness.capabilities.qixiangTopups).toEqual({ mode: 'shadow', available: false, rails: [],
      minAmountCents: null, maxAmountCents: null, conversion: null, lotValidityDays: 364, checkout: null, blockers: [] });
    const inquiry = loadConfig({ ...input, MOBILE_API_PROFILE: 'inquiry_only', QIXIANG_TOPUP_MODE: 'on' });
    expect(inquiry.readiness.capabilities.qixiangTopups).toEqual({ mode: 'off', available: false, rails: [],
      minAmountCents: null, maxAmountCents: null, conversion: null, lotValidityDays: 364, checkout: null, blockers: [] });
  });
});
