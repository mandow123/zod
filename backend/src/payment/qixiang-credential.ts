import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export const QIXIANG_MERCHANT_KEY_CREDENTIAL_NAME = 'qixiang-merchant-key';
export const QIXIANG_CHECKOUT_KEY_CREDENTIAL_NAME = 'qixiang-checkout-key';
export const QIXIANG_GATE_RECEIPT_CREDENTIAL_NAME = 'qixiang-production-gate-receipt';
export const QIXIANG_GATE_PUBLIC_KEY_CREDENTIAL_NAME = 'qixiang-gate-verification-public';

export function qixiangMerchantKeyPath(input: Readonly<{
  credentialDirectory?: string;
  explicitFile?: string;
}>) {
  if (input.explicitFile) {
    if (!isAbsolute(input.explicitFile)) throw new Error('QIXIANG_MERCHANT_KEY_FILE_ABSOLUTE_REQUIRED');
    return input.explicitFile;
  }
  if (!input.credentialDirectory || !isAbsolute(input.credentialDirectory)) {
    throw new Error('QIXIANG_MERCHANT_KEY_CREDENTIAL_DIRECTORY_REQUIRED');
  }
  return join(input.credentialDirectory, QIXIANG_MERCHANT_KEY_CREDENTIAL_NAME);
}

export function qixiangCheckoutKeyPath(input: Readonly<{
  credentialDirectory?: string;
  explicitFile?: string;
}>) {
  if (input.explicitFile) {
    if (!isAbsolute(input.explicitFile)) throw new Error('QIXIANG_CHECKOUT_KEY_FILE_ABSOLUTE_REQUIRED');
    return input.explicitFile;
  }
  if (!input.credentialDirectory || !isAbsolute(input.credentialDirectory)) {
    throw new Error('QIXIANG_CHECKOUT_KEY_CREDENTIAL_DIRECTORY_REQUIRED');
  }
  return join(input.credentialDirectory, QIXIANG_CHECKOUT_KEY_CREDENTIAL_NAME);
}

export function qixiangGateReceiptPath(credentialDirectory: string) {
  return credentialPath(credentialDirectory, QIXIANG_GATE_RECEIPT_CREDENTIAL_NAME);
}

export function qixiangGatePublicKeyPath(credentialDirectory: string) {
  return credentialPath(credentialDirectory, QIXIANG_GATE_PUBLIC_KEY_CREDENTIAL_NAME);
}

export function loadQixiangMerchantKey(path: string) {
  return readCredential(path, (value) => {
    if (value.length < 8 || value.length > 4_095 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error('QIXIANG_MERCHANT_KEY_INVALID');
    }
    return value;
  });
}

export function loadQixiangCheckoutKey(path: string) {
  return readCredential(path, (value) => {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== value) throw new Error('QIXIANG_CHECKOUT_KEY_INVALID');
    return decoded;
  });
}

export function loadQixiangGateReceipt(path: string) {
  return readCredential(path, (value) => {
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024 || !value.startsWith('{')) {
      throw new Error('QIXIANG_GATE_RECEIPT_INVALID');
    }
    return value;
  }, 8, 64 * 1024, true);
}

export function loadQixiangGatePublicKey(path: string) {
  return readCredential(path, (value) => {
    if (!/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----$/u.test(value)) {
      throw new Error('QIXIANG_GATE_PUBLIC_KEY_INVALID');
    }
    return value;
  }, 64, 4_096);
}

function credentialPath(directory: string, name: string) {
  if (!directory || !isAbsolute(directory)) throw new Error('QIXIANG_CREDENTIAL_DIRECTORY_REQUIRED');
  return join(directory, name);
}

export function qixiangPrivateCredentialPermissionsSafe(path: string,
  metadata: Readonly<{mode:number;uid:number;gid:number}>,credentialDirectory=process.env.CREDENTIALS_DIRECTORY) {
  if ((metadata.mode & 0o077) === 0) return true;
  return metadata.uid===0&&metadata.gid===0&&(metadata.mode&0o777)===0o440
    &&typeof credentialDirectory==='string'&&/^\/run\/credentials\/[^/]+$/u.test(credentialDirectory)
    &&dirname(path)===credentialDirectory;
}

function readCredential<T>(path: string, decode: (value: string) => T, minimum = 8, maximum = 4_096,
  publicReadable = false) {
  const linkMetadata = lstatSync(path);
  if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile()) throw new Error('QIXIANG_MERCHANT_KEY_FILE_INVALID');
  if (publicReadable ? (linkMetadata.mode & 0o022) !== 0
    : !qixiangPrivateCredentialPermissionsSafe(path,linkMetadata)) {
    throw new Error('QIXIANG_MERCHANT_KEY_FILE_PERMISSIONS_UNSAFE');
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.dev !== linkMetadata.dev || metadata.ino !== linkMetadata.ino
      || metadata.size < minimum || metadata.size > maximum + 1
      || (publicReadable ? (metadata.mode & 0o022) !== 0
        : !qixiangPrivateCredentialPermissionsSafe(path,metadata))) {
      throw new Error('QIXIANG_MERCHANT_KEY_FILE_CHANGED');
    }
    const raw = readFileSync(descriptor, 'utf8');
    const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    return decode(value);
  } finally {
    closeSync(descriptor);
  }
}
