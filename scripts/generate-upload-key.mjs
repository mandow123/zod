import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverJavaHome } from './android-toolchain.mjs';

const root = resolve(import.meta.dirname, '..');
const privateDirectory = join(homedir(), '.cloudpay-release');
const keystorePath = join(privateDirectory, 'cloudpay-upload.jks');
const passwordPath = join(privateDirectory, 'cloudpay-upload.secret');
const certificatePath = join(root, 'docs', 'cloudpay-upload-certificate.pem');
const alias = 'cloudpay-upload';

async function exists(path) {
  try { await readFile(path); return true; } catch { return false; }
}

function tool(name) {
  const javaHome = discoverJavaHome();
  return javaHome ? join(javaHome, 'bin', name) : name;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed.`);
  return result.stdout ?? '';
}

await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
await mkdir(dirname(certificatePath), { recursive: true });
let password;
if (await exists(passwordPath)) password = (await readFile(passwordPath, 'utf8')).trim();
else {
  password = randomBytes(36).toString('base64url');
  await writeFile(passwordPath, `${password}\n`, { mode: 0o600 });
}
if (!(await exists(keystorePath))) {
  run(tool('keytool'), [
    '-genkeypair', '-v', '-storetype', 'PKCS12', '-keystore', keystorePath,
    '-storepass', password, '-keypass', password, '-alias', alias,
    '-keyalg', 'RSA', '-keysize', '4096', '-sigalg', 'SHA256withRSA', '-validity', '10000',
    '-dname', 'CN=KAI CloudPay Upload, OU=Mobile Release, O=KAI CloudPay, C=CN',
  ]);
}
run(tool('keytool'), [
  '-exportcert', '-rfc', '-keystore', keystorePath, '-storepass', password,
  '-alias', alias, '-file', certificatePath,
]);
const listing = run(tool('keytool'), [
  '-list', '-v', '-keystore', keystorePath, '-storepass', password, '-alias', alias,
], { capture: true });
const sha = /SHA256:\s*([^\n\r]+)/u.exec(listing)?.[1]?.trim();
process.stdout.write(`CloudPay upload key ready.\nKeystore: ${keystorePath}\nCertificate: ${certificatePath}\nSHA-256: ${sha ?? 'unavailable'}\n`);
