import { analyzeCombination, canBeat } from './rules.ts';
import { sortCards } from './cards.ts';
import type { Card, Combination } from './types.ts';

function groups(hand: readonly Card[]) {
  const result = new Map<number, Card[]>();
  for (const card of sortCards(hand)) result.set(card.rank, [...(result.get(card.rank) ?? []), card]);
  return result;
}

function firstGroupAbove(hand: readonly Card[], amount: number, rank: number, exact = false) {
  return [...groups(hand).entries()]
    .find(([candidate, cards]) => candidate > rank && (exact ? cards.length === amount : cards.length >= amount))?.[1].slice(0, amount) ?? null;
}

function smallestBomb(hand: readonly Card[], above = 0) {
  return firstGroupAbove(hand, 4, above, true);
}

function rocket(hand: readonly Card[]) {
  const byRank = groups(hand);
  return byRank.has(16) && byRank.has(17) ? [byRank.get(16)![0]!, byRank.get(17)![0]!] : null;
}

export function evaluateHand(hand: readonly Card[]) {
  const byRank = groups(hand);
  let score = 0;
  score += hand.filter((card) => card.rank >= 15).length * 2;
  score += [...byRank.values()].filter((cards) => cards.length === 4).length * 3;
  if (byRank.has(16) && byRank.has(17)) score += 4;
  score += [...byRank.values()].filter((cards) => cards.length === 3).length;
  return score;
}

export function chooseBotBid(hand: readonly Card[], highestBid: number): 0 | 1 | 2 | 3 {
  const score = evaluateHand(hand);
  const desired = score >= 11 ? 3 : score >= 8 ? 2 : score >= 5 ? 1 : 0;
  return desired > highestBid ? desired as 1 | 2 | 3 : 0;
}

function attachment(hand: readonly Card[], excludedRanks: readonly number[], amount: number) {
  const candidates = sortCards(hand).filter((card) => !excludedRanks.includes(card.rank));
  if (amount === 1) return candidates.slice(0, 1);
  return [...groups(candidates).values()].find((cards) => cards.length >= amount)?.slice(0, amount) ?? [];
}

function respondSameType(hand: readonly Card[], lead: Combination): Card[] | null {
  if (lead.type === 'single') return firstGroupAbove(hand, 1, lead.mainRank);
  if (lead.type === 'pair') return firstGroupAbove(hand, 2, lead.mainRank);
  if (lead.type === 'triple') return firstGroupAbove(hand, 3, lead.mainRank);
  if (lead.type === 'bomb') return smallestBomb(hand, lead.mainRank) ?? rocket(hand);
  if (lead.type === 'triple_single' || lead.type === 'triple_pair') {
    const triple = firstGroupAbove(hand, 3, lead.mainRank);
    if (!triple) return null;
    const wing = attachment(hand, [triple[0]!.rank], lead.type === 'triple_single' ? 1 : 2);
    return wing.length === (lead.type === 'triple_single' ? 1 : 2) ? [...triple, ...wing] : null;
  }
  const handRanks = [...groups(hand).entries()].sort(([a], [b]) => a - b);
  if (lead.type === 'straight' || lead.type === 'pair_straight' || lead.type === 'airplane') {
    const width = lead.type === 'straight' ? 1 : lead.type === 'pair_straight' ? 2 : 3;
    for (let high = lead.mainRank + 1; high < 15; high += 1) {
      const low = high - lead.chainLength + 1;
      if (low < 3) continue;
      const selected: Card[] = [];
      for (let rank = low; rank <= high; rank += 1) {
        const cards = handRanks.find(([value]) => value === rank)?.[1] ?? [];
        if (cards.length < width) break;
        selected.push(...cards.slice(0, width));
      }
      if (selected.length === lead.cardCount) return selected;
    }
  }
  return null;
}

export function chooseBotPlay(hand: readonly Card[], lead: Combination | null): Card[] | null {
  const ordered = sortCards(hand);
  if (!lead) {
    const all = analyzeCombination(ordered);
    if (all) return ordered;
    const nonBombGroup = [...groups(ordered).values()].find((cards) => cards.length < 4);
    return [nonBombGroup?.[0] ?? ordered[0]!];
  }
  const sameType = respondSameType(ordered, lead);
  if (sameType) {
    const analyzed = analyzeCombination(sameType);
    if (analyzed && canBeat(analyzed, lead)) return sameType;
  }
  if (lead.type !== 'bomb' && lead.type !== 'rocket') return smallestBomb(ordered) ?? rocket(ordered);
  return null;
}
