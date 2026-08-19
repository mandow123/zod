import assert from 'node:assert/strict';
import test from 'node:test';
import { SlidingWindowLimiter } from '../server/src/security.ts';

test('rate limiter enforces a bounded window and resets deterministically', () => {
  const limiter = new SlidingWindowLimiter();
  assert.equal(limiter.consume('device', 2, 1_000, 100).allowed, true);
  assert.equal(limiter.consume('device', 2, 1_000, 200).allowed, true);
  const rejected = limiter.consume('device', 2, 1_000, 300);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterSeconds, 1);
  assert.equal(limiter.consume('device', 2, 1_000, 1_100).allowed, true);
});
