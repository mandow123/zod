import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveBuildPolicy } from '../config/build-policy.js';

const cases = [
  { platform: 'android', channel: 'direct-cn', nativeTopups: true, newOrders: true },
  { platform: 'android', channel: 'google-play', nativeTopups: false, newOrders: false },
  { platform: 'ios', channel: 'app-store', nativeTopups: false, newOrders: false },
];

test('only approved platform and distribution channel combinations resolve', () => {
  for (const expected of cases) {
    const policy = resolveBuildPolicy({
      CLOUDPAY_BUILD_PLATFORM: expected.platform,
      CLOUDPAY_DISTRIBUTION_CHANNEL: expected.channel,
    });
    assert.equal(policy.platform, expected.platform);
    assert.equal(policy.distributionChannel, expected.channel);
    assert.equal(policy.nativeTopupsEnabled, expected.nativeTopups);
    assert.equal(policy.newOrdersEnabled, expected.newOrders);
  }
});

test('missing, unknown, and cross-store combinations fail closed', () => {
  for (const environment of [
    {},
    { CLOUDPAY_BUILD_PLATFORM: 'web', CLOUDPAY_DISTRIBUTION_CHANNEL: 'app-store' },
    { CLOUDPAY_BUILD_PLATFORM: 'ios', CLOUDPAY_DISTRIBUTION_CHANNEL: 'direct-cn' },
    { CLOUDPAY_BUILD_PLATFORM: 'ios', CLOUDPAY_DISTRIBUTION_CHANNEL: 'google-play' },
    { CLOUDPAY_BUILD_PLATFORM: 'android', CLOUDPAY_DISTRIBUTION_CHANNEL: 'app-store' },
  ]) {
    assert.throws(() => resolveBuildPolicy(environment), /platform|channel|combination/iu);
  }
});

test('local E2E remains Android direct-cn only and never enables real topups', () => {
  const policy = resolveBuildPolicy({
    CLOUDPAY_BUILD_PLATFORM: 'android',
    CLOUDPAY_DISTRIBUTION_CHANNEL: 'direct-cn',
    CLOUDPAY_LOCAL_E2E_BASE_URL: 'http://10.0.2.2:3000',
    CLOUDPAY_E2E_SESSION_TOKEN: 'a'.repeat(43),
  });
  assert.equal(policy.nativeTopupsEnabled, false);
  assert.equal(policy.newOrdersEnabled, true);
  assert.throws(() => resolveBuildPolicy({
    CLOUDPAY_BUILD_PLATFORM: 'ios',
    CLOUDPAY_DISTRIBUTION_CHANNEL: 'app-store',
    CLOUDPAY_LOCAL_E2E_BASE_URL: 'http://10.0.2.2:3000',
    CLOUDPAY_E2E_SESSION_TOKEN: 'a'.repeat(43),
  }), /local E2E.*Android direct-cn/iu);
});

function readExpoConfig(platform, channel) {
  const result = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./app.config.js').expo))"], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDPAY_BUILD_PLATFORM: platform,
      CLOUDPAY_DISTRIBUTION_CHANNEL: channel,
      CLOUDPAY_PUSH_NOTIFICATIONS_ENABLED: '0',
      CLOUDPAY_LOCAL_E2E_BASE_URL: '',
      CLOUDPAY_E2E_SESSION_TOKEN: '',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('resolved iOS config excludes the Android signing plugin and embeds closed commerce policy', () => {
  const config = readExpoConfig('ios', 'app-store');
  const pluginNames = config.plugins.map((plugin) => Array.isArray(plugin) ? plugin[0] : plugin);
  assert.equal(config.extra.buildPlatform, 'ios');
  assert.equal(config.extra.distributionChannel, 'app-store');
  assert.equal(config.extra.nativeTopupsEnabled, false);
  assert.equal(config.extra.newOrdersEnabled, false);
  assert.equal(pluginNames.includes('./plugins/with-android-release-signing'), false);
  assert.ok(pluginNames.includes('expo-secure-store'));
  assert.ok(pluginNames.includes('expo-notifications'));
  assert.ok(pluginNames.includes('expo-splash-screen'));
  assert.ok(pluginNames.includes('expo-web-browser'));
});

test('resolved Android config keeps its signing plugin and direct-cn commerce behavior', () => {
  const config = readExpoConfig('android', 'direct-cn');
  const pluginNames = config.plugins.map((plugin) => Array.isArray(plugin) ? plugin[0] : plugin);
  assert.equal(config.extra.buildPlatform, 'android');
  assert.equal(config.extra.nativeTopupsEnabled, true);
  assert.equal(config.extra.newOrdersEnabled, true);
  assert.ok(pluginNames.includes('./plugins/with-android-release-signing'));
});

test('EAS profiles keep Android behavior and give every iOS build the App Store policy', () => {
  const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));
  assert.equal(eas.build.preview.env.CLOUDPAY_DISTRIBUTION_CHANNEL, 'direct-cn');
  assert.equal(eas.build.production.env.CLOUDPAY_DISTRIBUTION_CHANNEL, 'google-play');
  for (const name of ['ios-simulator', 'ios-preview', 'ios-production']) {
    assert.equal(eas.build[name].env.CLOUDPAY_BUILD_PLATFORM, 'ios');
    assert.equal(eas.build[name].env.CLOUDPAY_DISTRIBUTION_CHANNEL, 'app-store');
  }
  assert.equal(eas.build['ios-simulator'].ios.simulator, true);
  assert.equal(eas.build['ios-production'].distribution, 'store');
});
