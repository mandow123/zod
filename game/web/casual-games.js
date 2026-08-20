const SUITS = ['spade', 'heart', 'club', 'diamond'];
const THREE_CARD_LABELS = ['高牌', '对子', '顺子', '金花', '顺金', '豹子'];

export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const next = Math.floor(random() * (index + 1));
    [result[index], result[next]] = [result[next], result[index]];
  }
  return result;
}

export function createTrainingDeck() {
  return SUITS.flatMap((suit) => Array.from({ length: 13 }, (_, index) => ({
    id: `train-${suit}-${index + 2}`,
    suit,
    rank: index + 2,
  })));
}

function straightHigh(ranks) {
  const unique = [...new Set(ranks)].sort((a, b) => a - b);
  if (unique.length !== 3) return 0;
  if (unique.join(',') === '2,3,14') return 3;
  return unique[2] - unique[0] === 2 ? unique[2] : 0;
}

export function evaluateThreeCard(hand) {
  if (!Array.isArray(hand) || hand.length !== 3) throw new Error('THREE_CARDS_REQUIRED');
  const ranks = hand.map((card) => card.rank).sort((a, b) => b - a);
  const counts = new Map(ranks.map((value) => [value, ranks.filter((rank) => rank === value).length]));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = hand.every((card) => card.suit === hand[0].suit);
  const high = straightHigh(ranks);
  let category = 0;
  let tiebreak = ranks;
  if (groups[0][1] === 3) { category = 5; tiebreak = [groups[0][0]]; }
  else if (flush && high) { category = 4; tiebreak = [high]; }
  else if (flush) { category = 3; }
  else if (high) { category = 2; tiebreak = [high]; }
  else if (groups[0][1] === 2) { category = 1; tiebreak = [groups[0][0], groups[1][0]]; }
  return { category, label: THREE_CARD_LABELS[category], tiebreak };
}

export function compareThreeCard(left, right) {
  const a = evaluateThreeCard(left);
  const b = evaluateThreeCard(right);
  if (a.category !== b.category) return Math.sign(a.category - b.category);
  const length = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a.tiebreak[index] || 0) - (b.tiebreak[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function newThreeCardRound(random = Math.random) {
  const deck = shuffle(createTrainingDeck(), random);
  return {
    players: [
      { name: '你', hand: deck.slice(0, 3) },
      { name: '阿满', hand: deck.slice(3, 6) },
      { name: '小禾', hand: deck.slice(6, 9) },
    ],
  };
}

const HONORS = ['东', '南', '西', '北', '中', '发', '白'];

export function createMahjongWall() {
  const suited = ['万', '筒', '条'].flatMap((suit) => Array.from({ length: 9 }, (_, index) =>
    Array.from({ length: 4 }, (__, copy) => ({ id: `${suit}-${index + 1}-${copy}`, key: `${suit}${index + 1}`, suit, rank: index + 1, label: `${index + 1}${suit}` })),
  )).flat();
  const honors = HONORS.flatMap((label) => Array.from({ length: 4 }, (_, copy) => ({
    id: `字-${label}-${copy}`, key: `字${label}`, suit: '字', rank: HONORS.indexOf(label) + 1, label,
  })));
  return [...suited, ...honors];
}

export function sortMahjong(hand) {
  const order = { 万: 0, 筒: 1, 条: 2, 字: 3 };
  return [...hand].sort((a, b) => order[a.suit] - order[b.suit] || a.rank - b.rank);
}

function canFormMelds(counts, keys, tileByKey) {
  const first = keys.find((key) => (counts.get(key) || 0) > 0);
  if (!first) return true;
  const count = counts.get(first) || 0;
  if (count >= 3) {
    counts.set(first, count - 3);
    if (canFormMelds(counts, keys, tileByKey)) return true;
    counts.set(first, count);
  }
  const tile = tileByKey.get(first);
  if (tile?.suit !== '字' && tile.rank <= 7) {
    const next = `${tile.suit}${tile.rank + 1}`;
    const third = `${tile.suit}${tile.rank + 2}`;
    if ((counts.get(next) || 0) > 0 && (counts.get(third) || 0) > 0) {
      counts.set(first, count - 1);
      counts.set(next, counts.get(next) - 1);
      counts.set(third, counts.get(third) - 1);
      if (canFormMelds(counts, keys, tileByKey)) return true;
      counts.set(first, count);
      counts.set(next, counts.get(next) + 1);
      counts.set(third, counts.get(third) + 1);
    }
  }
  return false;
}

export function isWinningMahjong(hand) {
  if (!Array.isArray(hand) || hand.length % 3 !== 2) return false;
  const counts = new Map();
  const tileByKey = new Map();
  for (const tile of hand) {
    counts.set(tile.key, (counts.get(tile.key) || 0) + 1);
    tileByKey.set(tile.key, tile);
  }
  const keys = [...counts.keys()].sort();
  for (const key of keys) {
    if ((counts.get(key) || 0) < 2) continue;
    const candidate = new Map(counts);
    candidate.set(key, candidate.get(key) - 2);
    if (canFormMelds(candidate, keys, tileByKey)) return true;
  }
  return false;
}

export function newMahjongRound(random = Math.random) {
  const wall = shuffle(createMahjongWall(), random);
  return { hand: sortMahjong(wall.splice(0, 13)), wall, discards: [], drawnId: null, won: false };
}

export const SLOT_SYMBOLS = Object.freeze(['7', 'KAI', '⚡', 'AI', '★']);

export function spinSlots(random = Math.random) {
  const reels = Array.from({ length: 3 }, () => SLOT_SYMBOLS[Math.floor(random() * SLOT_SYMBOLS.length)]);
  const unique = new Set(reels).size;
  const result = unique === 1 ? { tier: 'jackpot', label: '三连共振' }
    : unique === 2 ? { tier: 'pair', label: '双核同频' }
      : { tier: 'none', label: '继续挑战' };
  return { reels, result };
}
