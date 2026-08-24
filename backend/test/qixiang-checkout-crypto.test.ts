import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptQixiangCheckout, encryptQixiangCheckout } from '../src/payment/qixiang-checkout-crypto.js';

const key = Buffer.alloc(32, 9);
const context = { topupId: '10000000-0000-4000-8000-000000000001',
  providerReference: 'KCT20260821123456789012', keyId: 'qixiang-checkout-2026a' };
const checkout = 'https://api.payqixiang.cn/pay/submit/opaque_1/';

describe('Qixiang checkout envelope encryption', () => {
  it('round-trips AES-256-GCM using the exact contextual AAD without storing plaintext', () => {
    const encrypted = encryptQixiangCheckout(checkout, context, key);
    expect(encrypted).toMatchObject({ cipherVersion: 1, keyId: context.keyId });
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('payqixiang');
    expect(decryptQixiangCheckout(encrypted, context, key)).toBe(checkout);
  });

  it('fails authentication if the topup, provider reference, key id, key, tag or nonce changes', () => {
    const encrypted = encryptQixiangCheckout(checkout, context, key);
    const attempts = [
      () => decryptQixiangCheckout(encrypted, { ...context, topupId: '20000000-0000-4000-8000-000000000002' }, key),
      () => decryptQixiangCheckout(encrypted, { ...context, providerReference: 'KCT20260821999999999999' }, key),
      () => decryptQixiangCheckout({ ...encrypted, keyId: 'qixiang-checkout-2026b' }, context, key),
      () => decryptQixiangCheckout(encrypted, context, Buffer.alloc(32, 8)),
      () => decryptQixiangCheckout({ ...encrypted, authTag: Buffer.alloc(16) }, context, key),
      () => decryptQixiangCheckout({ ...encrypted, nonce: Buffer.alloc(12) }, context, key),
    ];
    for (const attempt of attempts) expect(attempt).toThrow();
  });

  it('uses the official checkout URL validator on encryption and authenticated decryption', () => {
    expect(() => encryptQixiangCheckout('https://api.payqixiang.cn/cashier/one', context, key))
      .toThrow(expect.objectContaining({ code: 'QIXIANG_CHECKOUT_URL_INVALID' }));
    expect(decryptQixiangCheckout(encryptQixiangCheckout(checkout, context, key), context, key)).toBe(checkout);
    const nonce = Buffer.alloc(12, 4);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`qixiang|${context.topupId}|${context.providerReference}|${context.keyId}|1`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update('https://api.payqixiang.cn/cashier/one'), cipher.final()]);
    expect(() => decryptQixiangCheckout({
      cipherVersion: 1, keyId: context.keyId, nonce, ciphertext, authTag: cipher.getAuthTag(),
    }, context, key)).toThrow(expect.objectContaining({ code: 'QIXIANG_CHECKOUT_URL_INVALID' }));
  });

  it.each(['Qixiang-Key-1', ':bad-key1', '.bad-key1', '-bad-key1'])(
    'rejects a non-canonical checkout key identifier: %s', (keyId) => {
      expect(() => encryptQixiangCheckout(checkout, { ...context, keyId }, key))
        .toThrow(/QIXIANG_CHECKOUT_KEY_ID_INVALID/u);
    },
  );

  it('accepts a canonical lowercase checkout key identifier', () => {
    expect(encryptQixiangCheckout(checkout, { ...context, keyId: 'qixiang.key_2026-a' }, key).keyId)
      .toBe('qixiang.key_2026-a');
  });
});
