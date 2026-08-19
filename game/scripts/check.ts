import assert from 'node:assert/strict';
import { analyzeCombination } from '../core/rules.ts';
import { createDeck, secureShuffle } from '../core/cards.ts';

const deck = secureShuffle(createDeck());
assert.equal(deck.length, 54);
assert.equal(new Set(deck.map((card) => card.id)).size, 54);
assert.equal(analyzeCombination(deck.filter((card) => card.rank >= 16))?.type, 'rocket');
console.log('KAI Play integrity check passed: deck, uniqueness, and rocket rules are valid.');
