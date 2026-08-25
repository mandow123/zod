import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeck } from '../core/cards.ts';
import { deckCommitment, verifyFairnessReveal } from '../core/fairness.ts';

test('verifies a complete, untampered deck reveal', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const deckOrder = createDeck().map((card) => card.id).reverse();
  const commitment = deckCommitment(nonce, deckOrder);
  assert.equal(verifyFairnessReveal({ algorithm: 'sha256', commitment, nonce, deckOrder }), true);
});

test('rejects tampered, duplicate and malformed reveals', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const deckOrder = createDeck().map((card) => card.id);
  const commitment = deckCommitment(nonce, deckOrder);
  const valid = { algorithm: 'sha256' as const, commitment, nonce, deckOrder };

  assert.equal(verifyFairnessReveal({ ...valid, deckOrder: [...deckOrder].reverse() }), false);
  assert.equal(verifyFairnessReveal({ ...valid, deckOrder: [...deckOrder.slice(0, -1), deckOrder[0]!] }), false);
  assert.equal(verifyFairnessReveal({ ...valid, commitment: 'not-a-digest' }), false);
});
