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
};
const deploymentFailures = Object.entries(deployment)
  .filter(([, pass]) => !pass)
  .map(([name]) => name);
const blockers = [...new Set([
  ...deploymentFailures,
  ...config.readiness.releaseBlockers,
  ...config.readiness.capabilities.computeProvider.missing,
])];

if (blockers.length > 0) {
  process.stderr.write(`CloudPay production environment is incomplete (${blockers.length} blockers):\n`);
  for (const blocker of blockers) process.stderr.write(`- ${blocker}\n`);
  process.exit(1);
}

process.stdout.write('CloudPay production environment gate passed.\n');
