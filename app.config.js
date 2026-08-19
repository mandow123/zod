const source = require('./app.json');
const { resolveBuildPolicy } = require('./config/build-policy');

const buildPolicy = resolveBuildPolicy(process.env);
const localE2eBaseUrl = buildPolicy.localE2eBaseUrl;
const localE2eSessionToken = buildPolicy.localE2eSessionToken;
const configuredProjectId = process.env.CLOUDPAY_EAS_PROJECT_ID?.trim() || source.expo.extra?.eas?.projectId;
if (configuredProjectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(configuredProjectId)) {
  throw new Error('CLOUDPAY_EAS_PROJECT_ID must be an Expo project UUID.');
}
const sourceDigest = process.env.CLOUDPAY_FRONTEND_SOURCE_DIGEST?.trim();
if (sourceDigest && !/^[a-f0-9]{64}$/u.test(sourceDigest)) {
  throw new Error('CLOUDPAY_FRONTEND_SOURCE_DIGEST must be a SHA-256 digest.');
}
const pushNotificationsEnabled = process.env.CLOUDPAY_PUSH_NOTIFICATIONS_ENABLED === '1'
  || (process.env.CLOUDPAY_PUSH_NOTIFICATIONS_ENABLED === undefined && Boolean(configuredProjectId));
const kaiAuthUniversalLinksEnabled = buildPolicy.platform === 'ios'
  && process.env.CLOUDPAY_IOS_UNIVERSAL_AUTH_ENABLED === '1';
const pluginName = (plugin) => Array.isArray(plugin) ? plugin[0] : plugin;
const configuredPlugins = source.expo.plugins.filter((plugin) => ![
  'expo-secure-store', 'expo-notifications', 'expo-splash-screen', 'expo-web-browser',
  './plugins/with-android-release-signing',
].includes(pluginName(plugin)));
const platformPlugins = buildPolicy.platform === 'android'
  ? ['./plugins/with-android-release-signing']
  : [];

module.exports = {
  expo: {
    ...source.expo,
    plugins: [
      ...configuredPlugins,
      ['expo-secure-store', {
        configureAndroidBackup: true,
        faceIDPermission: '允许 Zod 使用面容 ID 保护账户凭证。',
      }],
      ['expo-notifications', {
        color: '#1769E0',
        defaultChannel: 'cloudpay-activity',
        enableBackgroundRemoteNotifications: false,
      }],
      ['expo-splash-screen', {
        backgroundColor: '#F4F8FE',
        image: './assets/splash-icon.png',
        imageWidth: 180,
        resizeMode: 'contain',
      }],
      'expo-web-browser',
      ...platformPlugins,
    ],
    ios: {
      ...source.expo.ios,
      associatedDomains: ['applinks:cloudpay.kai.com'],
      config: {
        ...source.expo.ios?.config,
        usesNonExemptEncryption: false,
      },
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyAccessedAPITypes: [
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
        ],
      },
    },
    extra: {
      ...source.expo.extra,
      cloudPayBaseUrl: localE2eBaseUrl || source.expo.extra.cloudPayBaseUrl,
      kaiAuthAppRedirect: 'kaicloudpay://auth/kai/callback',
      kaiAuthUniversalLink: 'https://cloudpay.kai.com/mobile/auth/kai/callback',
      kaiAuthUniversalLinksEnabled,
      allowInsecureApiForLocalE2e: Boolean(localE2eBaseUrl),
      ...(localE2eBaseUrl ? { localE2eSessionToken } : {}),
      buildPlatform: buildPolicy.platform,
      distributionChannel: buildPolicy.distributionChannel,
      nativeTopupsEnabled: buildPolicy.nativeTopupsEnabled,
      newOrdersEnabled: buildPolicy.newOrdersEnabled,
      providerPublishingEnabled: buildPolicy.providerPublishingEnabled,
      pushNotificationsEnabled,
      ...(sourceDigest ? { frontendSourceDigest: sourceDigest } : {}),
      ...(configuredProjectId ? { eas: { ...source.expo.extra?.eas, projectId: configuredProjectId } } : {}),
    },
  },
};
