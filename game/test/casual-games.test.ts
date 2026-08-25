import assert from 'node:assert/strict';
import test from 'node:test';
import { compareThreeCard, createMahjongWall, evaluateThreeCard, isWinningMahjong, spinSlots } from '../web/casual-games.js';

const card = (rank: number, suit = 'spade') => ({ id: `${suit}-${rank}`, rank, suit });
const tile = (suit: string, rank: number, suffix: string) => ({ id: `${suit}-${rank}-${suffix}`, key: `${suit}${rank}`, suit, rank, label: suit === '字' ? suffix : `${rank}${suit}` });

test('three-card evaluator ranks 豹子 above 顺金 above 对子', () => {
  assert.equal(evaluateThreeCard([card(9), card(9, 'heart'), card(9, 'club')]).label, '豹子');
  assert.equal(evaluateThreeCard([card(7), card(8), card(9)]).label, '顺金');
  assert.equal(compareThreeCard([card(9), card(9, 'heart'), card(2)], [card(14), card(13, 'heart'), card(10, 'club')]), 1);
});

test('mahjong wall contains 136 unique physical tiles', () => {
  const wall = createMahjongWall();
  assert.equal(wall.length, 136);
  assert.equal(new Set(wall.map((entry) => entry.id)).size, 136);
});

test('mahjong win detector accepts four melds and one pair', () => {
  const hand = [
    tile('万', 1, 'a'), tile('万', 2, 'a'), tile('万', 3, 'a'),
    tile('万', 4, 'a'), tile('万', 5, 'a'), tile('万', 6, 'a'),
    tile('筒', 2, 'a'), tile('筒', 3, 'a'), tile('筒', 4, 'a'),
    tile('条', 7, 'a'), tile('条', 7, 'b'), tile('条', 7, 'c'),
    tile('字', 1, '东'), tile('字', 1, '东2'),
  ];
  assert.equal(isWinningMahjong(hand), true);
  assert.equal(isWinningMahjong(hand.slice(0, 13)), false);
});

test('slot result is deterministic with an injected random source', () => {
  assert.deepEqual(spinSlots(() => 0), { reels: ['7', '7', '7'], result: { tier: 'jackpot', label: '三连共振' } });
});
