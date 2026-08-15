import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

export function normalizeMainlandPhone(input: string) {
  const compact = input.replace(/[\s()-]/gu, '');
  const local = compact.replace(/^(?:\+86|0086|86)/u, '');
  if (!/^1[3-9]\d{9}$/u.test(local)) {
    throw new AppError('AUTH_PHONE_INVALID', 400, '请输入有效的中国大陆手机号。');
  }
  return `+86${local}`;
}

export function lookupHash(value: string, pepper: string) {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function secretHash(value: string, pepper: string) {
  return createHmac('sha512', pepper).update(value).digest('hex');
}

export function otpHash(challengeId: string, code: string, pepper: string) {
  return secretHash(`${challengeId}:${code}`, pepper);
}

export function generateOtp() {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function generateOpaqueToken() {
  return randomBytes(48).toString('base64url');
}

export function encryptPii(value: string, base64Key: string) {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('PII encryption key must contain exactly 32 bytes.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptPii(envelope: string, base64Key: string) {
  const [version, ivValue, tagValue, ciphertextValue] = envelope.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || ciphertextValue === undefined) throw new Error('Invalid PII envelope.');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(base64Key, 'base64'), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]).toString('utf8');
}

export function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function maskedPhone(phone: string) {
  return `${phone.slice(0, 5)}****${phone.slice(-4)}`;
}

export function maskedEmail(email: string) {
  const separator = email.lastIndexOf('@');
  if (separator <= 0) return '***';
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}
