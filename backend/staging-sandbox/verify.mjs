const base = process.env.STAGING_BASE_URL ?? 'http://127.0.0.1:4187';
const session = process.env.STAGING_BUYER_TOKEN;
if (!session) throw new Error('STAGING_BUYER_TOKEN_REQUIRED');
const response = await fetch(`${base}/mobile/v1/staging/health`, { headers: {
  'x-zod-client-environment': 'staging', 'x-kai-e2e-session': session,
} });
if (!response.ok || response.headers.get('x-zod-environment') !== 'staging'
  || response.headers.get('cache-control') !== 'no-store') throw new Error(`STAGING_HEALTH_FAILED:${response.status}`);
const body = await response.json();
if (body.environment !== 'staging' || body.simulation !== true || body.status !== 'ready') throw new Error('STAGING_HEALTH_CONTRACT_INVALID');
process.stdout.write('Zod staging sandbox health contract passed.\n');
