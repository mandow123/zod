import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { androidToolchainEnvironment } from './android-toolchain.mjs';
import { frontendSourceDigest } from './frontend-source-digest.mjs';
import { androidVersionEvidence, expoProjectBinding, validProjectId } from './android-release-identity.mjs';

const root = resolve(import.meta.dirname, '..');
const app = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo;
const aab = resolve(process.argv[2] ?? join(root, `artifacts/release/KAI-CloudPay-${app.version}-${app.android.versionCode}-google-play.aab`));
const reportPath = resolve(process.argv[3] ?? join(root, 'artifacts/release/android-release-report.json'));
const checks = [];
const check = (id, pass, evidence) => checks.push({ id, pass, evidence });
const normalizedFingerprint = (value) => value?.replace(/:/gu, '').toLowerCase();
const currentSource = await frontendSourceDigest(root);

async function readable(path) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', ...options });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function certificateFingerprint(pemOutput) {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/u.exec(pemOutput);
  if (!match) return undefined;
  const der = Buffer.from(match[1].replace(/\s/gu, ''), 'base64');
  return createHash('sha256').update(der).digest('hex');
}

function manifestAttribute(manifest, name) {
  return new RegExp(`(?:android:)?${name}="([^"]+)"`, 'u').exec(manifest)?.[1];
}

