'use strict';

const PLATFORMS = Object.freeze(['android', 'ios']);
const CHANNELS = Object.freeze(['direct-cn', 'google-play', 'app-store']);
const APPROVED_CHANNEL = Object.freeze({ android: ['direct-cn', 'google-play'], ios: ['app-store'] });

function requiredValue(value, name) {
  const resolved = value?.trim();
  if (!resolved) throw new Error(`${name} is required.`);
  return resolved;
}

function resolveBuildPolicy(environment = process.env) {
  const platform = requiredValue(
    environment.CLOUDPAY_BUILD_PLATFORM ?? environment.EAS_BUILD_PLATFORM,
    'CLOUDPAY_BUILD_PLATFORM',
  );
  const distributionChannel = requiredValue(
    environment.CLOUDPAY_DISTRIBUTION_CHANNEL,
    'CLOUDPAY_DISTRIBUTION_CHANNEL',
  );
  if (!PLATFORMS.includes(platform)) {
    throw new Error('CLOUDPAY_BUILD_PLATFORM must be android or ios.');
  }
  if (!CHANNELS.includes(distributionChannel)) {
    throw new Error('CLOUDPAY_DISTRIBUTION_CHANNEL must be direct-cn, google-play, or app-store.');
  }
  if (!APPROVED_CHANNEL[platform].includes(distributionChannel)) {
    throw new Error(`Unsupported platform/channel combination: ${platform}/${distributionChannel}.`);
  }

  const localE2eBaseUrl = environment.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim();
  const localE2eSessionToken = environment.CLOUDPAY_E2E_SESSION_TOKEN?.trim();
  if (localE2eBaseUrl && (platform !== 'android' || distributionChannel !== 'direct-cn')) {
    throw new Error('Local E2E is supported only for the Android direct-cn build.');
  }
  if (localE2eBaseUrl && !/^http:\/\/10\.0\.2\.2:\d{2,5}$/u.test(localE2eBaseUrl)) {
    throw new Error('CLOUDPAY_LOCAL_E2E_BASE_URL must use the Android emulator host 10.0.2.2.');
  }
  if (localE2eBaseUrl && !/^[A-Za-z0-9_-]{43,120}$/u.test(localE2eSessionToken || '')) {
    throw new Error('CLOUDPAY_E2E_SESSION_TOKEN is required for local Android E2E builds.');
  }
  if (!localE2eBaseUrl && localE2eSessionToken) {
    throw new Error('CLOUDPAY_E2E_SESSION_TOKEN is forbidden outside a local Android E2E build.');
  }

  const directCommerce = platform === 'android' && distributionChannel === 'direct-cn';
  return Object.freeze({
    platform,
    distributionChannel,
    localE2eBaseUrl: localE2eBaseUrl || null,
    localE2eSessionToken: localE2eSessionToken || null,
    nativeTopupsEnabled: directCommerce && !localE2eBaseUrl,
    newOrdersEnabled: directCommerce,
    providerPublishingEnabled: true,
  });
}

exports.resolveBuildPolicy = resolveBuildPolicy;
exports.APPROVED_CHANNEL = APPROVED_CHANNEL;
