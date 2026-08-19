import { createHash, timingSafeEqual } from 'node:crypto';
import { createDeck } from './cards.ts';

export type FairnessReveal = Readonly<{
  algorithm: 'sha256';
  commitment: string;
  nonce: string;
  deckOrder: readonly string[];
}>;

export function deckCommitment(nonce: string, deckOrder: readonly string[]) {
  return createHash('sha256').update(`${nonce}:${deckOrder.join(',')}`).digest('hex');
}

export function verifyFairnessReveal(reveal: FairnessReveal) {
  if (!/^[a-f0-9]{32}$/i.test(reveal.nonce) || !/^[a-f0-9]{64}$/i.test(reveal.commitment)) return false;
  const expectedCards = new Set(createDeck().map((card) => card.id));
  if (reveal.deckOrder.length !== expectedCards.size || new Set(reveal.deckOrder).size !== expectedCards.size) return false;
  if (reveal.deckOrder.some((id) => !expectedCards.has(id))) return false;

  const calculated = Buffer.from(deckCommitment(reveal.nonce, reveal.deckOrder), 'hex');
  const committed = Buffer.from(reveal.commitment, 'hex');
  return calculated.length === committed.length && timingSafeEqual(calculated, committed);
}
