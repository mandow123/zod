import { createDeck } from './cards.ts';
import type { GameState } from './types.ts';

export function gameView(state: GameState, viewerId: string) {
  const viewerSeat = state.players.findIndex((player) => player.id === viewerId);
  if (viewerSeat < 0) throw new Error('VIEWER_NOT_IN_GAME');
  const allKnownCards = createDeck();
  return {
    id: state.id,
    phase: state.phase,
    players: state.players.map((player, seat) => ({
      id: player.id, name: player.name, isBot: player.isBot, role: player.role,
      seat, cardCount: state.hands[player.id]!.length,
    })),
    viewerSeat,
    hand: state.hands[viewerId]!,
    bottomCards: state.phase === 'bidding' ? [] : state.bottomCards,
    currentSeat: state.currentSeat,
    bids: state.bids,
    highestBid: state.highestBid,
    landlordSeat: state.landlordSeat,
    leadCombination: state.leadCombination,
    leadCards: state.leadCardIds.map((id) => allKnownCards.find((card) => card.id === id)).filter(Boolean),
    lastEvent: state.events.at(-1) ?? null,
    recentEvents: state.events.slice(-4).map((event) => ({
      ...event,
      cards: event.cardIds.map((id) => allKnownCards.find((card) => card.id === id)).filter(Boolean),
    })),
    sequence: state.sequence,
    bombs: state.bombs,
    baseStake: state.baseStake,
    settlement: state.settlement,
    fairness: {
      algorithm: state.fairness.algorithm,
      commitment: state.fairness.commitment,
      revealed: state.phase === 'finished'
        ? { nonce: state.fairness.nonce, deckOrder: state.fairness.deckOrder }
        : null,
    },
    updatedAt: state.updatedAt,
  };
}
