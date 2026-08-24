import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { androidToolchainEnvironment, discoverAndroidHome, platformExecutable, runPlatformCommand } from './android-toolchain.mjs';
import { frontendSourceDigest } from './frontend-source-digest.mjs';

const root = resolve(import.meta.dirname, '..');
const app = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo;
const defaultApk = join(root, `artifacts/release/KAI-CloudPay-${app.version}-${app.android.versionCode}-direct-cn.apk`);
const localE2eApk = join(root, `artifacts/release/KAI-CloudPay-${app.version}-${app.android.versionCode}-local-e2e.apk`);
const apk = resolve(process.argv.find((value) => value.endsWith('.apk'))
  ?? (process.argv.includes('--local-e2e') ? localE2eApk : defaultApk));
const install = process.argv.includes('--install');
const cleanInstall = process.argv.includes('--clean-install');
const replaceIncompatible = process.argv.includes('--replace-incompatible');
const requireProviderMode = process.argv.includes('--provider');
const requireStoreChannel = process.argv.includes('--store');
const toolchainEnvironment = androidToolchainEnvironment();
const androidHome = discoverAndroidHome(toolchainEnvironment);
const adb = platformExecutable(androidHome, androidHome ? 'platform-tools/adb' : 'adb');
const aapt = platformExecutable(androidHome, androidHome ? 'build-tools/36.0.0/aapt' : 'aapt');
const apksigner = platformExecutable(androidHome, androidHome ? 'build-tools/36.0.0/apksigner' : 'apksigner');
const packageName = app.android.package;
const reportPath = join(root, requireStoreChannel
  ? 'artifacts/test/android-store-provider-smoke-report.json'
  : 'artifacts/release/android-device-smoke-report.json');
const outputDirectory = join(root, requireStoreChannel ? 'artifacts/test/store-smoke' : 'artifacts/release/smoke');

