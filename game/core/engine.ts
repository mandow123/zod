import { randomBytes, randomUUID } from 'node:crypto';
import { chooseBotBid, chooseBotPlay, evaluateHand } from './bot.ts';
import { createDeck, dealCards, secureShuffle, sortCards } from './cards.ts';
import { deckCommitment } from './fairness.ts';
import { analyzeCombination, canBeat } from './rules.ts';
import { GameRuleError } from './types.ts';
import type { BidEvent, Card, GamePlayer, GameState, PlayEvent, Settlement } from './types.ts';

const now = () => new Date().toISOString();
const nextSeat = (seat: number) => (seat + 1) % 3;

export function createGame(input: Readonly<{
  humanId: string;
  humanName: string;
  baseStake: number;
  deck?: readonly Card[];
  players?: readonly Readonly<{ id: string; name: string; isBot: boolean }>[];
}>): GameState {
  const deck = input.deck ? [...input.deck] : secureShuffle(createDeck());
  const dealt = dealCards(deck);
  const nonce = randomBytes(16).toString('hex');
  const commitment = deckCommitment(nonce, deck.map((card) => card.id));
  const players: GamePlayer[] = (input.players ?? [
    { id: input.humanId, name: input.humanName, isBot: false },
    { id: `bot:${randomUUID()}`, name: '阿满', isBot: true },
    { id: `bot:${randomUUID()}`, name: '小禾', isBot: true },
  ]).map((player) => ({ ...player, role: null }));
  if (players.length !== 3 || new Set(players.map((player) => player.id)).size !== 3) {
    throw new Error('THREE_UNIQUE_PLAYERS_REQUIRED');
  }
  const timestamp = now();
  return {
    id: randomUUID(), phase: 'bidding', players,
    hands: Object.fromEntries(players.map((player, index) => [player.id, dealt.hands[index]!])),
    bottomCards: dealt.bottomCards, currentSeat: 0, bids: [], highestBid: 0,
    highestBidSeat: null, landlordSeat: null, lastPlaySeat: null,
    leadCombination: null, leadCardIds: [], consecutivePasses: 0, bombs: 0,
    baseStake: Math.max(1, Math.floor(input.baseStake)), sequence: 0, events: [],
    settlement: null,
    fairness: { algorithm: 'sha256', commitment, nonce, deckOrder: deck.map((card) => card.id) },
    createdAt: timestamp, updatedAt: timestamp,
  };
}

function assertTurn(state: GameState, playerId: string) {
  const player = state.players[state.currentSeat];
  if (!player || player.id !== playerId) throw new GameRuleError('NOT_YOUR_TURN', '还没轮到你。');
}

function finalizeBidding(state: GameState) {
  let landlordSeat = state.highestBidSeat;
  if (landlordSeat === null) {
    landlordSeat = state.players
      .map((player, seat) => ({ seat, strength: evaluateHand(state.hands[player.id]!) }))
      .sort((a, b) => b.strength - a.strength || a.seat - b.seat)[0]!.seat;
    state.highestBid = 1;
    state.highestBidSeat = landlordSeat;
  }
  state.landlordSeat = landlordSeat;
  state.players = state.players.map((player, seat) => ({
    ...player,
    role: seat === landlordSeat ? 'landlord' : 'farmer',
  }));
  const landlord = state.players[landlordSeat]!;
  state.hands[landlord.id] = sortCards([...state.hands[landlord.id]!, ...state.bottomCards]);
  state.phase = 'playing';
  state.currentSeat = landlordSeat;
  state.updatedAt = now();
}

export function bid(state: GameState, playerId: string, score: 0 | 1 | 2 | 3) {
  if (state.phase !== 'bidding') throw new GameRuleError('BIDDING_CLOSED', '叫分已经结束。');
  assertTurn(state, playerId);
  if (![0, 1, 2, 3].includes(score)) throw new GameRuleError('INVALID_BID', '叫分必须是 0 到 3 分。');
  if (score > 0 && score <= state.highestBid) throw new GameRuleError('BID_TOO_LOW', '叫分必须高于当前分数。');
  const event: BidEvent = { seat: state.currentSeat, score };
  state.bids.push(event);
  state.sequence += 1;
  if (score > state.highestBid) {
    state.highestBid = score;
    state.highestBidSeat = state.currentSeat;
  }
  if (score === 3 || state.bids.length === 3) finalizeBidding(state);
  else state.currentSeat = nextSeat(state.currentSeat);
  state.updatedAt = now();
  return state;
}

function selectedCards(state: GameState, playerId: string, cardIds: readonly string[]) {
  if (cardIds.length === 0 || new Set(cardIds).size !== cardIds.length) {
    throw new GameRuleError('INVALID_SELECTION', '请选择至少一张且不能重复选择。');
  }
  const hand = state.hands[playerId] ?? [];
  const selected = cardIds.map((id) => hand.find((card) => card.id === id));
  if (selected.some((card) => !card)) throw new GameRuleError('CARD_NOT_OWNED', '所选牌不在你的手牌中。');
  return selected as Card[];
}

function appendEvent(state: GameState, event: Omit<PlayEvent, 'sequence'>) {
  state.sequence += 1;
  state.events.push({ ...event, sequence: state.sequence });
}

