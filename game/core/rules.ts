import type { Card, Combination, ComboType } from './types.ts';

function rankCounts(cards: readonly Card[]) {
  const counts = new Map<number, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return counts;
}

function consecutive(ranks: readonly number[]) {
  return ranks.every((rank, index) => index === 0 || rank === ranks[index - 1]! + 1);
}

function combo(type: ComboType, mainRank: number, cardCount: number, chainLength = 1): Combination {
  return { type, mainRank, cardCount, chainLength };
}

function findTripleChain(counts: ReadonlyMap<number, number>, length: number) {
  const eligible = [...counts.entries()]
    .filter(([rank, count]) => rank < 15 && count >= 3)
    .map(([rank]) => rank)
    .sort((a, b) => a - b);
  for (let start = 0; start <= eligible.length - length; start += 1) {
    const ranks = eligible.slice(start, start + length);
    if (consecutive(ranks)) return ranks;
  }
  return null;
}

export function analyzeCombination(cards: readonly Card[]): Combination | null {
  if (cards.length === 0) return null;
  const counts = rankCounts(cards);
  const entries = [...counts.entries()].sort(([a], [b]) => a - b);
  const ranks = entries.map(([rank]) => rank);
  const sizes = entries.map(([, count]) => count);
  const count = cards.length;

  if (count === 2 && ranks[0] === 16 && ranks[1] === 17) return combo('rocket', 17, 2);
  if (entries.length === 1) {
    const rank = ranks[0]!;
    if (count === 1) return combo('single', rank, 1);
    if (count === 2) return combo('pair', rank, 2);
    if (count === 3) return combo('triple', rank, 3);
    if (count === 4) return combo('bomb', rank, 4);
  }

  if (count === 4 && sizes.includes(3)) return combo('triple_single', entries.find(([, n]) => n === 3)![0], 4);
  if (count === 5 && sizes.includes(3) && sizes.includes(2)) return combo('triple_pair', entries.find(([, n]) => n === 3)![0], 5);

  if (count >= 5 && entries.length === count && ranks.at(-1)! < 15 && consecutive(ranks)) {
    return combo('straight', ranks.at(-1)!, count, count);
  }
  if (count >= 6 && count % 2 === 0 && entries.length === count / 2
    && sizes.every((size) => size === 2) && ranks.at(-1)! < 15 && consecutive(ranks)) {
    return combo('pair_straight', ranks.at(-1)!, count, count / 2);
  }

  if (count >= 6 && count % 3 === 0 && entries.length === count / 3
    && sizes.every((size) => size === 3) && ranks.at(-1)! < 15 && consecutive(ranks)) {
    return combo('airplane', ranks.at(-1)!, count, count / 3);
  }

  if (count >= 8 && count % 4 === 0) {
    const length = count / 4;
    const chain = findTripleChain(counts, length);
    if (chain) {
      const remainder = new Map(counts);
      for (const rank of chain) remainder.set(rank, remainder.get(rank)! - 3);
      const remainderCount = [...remainder.values()].reduce((sum, value) => sum + value, 0);
      if (remainderCount === length && chain.every((rank) => remainder.get(rank) === 0)) {
        return combo('airplane_single', chain.at(-1)!, count, length);
      }
    }
  }

  if (count >= 10 && count % 5 === 0) {
    const length = count / 5;
    const chain = findTripleChain(counts, length);
    if (chain) {
      const remainder = new Map(counts);
      for (const rank of chain) remainder.set(rank, remainder.get(rank)! - 3);
      const wings = [...remainder.entries()].filter(([, size]) => size > 0);
      if (wings.length === length && wings.every(([rank, size]) => size === 2 && !chain.includes(rank))) {
        return combo('airplane_pair', chain.at(-1)!, count, length);
      }
    }
  }

  if (count === 6 && sizes.includes(4)) return combo('four_two_single', entries.find(([, n]) => n === 4)![0], 6);
  if (count === 8 && sizes.filter((size) => size === 4).length === 1) {
    const fourRank = entries.find(([, n]) => n === 4)![0];
    const rest = entries.filter(([rank]) => rank !== fourRank);
    if (rest.length === 2 && rest.every(([, n]) => n === 2)) return combo('four_two_pair', fourRank, 8);
  }
  return null;
}

export function canBeat(candidate: Combination, incumbent: Combination | null) {
  if (!incumbent) return true;
  if (candidate.type === 'rocket') return incumbent.type !== 'rocket';
  if (incumbent.type === 'rocket') return false;
  if (candidate.type === 'bomb' && incumbent.type !== 'bomb') return true;
  if (candidate.type !== incumbent.type) return false;
  return candidate.cardCount === incumbent.cardCount
    && candidate.chainLength === incumbent.chainLength
    && candidate.mainRank > incumbent.mainRank;
}
