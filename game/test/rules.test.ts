import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCombination, canBeat } from '../core/rules.ts';
import type { Card } from '../core/types.ts';

function cards(...ranks: number[]): Card[] {
  return ranks.map((rank, index) => ({ id: `${rank}-${index}`, rank, suit: rank >= 16 ? 'joker' : 'spade' }));
}

test('recognizes the principal Dou Dizhu combinations', () => {
  assert.equal(analyzeCombination(cards(3))?.type, 'single');
  assert.equal(analyzeCombination(cards(4, 4))?.type, 'pair');
  assert.equal(analyzeCombination(cards(5, 5, 5, 9))?.type, 'triple_single');
  assert.equal(analyzeCombination(cards(6, 6, 6, 10, 10))?.type, 'triple_pair');
  assert.deepEqual(analyzeCombination(cards(3, 4, 5, 6, 7)), { type: 'straight', mainRank: 7, cardCount: 5, chainLength: 5 });
  assert.equal(analyzeCombination(cards(3, 3, 4, 4, 5, 5))?.type, 'pair_straight');
  assert.equal(analyzeCombination(cards(3, 3, 3, 4, 4, 4))?.type, 'airplane');
  assert.equal(analyzeCombination(cards(3, 3, 3, 4, 4, 4, 8, 9))?.type, 'airplane_single');
  assert.equal(analyzeCombination(cards(3, 3, 3, 3))?.type, 'bomb');
  assert.equal(analyzeCombination(cards(16, 17))?.type, 'rocket');
});

test('rejects invalid combinations and ranks 2 in a straight', () => {
  assert.equal(analyzeCombination(cards(3, 4)), null);
  assert.equal(analyzeCombination(cards(11, 12, 13, 14, 15)), null);
  assert.equal(analyzeCombination([]), null);
});

test('compares like combinations and bomb precedence', () => {
  const pair6 = analyzeCombination(cards(6, 6))!;
  const pair7 = analyzeCombination(cards(7, 7))!;
  const bomb3 = analyzeCombination(cards(3, 3, 3, 3))!;
  const rocket = analyzeCombination(cards(16, 17))!;
  assert.equal(canBeat(pair7, pair6), true);
  assert.equal(canBeat(pair6, pair7), false);
  assert.equal(canBeat(bomb3, pair7), true);
  assert.equal(canBeat(rocket, bomb3), true);
  assert.equal(canBeat(bomb3, rocket), false);
});
