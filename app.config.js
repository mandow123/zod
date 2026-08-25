const source = require('./app.json');

const stagingDemoValue = process.env.CLOUDPAY_STAGING_DEMO?.trim();
if (stagingDemoValue && !['0', '1'].includes(stagingDemoValue)) {
  throw new Error('CLOUDPAY_STAGING_DEMO must be 1 when building the isolated demo App.');
}
const stagingDemo = stagingDemoValue === '1';
const localQixiangPreviewValue = process.env.CLOUDPAY_LOCAL_QIXIANG_PREVIEW?.trim();
if (localQixiangPreviewValue && !['0', '1'].includes(localQixiangPreviewValue)) {
  throw new Error('CLOUDPAY_LOCAL_QIXIANG_PREVIEW must be 1 when enabling the local Qixiang preview.');
}
if (localQixiangPreviewValue === '1' && !stagingDemo) {
  throw new Error('CLOUDPAY_LOCAL_QIXIANG_PREVIEW is allowed only with CLOUDPAY_STAGING_DEMO=1.');
}
const configuredStagingBaseUrl = process.env.CLOUDPAY_STAGING_BASE_URL?.trim();
const legacyLocalE2eBaseUrl = process.env.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim();
if (stagingDemo && legacyLocalE2eBaseUrl) {
  throw new Error('CLOUDPAY_STAGING_DEMO and CLOUDPAY_LOCAL_E2E_BASE_URL cannot be combined.');
}
if (!stagingDemo && configuredStagingBaseUrl) {
  throw new Error('CLOUDPAY_STAGING_BASE_URL is allowed only when CLOUDPAY_STAGING_DEMO=1.');
}
if (stagingDemo && configuredStagingBaseUrl && configuredStagingBaseUrl !== 'http://10.0.2.2:4187') {
  throw new Error('CLOUDPAY_STAGING_BASE_URL must use the isolated Android staging endpoint on port 4187.');
}
const localE2eBaseUrl = stagingDemo
  ? 'http://10.0.2.2:4187'
  : legacyLocalE2eBaseUrl;
const localE2eSessionToken = process.env.CLOUDPAY_E2E_SESSION_TOKEN?.trim();
if (localE2eBaseUrl && !/^http:\/\/10\.0\.2\.2:\d{2,5}$/u.test(localE2eBaseUrl)) {
  throw new Error('CLOUDPAY_LOCAL_E2E_BASE_URL must use the Android emulator host 10.0.2.2.');
}
if (stagingDemo && localE2eSessionToken) {
  throw new Error('Staging principal tokens must be injected into SecureStore, never embedded in the App config.');
}
if (localE2eBaseUrl && !stagingDemo && !/^[A-Za-z0-9_-]{43,120}$/u.test(localE2eSessionToken || '')) {
  throw new Error('CLOUDPAY_E2E_SESSION_TOKEN is required for local Android E2E builds.');
}
if (!localE2eBaseUrl && localE2eSessionToken) {
  throw new Error('CLOUDPAY_E2E_SESSION_TOKEN is forbidden outside a local Android E2E build.');
}

const requestedDistributionChannel = process.env.CLOUDPAY_DISTRIBUTION_CHANNEL?.trim();
if (stagingDemo && requestedDistributionChannel && requestedDistributionChannel !== 'staging') {
  throw new Error('The isolated demo App must use the staging distribution channel.');
}
const distributionChannel = stagingDemo ? 'staging' : (requestedDistributionChannel || 'direct-cn');
if (!['direct-cn', 'google-play', 'app-store', 'staging'].includes(distributionChannel)) {
  throw new Error('CLOUDPAY_DISTRIBUTION_CHANNEL must be direct-cn, google-play, app-store, or staging.');
}
const directCommerce = distributionChannel === 'direct-cn';
const configuredProjectId = process.env.CLOUDPAY_EAS_PROJECT_ID?.trim() || source.expo.extra?.eas?.projectId;
if (configuredProjectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(configuredProjectId)) {
  throw new Error('CLOUDPAY_EAS_PROJECT_ID must be an Expo project UUID.');
}
const sourceDigest = process.env.CLOUDPAY_FRONTEND_SOURCE_DIGEST?.trim();
if (sourceDigest && !/^[a-f0-9]{64}$/u.test(sourceDigest)) {
  throw new Error('CLOUDPAY_FRONTEND_SOURCE_DIGEST must be a SHA-256 digest.');
}

module.exports = {
  expo: {
    ...source.expo,
    name: stagingDemo ? 'Zod 测试版' : source.expo.name,
    scheme: stagingDemo ? 'zod-staging' : source.expo.scheme,
    plugins: [...(source.expo.plugins || []), '@react-native-community/datetimepicker'],
    ios: {
      ...source.expo.ios,
      bundleIdentifier: stagingDemo ? 'com.kaicloud.marketplace.staging' : source.expo.ios.bundleIdentifier,
    },
    android: {
      ...source.expo.android,
      package: stagingDemo ? 'com.kaicloud.marketplace.staging' : source.expo.android.package,
      intentFilters: stagingDemo ? [] : source.expo.android.intentFilters,
    },
    extra: {
      ...source.expo.extra,
      cloudPayBaseUrl: localE2eBaseUrl || source.expo.extra.cloudPayBaseUrl,
      allowInsecureApiForLocalE2e: Boolean(localE2eBaseUrl),
      ...(localE2eBaseUrl && !stagingDemo ? { localE2eSessionToken } : {}),
      stagingDemoEnabled: stagingDemo,
      distributionChannel,
      nativeTopupsEnabled: directCommerce && !localE2eBaseUrl,
      newOrdersEnabled: directCommerce,
      providerPublishingEnabled: !stagingDemo,
      ...(sourceDigest ? { frontendSourceDigest: sourceDigest } : {}),
      ...(configuredProjectId ? { eas: { ...source.expo.extra?.eas, projectId: configuredProjectId } } : {}),
    },
  },
};
