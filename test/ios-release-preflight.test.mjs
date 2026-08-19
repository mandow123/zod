import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIosReleaseConfig } from '../scripts/ios-release-preflight-policy.mjs';

function fixture() {
  return {
    name: 'Zod', version: '1.0.0', orientation: 'portrait', icon: './assets/icon.png', scheme: 'kaicloudpay',
    plugins: [
      ['expo-secure-store', {}], ['expo-notifications', { enableBackgroundRemoteNotifications: false }],
      ['expo-splash-screen', { image: './assets/splash-icon.png' }], 'expo-web-browser',
    ],
    ios: {
      supportsTablet: false, bundleIdentifier: 'com.kaicloud.marketplace', buildNumber: '1',
      associatedDomains: [], config: { usesNonExemptEncryption: false },
      privacyManifests: { NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults' }] },
    },
    extra: {
      buildPlatform: 'ios', distributionChannel: 'app-store', nativeTopupsEnabled: false, newOrdersEnabled: false,
      cloudPayBaseUrl: 'https://cloudpay.kai.com', pushNotificationsEnabled: true,
      eas: { projectId: '123e4567-e89b-42d3-a456-426614174000' },
      privacyPolicyUrl: 'https://cloudpay.kai.com/privacy', termsOfServiceUrl: 'https://cloudpay.kai.com/terms',
      accountDeletionUrl: 'https://cloudpay.kai.com/account/delete', kaiAuthUniversalLinksEnabled: false,
    },
  };
}

test('a complete production iOS config passes release policy', () => {
  assert.deepEqual(validateIosReleaseConfig(fixture()), []);
});

test('release policy rejects commerce, identity, API, legal, push, icon, and privacy regressions', () => {
  const mutations = [
    (config) => { config.ios.bundleIdentifier = 'com.example.zod'; },
    (config) => { config.ios.buildNumber = ''; },
    (config) => { config.extra.distributionChannel = 'direct-cn'; },
    (config) => { config.extra.nativeTopupsEnabled = true; },
    (config) => { config.extra.newOrdersEnabled = true; },
    (config) => { config.extra.cloudPayBaseUrl = 'http://localhost:3000'; },
    (config) => { config.extra.eas.projectId = 'your-project-id'; },
    (config) => { config.extra.privacyPolicyUrl = ''; },
    (config) => { config.plugins = config.plugins.filter((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) !== 'expo-splash-screen'); },
    (config) => { config.ios.privacyManifests = {}; },
    (config) => { config.extra.kaiAuthUniversalLinksEnabled = 'maybe'; },
  ];
  for (const mutate of mutations) {
    const config = fixture();
    mutate(config);
    assert.ok(validateIosReleaseConfig(config).length > 0);
  }
});
