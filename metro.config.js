const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const defaultResolveRequest = config.resolver.resolveRequest;
const isolatedDemo = process.env.CLOUDPAY_STAGING_DEMO?.trim() === '1';
const localE2e = Boolean(process.env.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim()) || isolatedDemo;
const localQixiangPreviewValue = process.env.CLOUDPAY_LOCAL_QIXIANG_PREVIEW?.trim();
if (localQixiangPreviewValue && !['0', '1'].includes(localQixiangPreviewValue)) {
  throw new Error('CLOUDPAY_LOCAL_QIXIANG_PREVIEW must be 0 or 1.');
}
const localQixiangPreview = localQixiangPreviewValue === '1';
if (localQixiangPreview && !isolatedDemo) {
  throw new Error('The local Qixiang preview requires CLOUDPAY_STAGING_DEMO=1.');
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if ((moduleName.endsWith('/LocalQixiangPreviewShell') || moduleName === './src/LocalQixiangPreviewShell')
    && !moduleName.endsWith('/LocalQixiangPreviewShell.local-preview')) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, localQixiangPreview
        ? 'src/LocalQixiangPreviewShell.local-preview.tsx'
        : 'src/LocalQixiangPreviewShell.tsx'),
    };
  }
  if ((moduleName.endsWith('/AuthSheet') || moduleName === './src/AuthSheet')
    && !moduleName.endsWith('/AuthSheet.local-e2e')) {
    if (localE2e) {
      return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/AuthSheet.local-e2e.tsx') };
    }
  }
  if (moduleName.endsWith('/kai-auth') || moduleName === './src/kai-auth') {
    if (localE2e) {
      return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/kai-auth.local-e2e.ts') };
    }
  }
  if ((moduleName.endsWith('/session') || moduleName === './src/session')
    && !moduleName.endsWith('/session.local-e2e')) {
    if (localE2e) {
      return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/session.local-e2e.ts') };
    }
  }
  if ((moduleName.endsWith('/api-client') || moduleName === './src/api-client')
    && !moduleName.endsWith('/api-client.local-e2e')) {
    if (localE2e) {
      return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/api-client.local-e2e.ts') };
    }
  }
  if ((moduleName.endsWith('/session-logout') || moduleName === './src/session-logout')
    && !moduleName.endsWith('/session-logout.local-e2e')) {
    if (localE2e) {
      return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/session-logout.local-e2e.ts') };
    }
  }
  if ((moduleName.endsWith('/StagingProfileToolsSlot') || moduleName === './src/StagingProfileToolsSlot')
    && !moduleName.endsWith('/StagingProfileToolsSlot.staging')) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, isolatedDemo
        ? 'src/StagingProfileToolsSlot.staging.tsx'
        : 'src/StagingProfileToolsSlot.tsx'),
    };
  }
  if ((moduleName.endsWith('/StagingEnvironmentBanner') || moduleName === './src/StagingEnvironmentBanner')
    && !moduleName.endsWith('/StagingEnvironmentBanner.staging')) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, isolatedDemo
        ? 'src/StagingEnvironmentBanner.staging.tsx'
        : 'src/StagingEnvironmentBanner.tsx'),
    };
  }
  if ((moduleName.endsWith('/StagingManualDeliverySlot') || moduleName === './src/StagingManualDeliverySlot')
    && !moduleName.endsWith('/StagingManualDeliverySlot.staging')) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, isolatedDemo
        ? 'src/StagingManualDeliverySlot.staging.tsx'
        : 'src/StagingManualDeliverySlot.tsx'),
    };
  }
  if ((moduleName.endsWith('/StagingOrderActionsSlot') || moduleName === './src/StagingOrderActionsSlot')
    && !moduleName.endsWith('/StagingOrderActionsSlot.staging')) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, isolatedDemo
        ? 'src/StagingOrderActionsSlot.staging.tsx'
        : 'src/StagingOrderActionsSlot.tsx'),
    };
  }
  if ((moduleName.endsWith('/StagingOrdersSlot') || moduleName === './src/StagingOrdersSlot')
    && !moduleName.endsWith('/StagingOrdersSlot.staging')) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, isolatedDemo
        ? 'src/StagingOrdersSlot.staging.tsx'
        : 'src/StagingOrdersSlot.tsx'),
    };
  }
  if ((moduleName.endsWith('/MarketCommerceSource') || moduleName === './src/MarketCommerceSource')
    && !moduleName.endsWith('/MarketCommerceSource.staging')) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, isolatedDemo
        ? 'src/MarketCommerceSource.staging.ts'
        : 'src/MarketCommerceSource.ts'),
    };
  }
  if ((moduleName.endsWith('/QuicklinePaymentSource') || moduleName === './src/QuicklinePaymentSource')
    && !moduleName.endsWith('/QuicklinePaymentSource.staging')) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, isolatedDemo
        ? 'src/QuicklinePaymentSource.staging.ts'
        : 'src/QuicklinePaymentSource.ts'),
    };
  }
  if (moduleName.endsWith('/account-security') || moduleName === './account-security') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, localE2e
        ? 'src/account-security.local-e2e.ts'
        : 'src/account-security.ts'),
    };
  }
  if (moduleName.endsWith('/local-e2e-runtime') || moduleName === './local-e2e-runtime') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, localE2e
        ? 'src/local-e2e-runtime-enabled.ts'
        : 'src/local-e2e-runtime.ts'),
    };
  }
  if (moduleName.endsWith('/local-network-policy') || moduleName.endsWith('/local-network-policy.ts')
    || moduleName === './local-network-policy' || moduleName === './local-network-policy.ts') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, localE2e
        ? 'src/local-network-policy.local-e2e.ts'
        : 'src/local-network-policy.ts'),
    };
  }
  if (moduleName.endsWith('/native-payments') || moduleName === './native-payments') {
    const channel = process.env.CLOUDPAY_DISTRIBUTION_CHANNEL?.trim() || 'direct-cn';
    if (channel !== 'direct-cn') {
      return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/native-payments-disabled.ts') };
    }
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
