const source = require('./app.json');

const localE2eBaseUrl = process.env.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim();
const localE2eSessionToken = process.env.CLOUDPAY_E2E_SESSION_TOKEN?.trim();
if (localE2eBaseUrl && !/^http:\/\/10\.0\.2\.2:\d{2,5}$/u.test(localE2eBaseUrl)) {
  throw new Error('CLOUDPAY_LOCAL_E2E_BASE_URL must use the Android emulator host 10.0.2.2.');
}
if (localE2eBaseUrl && !/^[A-Za-z0-9_-]{43,120}$/u.test(localE2eSessionToken || '')) {
  throw new Error('CLOUDPAY_E2E_SESSION_TOKEN is required for local Android E2E builds.');
}
if (!localE2eBaseUrl && localE2eSessionToken) {
  throw new Error('CLOUDPAY_E2E_SESSION_TOKEN is forbidden outside a local Android E2E build.');
}

const distributionChannel = process.env.CLOUDPAY_DISTRIBUTION_CHANNEL?.trim() || 'direct-cn';
if (!['direct-cn', 'google-play', 'app-store'].includes(distributionChannel)) {
  throw new Error('CLOUDPAY_DISTRIBUTION_CHANNEL must be direct-cn, google-play, or app-store.');
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
    plugins: [...(source.expo.plugins || []), '@react-native-community/datetimepicker'],
    extra: {
      ...source.expo.extra,
      cloudPayBaseUrl: localE2eBaseUrl || source.expo.extra.cloudPayBaseUrl,
      kaiAuthAppRedirect: 'kaicloudpay://auth/kai/callback',
      allowInsecureApiForLocalE2e: Boolean(localE2eBaseUrl),
      ...(localE2eBaseUrl ? { localE2eSessionToken } : {}),
      distributionChannel,
      nativeTopupsEnabled: directCommerce && !localE2eBaseUrl,
      newOrdersEnabled: directCommerce,
      providerPublishingEnabled: true,
      ...(sourceDigest ? { frontendSourceDigest: sourceDigest } : {}),
      ...(configuredProjectId ? { eas: { ...source.expo.extra?.eas, projectId: configuredProjectId } } : {}),
    },
  },
};
