export const RANK_LABELS: Readonly<Record<number, string>> = Object.freeze({
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王',
});

export type Suit = 'spade' | 'heart' | 'club' | 'diamond' | 'joker';

export type Card = Readonly<{
  id: string;
  rank: number;
  suit: Suit;
}>;

export type ComboType =
  | 'single' | 'pair' | 'triple' | 'triple_single' | 'triple_pair'
  | 'straight' | 'pair_straight' | 'airplane' | 'airplane_single' | 'airplane_pair'
  | 'four_two_single' | 'four_two_pair' | 'bomb' | 'rocket';

export type Combination = Readonly<{
  type: ComboType;
  mainRank: number;
  cardCount: number;
  chainLength: number;
}>;

export type PlayerRole = 'landlord' | 'farmer' | null;

export type GamePlayer = Readonly<{
  id: string;
  name: string;
  isBot: boolean;
  role: PlayerRole;
}>;

export type BidEvent = Readonly<{ seat: number; score: 0 | 1 | 2 | 3 }>;
export type PlayEvent = Readonly<{
  sequence: number;
  seat: number;
  kind: 'play' | 'pass';
  cardIds: readonly string[];
  combination: Combination | null;
}>;

export type GamePhase = 'bidding' | 'playing' | 'finished';

export type Settlement = Readonly<{
  winner: 'landlord' | 'farmers';
  multiplier: number;
  deltas: Readonly<Record<string, number>>;
}>;

export type GameState = {
  id: string;
  phase: GamePhase;
  players: GamePlayer[];
  hands: Record<string, Card[]>;
  bottomCards: Card[];
  currentSeat: number;
  bids: BidEvent[];
  highestBid: 0 | 1 | 2 | 3;
  highestBidSeat: number | null;
  landlordSeat: number | null;
  lastPlaySeat: number | null;
  leadCombination: Combination | null;
  leadCardIds: string[];
  consecutivePasses: number;
  bombs: number;
  baseStake: number;
  sequence: number;
  events: PlayEvent[];
  settlement: Settlement | null;
  fairness: {
    algorithm: 'sha256';
    commitment: string;
    nonce: string;
    deckOrder: string[];
  };
  createdAt: string;
  updatedAt: string;
};

export class GameRuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GameRuleError';
    this.code = code;
  }
}
