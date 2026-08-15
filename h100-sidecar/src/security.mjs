import {
  createCipheriv, createDecipheriv, createHash, createHmac, generateKeyPairSync, randomBytes, timingSafeEqual,
} from 'node:crypto';

export function constantTimeToken(value, candidates) {
  const left = createHash('sha256').update(value || '').digest();
  return candidates.some((candidate) => timingSafeEqual(left, createHash('sha256').update(candidate).digest()));
}
export function ticketFor(secret, leaseId, sessionId) {
  return createHmac('sha256', secret).update(`access-ticket:v1:${leaseId}:${sessionId}`).digest('base64url');
}
export function ticketDigest(ticket, secret) {
  return createHmac('sha256', secret).update(`ticket-digest:v1:${ticket}`).digest('hex');
}
function ticketKey(ticket, secret) { return createHmac('sha256', secret).update(`ticket-key:v1:${ticket}`).digest(); }
export function encryptForTicket(value, ticket, secret) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', ticketKey(ticket, secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
export function decryptForTicket(value, ticket, secret) {
  const [version, iv, tag, body] = value.split('.');
  if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('TICKET_ENVELOPE_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', ticketKey(ticket, secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

function uint32(value) {
  const output = Buffer.allocUnsafe(4); output.writeUInt32BE(value); return output;
}
function sshString(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'); return Buffer.concat([uint32(body.length), body]);
}
function pem(label, value) {
  const encoded = value.toString('base64').match(/.{1,70}/gu)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----\n`;
}

export async function generateSshKeyPair(comment) {
  if (!/^[A-Za-z0-9:_-]{8,160}$/u.test(comment)) throw new Error('SSH_KEY_COMMENT_INVALID');
  const pair = generateKeyPairSync('ed25519');
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const privateJwk = pair.privateKey.export({ format: 'jwk' });
  if (typeof publicJwk.x !== 'string' || typeof privateJwk.d !== 'string') throw new Error('SSH_KEY_EXPORT_INVALID');
  const publicBytes = Buffer.from(publicJwk.x, 'base64url'); const privateSeed = Buffer.from(privateJwk.d, 'base64url');
  if (publicBytes.length !== 32 || privateSeed.length !== 32) throw new Error('SSH_KEY_EXPORT_INVALID');
  const keyType = 'ssh-ed25519'; const publicBlob = Buffer.concat([sshString(keyType), sshString(publicBytes)]);
  const check = randomBytes(4); const privateBody = [check, check, sshString(keyType), sshString(publicBytes),
    sshString(Buffer.concat([privateSeed, publicBytes])), sshString(comment)];
  const unpaddedLength = privateBody.reduce((total, item) => total + item.length, 0);
  const paddingLength = 8 - (unpaddedLength % 8 || 8);
  const padding = Buffer.from(Array.from({ length: paddingLength || 8 }, (_, index) => index + 1));
  const envelope = Buffer.concat([Buffer.from('openssh-key-v1\0'), sshString('none'), sshString('none'), sshString(''),
    uint32(1), sshString(publicBlob), sshString(Buffer.concat([...privateBody, padding]))]);
  return { privateKey: pem('OPENSSH PRIVATE KEY', envelope),
    publicKey: `${keyType} ${publicBlob.toString('base64')} ${comment}` };
}
export function evidenceDigest(secret, payload) {
  return `sha256:${createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')}`;
}