function settle(state: GameState, winnerSeat: number) {
  const landlordSeat = state.landlordSeat!;
  const landlordWon = winnerSeat === landlordSeat;
  const playCounts = state.players.map((_, seat) => state.events.filter((event) => event.seat === seat && event.kind === 'play').length);
  const spring = landlordWon
    ? playCounts.every((count, seat) => seat === landlordSeat || count === 0)
    : playCounts[landlordSeat] === 1;
  const rawMultiplier = Math.max(1, state.highestBid) * (2 ** state.bombs) * (spring ? 2 : 1);
  const multiplier = Math.min(rawMultiplier, 64);
  const unit = state.baseStake * multiplier;
  const deltas: Record<string, number> = {};
  for (const [seat, player] of state.players.entries()) {
    const isLandlord = seat === landlordSeat;
    deltas[player.id] = landlordWon
      ? (isLandlord ? unit * 2 : -unit)
      : (isLandlord ? -unit * 2 : unit);
  }
  const settlement: Settlement = {
    winner: landlordWon ? 'landlord' : 'farmers', multiplier, deltas,
  };
  state.phase = 'finished';
  state.settlement = settlement;
  state.updatedAt = now();
}

export function forfeit(state: GameState, playerId: string) {
  if (state.phase === 'finished') return state;
  const forfeitingSeat = state.players.findIndex((player) => player.id === playerId);
  if (forfeitingSeat < 0) throw new GameRuleError('PLAYER_NOT_IN_GAME', '你不在这局牌中。');
  if (state.phase === 'bidding') {
    state.landlordSeat = forfeitingSeat;
    state.highestBid = Math.max(1, state.highestBid) as 1 | 2 | 3;
    state.highestBidSeat = forfeitingSeat;
    state.players = state.players.map((player, seat) => ({
      ...player,
      role: seat === forfeitingSeat ? 'landlord' : 'farmer',
    }));
  }
  const winnerSeat = forfeitingSeat === state.landlordSeat
    ? nextSeat(forfeitingSeat)
    : state.landlordSeat!;
  state.sequence += 1;
  settle(state, winnerSeat);
  return state;
}

export function play(state: GameState, playerId: string, cardIds: readonly string[]) {
  if (state.phase !== 'playing') throw new GameRuleError('PLAYING_CLOSED', '当前不能出牌。');
  assertTurn(state, playerId);
  const cards = selectedCards(state, playerId, cardIds);
  const combination = analyzeCombination(cards);
  if (!combination) throw new GameRuleError('INVALID_COMBINATION', '这些牌不能组成有效牌型。');
  if (!canBeat(combination, state.leadCombination)) throw new GameRuleError('DOES_NOT_BEAT', '所选牌压不过当前牌型。');

  const selectedIds = new Set(cardIds);
  state.hands[playerId] = state.hands[playerId]!.filter((card) => !selectedIds.has(card.id));
  state.leadCombination = combination;
  state.leadCardIds = [...cardIds];
  state.lastPlaySeat = state.currentSeat;
  state.consecutivePasses = 0;
  if (combination.type === 'bomb' || combination.type === 'rocket') state.bombs += 1;
  appendEvent(state, { seat: state.currentSeat, kind: 'play', cardIds: [...cardIds], combination });
  if (state.hands[playerId]!.length === 0) settle(state, state.currentSeat);
  else state.currentSeat = nextSeat(state.currentSeat);
  state.updatedAt = now();
  return state;
}

export function pass(state: GameState, playerId: string) {
  if (state.phase !== 'playing') throw new GameRuleError('PLAYING_CLOSED', '当前不能过牌。');
  assertTurn(state, playerId);
  if (!state.leadCombination || state.lastPlaySeat === state.currentSeat) {
    throw new GameRuleError('CANNOT_PASS', '你是本轮首家，必须出牌。');
  }
  appendEvent(state, { seat: state.currentSeat, kind: 'pass', cardIds: [], combination: null });
  state.consecutivePasses += 1;
  if (state.consecutivePasses >= 2) {
    state.currentSeat = state.lastPlaySeat!;
    state.leadCombination = null;
    state.leadCardIds = [];
    state.consecutivePasses = 0;
  } else state.currentSeat = nextSeat(state.currentSeat);
  state.updatedAt = now();
  return state;
}

export function advanceBotTurn(state: GameState) {
  if (state.phase === 'finished' || !state.players[state.currentSeat]!.isBot) return false;
  const bot = state.players[state.currentSeat]!;
  if (state.phase === 'bidding') bid(state, bot.id, chooseBotBid(state.hands[bot.id]!, state.highestBid));
  else {
    const cards = chooseBotPlay(state.hands[bot.id]!, state.leadCombination);
    if (cards) play(state, bot.id, cards.map((card) => card.id));
    else pass(state, bot.id);
  }
  return true;
}

export function advanceBots(state: GameState) {
  let safety = 0;
  while (state.phase !== 'finished' && state.players[state.currentSeat]!.isBot) {
    if (safety++ > 200) throw new Error('BOT_TURN_SAFETY_LIMIT');
    advanceBotTurn(state);
  }
  return state;
}

export function advanceTimedOutPlayer(state: GameState, at = Date.now(), timeoutMs = 45_000) {
  if (state.phase === 'finished' || at - Date.parse(state.updatedAt) < timeoutMs) return false;
  const player = state.players[state.currentSeat]!;
  if (player.isBot) return false;
  if (state.phase === 'bidding') bid(state, player.id, 0);
  else if (state.leadCombination && state.lastPlaySeat !== state.currentSeat) pass(state, player.id);
  else {
    const cards = chooseBotPlay(state.hands[player.id]!, null);
    if (!cards) throw new Error('TIMEOUT_PLAY_REQUIRED');
    play(state, player.id, cards.map((card) => card.id));
  }
  return true;
}
