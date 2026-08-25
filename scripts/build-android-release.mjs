import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { androidToolchainEnvironment, runGradle } from './android-toolchain.mjs';
import { frontendSourceDigest } from './frontend-source-digest.mjs';
import { androidVersionEvidence, expoProjectBinding, optionalExpoProjectId, validProjectId } from './android-release-identity.mjs';

const kind = process.argv[2];
if (!['apk', 'aab'].includes(kind)) throw new Error('Usage: build-android-release.mjs <apk|aab> [--channel=direct-cn|google-play]');
const channelArguments = process.argv.slice(3).filter((value) => value.startsWith('--channel='));
if (channelArguments.length > 1) throw new Error('Android release channel may be provided only once.');
const requestedChannel = channelArguments[0]?.slice('--channel='.length).trim();
const root = resolve(import.meta.dirname, '..');
const toolchainEnvironment = androidToolchainEnvironment();
const app = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo;
const currentSource = await frontendSourceDigest(root);
const publishSource = await readFile(join(root, 'src/screens/PublishScreen.tsx'), 'utf8');
const removedFrontendMarkers = ['创建任务', '算力需求、资源与供应商入驻'];
const removedSourceMarkers = removedFrontendMarkers.filter((marker) => publishSource.includes(marker));
if (removedSourceMarkers.length > 0) {
  throw new Error(`PublishScreen contains a removed frontend: ${removedSourceMarkers.join(', ')}`);
}
const localE2e = Boolean(process.env.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim());
const configuredProjectId = optionalExpoProjectId(process.env);
if (!localE2e) {
  androidVersionEvidence(app.android.versionCode, process.env);
  if (configuredProjectId) {
    const binding = expoProjectBinding(configuredProjectId, root, process.env);
    if (!binding.ok) throw new Error(`Expo push was requested but its project binding could not be verified. ${binding.evidence}`);
  }
}
const distributionChannel = requestedChannel || process.env.CLOUDPAY_DISTRIBUTION_CHANNEL?.trim()
  || (kind === 'aab' ? 'google-play' : 'direct-cn');
