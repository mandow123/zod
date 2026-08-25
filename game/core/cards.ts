import { randomInt } from 'node:crypto';
import type { Card, Suit } from './types.ts';

const SUITS: readonly Suit[] = ['spade', 'heart', 'club', 'diamond'];

export function createDeck(): Card[] {
  const cards: Card[] = [];
  for (let rank = 3; rank <= 15; rank += 1) {
    for (const suit of SUITS) cards.push({ id: `${suit}-${rank}`, rank, suit });
  }
  cards.push({ id: 'joker-16', rank: 16, suit: 'joker' });
  cards.push({ id: 'joker-17', rank: 17, suit: 'joker' });
  return cards;
}

export function secureShuffle<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

export function sortCards(cards: readonly Card[]): Card[] {
  return [...cards].sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
}

export function dealCards(deck = secureShuffle(createDeck())): Readonly<{
  hands: [Card[], Card[], Card[]];
  bottomCards: Card[];
}> {
  if (deck.length !== 54 || new Set(deck.map((card) => card.id)).size !== 54) {
    throw new Error('A valid 54-card deck is required');
  }
  return {
    hands: [sortCards(deck.slice(0, 17)), sortCards(deck.slice(17, 34)), sortCards(deck.slice(34, 51))],
    bottomCards: sortCards(deck.slice(51)),
  };
}
