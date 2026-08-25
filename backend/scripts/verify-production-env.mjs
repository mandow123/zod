import { adminProductionConfigurationIssues, loadConfig } from '../dist/config.js';

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== '--admin-only')) {
  process.stderr.write('Usage: node scripts/verify-production-env.mjs [--admin-only]\n');
  process.exit(2);
}

if (arguments_[0] === '--admin-only') {
  let issues;
  try {
    issues = adminProductionConfigurationIssues(process.env);
  } catch {
    // Never serialize the parser error: validation errors may retain rejected input.
    issues = ['ADMIN_CONFIGURATION'];
  }
  if (issues.length > 0) {
    process.stderr.write(`Administrator production configuration is incomplete (${issues.length} items):\n`);
    for (const issue of issues) process.stderr.write(`- ${issue}\n`);
    process.exit(1);
  }
  process.stdout.write('Administrator production configuration gate passed.\n');
  process.exit(0);
}

const config = loadConfig(process.env);
const deployment = {
  nodeEnvironment: config.NODE_ENV === 'production',
  loopbackOnly: config.HOST === '127.0.0.1',
  expectedPort: config.PORT === 4100,
  canonicalOrigin: config.PUBLIC_ORIGIN === 'https://cloudpay.kai.com',
  inquiryProxyChain: config.mobileApiProfile !== 'inquiry_only' || config.TRUST_PROXY_HOPS === 1,
};
const deploymentFailures = Object.entries(deployment)
  .filter(([, pass]) => !pass)
  .map(([name]) => name);
const technicalCanaryToleratedStartupBlockers = new Set([
  'SMS_PROVIDER','SMS_ACCESS_KEY_ID','SMS_ACCESS_KEY_SECRET','SMS_SIGN_NAME','SMS_TEMPLATE_CODE',
  'PUSH_PROVIDER','PUSH_CREDENTIALS_JSON',
  'OBJECT_STORAGE_PROVIDER','OBJECT_STORAGE_ENDPOINT','OBJECT_STORAGE_REGION','OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY','OBJECT_STORAGE_SECRET_KEY','CLAMAV_HOST','CLAMAV_PORT',
  'BACKUP_S3_ENDPOINT','BACKUP_S3_REGION','BACKUP_S3_BUCKET','BACKUP_S3_ACCESS_KEY','BACKUP_S3_SECRET_KEY',
  'KAI_CREDIT_TOPUP_PROVIDER_NOT_CONFIGURED','COMPUTE_PROVIDER_NOT_CONFIGURED',
  'ICP_FILING_NOT_APPROVED','APP_FILING_NOT_APPROVED','INTERNET_SERVICE_CLASSIFICATION_REQUIRED',
]);
const technicalCanary=config.mobileApiProfile==='full_commerce'&&config.qixiangTechnicalCanaryMode;
const startupBlockers=technicalCanary?config.readiness.startupBlockers.filter((item)=>
  !technicalCanaryToleratedStartupBlockers.has(item)):config.readiness.startupBlockers;
const technicalCanaryBlockers=technicalCanary?[
  ...(config.readiness.capabilities.qixiangTopups.available?[]:['QIXIANG_TECHNICAL_CANARY_TOPUPS_UNAVAILABLE']),
  ...(config.readiness.capabilities.qixiangRecovery.available?[]:['QIXIANG_TECHNICAL_CANARY_RECOVERY_UNAVAILABLE']),
  ...(config.readiness.capabilities.qixiangTopups.minAmountCents===501
    &&config.readiness.capabilities.qixiangTopups.maxAmountCents===501?[]:['QIXIANG_TECHNICAL_CANARY_AMOUNT']),
]:[];
const blockers = [...new Set([
  ...deploymentFailures,
  ...startupBlockers,
  ...technicalCanaryBlockers,
  ...(config.mobileApiProfile === 'full_commerce'&&!technicalCanary?config.readiness.capabilities.computeProvider.missing:[]),
])];

if (blockers.length > 0) {
  process.stderr.write(`CloudPay production environment is incomplete (${blockers.length} blockers):\n`);
  for (const blocker of blockers) process.stderr.write(`- ${blocker}\n`);
  process.exit(1);
}

process.stdout.write('CloudPay production environment gate passed.\n');
