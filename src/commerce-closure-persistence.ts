import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { createCommerceClosurePendingPersistence } from './commerce-closure-persistence-core.ts';

const PENDING_KEY = 'kai.cloudpay.commerce-closure.pending.v1';
const secureOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

export async function commerceClosureSubjectFingerprint(userId: string, subjectId: string) {
  if (!userId || !subjectId || userId.trim() !== userId || subjectId.trim() !== subjectId) {
    throw new Error('COMMERCE_CLOSURE_SUBJECT_REQUIRED');
  }
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `commerce-closure-subject-v1\u0000${userId}\u0000${subjectId}`,
  );
}

export const commerceClosurePendingPersistence = createCommerceClosurePendingPersistence({
  get: () => SecureStore.getItemAsync(PENDING_KEY, secureOptions),
  set: (value) => SecureStore.setItemAsync(PENDING_KEY, value, secureOptions),
  remove: () => SecureStore.deleteItemAsync(PENDING_KEY, secureOptions),
  digest: (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
  randomUuid: () => Crypto.randomUUID(),
  now: () => new Date().toISOString(),
});
