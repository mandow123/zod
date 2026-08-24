import { loadConfig } from '../dist/config.js';

const config = loadConfig(process.env);
const deployment = {
  nodeEnvironment: config.NODE_ENV === 'production',
  containerBind: config.HOST === '0.0.0.0',
  expectedPort: config.PORT === 4100,
  canonicalOrigin: config.PUBLIC_ORIGIN === 'https://cloudpay.kai.com',
};
const deploymentFailures = Object.entries(deployment)
  .filter(([, pass]) => !pass)
  .map(([name]) => name);
const blockers = [...new Set([
  ...deploymentFailures,
  ...config.readiness.releaseBlockers,
  ...(config.mobileApiProfile === 'full_commerce' ? config.readiness.capabilities.computeProvider.missing : []),
])];

if (blockers.length > 0) {
  process.stderr.write(`CloudPay container environment is incomplete (${blockers.length} blockers):\n`);
  for (const blocker of blockers) process.stderr.write(`- ${blocker}\n`);
  process.exit(1);
}

process.stdout.write('CloudPay container environment gate passed.\n');
