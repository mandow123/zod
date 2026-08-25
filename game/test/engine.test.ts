import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceBotTurn, bid, createGame, forfeit, pass, play } from '../core/engine.ts';
import { createDeck } from '../core/cards.ts';
import { GameRuleError } from '../core/types.ts';
import { createHash } from 'node:crypto';

test('deals unique cards and assigns the winning bidder as landlord', () => {
  const game = createGame({ humanId: 'human', humanName: '测试玩家', baseStake: 50, deck: createDeck() });
  assert.equal(Object.values(game.hands).flat().length + game.bottomCards.length, 54);
  bid(game, 'human', 3);
  assert.equal(game.phase, 'playing');
  assert.equal(game.landlordSeat, 0);
  assert.equal(game.hands.human.length, 20);
  assert.equal(game.players[0]?.role, 'landlord');
});

test('enforces ownership, valid combinations and turn order', () => {
  const game = createGame({ humanId: 'human', humanName: '测试玩家', baseStake: 50, deck: createDeck() });
  bid(game, 'human', 3);
  assert.throws(() => play(game, 'human', ['missing']), (error) => error instanceof GameRuleError && error.code === 'CARD_NOT_OWNED');
  const first = game.hands.human[0]!;
  play(game, 'human', [first.id]);
  assert.throws(() => play(game, 'human', [game.hands.human[0]!.id]), (error) => error instanceof GameRuleError && error.code === 'NOT_YOUR_TURN');
});

test('two passes return initiative to the last player', () => {
  const game = createGame({ humanId: 'human', humanName: '测试玩家', baseStake: 50, deck: createDeck() });
  bid(game, 'human', 3);
  play(game, 'human', [game.hands.human[0]!.id]);
  pass(game, game.players[1]!.id);
  pass(game, game.players[2]!.id);
  assert.equal(game.currentSeat, 0);
  assert.equal(game.leadCombination, null);
});

test('settlement is zero-sum and cannot leave the winner ambiguous', () => {
  const game = createGame({ humanId: 'human', humanName: '测试玩家', baseStake: 50, deck: createDeck() });
  bid(game, 'human', 3);
  game.hands.human = [game.hands.human[0]!];
  play(game, 'human', [game.hands.human[0]!.id]);
  assert.equal(game.phase, 'finished');
  assert.equal(game.settlement?.winner, 'landlord');
  assert.equal(Object.values(game.settlement!.deltas).reduce((sum, value) => sum + value, 0), 0);
  const digest = createHash('sha256').update(`${game.fairness.nonce}:${game.fairness.deckOrder.join(',')}`).digest('hex');
  assert.equal(digest, game.fairness.commitment);
});

test('a bot advances exactly one visible turn at a time', () => {
  const game = createGame({ humanId: 'human', humanName: '测试玩家', baseStake: 50, deck: createDeck() });
  bid(game, 'human', 3);
  play(game, 'human', [game.hands.human[0]!.id]);
  const beforeSequence = game.sequence;
  const beforeEvents = game.events.length;
  assert.equal(game.players[game.currentSeat]!.isBot, true);
  assert.equal(advanceBotTurn(game), true);
  assert.equal(game.sequence, beforeSequence + 1);
  assert.equal(game.events.length, beforeEvents + 1);
});

test('forfeiting finishes the game as a loss with a zero-sum settlement', () => {
  const game = createGame({ humanId: 'human', humanName: '测试玩家', baseStake: 50, deck: createDeck() });
  forfeit(game, 'human');
  assert.equal(game.phase, 'finished');
  assert.equal(game.players[0]!.role, 'landlord');
  assert.equal(game.settlement?.winner, 'farmers');
  assert.ok(game.settlement!.deltas.human! < 0);
  assert.equal(Object.values(game.settlement!.deltas).reduce((sum, value) => sum + value, 0), 0);
});
