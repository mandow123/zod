import { loadConfig } from '../dist/config.js';

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