const toolchainEnvironment = androidToolchainEnvironment();
const javaHome = toolchainEnvironment.JAVA_HOME?.trim();
const keytool = javaHome ? join(javaHome, 'bin/keytool') : 'keytool';
const jarsigner = javaHome ? join(javaHome, 'bin/jarsigner') : 'jarsigner';
const androidHome = toolchainEnvironment.ANDROID_HOME?.trim();
const androidTool = androidHome ? join(androidHome, 'build-tools/36.0.0/aapt2') : undefined;
const propertiesPath = join(root, 'release-signing.properties');
const properties = (await readable(propertiesPath))
  ? Object.fromEntries((await readFile(propertiesPath, 'utf8')).split(/\r?\n/u).flatMap((line) => {
      const match = /^([^#=]+)=(.*)$/u.exec(line); return match ? [[match[1].trim(), match[2].trim()]] : [];
    })) : {};
const defaultPrivateDirectory = join(homedir(), '.cloudpay-release');
const defaultSecretPath = join(defaultPrivateDirectory, 'cloudpay-upload.secret');
const defaultPassword = await readable(defaultSecretPath) ? (await readFile(defaultSecretPath, 'utf8')).trim() : undefined;
const signing = {
  storeFile: process.env.CLOUDPAY_UPLOAD_STORE_FILE?.trim() || properties.storeFile || join(defaultPrivateDirectory, 'cloudpay-upload.jks'),
  storePassword: process.env.CLOUDPAY_UPLOAD_STORE_PASSWORD?.trim() || properties.storePassword || defaultPassword,
  keyAlias: process.env.CLOUDPAY_UPLOAD_KEY_ALIAS?.trim() || properties.keyAlias || 'cloudpay-upload',
  keyPassword: process.env.CLOUDPAY_UPLOAD_KEY_PASSWORD?.trim() || properties.keyPassword || defaultPassword,
};

check('aab_exists', await readable(aab), aab);
check('package_id', app.android?.package === 'com.kaicloud.marketplace', app.android?.package);
check('version_code', Number.isInteger(app.android?.versionCode) && app.android.versionCode > 0, String(app.android?.versionCode));
try {
  const versionEvidence = androidVersionEvidence(app.android.versionCode, process.env);
  check('version_history_verified', true, versionEvidence.kind === 'never-published'
    ? `candidate=${String(app.android.versionCode)}; package declared never published`
    : `candidate=${String(app.android.versionCode)} published=${String(versionEvidence.publishedVersionCode)}`);
} catch (error) {
  check('version_history_verified', false, error instanceof Error ? error.message : 'version evidence missing');
}
const configuredProjectId = process.env.CLOUDPAY_EAS_PROJECT_ID?.trim();
const projectBinding = validProjectId(configuredProjectId)
  ? expoProjectBinding(configuredProjectId, root, process.env)
  : configuredProjectId
    ? { ok: false, evidence: 'CLOUDPAY_EAS_PROJECT_ID is invalid.' }
    : { ok: true, evidence: 'Expo push is not enabled for this build.' };
check('expo_project_binding_verified', projectBinding.ok, projectBinding.evidence);
check('android_build_tools_36', Boolean(androidTool && await readable(androidTool)), androidHome ? 'Android build tools 36 configured' : 'ANDROID_HOME missing');
check('public_https', /^https:\/\//u.test(app.extra?.cloudPayBaseUrl ?? ''), app.extra?.cloudPayBaseUrl);
check('release_signing_configured', Object.values(signing).every(Boolean), signing.storeFile ? 'configured outside source control' : 'missing');
let configuredCertificateFingerprint;
if (signing.storeFile && signing.storePassword && signing.keyAlias) {
  const certificate = command(keytool, ['-exportcert', '-rfc', '-keystore', signing.storeFile, '-storepass', signing.storePassword, '-alias', signing.keyAlias]);
  configuredCertificateFingerprint = certificateFingerprint(certificate.stdout);
  check('upload_certificate_readable', certificate.ok && Boolean(configuredCertificateFingerprint), configuredCertificateFingerprint ?? certificate.stderr.trim());
}
if (await readable(aab)) {
  const embeddedConfigResult = command('unzip', ['-p', aab, 'base/assets/app.config']);
  let embeddedConfig;
  try { embeddedConfig = JSON.parse(embeddedConfigResult.stdout); } catch { embeddedConfig = null; }
  const embeddedProjectId = embeddedConfig?.extra?.eas?.projectId;
  const embeddedSourceDigest = embeddedConfig?.extra?.frontendSourceDigest;
  const embeddedDistribution = embeddedConfig?.extra?.distributionChannel;
  const embeddedNativeTopups = embeddedConfig?.extra?.nativeTopupsEnabled === true;
  const embeddedNewOrders = embeddedConfig?.extra?.newOrdersEnabled === true;
  const embeddedProviderPublishing = embeddedConfig?.extra?.providerPublishingEnabled === true;
  check(
    'frontend_source_current',
    embeddedSourceDigest === currentSource.digest,
    `artifact=${embeddedSourceDigest ?? 'missing'} current=${currentSource.digest} files=${currentSource.fileCount}`,
  );
  check(
    'project_id',
    configuredProjectId
      ? validProjectId(embeddedProjectId) && embeddedProjectId === configuredProjectId && projectBinding.ok
      : !embeddedProjectId,
    embeddedProjectId ?? 'push disabled',
  );
  check('google_play_distribution', embeddedDistribution === 'google-play', embeddedDistribution ?? 'missing');
  check('google_play_commerce_disabled', !embeddedNativeTopups && !embeddedNewOrders,
    `topups=${String(embeddedNativeTopups)}, orders=${String(embeddedNewOrders)}`);
  check('google_play_provider_publishing_enabled', embeddedProviderPublishing,
    `providerPublishing=${String(embeddedProviderPublishing)}`);
  const embeddedBundle = command('unzip', ['-p', aab, 'base/assets/index.android.bundle']);
  const providerMarkers = [
    'KAI_CLOUD_DUAL_WORKSPACE_PROVIDER_PUBLISH_V1', 'ProviderResourcesScreen', 'PublishScreen',
    '/mobile/v1/provider/bootstrap', '/mobile/v1/provider/resources', '/mobile/v1/provider/offer-drafts',
    '/mobile/v1/provider/listings', '/mobile/v1/provider/listings/', '/mobile/v1/provider/orders/',
    '/delivery/start', '/delivery/ready', '/refund/approve',
  ];
  const missingProviderMarkers = providerMarkers.filter((marker) => !embeddedBundle.stdout.includes(marker));
  check('google_play_provider_workflow_embedded', embeddedBundle.ok && missingProviderMarkers.length === 0,
    missingProviderMarkers.length ? `missing: ${missingProviderMarkers.join(', ')}` : 'resource, audit, listing and fulfillment workflow');
  const bundleEnvironment = { ...toolchainEnvironment, CLOUDPAY_BUNDLE_PATH: aab };
  const gradle = join(root, 'android/gradlew');
  const initScript = join(root, 'scripts/bundletool.init.gradle');
  const validation = command(gradle, ['--no-daemon', '--quiet', '--init-script', initScript, 'cloudPayValidateBundle'], { cwd: join(root, 'android'), env: bundleEnvironment });
  check('aab_structure_valid', validation.ok, validation.ok ? 'bundletool 1.18.3 validation passed' : validation.stderr.trim());

  const dump = command(gradle, ['--no-daemon', '--quiet', '--init-script', initScript, 'cloudPayDumpBundleManifest'], { cwd: join(root, 'android'), env: bundleEnvironment });
  const manifest = /<manifest[\s\S]+<\/manifest>/u.exec(dump.stdout)?.[0] ?? '';
  const bundlePackage = manifestAttribute(manifest, 'package');
  const bundleVersionCode = manifestAttribute(manifest, 'versionCode');
  const bundleVersionName = manifestAttribute(manifest, 'versionName');
  const bundleTargetSdk = manifestAttribute(manifest, 'targetSdkVersion');
  check('aab_manifest_readable', dump.ok && Boolean(manifest), dump.ok ? 'base manifest extracted' : dump.stderr.trim());
  check('aab_package_match', bundlePackage === app.android?.package, bundlePackage ?? 'missing');
  check('aab_version_code_match', bundleVersionCode === String(app.android?.versionCode), bundleVersionCode ?? 'missing');
  check('aab_version_name_match', bundleVersionName === app.version, bundleVersionName ?? 'missing');
  check('aab_target_api_36', bundleTargetSdk === '36', bundleTargetSdk ?? 'missing');
  const forbiddenPermissions = [
    'android.permission.CAMERA', 'android.permission.RECORD_AUDIO', 'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION', 'android.permission.READ_CONTACTS', 'android.permission.READ_PHONE_STATE',
    'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW',
  ].filter((permission) => manifest.includes(`android:name="${permission}"`));
  check('aab_no_forbidden_permissions', forbiddenPermissions.length === 0, forbiddenPermissions.length === 0 ? 'none' : forbiddenPermissions.join(', '));

  const verification = command(jarsigner, ['-verify', aab]);
  check('aab_signature_integrity', verification.ok, verification.ok ? 'jarsigner integrity verification passed' : verification.stderr.trim());
  const artifactCertificate = command(keytool, ['-printcert', '-rfc', '-jarfile', aab]);
  const artifactCertificateFingerprint = certificateFingerprint(artifactCertificate.stdout);
  check('aab_certificate_readable', artifactCertificate.ok && Boolean(artifactCertificateFingerprint), artifactCertificateFingerprint ?? artifactCertificate.stderr.trim());
  check(
    'aab_certificate_matches_upload_key',
    Boolean(configuredCertificateFingerprint && artifactCertificateFingerprint === configuredCertificateFingerprint),
    artifactCertificateFingerprint ?? 'missing',
  );
  const debugCertificate = command(keytool, ['-exportcert', '-rfc', '-keystore', join(root, 'android/app/debug.keystore'), '-storepass', 'android', '-alias', 'androiddebugkey']);
  const debugCertificateFingerprint = certificateFingerprint(debugCertificate.stdout);
  check(
    'not_debug_certificate',
    Boolean(artifactCertificateFingerprint && normalizedFingerprint(artifactCertificateFingerprint) !== normalizedFingerprint(debugCertificateFingerprint)),
    artifactCertificateFingerprint ?? 'missing',
  );
  const bytes = await readFile(aab);
  check('aab_size', bytes.byteLength > 1_000_000 && bytes.byteLength < 200_000_000, `${bytes.byteLength} bytes`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  check('aab_sha256', true, sha256);
}
const productionPageMarkers = {
  '/privacy': ['<title>隐私政策 · KAI CloudPay</title>', '公开注销页面'],
  '/terms': ['<title>用户协议 · KAI CloudPay</title>', '公开注销页面'],
  '/account/delete': ['删除 KAI CloudPay 账户', 'send-code'],
};
const protectedProviderProbes = [
  '/mobile/v1/provider/bootstrap',
  '/mobile/v1/provider/resources',
  '/mobile/v1/provider/offer-drafts',
  '/mobile/v1/provider/offers',
  '/mobile/v1/provider/listings',
];
await Promise.all(['/mobile/v1/health', '/mobile/v1/readiness', '/privacy', '/terms', '/account/delete', ...protectedProviderProbes].map(async (path) => {
  const url = `${String(app.extra?.cloudPayBaseUrl).replace(/\/+$/u, '')}${path}`;
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const type = response.headers.get('content-type') ?? '';
    const body = await response.text();
    const expectedJson = path.startsWith('/mobile/');
    const markers = productionPageMarkers[path] ?? [];
    let json;
    try { json = JSON.parse(body); } catch { json = null; }
    const protectedProbe = protectedProviderProbes.includes(path);
    const contentMatches = expectedJson
      ? type.includes('application/json') && json !== null
      : type.includes('text/html') && markers.every((marker) => body.includes(marker));
    const statusMatches = protectedProbe
      ? response.status === 401 && json?.ok === false && typeof json?.error?.code === 'string'
      : response.ok;
    check(`production_${path.replaceAll('/', '_').replaceAll('-', '_')}`, statusMatches && contentMatches, `${response.status} ${type}`);
  } catch (error) {
    check(`production_${path.replaceAll('/', '_').replaceAll('-', '_')}`, false, error instanceof Error ? error.message : 'unavailable');
  }
}));
const report = {
  generatedAt: new Date().toISOString(), app: { name: app.name, package: app.android.package, version: app.version, versionCode: app.android.versionCode },
  artifact: basename(aab), ready: checks.every((item) => item.pass), checks,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
for (const item of checks) process.stdout.write(`${item.pass ? 'PASS' : 'FAIL'} ${item.id}: ${item.evidence}\n`);
process.stdout.write(`Report: ${reportPath}\n`);
if (!report.ready) process.exitCode = 1;
