import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const STAGING_PRINCIPAL_KEY = 'kai.zod.staging.principal.v1';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

function validToken(value: string) {
  return /^[A-Za-z0-9._~-]{43,200}$/u.test(value);
}

export async function loadStagingPrincipalToken() {
  const value = await SecureStore.getItemAsync(STAGING_PRINCIPAL_KEY, options);
  return value && validToken(value) ? value : null;
}

export async function loadStagingPrincipalFingerprint() {
  const token = await loadStagingPrincipalToken();
  if (!token) throw new Error('请先连接隔离的测试账号。');
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, token);
}

export async function saveStagingPrincipalToken(value: string) {
  const token = value.trim();
  if (!validToken(token)) throw new Error('测试账号凭证格式不正确。');
  await SecureStore.setItemAsync(STAGING_PRINCIPAL_KEY, token, options);
}

export async function clearStagingPrincipalToken() {
  await SecureStore.deleteItemAsync(STAGING_PRINCIPAL_KEY, options);
}
