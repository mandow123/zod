const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if ((moduleName.endsWith('/AuthSheet') || moduleName === './src/AuthSheet')
    && !moduleName.endsWith('/AuthSheet.local-e2e')) {
    const localE2e = Boolean(process.env.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim());
    if (localE2e) {
      return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/AuthSheet.local-e2e.tsx') };
    }
  }
  if (moduleName.endsWith('/account-security') || moduleName === './account-security') {
    const localE2e = Boolean(process.env.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim());
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, localE2e
        ? 'src/account-security.local-e2e.ts'
        : 'src/account-security.ts'),
    };
  }
  if (moduleName.endsWith('/local-e2e-runtime') || moduleName === './local-e2e-runtime') {
    const localE2e = Boolean(process.env.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim());
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, localE2e
        ? 'src/local-e2e-runtime-enabled.ts'
        : 'src/local-e2e-runtime.ts'),
    };
  }
  if (moduleName.endsWith('/local-network-policy') || moduleName.endsWith('/local-network-policy.ts')
    || moduleName === './local-network-policy' || moduleName === './local-network-policy.ts') {
    const localE2e = Boolean(process.env.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim());
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
