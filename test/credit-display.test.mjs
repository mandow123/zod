import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCreditMicros, remainingCreditAmount } from '../src/credit-display.ts';

test('credit input keeps at most six decimal places and must be positive', () => {
  assert.equal(parseCreditMicros('20.27545'), 20_275_450n);
  assert.equal(parseCreditMicros('0'), null);
  assert.equal(parseCreditMicros('1.0000001'), null);
});

test('settlement remainder shows partial, full, and defensive over-refund correctly', () => {
  assert.equal(remainingCreditAmount('62.275450', '20.000000'), '42.275450');
  assert.equal(remainingCreditAmount('62.275450', '62.275450'), '0');
  assert.equal(remainingCreditAmount('62.275450', '70.000000'), '0');
});
