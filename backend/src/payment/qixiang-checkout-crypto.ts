import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { controlledQixiangCheckoutUrl } from './qixiang-provider.js';

export type QixiangCheckoutCiphertext = Readonly<{
  cipherVersion: 1;
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}>;

function aad(topupId: string, providerReference: string, keyId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(topupId)) {
    throw new Error('QIXIANG_CHECKOUT_TOPUP_ID_INVALID');
  }
  if (!/^[A-Z0-9]{20,48}$/u.test(providerReference)) throw new Error('QIXIANG_PROVIDER_REFERENCE_INVALID');
  if (!/^[a-z0-9][a-z0-9._-]{7,63}$/u.test(keyId)) throw new Error('QIXIANG_CHECKOUT_KEY_ID_INVALID');
  return Buffer.from(`qixiang|${topupId}|${providerReference}|${keyId}|1`, 'utf8');
}

export function encryptQixiangCheckout(
  checkoutUrl: string,
  context: Readonly<{ topupId: string; providerReference: string; keyId: string }>,
  key: Buffer,
): QixiangCheckoutCiphertext {
  if (key.length !== 32) throw new Error('QIXIANG_CHECKOUT_KEY_INVALID');
  const plaintext = Buffer.from(controlledQixiangCheckoutUrl(checkoutUrl), 'utf8');
  if (plaintext.length < 16 || plaintext.length > 8_192) throw new Error('QIXIANG_CHECKOUT_PLAINTEXT_INVALID');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(context.topupId, context.providerReference, context.keyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { cipherVersion: 1, keyId: context.keyId, nonce, ciphertext, authTag: cipher.getAuthTag() };
}

export function decryptQixiangCheckout(
  encrypted: QixiangCheckoutCiphertext,
  context: Readonly<{ topupId: string; providerReference: string }>,
  key: Buffer,
) {
  if (key.length !== 32 || encrypted.cipherVersion !== 1 || encrypted.nonce.length !== 12
    || encrypted.authTag.length !== 16 || encrypted.ciphertext.length < 16 || encrypted.ciphertext.length > 8_192) {
    throw new Error('QIXIANG_CHECKOUT_CIPHERTEXT_INVALID');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.nonce);
  decipher.setAAD(aad(context.topupId, context.providerReference, encrypted.keyId));
  decipher.setAuthTag(encrypted.authTag);
  const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8');
  return controlledQixiangCheckoutUrl(plaintext);
}
