import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [platform, distributionChannel, ...args] = process.argv.slice(2);
if (!platform || !distributionChannel || args.length === 0) {
  throw new Error('Usage: expo-with-build-policy.mjs <android|ios> <channel> <expo arguments...>');
}
const expoCli = fileURLToPath(new URL('../node_modules/expo/bin/cli', import.meta.url));
const result = spawnSync(process.execPath, [expoCli, ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CLOUDPAY_BUILD_PLATFORM: platform,
    CLOUDPAY_DISTRIBUTION_CHANNEL: distributionChannel,
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
