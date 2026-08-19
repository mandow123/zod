import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateIosReleaseConfig } from './ios-release-preflight-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.CLOUDPAY_BUILD_PLATFORM = 'ios';
process.env.CLOUDPAY_DISTRIBUTION_CHANNEL = 'app-store';
process.env.CLOUDPAY_PUSH_NOTIFICATIONS_ENABLED = '1';
process.env.CLOUDPAY_IOS_UNIVERSAL_AUTH_ENABLED = '0';
const require = createRequire(import.meta.url);
const config = require(join(root, 'app.config.js')).expo;
const issues = validateIosReleaseConfig(config);

async function inspectPng(relativePath, expectedWidth, expectedHeight, requireOpaque) {
  try {
    const bytes = await readFile(join(root, relativePath.replace(/^\.\//u, '')));
    if (bytes.length < 26 || bytes.toString('ascii', 1, 4) !== 'PNG') return `${relativePath} is not a PNG.`;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const colorType = bytes[25];
    if (width !== expectedWidth || height !== expectedHeight) return `${relativePath} must be ${expectedWidth}x${expectedHeight}.`;
    if (requireOpaque && [4, 6].includes(colorType)) return `${relativePath} must not contain an alpha channel.`;
    return null;
  } catch {
    return `${relativePath} is missing.`;
  }
}

const splashPlugin = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen');
const [iconIssue, splashIssue, accountSecurity] = await Promise.all([
  inspectPng(config.icon, 1024, 1024, true),
  inspectPng(splashPlugin?.[1]?.image ?? '', 512, 512, false),
  readFile(join(root, 'src/AccountSecuritySheet.tsx'), 'utf8').catch(() => ''),
]);
if (iconIssue) issues.push(iconIssue);
if (splashIssue) issues.push(splashIssue);
if (!accountSecurity.includes('requestAccountDeletion') || !accountSecurity.includes('申请注销 Zod 账户')) {
  issues.push('the in-app account deletion entry is missing.');
}

if (issues.length > 0) {
  process.stderr.write(`iOS release preflight failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('iOS release preflight passed.\n');
