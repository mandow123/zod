export type DistributionChannel = 'direct-cn' | 'google-play' | 'app-store';
export type BuildPlatform = 'android' | 'ios';
export type CommerceCapability = 'newOrders' | 'nativeTopups';
export type CommercePolicy = Readonly<Record<CommerceCapability, boolean>>;

export function createCommercePolicy(input: Readonly<{
  buildPlatform: BuildPlatform;
  distributionChannel: DistributionChannel;
  nativeTopupsEnabled: boolean;
  newOrdersEnabled: boolean;
}>): CommercePolicy {
  const directAndroid = input.buildPlatform === 'android'
    && input.distributionChannel === 'direct-cn';
  return Object.freeze({
    nativeTopups: directAndroid && input.nativeTopupsEnabled,
    newOrders: directAndroid && input.newOrdersEnabled,
  });
}

const capabilityLabels: Readonly<Record<CommerceCapability, string>> = Object.freeze({
  newOrders: '新增购买',
  nativeTopups: '充值',
});

export function assertCommerceCapability(policy: CommercePolicy, capability: CommerceCapability) {
  if (!policy[capability]) throw new Error(`此版本不提供${capabilityLabels[capability]}。`);
}

export function guardCommerceRequest<T>(
  policy: CommercePolicy,
  capability: CommerceCapability,
  request: () => T,
) {
  assertCommerceCapability(policy, capability);
  return request();
}
