export type Card = { id: string; rank: number; suit: 'spade' | 'heart' | 'club' | 'diamond' | 'joker' };
export type ComboType = 'single' | 'pair' | 'triple' | 'triple_single' | 'triple_pair' | 'straight'
  | 'pair_straight' | 'airplane' | 'airplane_single' | 'airplane_pair' | 'four_two_single'
  | 'four_two_pair' | 'bomb' | 'rocket';
export type Combination = { type: ComboType; mainRank: number; cardCount: number; chainLength: number };
export type PlayerView = {
  id: string; name: string; isBot: boolean; role: 'landlord' | 'farmer' | null; seat: number; cardCount: number;
};
export type Profile = {
  id: string; name: string; balance: number; games: number; wins: number; winRate: number;
  tokenPolicy: { purchasable: false; withdrawable: false; transferable: false; redeemable: false };
};
export type GameView = {
  id: string;
  phase: 'bidding' | 'playing' | 'finished';
  players: PlayerView[];
  viewerSeat: number;
  hand: Card[];
  bottomCards: Card[];
  currentSeat: number;
  bids: { seat: number; score: 0 | 1 | 2 | 3 }[];
  highestBid: 0 | 1 | 2 | 3;
  landlordSeat: number | null;
  leadCombination: Combination | null;
  leadCards: Card[];
  lastEvent: { seat: number; kind: 'play' | 'pass'; cardIds: string[]; combination: Combination | null } | null;
  sequence: number;
  bombs: number;
  baseStake: number;
  settlement: { winner: 'landlord' | 'farmers'; multiplier: number; deltas: Record<string, number> } | null;
  fairness: {
    algorithm: 'sha256';
    commitment: string;
    revealed: { nonce: string; deckOrder: string[] } | null;
  };
  updatedAt: string;
};
export type History = {
  games: { id: string; updatedAt: string; role: 'landlord' | 'farmer'; winner: 'landlord' | 'farmers'; multiplier: number; delta: number }[];
  ledger: { id: string; amount: number; memo: string; createdAt: string }[];
};

export type RoomView = {
  id: string;
  code: string;
  version: number;
  status: 'waiting' | 'playing' | 'finished';
  hostId: string;
  isHost: boolean;
  gameId: string | null;
  members: { id: string; name: string; isYou: boolean }[];
  updatedAt: string;
};