const allowStoreLocalE2e = process.env.CLOUDPAY_ALLOW_STORE_LOCAL_E2E === '1';
if (!['direct-cn', 'google-play'].includes(distributionChannel)) {
  throw new Error('Android release channel must be direct-cn or google-play.');
}
if (localE2e && distributionChannel !== 'direct-cn' && !allowStoreLocalE2e) {
  throw new Error('Store local E2E builds require CLOUDPAY_ALLOW_STORE_LOCAL_E2E=1.');
}
const flavor = distributionChannel === 'direct-cn' ? 'DirectCn' : 'Store';
const privateDirectory = join(homedir(), '.cloudpay-release');
const keystorePath = process.env.CLOUDPAY_UPLOAD_STORE_FILE?.trim() || join(privateDirectory, 'cloudpay-upload.jks');
const secretPath = join(privateDirectory, 'cloudpay-upload.secret');
const password = process.env.CLOUDPAY_UPLOAD_STORE_PASSWORD?.trim() || (await readFile(secretPath, 'utf8')).trim();
const alias = process.env.CLOUDPAY_UPLOAD_KEY_ALIAS?.trim() || 'cloudpay-upload';
const keyPassword = process.env.CLOUDPAY_UPLOAD_KEY_PASSWORD?.trim() || password;
await access(keystorePath, constants.R_OK);
const contract = spawnSync(process.execPath, [join(root, 'scripts/verify-mobile-backend-contract.mjs')], {
  cwd: root, stdio: 'inherit', env: toolchainEnvironment,
});
if (contract.status !== 0) process.exit(contract.status ?? 1);
const supplierLogos = spawnSync(process.execPath, [join(root, 'scripts/verify-supplier-logo-evidence.mjs')], {
  cwd: root, stdio: 'inherit', env: toolchainEnvironment,
});
if (supplierLogos.status !== 0) process.exit(supplierLogos.status ?? 1);
// Gradle removes dependency codegen before cleaning the app's cached CMake graph.
// Isolate that disposable graph first so a clean release remains reproducible.
const nativeBuildCache = join(root, 'android/app/.cxx');
try {
  await access(nativeBuildCache, constants.F_OK);
  const cacheQuarantine = await mkdtemp(join(tmpdir(), 'cloudpay-native-cache-'));
  await rename(nativeBuildCache, join(cacheQuarantine, 'app-cxx'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const clean = runGradle(root, ['clean'], {
  stdio: 'inherit', env: { ...toolchainEnvironment, NODE_ENV: 'production' },
});
if (clean.status !== 0) process.exit(clean.status ?? 1);
const result = runGradle(root, [`${kind === 'aab' ? 'bundle' : 'assemble'}${flavor}Release`], {
  stdio: 'inherit',
  env: {
    ...toolchainEnvironment,
    NODE_ENV: 'production',
    CLOUDPAY_UPLOAD_STORE_FILE: keystorePath,
    CLOUDPAY_UPLOAD_STORE_PASSWORD: password,
    CLOUDPAY_UPLOAD_KEY_ALIAS: alias,
    CLOUDPAY_UPLOAD_KEY_PASSWORD: keyPassword,
    CLOUDPAY_DISTRIBUTION_CHANNEL: distributionChannel,
    CLOUDPAY_FRONTEND_SOURCE_DIGEST: currentSource.digest,
  },
});
if (result.status !== 0) process.exit(result.status ?? 1);

const source = kind === 'aab'
  ? join(root, `android/app/build/outputs/bundle/${flavor[0].toLowerCase()}${flavor.slice(1)}Release/app-${flavor === 'DirectCn' ? 'directCn' : 'store'}-release.aab`)
  : join(root, `android/app/build/outputs/apk/${flavor === 'DirectCn' ? 'directCn' : 'store'}/release/app-${flavor === 'DirectCn' ? 'directCn' : 'store'}-release.apk`);
const bundleEntry = kind === 'aab' ? 'base/assets/index.android.bundle' : 'assets/index.android.bundle';
const embeddedBundle = spawnSync('unzip', ['-p', source, bundleEntry], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
if (embeddedBundle.status !== 0 || !Buffer.isBuffer(embeddedBundle.stdout)) {
  process.stderr.write(`Unable to inspect Android JavaScript bundle: ${String(embeddedBundle.stderr ?? '')}\n`);
  process.exit(1);
}
const configEntry = kind === 'aab' ? 'base/assets/app.config' : 'assets/app.config';
const embeddedConfig = spawnSync('unzip', ['-p', source, configEntry], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
if (embeddedConfig.status !== 0) {
  process.stderr.write(`Unable to inspect Android app configuration: ${String(embeddedConfig.stderr ?? '')}\n`);
  process.exit(1);
}
let releaseConfig;
try { releaseConfig = JSON.parse(embeddedConfig.stdout); } catch {
  process.stderr.write('Android artifact contains an invalid app configuration.\n');
  process.exit(1);
}
const embeddedBaseUrl = releaseConfig?.extra?.cloudPayBaseUrl;
const embeddedAllowsInsecureE2e = releaseConfig?.extra?.allowInsecureApiForLocalE2e === true;
const embeddedDistributionChannel = releaseConfig?.extra?.distributionChannel;
const embeddedNativeTopups = releaseConfig?.extra?.nativeTopupsEnabled === true;
const embeddedNewOrders = releaseConfig?.extra?.newOrdersEnabled === true;
const embeddedProviderPublishing = releaseConfig?.extra?.providerPublishingEnabled === true;
const embeddedProjectId = releaseConfig?.extra?.eas?.projectId;
const embeddedSourceDigest = releaseConfig?.extra?.frontendSourceDigest;
if (embeddedSourceDigest !== currentSource.digest) {
  process.stderr.write(`Android artifact source digest does not match the current primary frontend (${currentSource.fileCount} files).\n`);
  process.exit(1);
}
if (embeddedDistributionChannel !== distributionChannel) {
  process.stderr.write('Android artifact distribution channel does not match the requested channel.\n');
  process.exit(1);
}
if (distributionChannel === 'direct-cn' && !localE2e && (!embeddedNativeTopups || !embeddedNewOrders)) {
  process.stderr.write('Direct Android artifact is missing native commerce capabilities.\n');
  process.exit(1);
}
if (distributionChannel === 'direct-cn' && localE2e && (embeddedNativeTopups || !embeddedNewOrders)) {
  process.stderr.write('Local E2E Android artifact must keep sandbox orders enabled and real topups disabled.\n');
  process.exit(1);
}
if (distributionChannel === 'google-play' && (embeddedNativeTopups || embeddedNewOrders)) {
  process.stderr.write('Google Play artifact exposes unsupported commerce capabilities.\n');
  process.exit(1);
}
if (!embeddedProviderPublishing) {
  process.stderr.write('Android artifact is missing the provider publishing workspace.\n');
  process.exit(1);
}
if (localE2e && (embeddedBaseUrl !== process.env.CLOUDPAY_LOCAL_E2E_BASE_URL.trim() || !embeddedAllowsInsecureE2e)) {
  process.stderr.write('Local E2E artifact is not connected to the requested emulator backend.\n');
  process.exit(1);
}
if (!localE2e) {
  const pushProjectMatches = configuredProjectId
    ? validProjectId(embeddedProjectId) && embeddedProjectId === configuredProjectId
    : !embeddedProjectId;
  if (!pushProjectMatches) {
    process.stderr.write('Production artifact Expo push configuration does not match the requested build.\n');
    process.exit(1);
  }
}
const requiredFrontendMarkers = [
  'KAI_CLOUD_UNIFIED_ASSETS_V2',
  'UnifiedAssetsScreen',
  'ProviderWorkspaceScreen',
  'PublishScreen',
  '/mobile/v1/provider/bootstrap',
  '/mobile/v1/provider/resources',
  '/mobile/v1/provider/offer-drafts',
  '/mobile/v1/provider/listings',
  '/mobile/v1/provider/listings/',
  '/mobile/v1/provider/orders/',
  '/delivery/start',
  '/delivery/ready',
  '/refund/approve',
  'https://auth.kai.com/api/auth',
  'xUTgWjuzpAz-JT-wDbTJxh9xoh3ssU7K',
  'http://127.0.0.1:',
  '/oauth2redirect/kai',
  '/mobile/v1/device-products',
  '/mobile/v1/device-orders',
  '/mobile/v1/device-assets',
  '/mobile/v1/shipping-addresses',
  '/mobile/v1/credits/payout-profile',
  '/mobile/v1/credits/payouts',
];
const missingFrontendMarkers = requiredFrontendMarkers.filter((marker) => !embeddedBundle.stdout.includes(Buffer.from(marker)));
if (missingFrontendMarkers.length > 0) {
  process.stderr.write(`Android artifact is not the approved primary frontend: ${missingFrontendMarkers.join(', ')}\n`);
  process.exit(1);
}
if (!localE2e) {
  const productionIdentityMarkers = [
    'KAI_CLOUD_UNIFIED_IDENTITY_V1', 'X-KAI-ID-Token',
    '/mobile/v1/auth/kai/consents', 'kai.zod.auth.pending-revocations.v1',
  ];
  const missingIdentityMarkers = productionIdentityMarkers.filter(
    (marker) => !embeddedBundle.stdout.includes(Buffer.from(marker)),
  );
  if (missingIdentityMarkers.length > 0) {
    process.stderr.write(`Production artifact is missing the KAI unified identity protocol: ${missingIdentityMarkers.join(', ')}\n`);
    process.exit(1);
  }
  const forbiddenMarkers = [
    '10.0.2.2', '/__e2e/', 'CLOUDPAY_LOCAL_E2E',
    '/mobile/v1/auth/otp/request', '/mobile/v1/auth/otp/verify',
    '/mobile/v1/auth/kai/start', '/mobile/v1/auth/kai/exchange',
    '/mobile/v1/auth/refresh', '/mobile/v1/auth/logout', '/mobile/v1/auth/sessions',
    'kaicloudpay://auth/kai/callback',
    'com.kaicloud.marketplace:/oauth2redirect/kai',
    'https://cloud.kai.com/zod/oauth2redirect/kai',
  ];
  const found = forbiddenMarkers.filter((marker) => embeddedBundle.stdout.includes(Buffer.from(marker)));
  if (found.length > 0) {
    process.stderr.write(`Production artifact contains local E2E markers: ${found.join(', ')}\n`);
    process.exit(1);
  }
  if (embeddedBaseUrl !== 'https://api.kaicloudpay.com' || embeddedAllowsInsecureE2e
    || !embeddedBundle.stdout.includes(Buffer.from('https://api.kaicloudpay.com'))) {
    process.stderr.write('Production artifact does not contain the CloudPay HTTPS origin.\n');
    process.exit(1);
  }
}
if (localE2e && !embeddedBundle.stdout.includes(Buffer.from('KAI_CLOUD_LOCAL_E2E_AUTH_V1'))) {
  process.stderr.write('Local E2E artifact is missing its isolated test login.\n');
  process.exit(1);
}
if (distributionChannel === 'google-play') {
  const nativePaymentMarkers = ['Lcom/alipay/', 'Lcom/tencent/mm/opensdk/', 'KaiPaymentsModule', 'WXPayEntryActivity'];
  const archive = spawnSync('unzip', ['-l', source], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const dexEntries = archive.stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u).at(-1))
    .filter((entry) => typeof entry === 'string' && /^base\/dex\/classes\d*\.dex$/u.test(entry));
  const dexBytes = dexEntries.map((entry) => spawnSync('unzip', ['-p', source, entry], { encoding: null, maxBuffer: 128 * 1024 * 1024 }).stdout)
    .filter(Buffer.isBuffer);
  const found = nativePaymentMarkers.filter((marker) => dexBytes.some((bytes) => bytes.includes(Buffer.from(marker))));
  if (archive.status !== 0 || found.length > 0) {
    process.stderr.write(`Google Play artifact contains direct-payment native code: ${found.join(', ')}\n`);
    process.exit(1);
  }
  const forbiddenBundleMarkers = ['支付宝', '微信支付', '支付 ¥', '充值卡时', 'KaiPayments'];
  const bundleMatches = forbiddenBundleMarkers.filter((marker) => embeddedBundle.stdout.includes(Buffer.from(marker)));
  if (bundleMatches.length > 0) {
    process.stderr.write(`Google Play artifact contains direct-payment bundle code: ${bundleMatches.join(', ')}\n`);
    process.exit(1);
  }
}
const outputChannel = localE2e && distributionChannel === 'google-play' ? 'google-play-local-e2e'
  : localE2e ? 'local-e2e' : distributionChannel;
const releaseDirectory = join(root, 'artifacts', outputChannel === 'google-play-local-e2e' ? 'test' : 'release');
const outputName = `KAI-CloudPay-${app.version}-${app.android.versionCode}-${outputChannel}.${kind}`;
const destination = join(releaseDirectory, outputName);
await mkdir(releaseDirectory, { recursive: true });
await copyFile(source, destination);
const digest = createHash('sha256').update(await readFile(destination)).digest('hex');
await writeFile(`${destination}.sha256`, `${digest}  ${outputName}\n`);
process.stdout.write(`CloudPay release artifact: ${destination}\nSHA-256: ${digest}\n`);
