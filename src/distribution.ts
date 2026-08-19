import Constants from 'expo-constants';
import {
  createCommercePolicy,
  guardCommerceRequest,
  type BuildPlatform,
  type DistributionChannel,
} from './commerce-policy';

export type { BuildPlatform, DistributionChannel } from './commerce-policy';

const configuredPlatform = Constants.expoConfig?.extra?.buildPlatform;
if (!['android', 'ios'].includes(String(configuredPlatform))) {
  throw new Error('KAI CloudPay build platform is invalid.');
}
export const buildPlatform = configuredPlatform as BuildPlatform;

const configuredChannel = Constants.expoConfig?.extra?.distributionChannel;
if (!['direct-cn', 'google-play', 'app-store'].includes(String(configuredChannel))) {
  throw new Error('KAI CloudPay distribution channel is invalid.');
}

export const distributionChannel = configuredChannel as DistributionChannel;
const validCombination = (buildPlatform === 'ios' && distributionChannel === 'app-store')
  || (buildPlatform === 'android' && ['direct-cn', 'google-play'].includes(distributionChannel));
if (!validCombination) throw new Error('KAI CloudPay platform and distribution channel combination is invalid.');
const commercePolicy = createCommercePolicy({
  buildPlatform,
  distributionChannel,
  nativeTopupsEnabled: Constants.expoConfig?.extra?.nativeTopupsEnabled === true,
  newOrdersEnabled: Constants.expoConfig?.extra?.newOrdersEnabled === true,
});
export const distributionPolicy = Object.freeze({
  ...commercePolicy,
  providerPublishing: Constants.expoConfig?.extra?.providerPublishingEnabled === true,
});

export function guardNewOrderRequest<T>(request: () => T) {
  return guardCommerceRequest(distributionPolicy, 'newOrders', request);
}

export function guardNativeTopupRequest<T>(request: () => T) {
  return guardCommerceRequest(distributionPolicy, 'nativeTopups', request);
}
