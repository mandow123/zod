import { createHash } from 'node:crypto';

export const FULL_COMMERCE_ENV_KEYS = [
  'NODE_ENV', 'MOBILE_API_PROFILE', 'HOST', 'PORT', 'TRUST_PROXY_HOPS', 'DATABASE_URL', 'DATABASE_SSL',
  'PUBLIC_ORIGIN', 'QIXIANG_TOPUP_MODE', 'QIXIANG_RECOVERY_MODE', 'QIXIANG_PID',
  'QIXIANG_APPROVED_MAX_CENTS', 'QIXIANG_CHECKOUT_KEY_ID', 'QIXIANG_CHECKOUT_CIPHER_VERSION',
  'QIXIANG_NOTIFY_URL', 'QIXIANG_RETURN_URL', 'QIXIANG_KEY_ROTATION_EVIDENCE_REF',
  'QIXIANG_OLD_KEY_REVOCATION_EVIDENCE_REF', 'QIXIANG_MERCHANT_ENTITY_EVIDENCE_REF',
  'QIXIANG_DOMAIN_APP_SCENE_EVIDENCE_REF', 'QIXIANG_SERVICE_CATEGORY_EVIDENCE_REF',
  'QIXIANG_REFUND_API_EVIDENCE_REF', 'QIXIANG_REAL_FULFILLMENT_EVIDENCE_REF',
  'QIXIANG_RECONCILIATION_EVIDENCE_REF', 'QIXIANG_APPROVED_MAX_EVIDENCE_REF',
  'QIXIANG_LOT_ACCOUNTING_EVIDENCE_REF', 'LEGAL_ENTITY_NAME', 'UNIFIED_SOCIAL_CREDIT_CODE',
  'ICP_FILING', 'ICP_FILING_STATUS', 'ICP_FILING_EVIDENCE_REF', 'ICP_FILING_DOMAIN',
  'APP_FILING', 'APP_FILING_STATUS', 'APP_FILING_EVIDENCE_REF', 'APP_FILING_PACKAGE',
  'FILING_OPERATOR_CREDIT_CODE', 'INTERNET_SERVICE_CLASSIFICATION_STATUS',
  'INTERNET_SERVICE_CLASSIFICATION_EVIDENCE_REF',
];

export function parseEnvironment(value) {
  return Object.fromEntries(value.split(/\r?\n/u).filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
    .map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
}

export function fullCommerceConfigurationDigest(env) {
  const canonical = Object.fromEntries([...FULL_COMMERCE_ENV_KEYS].sort().map((key) => [key, env[key] ?? null]));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function fullCommerceStaticFailures(env) {
  const requiredEvidence = FULL_COMMERCE_ENV_KEYS.filter((key) => key.endsWith('_EVIDENCE_REF'));
  const failures = [];
  if (env.NODE_ENV !== 'production') failures.push('NODE_ENV');
  if (env.MOBILE_API_PROFILE !== 'full_commerce') failures.push('MOBILE_API_PROFILE');
  if (env.HOST !== '127.0.0.1' || env.PORT !== '4100' || env.TRUST_PROXY_HOPS !== '1') failures.push('NETWORK_BINDING');
  try {
    const database = new URL(env.DATABASE_URL);
    if (database.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost'].includes(database.hostname)
      || env.DATABASE_SSL !== 'false') failures.push('DATABASE_BINDING');
  } catch { failures.push('DATABASE_BINDING'); }
  if (env.PUBLIC_ORIGIN !== 'https://cloudpay.kai.com') failures.push('PUBLIC_ORIGIN');
  if (env.QIXIANG_TOPUP_MODE !== 'on' || env.QIXIANG_RECOVERY_MODE !== 'on') failures.push('QIXIANG_MODE');
  if (env.QIXIANG_PID !== '4611') failures.push('QIXIANG_PID');
  if (!/^\d+$/u.test(env.QIXIANG_APPROVED_MAX_CENTS ?? '')
    || Number(env.QIXIANG_APPROVED_MAX_CENTS) < 100 || Number(env.QIXIANG_APPROVED_MAX_CENTS) > 4_999_999) {
    failures.push('QIXIANG_APPROVED_MAX_CENTS');
  }
  if (!/^[a-z0-9][a-z0-9._-]{7,63}$/u.test(env.QIXIANG_CHECKOUT_KEY_ID ?? '')
    || env.QIXIANG_CHECKOUT_CIPHER_VERSION !== '1') failures.push('QIXIANG_CHECKOUT_KEY');
  if (env.QIXIANG_NOTIFY_URL !== 'https://cloudpay.kai.com/mobile/v1/credits/topups/qixiang/notify'
    || env.QIXIANG_RETURN_URL !== 'https://cloudpay.kai.com/payments/qixiang/return') failures.push('QIXIANG_CALLBACKS');
  if (env.LEGAL_ENTITY_NAME !== '上海申比芯人工智能科技有限公司'
    || env.UNIFIED_SOCIAL_CREDIT_CODE !== '91310112MAKJAYAJ7U') failures.push('LEGAL_ENTITY');
  if (env.ICP_FILING_STATUS !== 'issued' || !env.ICP_FILING || env.ICP_FILING_DOMAIN !== 'cloudpay.kai.com') {
    failures.push('ICP_FILING');
  }
  if (env.APP_FILING_STATUS !== 'issued' || !env.APP_FILING
    || env.APP_FILING_PACKAGE !== 'com.kaicloud.marketplace') failures.push('APP_FILING');
  if (env.FILING_OPERATOR_CREDIT_CODE !== '91310112MAKJAYAJ7U') failures.push('FILING_OPERATOR');
  if (env.INTERNET_SERVICE_CLASSIFICATION_STATUS !== 'approved_with_legal_evidence') {
    failures.push('INTERNET_SERVICE_CLASSIFICATION');
  }
  if (requiredEvidence.some((key) => !env[key] || env[key].length < 8)) failures.push('EVIDENCE_REFERENCES');
  if (['QIXIANG_KEY', 'QIXIANG_MERCHANT_KEY', 'QIXIANG_API_KEY'].some((key) => env[key] !== undefined)) {
    failures.push('PLAINTEXT_QIXIANG_SECRET_IN_ENV');
  }
  return [...new Set(failures)];
}
