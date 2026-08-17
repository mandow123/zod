import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCreditMicros, remainingCreditAmount } from '../src/credit-display.ts';

test('credit input accepts at most two decimal places and must be positive', () => {
  assert.equal(parseCreditMicros('20.27'), 20_270_000n);
  assert.equal(parseCreditMicros('0'), null);
  assert.equal(parseCreditMicros('1.001'), null);
});

test('settlement remainder shows partial, full, and defensive over-refund correctly', () => {
  assert.equal(remainingCreditAmount('62.28', '20.00'), '42.28');
  assert.equal(remainingCreditAmount('62.28', '62.28'), '0');
  assert.equal(remainingCreditAmount('62.28', '70.00'), '0');
});
