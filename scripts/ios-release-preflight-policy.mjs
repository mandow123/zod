const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const versionPattern = /^\d+(?:\.\d+){1,2}$/u;

function pluginNames(config) {
  return (config.plugins ?? []).map((plugin) => Array.isArray(plugin) ? plugin[0] : plugin);
}

export function validateIosReleaseConfig(config) {
  const issues = [];
  const extra = config.extra ?? {};
  const ios = config.ios ?? {};
  const plugins = pluginNames(config);
  if (ios.bundleIdentifier !== 'com.kaicloud.marketplace') issues.push('bundleIdentifier must be com.kaicloud.marketplace.');
  if (!versionPattern.test(config.version ?? '')) issues.push('version must be an Apple-compatible dotted numeric version.');
  if (!/^\d+(?:\.\d+){0,2}$/u.test(ios.buildNumber ?? '')) issues.push('ios.buildNumber is missing or invalid.');
  if (extra.buildPlatform !== 'ios') issues.push('buildPlatform must be ios.');
  if (extra.distributionChannel !== 'app-store') issues.push('distributionChannel must be app-store.');
  if (extra.nativeTopupsEnabled !== false) issues.push('nativeTopupsEnabled must be false.');
  if (extra.newOrdersEnabled !== false) issues.push('newOrdersEnabled must be false.');
  if (extra.cloudPayBaseUrl !== 'https://cloudpay.kai.com') issues.push('production API must be https://cloudpay.kai.com.');
  if (extra.pushNotificationsEnabled !== true) issues.push('production iOS push must be explicitly enabled.');
  if (!projectIdPattern.test(extra.eas?.projectId ?? '')) issues.push('a real EAS projectId is required when push is enabled.');
  if (extra.privacyPolicyUrl !== 'https://cloudpay.kai.com/privacy') issues.push('privacy policy URL is missing or unexpected.');
  if (extra.termsOfServiceUrl !== 'https://cloudpay.kai.com/terms') issues.push('terms URL is missing or unexpected.');
  if (extra.accountDeletionUrl !== 'https://cloudpay.kai.com/account/delete') issues.push('account deletion URL is missing or unexpected.');
  if (config.icon !== './assets/icon.png') issues.push('the reviewed App Store icon is not configured.');
  if (config.scheme !== 'kaicloudpay') issues.push('the compatibility callback scheme is missing.');
  if (config.orientation !== 'portrait' || ios.supportsTablet !== false) issues.push('the reviewed iPhone orientation policy changed.');
  if (!ios.associatedDomains?.includes('applinks:cloudpay.kai.com')) issues.push('the Universal Link associated domain is missing.');
  if (extra.kaiAuthUniversalLinksEnabled !== true) issues.push('Universal Link authentication is not enabled for production iOS.');
  if (ios.config?.usesNonExemptEncryption !== false) issues.push('export compliance encryption declaration is missing.');
  if (!Array.isArray(ios.privacyManifests?.NSPrivacyAccessedAPITypes)
    || ios.privacyManifests.NSPrivacyAccessedAPITypes.length === 0) issues.push('Privacy Manifest required-reason APIs are missing.');
  for (const required of ['expo-secure-store', 'expo-notifications', 'expo-splash-screen', 'expo-web-browser']) {
    if (!plugins.includes(required)) issues.push(`${required} config plugin is missing.`);
  }
  if (plugins.includes('./plugins/with-android-release-signing')) issues.push('Android signing plugin leaked into the iOS config.');
  return issues;
}
