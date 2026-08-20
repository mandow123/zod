import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class KaiCloudWebhookVerifier {
  constructor(private readonly secret: string, private readonly toleranceSeconds = 300,
    private readonly now: () => number = Date.now) {}

  verify(input: Readonly<{ deliveryId: string | undefined; timestamp: string | undefined;
    signature: string | undefined; rawBody: string }>) {
    if (!input.deliveryId || !/^[A-Za-z0-9._:-]{8,160}$/u.test(input.deliveryId)
      || !input.timestamp || !/^\d{10}$/u.test(input.timestamp)
      || !input.signature || !/^sha256=[a-f0-9]{64}$/u.test(input.signature)) return null;
    const seconds = Number(input.timestamp);
    if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(this.now() / 1_000) - seconds) > this.toleranceSeconds) return null;
    const expected = `sha256=${createHmac('sha256', this.secret).update(`${input.timestamp}.${input.rawBody}`).digest('hex')}`;
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature))) return null;
    return { deliveryId: input.deliveryId,
      payloadDigest: `sha256:${createHash('sha256').update(input.rawBody).digest('hex')}` };
  }
}
