export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();

  consume(key: string, limit: number, windowMs: number, at = Date.now()) {
    const existing = this.buckets.get(key);
    const bucket = !existing || at - existing.startedAt >= windowMs
      ? { startedAt: at, count: 0 }
      : existing;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10_000) {
      for (const [bucketKey, value] of this.buckets) {
        if (at - value.startedAt >= windowMs) this.buckets.delete(bucketKey);
      }
    }
    return bucket.count <= limit
      ? { allowed: true as const, retryAfterSeconds: 0 }
      : { allowed: false as const, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (at - bucket.startedAt)) / 1_000)) };
  }
}
