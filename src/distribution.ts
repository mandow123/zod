import Constants from 'expo-constants';

export type DistributionChannel = 'direct-cn' | 'google-play' | 'app-store' | 'staging';

const configuredChannel = Constants.expoConfig?.extra?.distributionChannel;
if (!['direct-cn', 'google-play', 'app-store', 'staging'].includes(String(configuredChannel))) {
  throw new Error('KAI CloudPay distribution channel is invalid.');
}

export const distributionChannel = configuredChannel as DistributionChannel;
export const distributionPolicy = Object.freeze({
  nativeTopups: Constants.expoConfig?.extra?.nativeTopupsEnabled === true && distributionChannel === 'direct-cn',
  newOrders: Constants.expoConfig?.extra?.newOrdersEnabled === true && distributionChannel === 'direct-cn',
  providerPublishing: Constants.expoConfig?.extra?.providerPublishingEnabled === true,
  stagingDemo: Constants.expoConfig?.extra?.stagingDemoEnabled === true && distributionChannel === 'staging',
});