function run(binary, args, options = {}) {
  const result = runPlatformCommand(binary, args, { encoding: 'utf8', env: toolchainEnvironment, ...options });
  if (result.status !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    throw new Error(`${basename(binary)} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout;
}

function runBinary(binary, args, options = {}) {
  const result = runPlatformCommand(binary, args, { encoding: null, env: toolchainEnvironment, maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    throw new Error(`${basename(binary)} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return Buffer.isBuffer(result.rawStdout) ? result.rawStdout : Buffer.from(result.stdout);
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const checks = [];
const check = (id, pass, evidence) => checks.push({ id, pass, evidence });
const adbRun = (...args) => run(adb, args);

await mkdir(outputDirectory, { recursive: true });

const devices = run(adb, ['devices']).split(/\r?\n/u).slice(1).filter((line) => /\tdevice$/u.test(line));
check('single_android_device', devices.length === 1, devices.join(', ') || 'none');
if (devices.length !== 1) throw new Error('Connect exactly one unlocked Android emulator or test device.');

const badging = run(aapt, ['dump', 'badging', apk]);
const packageMatch = /package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/u.exec(badging);
check('apk_package', packageMatch?.[1] === packageName, packageMatch?.[1] ?? 'missing');
check('apk_version_code', packageMatch?.[2] === String(app.android.versionCode), packageMatch?.[2] ?? 'missing');
check('apk_version_name', packageMatch?.[3] === app.version, packageMatch?.[3] ?? 'missing');
check('apk_target_api_36', /targetSdkVersion:'36'/u.test(badging), /targetSdkVersion:'([^']+)'/u.exec(badging)?.[1] ?? 'missing');

const signing = run(apksigner, ['verify', '--verbose', '--print-certs', apk]);
const certificate = /Signer #1 certificate SHA-256 digest: ([a-f0-9]+)/iu.exec(signing)?.[1]?.toLowerCase();
check('apk_signature_valid', /^Verifies$/mu.test(signing), certificate ?? 'missing');
check('apk_v2_or_v3_signature', /Verified using v[23] scheme[^:]*: true/u.test(signing), 'APK Signature Scheme v2/v3');
check('apk_upload_certificate', certificate === '20441f6b593c4f19c05ac66975e28469daa84b36f18a4120e0dcda661cf1996a', certificate ?? 'missing');

const contents = run('unzip', ['-l', apk]);
check('embedded_javascript_bundle', /assets\/index\.android\.bundle/u.test(contents), 'assets/index.android.bundle');

const currentSource = await frontendSourceDigest(root);
const embeddedConfig = JSON.parse(run('unzip', ['-p', apk, 'assets/app.config']));
const embeddedBundle = runBinary('unzip', ['-p', apk, 'assets/index.android.bundle']);
const embeddedExtra = embeddedConfig?.extra ?? {};
const requiredFrontendMarkers = [
  'KAI_CLOUD_UNIFIED_ASSETS_V2',
  'UnifiedAssetsScreen',
  'ProviderWorkspaceScreen',
  'PublishScreen',
];
const commerceWorkflowMarkers = [
  '/mobile/v1/device-products', '/mobile/v1/device-orders', '/mobile/v1/device-assets',
  '/mobile/v1/shipping-addresses', '/mobile/v1/credits/payout-profile', '/mobile/v1/credits/payouts',
];
const providerWorkflowMarkers = [
  '/mobile/v1/provider/bootstrap', '/mobile/v1/provider/resources', '/mobile/v1/provider/offer-drafts',
  '/mobile/v1/provider/listings', '/mobile/v1/provider/listings/', '/mobile/v1/provider/orders/',
  '/delivery/start', '/delivery/ready', '/refund/approve',
];
const unifiedIdentityMarkers = [
  'https://auth.kai.com/api/auth',
  'xUTgWjuzpAz-JT-wDbTJxh9xoh3ssU7K',
  'http://127.0.0.1:',
  '/oauth2redirect/kai',
];
const productionIdentityMarkers = [
  'X-KAI-ID-Token', '/mobile/v1/auth/kai/consents', 'kai.zod.auth.pending-revocations.v1',
];
const retiredIdentityMarkers = [
  '/mobile/v1/auth/refresh', '/mobile/v1/auth/logout', '/mobile/v1/auth/sessions',
  'kaicloudpay://auth/kai/callback',
  'com.kaicloud.marketplace:/oauth2redirect/kai',
  'https://cloud.kai.com/zod/oauth2redirect/kai',
];
const missingFrontendMarkers = requiredFrontendMarkers.filter(
  (marker) => !embeddedBundle.includes(Buffer.from(marker)),
);
const missingProviderWorkflowMarkers = providerWorkflowMarkers.filter(
  (marker) => !embeddedBundle.includes(Buffer.from(marker)),
);
const missingUnifiedIdentityMarkers = unifiedIdentityMarkers.filter(
  (marker) => !embeddedBundle.includes(Buffer.from(marker)),
);
const missingCommerceWorkflowMarkers = commerceWorkflowMarkers.filter(
  (marker) => !embeddedBundle.includes(Buffer.from(marker)),
);
const localE2e = /^http:\/\/10\.0\.2\.2:\d{2,5}$/u.test(embeddedExtra.cloudPayBaseUrl ?? '');
check(
  'primary_frontend_source',
  embeddedExtra.frontendSourceDigest === currentSource.digest,
  embeddedExtra.frontendSourceDigest ?? 'missing',
);
check(
  'primary_frontend_markers',
  missingFrontendMarkers.length === 0,
  missingFrontendMarkers.length === 0 ? 'approved provider frontend' : `missing: ${missingFrontendMarkers.join(', ')}`,
);
check('distribution_channel', embeddedExtra.distributionChannel === (requireStoreChannel ? 'google-play' : 'direct-cn'), embeddedExtra.distributionChannel ?? 'missing');
check(
  'api_environment',
  localE2e
    ? embeddedExtra.allowInsecureApiForLocalE2e === true
    : embeddedExtra.cloudPayBaseUrl === 'https://cloudpay.kai.com' && embeddedExtra.allowInsecureApiForLocalE2e !== true,
  `${embeddedExtra.cloudPayBaseUrl ?? 'missing'} (${localE2e ? 'local-e2e' : 'production'})`,
);
check('unified_identity_protocol_embedded', missingUnifiedIdentityMarkers.length === 0,
  missingUnifiedIdentityMarkers.length ? `missing: ${missingUnifiedIdentityMarkers.join(', ')}` : 'direct public PKCE client and exact HTTPS App Link');
if (!localE2e) {
  const missingProductionIdentity = productionIdentityMarkers.filter(
    (marker) => !embeddedBundle.includes(Buffer.from(marker)),
  );
  const foundRetiredIdentity = retiredIdentityMarkers.filter(
    (marker) => embeddedBundle.includes(Buffer.from(marker)),
  );
  check('production_paired_identity_and_consent', missingProductionIdentity.length === 0,
    missingProductionIdentity.length ? `missing: ${missingProductionIdentity.join(', ')}` : 'paired access/id, legal consent and revocation retry');
  check('retired_local_session_protocol_absent', foundRetiredIdentity.length === 0,
    foundRetiredIdentity.length ? `found: ${foundRetiredIdentity.join(', ')}` : 'old refresh/logout/sessions and callback absent');
}
check('unified_asset_commerce_embedded', missingCommerceWorkflowMarkers.length === 0,
  missingCommerceWorkflowMarkers.length ? `missing: ${missingCommerceWorkflowMarkers.join(', ')}` : 'device purchase, assets and supplier payout APIs');
if (requireStoreChannel) {
  check('store_commerce_disabled',
    embeddedExtra.nativeTopupsEnabled !== true && embeddedExtra.newOrdersEnabled !== true,
    `topups=${String(embeddedExtra.nativeTopupsEnabled)}, orders=${String(embeddedExtra.newOrdersEnabled)}`);
  check('store_provider_publishing_enabled', embeddedExtra.providerPublishingEnabled === true,
    `providerPublishing=${String(embeddedExtra.providerPublishingEnabled)}`);
  check('store_provider_workflow_embedded', missingProviderWorkflowMarkers.length === 0,
    missingProviderWorkflowMarkers.length ? `missing: ${missingProviderWorkflowMarkers.join(', ')}` : 'resource, listing and fulfillment APIs');
} else {
  check(
    'direct_commerce_capabilities',
    localE2e
      ? embeddedExtra.nativeTopupsEnabled !== true && embeddedExtra.newOrdersEnabled === true
      : embeddedExtra.nativeTopupsEnabled === true && embeddedExtra.newOrdersEnabled === true,
    `topups=${String(embeddedExtra.nativeTopupsEnabled)}, orders=${String(embeddedExtra.newOrdersEnabled)}`,
  );
}

if (install) {
  const rejectedCandidate = checks.filter((item) => !item.pass);
  if (rejectedCandidate.length > 0) {
    const detail = rejectedCandidate.map((item) => `${item.id}: ${item.evidence}`).join('; ');
    throw new Error(`Refusing to install an unapproved Android candidate. ${detail}`);
  }
  if (cleanInstall) {
    const isEmulator = adbRun('shell', 'getprop', 'ro.kernel.qemu').trim() === '1';
    if (!isEmulator) throw new Error('Clean installation is restricted to the Android acceptance emulator.');
    const installedBefore = adbRun('shell', 'pm', 'path', packageName).trim();
    if (installedBefore.startsWith('package:')) adbRun('uninstall', packageName);
  }
  const firstInstall = runPlatformCommand(adb, ['install', ...(cleanInstall ? [] : ['-r']), apk], { encoding: 'utf8', env: toolchainEnvironment });
  if (firstInstall.status !== 0 && /INSTALL_FAILED_UPDATE_INCOMPATIBLE/u.test(`${firstInstall.stdout}${firstInstall.stderr}`) && replaceIncompatible) {
    const isEmulator = adbRun('shell', 'getprop', 'ro.kernel.qemu').trim() === '1';
    if (!isEmulator) {
      throw new Error('Refusing to remove an incompatible app from a physical device because uninstalling would erase its local data.');
    }
    adbRun('uninstall', packageName);
    adbRun('install', apk);
  } else if (firstInstall.status !== 0) {
    throw new Error(`${firstInstall.stdout ?? ''}\n${firstInstall.stderr ?? ''}`.trim());
  }
}

const installedPath = adbRun('shell', 'pm', 'path', packageName).trim();
check('package_installed', installedPath.startsWith('package:'), installedPath || 'missing');
const installed = adbRun('shell', 'dumpsys', 'package', packageName);
check('installed_version', installed.includes(`versionCode=${app.android.versionCode}`) && installed.includes(`versionName=${app.version}`), `${app.version} (${app.android.versionCode})`);
const deviceApkPath = installedPath.split(/\r?\n/u)[0]?.replace(/^package:/u, '');
const candidateDigest = createHash('sha256').update(await readFile(apk)).digest('hex');
const installedDigest = deviceApkPath
  ? createHash('sha256').update(runBinary(adb, ['exec-out', 'cat', deviceApkPath])).digest('hex')
  : undefined;
check('installed_artifact_exact_match', installedDigest === candidateDigest, installedDigest ?? 'missing');

adbRun('shell', 'am', 'force-stop', packageName);
adbRun('logcat', '-c');
const launch = adbRun('shell', 'am', 'start', '-W', '-n', `${packageName}/.MainActivity`);
await wait(6_000);
const launchTime = Number(/TotalTime:\s*(\d+)/u.exec(launch)?.[1]);
check('cold_launch', /Status:\s*ok/u.test(launch) && /LaunchState:\s*COLD/u.test(launch), Number.isFinite(launchTime) ? `${launchTime} ms` : launch.trim());
const appPid = adbRun('shell', 'pidof', packageName).trim().split(/\s+/u)[0] ?? '';
check('process_alive', Boolean(appPid), appPid ? `process ${appPid}` : 'process missing');
const windowState = adbRun('shell', 'dumpsys', 'window');
check('app_in_foreground', windowState.includes(`${packageName}/${packageName}.MainActivity`), packageName);

const screen = adbRun('shell', 'wm', 'size');
const screenMatch = /Physical size:\s*(\d+)x(\d+)/u.exec(screen) ?? /Override size:\s*(\d+)x(\d+)/u.exec(screen);
if (!screenMatch) throw new Error(`Unable to read device size: ${screen.trim()}`);
const width = Number(screenMatch[1]);
const height = Number(screenMatch[2]);
adbRun('shell', 'uiautomator', 'dump', '/sdcard/cloudpay-smoke-mode.xml');
let initialHierarchy = adbRun('exec-out', 'cat', '/sdcard/cloudpay-smoke-mode.xml');
let providerMode = initialHierarchy.includes('text="上架资源"')
  || initialHierarchy.includes('text="登录后管理供给"');
if (requireProviderMode && !providerMode) {
  adbRun('shell', 'input', 'tap', String(Math.round(4.5 * width / 5)), String(height - 140));
  await wait(1_000);
  adbRun('shell', 'uiautomator', 'dump', '/sdcard/cloudpay-smoke-mode.xml');
  initialHierarchy = adbRun('exec-out', 'cat', '/sdcard/cloudpay-smoke-mode.xml');
  const providerToggle = /(?:content-desc="[^"]*提供算力[^"]*"|text="提供算力")[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u.exec(initialHierarchy);
  if (providerToggle) {
    const [, left, top, right, bottom] = providerToggle.map(Number);
    adbRun('shell', 'input', 'tap', String(Math.round((left + right) / 2)), String(Math.round((top + bottom) / 2)));
    await wait(1_200);
    adbRun('shell', 'uiautomator', 'dump', '/sdcard/cloudpay-smoke-mode.xml');
    initialHierarchy = adbRun('exec-out', 'cat', '/sdcard/cloudpay-smoke-mode.xml');
    adbRun('shell', 'input', 'tap', String(Math.round(0.5 * width / 5)), String(height - 140));
    await wait(1_000);
    adbRun('shell', 'uiautomator', 'dump', '/sdcard/cloudpay-smoke-mode.xml');
    initialHierarchy = adbRun('exec-out', 'cat', '/sdcard/cloudpay-smoke-mode.xml');
    providerMode = initialHierarchy.includes('text="上架资源"')
      || initialHierarchy.includes('text="登录后管理供给"');
  }
}
check('requested_workspace', !requireProviderMode || providerMode, requireProviderMode ? '提供算力' : (providerMode ? '提供算力' : '使用算力'));
const tabs = providerMode ? [
  { id: 'home', markers: ['上架资源', '登录后管理供给'], forbidden: ['上架数据没能载入'], settle: ['正在同步上架数据'] },
  { id: 'market', markers: ['资源市场'] },
  { id: 'assets', markers: ['我的资产'] },
  { id: 'messages', markers: ['消息'] },
  { id: 'profile', markers: ['当前视角'] },
] : [
  { id: 'home', markers: ['找到正在可用的算力'] },
  { id: 'market', markers: ['资源市场'] },
  { id: 'publish', markers: ['先完成资源方入驻'] },
  { id: 'messages', markers: ['消息'] },
  { id: 'profile', markers: ['我的资产'] },
];

for (const [index, tab] of tabs.entries()) {
  const { id, markers, forbidden = [], settle = [] } = tab;
  adbRun('shell', 'input', 'tap', String(Math.round((index + 0.5) * width / tabs.length)), String(height - 140));
  const remoteXml = `/sdcard/cloudpay-smoke-${id}.xml`;
  let hierarchy = '';
  const deadline = Date.now() + 10_000;
  do {
    await wait(900);
    adbRun('shell', 'uiautomator', 'dump', remoteXml);
    hierarchy = adbRun('exec-out', 'cat', remoteXml);
    const expectedReady = markers.some((marker) => hierarchy.includes(marker));
    const stillSettling = settle.some((marker) => hierarchy.includes(marker));
    if (expectedReady && !stillSettling) break;
  } while (Date.now() < deadline);
  await writeFile(join(outputDirectory, `android-production-${id}.xml`), hierarchy);
  const screenshot = runPlatformCommand(adb, ['exec-out', 'screencap', '-p'], { encoding: null, env: toolchainEnvironment });
  if (screenshot.status !== 0) throw new Error(`Unable to capture ${id} screenshot.`);
  const screenshotBytes = Buffer.isBuffer(screenshot.rawStdout) ? screenshot.rawStdout : Buffer.from(screenshot.stdout);
  await writeFile(join(outputDirectory, `android-production-${id}.png`), screenshotBytes);
  const hasExpectedMarker = markers.some((marker) => hierarchy.includes(marker));
  const forbiddenMarker = forbidden.find((marker) => hierarchy.includes(marker));
  const hasRemovedPublishHeader = id === 'publish' && (hierarchy.includes('创建任务') || hierarchy.includes('算力需求、资源与供应商入驻'));
  check(`tab_${id}`, hasExpectedMarker && !forbiddenMarker && !hasRemovedPublishHeader,
    forbiddenMarker ? `unexpected: ${forbiddenMarker}` : markers.join(' / '));
}

// UIAutomator is a separate Android shell process and can crash independently
// while the application stays healthy. Scope fatal detection to the app PID so
// test-infrastructure failures cannot be misreported as Zod runtime crashes.
const logcat = adbRun('logcat', ...(appPid ? [`--pid=${appPid}`] : []), '-d', '-v', 'brief');
await writeFile(join(outputDirectory, 'android-production-smoke-logcat.txt'), logcat);
const fatalPatterns = [
  /FATAL EXCEPTION/u,
  /Unable to load script/u,
  /Could not connect to development server/u,
  /ReactNativeJS.*(?:Error|Exception)/u,
  /AndroidRuntime.*FATAL/u,
];
const fatal = fatalPatterns.find((pattern) => pattern.test(logcat));
check('no_fatal_runtime_error', !fatal, fatal?.source ?? 'no fatal or Metro errors');

const report = {
  generatedAt: new Date().toISOString(),
  device: devices[0].split('\t')[0],
  artifact: basename(apk),
  artifactSha256: candidateDigest,
  frontendSourceDigest: currentSource.digest,
  workspace: providerMode ? 'provider' : 'buyer',
  app: { package: packageName, version: app.version, versionCode: app.android.versionCode },
  ready: checks.every((item) => item.pass),
  checks,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
for (const item of checks) process.stdout.write(`${item.pass ? 'PASS' : 'FAIL'} ${item.id}: ${item.evidence}\n`);
process.stdout.write(`Report: ${reportPath}\n`);
if (!report.ready) process.exitCode = 1;
