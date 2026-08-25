import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFile(resolve(root, path), 'utf8');
const mobilePackage = JSON.parse(await read('mobile/package.json')) as { dependencies: Record<string, string> };
const appConfig = JSON.parse(await read('mobile/app.json')) as { expo: { android: { package: string }; ios: { bundleIdentifier: string } } };

assert.match(mobilePackage.dependencies.expo ?? '', /^~57\./, 'Expo must remain pinned to SDK 57');
assert.match(mobilePackage.dependencies['react-native'] ?? '', /^0\.86\./, 'SDK 57 React Native line is required');
assert.equal(appConfig.expo.android.package, 'com.kaicloud.doujoy');
assert.equal(appConfig.expo.ios.bundleIdentifier, 'com.kaicloud.doujoy');

const sourcePaths = [
  'server/src/server.ts', 'server/src/platform.ts', 'server/src/store.ts',
  'mobile/src/api.ts', 'core/engine.ts',
];
const source = (await Promise.all(sourcePaths.map(read))).join('\n').toLowerCase();
for (const forbidden of [
  'alipay-sdk', 'wechatpay', 'stripe', 'ethers.', 'walletconnect',
]) assert.equal(source.includes(forbidden), false, `Forbidden real-value capability found: ${forbidden}`);
assert.doesNotMatch(
  source,
  /['"`]\/(?:v\d+\/)?(?:topups?|withdrawals?|withdraw|redeem|transfer-token)(?:\/|['"`])/,
  'Forbidden real-value API route found',
);

for (const required of [
  'README.md', 'docs/PRODUCT.md', 'docs/SECURITY.md', 'docs/PRIVACY.md', 'docs/TERMS.md',
  'docs/DEPLOYMENT.md',
  'mobile/package-lock.json', 'server/data/.gitignore', 'Dockerfile', 'docker-compose.yml', '.env.example',
  'web/index.html', 'web/app.js', 'web/styles.css', 'web/serve.mjs', 'web/Dockerfile',
]) assert.equal((await stat(resolve(root, required))).isFile(), true, `Required artifact missing: ${required}`);

const engine = await read('core/engine.ts');
assert.match(engine, /randomBytes\(16\)/, '128-bit fairness nonce is required');
assert.match(engine, /deckCommitment\(/, 'Deck commitment must be recorded at game creation');
const fairness = await read('core/fairness.ts');
assert.match(fairness, /createHash\('sha256'\)/, 'SHA-256 deck commitment is required');
assert.match(fairness, /timingSafeEqual/, 'Fairness verification must compare digests safely');
const platform = await read('server/src/platform.ts');
assert.match(platform, /expectedSequence !== game\.sequence/, 'Stale game protection is required');
assert.match(platform, /settlement:\$\{game\.id\}/, 'Idempotent settlement key is required');
const server = await read('server/src/server.ts');
assert.match(server, /DOUJOY_CORS_ORIGIN_REQUIRED_IN_PRODUCTION/, 'Production CORS must fail closed');
assert.match(server, /DOUJOY_TURN_TIMEOUT_MS_INVALID/, 'Turn timeout bounds are required');
assert.match(server, /DOUJOY_BACKUP_COUNT_INVALID/, 'Snapshot backup count bounds are required');
assert.match(server, /DOUJOY_WAIT_TIMEOUT_MAX_MS_INVALID/, 'Long-poll timeout bounds are required');
const compose = await read('docker-compose.yml');
assert.match(compose, /DOUJOY_BIND_IP:-127\.0\.0\.1/, 'Server must bind to loopback by default');
assert.match(compose, /DOUJOY_WEB_BIND_IP:-127\.0\.0\.1/, 'Web preview must bind to loopback by default');

console.log('KAI Play release preflight passed: SDK 57, package identity, play-only boundary, fairness, and required docs.');
